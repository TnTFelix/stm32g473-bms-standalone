#include "bms_estimator.h"
#include <math.h>
#include <stddef.h>

static uint32_t s_rest_accum_ms = 0U;

static float estimator_clamp_pct(float pct)
{
    if (pct < 0.0f) {
        return 0.0f;
    }
    if (pct > 100.0f) {
        return 100.0f;
    }
    return pct;
}

bool bms_estimator_init(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }

    s_rest_accum_ms = 0U;
    state->energy.charge_power_w = 0.0f;
    state->energy.discharge_power_w = 0.0f;
    state->energy.energy_in_wh = 0.0f;
    state->energy.energy_out_wh = 0.0f;
    state->energy.charge_capacity_ah = 0.0f;
    state->energy.discharge_capacity_ah = 0.0f;
    state->energy.soc_pct = BMS_INITIAL_SOC_PCT;
    state->energy.remaining_capacity_ah = BMS_NOMINAL_CAPACITY_AH * (BMS_INITIAL_SOC_PCT / 100.0f);
    state->energy.avg_charge_current_a = 0.0f;
    state->energy.avg_discharge_current_a = 0.0f;
    state->energy.remaining_time_min = 0.0f;
    state->energy.estimated_charge_time_min = 0.0f;
    state->energy.efficiency_pct = 100.0f;
    return true;
}

float bms_estimator_calc_efficiency_pct(float energy_in_wh, float energy_out_wh)
{
    float eta;

    if (!isfinite(energy_in_wh) || !isfinite(energy_out_wh)) {
        return 0.0f;
    }
    if (energy_in_wh <= 0.0f) {
        return 100.0f;
    }
    if (energy_out_wh <= 0.0f) {
        return 0.0f;
    }

    eta = (energy_out_wh / energy_in_wh) * 100.0f;
    return estimator_clamp_pct(eta);
}

float bms_estimator_ocv_to_soc_pct(float ocv_v)
{
    float span = BMS_FULL_V - BMS_EMPTY_V;
    float soc;

    if (!isfinite(ocv_v) || (span <= 0.0f) || (ocv_v <= BMS_EMPTY_V)) {
        return 0.0f;
    }
    if (ocv_v >= BMS_FULL_V) {
        return 100.0f;
    }

    soc = ((ocv_v - BMS_EMPTY_V) / span) * 100.0f;
    return estimator_clamp_pct(soc);
}

bool bms_estimator_apply_rest_ocv_correction(bms_system_state_t *state)
{
    float target_soc;
    float blended;

    if (state == NULL) {
        return false;
    }
    if (!state->meas.ina226_ok ||
        !isfinite(state->meas.bus_voltage_v) ||
        !isfinite(state->meas.current_a) ||
        !isfinite(state->energy.soc_pct)) {
        return false;
    }
    if (fabsf(state->meas.current_a) >= REST_CURRENT_THRESHOLD_A) {
        return false;
    }
    if ((state->meas.bus_voltage_v < INA226_BUS_VALID_MIN_V) ||
        (state->meas.bus_voltage_v > INA226_BUS_VALID_MAX_V)) {
        return false;
    }

    target_soc = bms_estimator_ocv_to_soc_pct(state->meas.bus_voltage_v);
    blended = ((1.0f - OCV_CORRECTION_BLEND) * state->energy.soc_pct) +
              (OCV_CORRECTION_BLEND * target_soc);
    state->energy.soc_pct = estimator_clamp_pct(blended);
    state->energy.remaining_capacity_ah = BMS_NOMINAL_CAPACITY_AH * (state->energy.soc_pct / 100.0f);
    return true;
}

uint32_t bms_estimator_get_rest_time_ms(void)
{
    return s_rest_accum_ms;
}

