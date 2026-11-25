import {
    BMS_CHARGE_EFFICIENCY,
    BMS_EMPTY_V,
    BMS_FULL_V,
    BMS_INITIAL_SOC_PCT,
    BMS_NOMINAL_CAPACITY_AH,
    CHARGE_CURRENT_MIN_A,
    CHARGE_CV_COMPENSATION,
    DISCHARGE_CURRENT_MIN_A,
    ESTIMATOR_AVG_CURRENT_ALPHA,
    ESTIMATOR_MAX_DT_MS,
    INA226_BUS_VALID_MAX_V,
    INA226_BUS_VALID_MIN_V,
    OCV_CORRECTION_BLEND,
    OCV_REST_QUALIFY_MS,
    REST_CURRENT_THRESHOLD_A
} from '../bms_config.mjs';

let s_rest_accum_ms = 0;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampPct(pct) {
    if (pct < 0) {
        return 0;
    }
    if (pct > 100) {
        return 100;
    }
    return pct;
}

export function bms_estimator_init(state) {
    if (!isPlainObject(state) || !isPlainObject(state.energy)) {
        return false;
    }

    s_rest_accum_ms = 0;
    state.energy.charge_power_w = 0;
    state.energy.discharge_power_w = 0;
    state.energy.energy_in_wh = 0;
    state.energy.energy_out_wh = 0;
    state.energy.charge_capacity_ah = 0;
    state.energy.discharge_capacity_ah = 0;
    state.energy.soc_pct = BMS_INITIAL_SOC_PCT;
    state.energy.remaining_capacity_ah = BMS_NOMINAL_CAPACITY_AH * (BMS_INITIAL_SOC_PCT / 100);
    state.energy.avg_charge_current_a = 0;
    state.energy.avg_discharge_current_a = 0;
    state.energy.remaining_time_min = 0;
    state.energy.estimated_charge_time_min = 0;
    state.energy.efficiency_pct = 100;
    return true;
}

export function bms_estimator_calc_efficiency_pct(energy_in_wh, energy_out_wh) {
    if (typeof energy_in_wh !== 'number' || typeof energy_out_wh !== 'number' ||
        !Number.isFinite(energy_in_wh) || !Number.isFinite(energy_out_wh)) {
        return 0;
    }
    if (energy_in_wh <= 0) {
        return 100;
    }
    if (energy_out_wh <= 0) {
        return 0;
    }

    return clampPct((energy_out_wh / energy_in_wh) * 100);
}

const K_NMC_4S_OCV_V = [
    12.00, 13.40, 14.12, 14.52, 14.76,
    14.96, 15.20, 15.52, 15.88, 16.32, 16.80
];
const K_NMC_4S_SOC_PCT = [
    0.0, 10.0, 20.0, 30.0, 40.0,
    50.0, 60.0, 70.0, 80.0, 90.0, 100.0
];

export function bms_estimator_ocv_to_soc_pct(ocv_v) {
    if (typeof ocv_v !== 'number' || !Number.isFinite(ocv_v) || ocv_v <= K_NMC_4S_OCV_V[0]) {
        return 0;
    }
    if (ocv_v >= K_NMC_4S_OCV_V[10]) {
        return 100;
    }

    for (let i = 0; i < 10; i++) {
        if (ocv_v <= K_NMC_4S_OCV_V[i + 1]) {
            const vLo = K_NMC_4S_OCV_V[i];
            const vHi = K_NMC_4S_OCV_V[i + 1];
            const frac = (ocv_v - vLo) / (vHi - vLo);
            const soc = K_NMC_4S_SOC_PCT[i] + (frac * (K_NMC_4S_SOC_PCT[i + 1] - K_NMC_4S_SOC_PCT[i]));
            return clampPct(soc);
        }
    }

    return 100;
}

export function bms_estimator_apply_rest_ocv_correction(state) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) || !isPlainObject(state.energy)) {
        return false;
    }
    if (!state.meas.ina226_ok ||
        typeof state.meas.bus_voltage_v !== 'number' || !Number.isFinite(state.meas.bus_voltage_v) ||
        typeof state.meas.current_a !== 'number' || !Number.isFinite(state.meas.current_a) ||
        typeof state.energy.soc_pct !== 'number' || !Number.isFinite(state.energy.soc_pct)) {
        return false;
    }
    if (Math.abs(state.meas.current_a) >= REST_CURRENT_THRESHOLD_A) {
        return false;
    }
    if (state.meas.bus_voltage_v < INA226_BUS_VALID_MIN_V ||
        state.meas.bus_voltage_v > INA226_BUS_VALID_MAX_V) {
        return false;
    }

    const target_soc = bms_estimator_ocv_to_soc_pct(state.meas.bus_voltage_v);
    const blended = ((1 - OCV_CORRECTION_BLEND) * state.energy.soc_pct) +
        (OCV_CORRECTION_BLEND * target_soc);
    state.energy.soc_pct = clampPct(blended);
    state.energy.remaining_capacity_ah = BMS_NOMINAL_CAPACITY_AH * (state.energy.soc_pct / 100);
    return true;
}

export function bms_estimator_get_rest_time_ms() {
    return s_rest_accum_ms;
}

