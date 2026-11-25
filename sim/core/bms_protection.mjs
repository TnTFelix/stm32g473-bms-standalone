import {
    ADC_PIN_MAX_SAFE_V,
    ESTIMATOR_MAX_DT_MS,
    INA226_BUS_VALID_MAX_V,
    INA226_BUS_VALID_MIN_V,
    PROT_BAT_OV_CRIT_V,
    PROT_BAT_OV_TRIP_V,
    PROT_BAT_OV_WARN_V,
    PROT_BAT_UV_CRIT_V,
    PROT_BAT_UV_TRIP_V,
    PROT_BAT_UV_WARN_V,
    PROT_CHARGER_OV_TRIP_V,
    PROT_CHARGER_OV_WARN_V,
    PROT_CHG_OC_TRIP_A,
    PROT_CHG_OC_WARN_A,
    PROT_DEBOUNCE_NORM_MS,
    PROT_DI_DT_MAX_A_PER_STEP,
    PROT_DIS_OC_TRIP_A,
    PROT_DIS_OC_WARN_A,
    PROT_SHORT_CIRCUIT_A
} from '../bms_config.mjs';

import {
    BMS_MODE_FAULT,
    BMS_MODE_STANDBY,
    BMS_MODE_STARTUP,
    FAULT_BAT_OVERVOLTAGE,
    FAULT_BAT_UNDERVOLTAGE,
    FAULT_CHARGER_OVERVOLTAGE,
    FAULT_CHG_OVERCURRENT,
    FAULT_DIS_OVERCURRENT,
    FAULT_INA226_DISCONNECTED,
    FAULT_RELAY_NO_RESPONSE,
    FAULT_SHORT_CIRCUIT,
    FAULT_VSENSE_FAULT,
    PROT_LEVEL_1_NORMAL,
    PROT_LEVEL_2_WARNING,
    PROT_LEVEL_3_BRANCH,
    PROT_LEVEL_4_ISOLATE,
    PROT_LEVEL_5_LATCH,
    RELAY_1_MAIN
} from '../bms_types.mjs';

import { hal_get_tick_ms, hal_relay_read_cmd } from '../hal_mock.mjs';
import {
    relay_ctrl_apply_protection,
    relay_ctrl_has_mismatch,
    relay_ctrl_sync
} from '../drivers/relay_ctrl.mjs';

let s_ov_ms = 0;
let s_uv_ms = 0;
let s_chg_oc_ms = 0;
let s_dis_oc_ms = 0;
let s_charger_ov_ms = 0;
let s_branch_fault_hold_mask = 0;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function sanitizeFloat(v) {
    return isFiniteNum(v) ? v : 0;
}

function clearSnapshot(state) {
    state.snapshot.valid = false;
    state.snapshot.latched_fault_mask = 0;
    state.snapshot.prot_level = PROT_LEVEL_1_NORMAL;
    state.snapshot.bus_voltage_v = 0;
    state.snapshot.charger_voltage_v = 0;
    state.snapshot.current_a = 0;
    state.snapshot.power_w = 0;
    state.snapshot.timestamp_ms = 0;
}

function captureSnapshot(state, fault_mask) {
    if (!state.snapshot.valid) {
        state.snapshot.valid = true;
        state.snapshot.latched_fault_mask = fault_mask >>> 0;
        state.snapshot.prot_level = PROT_LEVEL_5_LATCH;
        state.snapshot.bus_voltage_v = sanitizeFloat(state.meas.bus_voltage_v);
        state.snapshot.charger_voltage_v = sanitizeFloat(state.meas.charger_voltage_v);
        state.snapshot.current_a = sanitizeFloat(state.meas.current_a);
        state.snapshot.power_w = sanitizeFloat(state.meas.power_w);
        state.snapshot.timestamp_ms = (state.tick_ms !== 0) ? state.tick_ms : hal_get_tick_ms();
    } else {
        state.snapshot.latched_fault_mask = (state.snapshot.latched_fault_mask | fault_mask) >>> 0;
    }
}

function updateDebounce(current_ms, active, dt_ms) {
    if (!active) {
        return { next_ms: 0, tripped: false };
    }
    const sum = current_ms + dt_ms;
    const next_ms = (sum <= 0xFFFFFFFF) ? sum : 0xFFFFFFFF;
    return { next_ms, tripped: next_ms >= PROT_DEBOUNCE_NORM_MS };
}

export function bms_protection_reset() {
    s_ov_ms = 0;
    s_uv_ms = 0;
    s_chg_oc_ms = 0;
    s_dis_oc_ms = 0;
    s_charger_ov_ms = 0;
    s_branch_fault_hold_mask = 0;
}

export function bms_protection_init(state) {
    if (!isPlainObject(state) || !isPlainObject(state.snapshot)) {
        return false;
    }

    bms_protection_reset();
    state.prot_level = PROT_LEVEL_1_NORMAL;
    state.active_faults = 0;
    state.warning_flags = 0;
    state.fault_latched = false;
    clearSnapshot(state);
    return true;
}