bool bms_estimator_step(bms_system_state_t *state, uint32_t dt_ms)
{
    float u;
    float i;
    float p;
    float dt_h;
    float i_chg;
    float i_dis;
    float delta_soc;
    float missing_ah;

    if (state == NULL) {
        return false;
    }
    if (dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    if (!state->meas.ina226_ok) {
        s_rest_accum_ms = 0U;
        state->meas.power_w = 0.0f;
        state->energy.charge_power_w = 0.0f;
        state->energy.discharge_power_w = 0.0f;
        state->energy.remaining_time_min = 0.0f;
        state->energy.estimated_charge_time_min = 0.0f;
        return false;
    }

    u = state->meas.bus_voltage_v;
    i = state->meas.current_a;
    if (!isfinite(u) || !isfinite(i) || (u < 0.0f)) {
        s_rest_accum_ms = 0U;
        state->meas.power_w = 0.0f;
        state->energy.charge_power_w = 0.0f;
        state->energy.discharge_power_w = 0.0f;
        state->energy.remaining_time_min = 0.0f;
        state->energy.estimated_charge_time_min = 0.0f;
        return false;
    }

    p = u * i;
    state->meas.power_w = p;
    if (i > 0.0f) {
        state->energy.charge_power_w = p;
        state->energy.discharge_power_w = 0.0f;
    } else if (i < 0.0f) {
        state->energy.charge_power_w = 0.0f;
        state->energy.discharge_power_w = -p;
    } else {
        state->energy.charge_power_w = 0.0f;
        state->energy.discharge_power_w = 0.0f;
    }

    i_chg = (i > 0.0f) ? i : 0.0f;
    i_dis = (i < 0.0f) ? -i : 0.0f;

    if (dt_ms > 0U) {
        dt_h = (float)dt_ms / 3600000.0f;
        state->energy.energy_in_wh += state->energy.charge_power_w * dt_h;
        state->energy.energy_out_wh += state->energy.discharge_power_w * dt_h;

        state->energy.charge_capacity_ah += i_chg * dt_h;
        state->energy.discharge_capacity_ah += i_dis * dt_h;

        if (i_chg >= CHARGE_CURRENT_MIN_A) {
            if (state->energy.avg_charge_current_a <= 0.0f) {
                state->energy.avg_charge_current_a = i_chg;
            } else {
                state->energy.avg_charge_current_a =
                    (ESTIMATOR_AVG_CURRENT_ALPHA * i_chg) +
                    ((1.0f - ESTIMATOR_AVG_CURRENT_ALPHA) * state->energy.avg_charge_current_a);
            }
        }

        if (i_dis >= DISCHARGE_CURRENT_MIN_A) {
            if (state->energy.avg_discharge_current_a <= 0.0f) {
                state->energy.avg_discharge_current_a = i_dis;
            } else {
                state->energy.avg_discharge_current_a =
                    (ESTIMATOR_AVG_CURRENT_ALPHA * i_dis) +
                    ((1.0f - ESTIMATOR_AVG_CURRENT_ALPHA) * state->energy.avg_discharge_current_a);
            }
        }

        if ((BMS_NOMINAL_CAPACITY_AH > 0.0f) && isfinite(state->energy.soc_pct)) {
            delta_soc = ((((BMS_CHARGE_EFFICIENCY * i_chg) - i_dis) * dt_h) / BMS_NOMINAL_CAPACITY_AH) * 100.0f;
            state->energy.soc_pct = estimator_clamp_pct(state->energy.soc_pct + delta_soc);
            state->energy.remaining_capacity_ah = BMS_NOMINAL_CAPACITY_AH * (state->energy.soc_pct / 100.0f);
        }

        if (fabsf(i) < REST_CURRENT_THRESHOLD_A) {
            if (s_rest_accum_ms <= (UINT32_MAX - dt_ms)) {
                s_rest_accum_ms += dt_ms;
            } else {
                s_rest_accum_ms = UINT32_MAX;
            }
            if (s_rest_accum_ms >= OCV_REST_QUALIFY_MS) {
                (void)bms_estimator_apply_rest_ocv_correction(state);
                s_rest_accum_ms = 0U;
            }
        } else {
            s_rest_accum_ms = 0U;
        }
    }

    if ((i_dis >= DISCHARGE_CURRENT_MIN_A) &&
        (state->energy.avg_discharge_current_a >= DISCHARGE_CURRENT_MIN_A) &&
        (state->energy.remaining_capacity_ah > 0.0f)) {
        state->energy.remaining_time_min =
            (state->energy.remaining_capacity_ah / state->energy.avg_discharge_current_a) * 60.0f;
    } else {
        state->energy.remaining_time_min = 0.0f;
    }

    if ((i_chg >= CHARGE_CURRENT_MIN_A) &&
        (state->energy.avg_charge_current_a >= CHARGE_CURRENT_MIN_A) &&
        (BMS_CHARGE_EFFICIENCY > 0.0f)) {
        missing_ah = BMS_NOMINAL_CAPACITY_AH - state->energy.remaining_capacity_ah;
        state->energy.estimated_charge_time_min = (missing_ah > 0.0f)
            ? ((missing_ah / (state->energy.avg_charge_current_a * BMS_CHARGE_EFFICIENCY)) * CHARGE_CV_COMPENSATION * 60.0f)
            : 0.0f;
    } else {
        state->energy.estimated_charge_time_min = 0.0f;
    }

    state->energy.efficiency_pct = bms_estimator_calc_efficiency_pct(
        state->energy.energy_in_wh,
        state->energy.energy_out_wh
    );

    return true;
}