export function bms_estimator_step(state, dt_ms) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) || !isPlainObject(state.energy)) {
        return false;
    }
    if (!Number.isInteger(dt_ms) || dt_ms < 0 || dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    if (!state.meas.ina226_ok) {
        s_rest_accum_ms = 0;
        state.meas.power_w = 0;
        state.energy.charge_power_w = 0;
        state.energy.discharge_power_w = 0;
        state.energy.remaining_time_min = 0;
        state.energy.estimated_charge_time_min = 0;
        return false;
    }

    const u = state.meas.bus_voltage_v;
    const i = state.meas.current_a;
    if (typeof u !== 'number' || typeof i !== 'number' ||
        !Number.isFinite(u) || !Number.isFinite(i) || u < 0) {
        s_rest_accum_ms = 0;
        state.meas.power_w = 0;
        state.energy.charge_power_w = 0;
        state.energy.discharge_power_w = 0;
        state.energy.remaining_time_min = 0;
        state.energy.estimated_charge_time_min = 0;
        return false;
    }

    const p = u * i;
    state.meas.power_w = p;
    if (i > 0) {
        state.energy.charge_power_w = p;
        state.energy.discharge_power_w = 0;
    } else if (i < 0) {
        state.energy.charge_power_w = 0;
        state.energy.discharge_power_w = -p;
    } else {
        state.energy.charge_power_w = 0;
        state.energy.discharge_power_w = 0;
    }

    const i_chg = (i > 0) ? i : 0;
    const i_dis = (i < 0) ? -i : 0;

    if (dt_ms > 0) {
        const dt_h = dt_ms / 3600000;
        state.energy.energy_in_wh += state.energy.charge_power_w * dt_h;
        state.energy.energy_out_wh += state.energy.discharge_power_w * dt_h;

        state.energy.charge_capacity_ah += i_chg * dt_h;
        state.energy.discharge_capacity_ah += i_dis * dt_h;

        if (i_chg >= CHARGE_CURRENT_MIN_A) {
            if (state.energy.avg_charge_current_a <= 0) {
                state.energy.avg_charge_current_a = i_chg;
            } else {
                state.energy.avg_charge_current_a =
                    (ESTIMATOR_AVG_CURRENT_ALPHA * i_chg) +
                    ((1 - ESTIMATOR_AVG_CURRENT_ALPHA) * state.energy.avg_charge_current_a);
            }
        }

        if (i_dis >= DISCHARGE_CURRENT_MIN_A) {
            if (state.energy.avg_discharge_current_a <= 0) {
                state.energy.avg_discharge_current_a = i_dis;
            } else {
                state.energy.avg_discharge_current_a =
                    (ESTIMATOR_AVG_CURRENT_ALPHA * i_dis) +
                    ((1 - ESTIMATOR_AVG_CURRENT_ALPHA) * state.energy.avg_discharge_current_a);
            }
        }

        if (BMS_NOMINAL_CAPACITY_AH > 0 && typeof state.energy.soc_pct === 'number' && Number.isFinite(state.energy.soc_pct)) {
            const delta_soc = ((((BMS_CHARGE_EFFICIENCY * i_chg) - i_dis) * dt_h) / BMS_NOMINAL_CAPACITY_AH) * 100;
            state.energy.soc_pct = clampPct(state.energy.soc_pct + delta_soc);
            state.energy.remaining_capacity_ah = BMS_NOMINAL_CAPACITY_AH * (state.energy.soc_pct / 100);
        }

        if (Math.abs(i) < REST_CURRENT_THRESHOLD_A) {
            const next_rest = s_rest_accum_ms + dt_ms;
            s_rest_accum_ms = (next_rest <= 0xFFFFFFFF) ? next_rest : 0xFFFFFFFF;
            if (s_rest_accum_ms >= OCV_REST_QUALIFY_MS) {
                bms_estimator_apply_rest_ocv_correction(state);
                s_rest_accum_ms = 0;
            }
        } else {
            s_rest_accum_ms = 0;
        }
    }

    if (i_dis >= DISCHARGE_CURRENT_MIN_A &&
        state.energy.avg_discharge_current_a >= DISCHARGE_CURRENT_MIN_A &&
        state.energy.remaining_capacity_ah > 0) {
        state.energy.remaining_time_min =
            (state.energy.remaining_capacity_ah / state.energy.avg_discharge_current_a) * 60;
    } else {
        state.energy.remaining_time_min = 0;
    }

    if (i_chg >= CHARGE_CURRENT_MIN_A &&
        state.energy.avg_charge_current_a >= CHARGE_CURRENT_MIN_A &&
        BMS_CHARGE_EFFICIENCY > 0) {
        const missing_ah = BMS_NOMINAL_CAPACITY_AH - state.energy.remaining_capacity_ah;
        state.energy.estimated_charge_time_min = (missing_ah > 0)
            ? ((missing_ah / (state.energy.avg_charge_current_a * BMS_CHARGE_EFFICIENCY)) * CHARGE_CV_COMPENSATION * 60)
            : 0;
    } else {
        state.energy.estimated_charge_time_min = 0;
    }

    state.energy.efficiency_pct = bms_estimator_calc_efficiency_pct(
        state.energy.energy_in_wh,
        state.energy.energy_out_wh
    );

    return true;
}