export function bms_protection_is_recovery_safe(state) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) || !isPlainObject(state.relays)) {
        return false;
    }
    if (!state.meas.ina226_ok || !state.meas.vsense_ok) {
        return false;
    }
    if (relay_ctrl_has_mismatch(state)) {
        return false;
    }

    const bus_v = state.meas.bus_voltage_v;
    const curr_a = state.meas.current_a;
    const prev_curr_a = state.meas.prev_current_a;
    const chg_pin_v = state.meas.charger_pin_v;
    const chg_v = state.meas.charger_voltage_v;

    if (!isFiniteNum(bus_v) || !isFiniteNum(curr_a) || !isFiniteNum(prev_curr_a) ||
        !isFiniteNum(chg_pin_v) || !isFiniteNum(chg_v)) {
        return false;
    }
    if (bus_v <= PROT_BAT_UV_WARN_V || bus_v >= PROT_BAT_OV_WARN_V) {
        return false;
    }
    if (curr_a <= -PROT_DIS_OC_WARN_A || curr_a >= PROT_CHG_OC_WARN_A) {
        return false;
    }
    if (Math.abs(curr_a - prev_curr_a) >= PROT_DI_DT_MAX_A_PER_STEP) {
        return false;
    }
    if (chg_pin_v > ADC_PIN_MAX_SAFE_V) {
        return false;
    }
    if (state.meas.charger_present && chg_v >= PROT_CHARGER_OV_WARN_V) {
        return false;
    }

    return true;
}

export function bms_protection_request_fault_clear(state) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) ||
        !isPlainObject(state.relays) || !isPlainObject(state.snapshot)) {
        return false;
    }

    relay_ctrl_sync(state);
    if (!bms_protection_is_recovery_safe(state)) {
        return false;
    }

    state.fault_latched = false;
    state.active_faults = 0;
    state.warning_flags = 0;
    state.prot_level = PROT_LEVEL_1_NORMAL;
    clearSnapshot(state);
    bms_protection_reset();

    if (state.mode === BMS_MODE_FAULT) {
        state.mode = hal_relay_read_cmd(RELAY_1_MAIN) ? BMS_MODE_STANDBY : BMS_MODE_STARTUP;
    }
    return true;
}

export function bms_protection_step(state, dt_ms) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) ||
        !isPlainObject(state.relays) || !isPlainObject(state.snapshot)) {
        return false;
    }
    if (!Number.isInteger(dt_ms) || dt_ms < 0 || dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    relay_ctrl_sync(state);

    let warn_mask = 0;
    let branch_mask = 0;
    let latch_mask = 0;

    const bus_v = state.meas.bus_voltage_v;
    const curr_a = state.meas.current_a;
    const prev_curr_a = state.meas.prev_current_a;
    const chg_pin_v = state.meas.charger_pin_v;
    const chg_v = state.meas.charger_voltage_v;

    const ina_v_ok = state.meas.ina226_ok && isFiniteNum(bus_v);
    const ina_i_ok = state.meas.ina226_ok && isFiniteNum(curr_a);
    const vsense_ok = Boolean(state.meas.vsense_ok);

    if (!ina_v_ok || !ina_i_ok ||
        bus_v < INA226_BUS_VALID_MIN_V ||
        bus_v > INA226_BUS_VALID_MAX_V) {
        latch_mask |= FAULT_INA226_DISCONNECTED;
    }

    if (ina_i_ok &&
        (Math.abs(curr_a) >= PROT_SHORT_CIRCUIT_A ||
            (isFiniteNum(prev_curr_a) && Math.abs(curr_a - prev_curr_a) >= PROT_DI_DT_MAX_A_PER_STEP))) {
        latch_mask |= FAULT_SHORT_CIRCUIT;
    }

    if (relay_ctrl_has_mismatch(state)) {
        latch_mask |= FAULT_RELAY_NO_RESPONSE;
    }

    if (ina_v_ok) {
        if (bus_v >= PROT_BAT_OV_CRIT_V) {
            latch_mask |= FAULT_BAT_OVERVOLTAGE;
        }
        if (bus_v <= PROT_BAT_UV_CRIT_V) {
            latch_mask |= FAULT_BAT_UNDERVOLTAGE;
        }
    }

    if (!vsense_ok || !isFiniteNum(chg_pin_v) || chg_pin_v > ADC_PIN_MAX_SAFE_V) {
        branch_mask |= FAULT_VSENSE_FAULT;
    }

    if (ina_v_ok) {
        if (bus_v >= PROT_BAT_OV_WARN_V) {
            warn_mask |= FAULT_BAT_OVERVOLTAGE;
        }
        const ovRes = updateDebounce(s_ov_ms, bus_v >= PROT_BAT_OV_TRIP_V, dt_ms);
        s_ov_ms = ovRes.next_ms;
        if (ovRes.tripped) {
            branch_mask |= FAULT_BAT_OVERVOLTAGE;
        }

        if (bus_v <= PROT_BAT_UV_WARN_V) {
            warn_mask |= FAULT_BAT_UNDERVOLTAGE;
        }
        const uvRes = updateDebounce(s_uv_ms, bus_v <= PROT_BAT_UV_TRIP_V, dt_ms);
        s_uv_ms = uvRes.next_ms;
        if (uvRes.tripped) {
            branch_mask |= FAULT_BAT_UNDERVOLTAGE;
        }
    } else {
        s_ov_ms = 0;
        s_uv_ms = 0;
    }

    if (ina_i_ok) {
        if (curr_a >= PROT_CHG_OC_WARN_A) {
            warn_mask |= FAULT_CHG_OVERCURRENT;
        }
        const chgRes = updateDebounce(s_chg_oc_ms, curr_a >= PROT_CHG_OC_TRIP_A, dt_ms);
        s_chg_oc_ms = chgRes.next_ms;
        if (chgRes.tripped) {
            branch_mask |= FAULT_CHG_OVERCURRENT;
        }

        if (curr_a <= -PROT_DIS_OC_WARN_A) {
            warn_mask |= FAULT_DIS_OVERCURRENT;
        }
        const disRes = updateDebounce(s_dis_oc_ms, curr_a <= -PROT_DIS_OC_TRIP_A, dt_ms);
        s_dis_oc_ms = disRes.next_ms;
        if (disRes.tripped) {
            branch_mask |= FAULT_DIS_OVERCURRENT;
        }
    } else {
        s_chg_oc_ms = 0;
        s_dis_oc_ms = 0;
    }

    if (vsense_ok && state.meas.charger_present && isFiniteNum(chg_v)) {
        if (chg_v >= PROT_CHARGER_OV_WARN_V) {
            warn_mask |= FAULT_CHARGER_OVERVOLTAGE;
        }
        const chgOvRes = updateDebounce(s_charger_ov_ms, chg_v >= PROT_CHARGER_OV_TRIP_V, dt_ms);
        s_charger_ov_ms = chgOvRes.next_ms;
        if (chgOvRes.tripped) {
            branch_mask |= FAULT_CHARGER_OVERVOLTAGE;
        }
    } else {
        s_charger_ov_ms = 0;
    }

    s_branch_fault_hold_mask = (s_branch_fault_hold_mask | branch_mask) >>> 0;

    if (ina_v_ok && bus_v < PROT_BAT_OV_WARN_V) {
        s_branch_fault_hold_mask &= ~FAULT_BAT_OVERVOLTAGE;
    }
    if (ina_v_ok && bus_v > PROT_BAT_UV_WARN_V) {
        s_branch_fault_hold_mask &= ~FAULT_BAT_UNDERVOLTAGE;
    }
    if (vsense_ok && (!state.meas.charger_present || (isFiniteNum(chg_v) && chg_v < PROT_CHARGER_OV_WARN_V))) {
        s_branch_fault_hold_mask &= ~FAULT_CHARGER_OVERVOLTAGE;
    }
    if (vsense_ok && isFiniteNum(chg_pin_v) && chg_pin_v <= ADC_PIN_MAX_SAFE_V) {
        s_branch_fault_hold_mask &= ~FAULT_VSENSE_FAULT;
    }
    if ((!state.charge_enabled_req || !state.meas.charger_present) &&
        ina_i_ok && curr_a < PROT_CHG_OC_WARN_A) {
        s_branch_fault_hold_mask &= ~FAULT_CHG_OVERCURRENT;
    }
    if (!state.load_enabled_req && ina_i_ok && curr_a > -PROT_DIS_OC_WARN_A) {
        s_branch_fault_hold_mask &= ~FAULT_DIS_OVERCURRENT;
    }

    s_branch_fault_hold_mask >>>= 0;
    const effective_branch = (branch_mask | s_branch_fault_hold_mask) >>> 0;
    state.warning_flags = warn_mask >>> 0;

    if (latch_mask !== 0 || state.fault_latched) {
        const all_faults = (latch_mask | effective_branch | state.snapshot.latched_fault_mask) >>> 0;
        if (!state.fault_latched) {
            state.prot_level = PROT_LEVEL_4_ISOLATE;
            state.mode = BMS_MODE_FAULT;
            state.active_faults = all_faults;
            relay_ctrl_apply_protection(state);
        }
        state.fault_latched = true;
        state.prot_level = PROT_LEVEL_5_LATCH;
        state.mode = BMS_MODE_FAULT;
        state.active_faults = all_faults;
        captureSnapshot(state, (latch_mask | effective_branch) >>> 0);
        relay_ctrl_apply_protection(state);
    } else if (effective_branch !== 0) {
        state.active_faults = effective_branch;
        state.prot_level = PROT_LEVEL_3_BRANCH;
        state.mode = BMS_MODE_FAULT;
        relay_ctrl_apply_protection(state);
    } else if (warn_mask !== 0) {
        state.active_faults = 0;
        state.prot_level = PROT_LEVEL_2_WARNING;
    } else {
        state.active_faults = 0;
        state.prot_level = PROT_LEVEL_1_NORMAL;
    }

    return true;
}
