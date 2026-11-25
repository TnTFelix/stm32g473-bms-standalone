#include "bms_protection.h"
#include "hal_interface.h"
#include "relay_ctrl.h"
#include <math.h>
#include <stddef.h>

static uint32_t s_ov_ms = 0U;
static uint32_t s_uv_ms = 0U;
static uint32_t s_chg_oc_ms = 0U;
static uint32_t s_dis_oc_ms = 0U;
static uint32_t s_charger_ov_ms = 0U;
static uint32_t s_branch_fault_hold_mask = 0U;

static float prot_sanitize_float(float v)
{
    return isfinite(v) ? v : 0.0f;
}

static bool prot_update_debounce(uint32_t *accum_ms, bool active, uint32_t dt_ms)
{
    if (accum_ms == NULL) {
        return false;
    }
    if (!active) {
        *accum_ms = 0U;
        return false;
    }
    if (*accum_ms <= (UINT32_MAX - dt_ms)) {
        *accum_ms += dt_ms;
    } else {
        *accum_ms = UINT32_MAX;
    }
    return (*accum_ms >= PROT_DEBOUNCE_NORM_MS);
}

static void prot_clear_snapshot(bms_system_state_t *state)
{
    if (state == NULL) {
        return;
    }
    state->snapshot.valid = false;
    state->snapshot.latched_fault_mask = 0U;
    state->snapshot.prot_level = PROT_LEVEL_1_NORMAL;
    state->snapshot.bus_voltage_v = 0.0f;
    state->snapshot.charger_voltage_v = 0.0f;
    state->snapshot.current_a = 0.0f;
    state->snapshot.power_w = 0.0f;
    state->snapshot.timestamp_ms = 0U;
}

static void prot_capture_snapshot(bms_system_state_t *state, uint32_t fault_mask)
{
    if (state == NULL) {
        return;
    }
    if (!state->snapshot.valid) {
        state->snapshot.valid = true;
        state->snapshot.latched_fault_mask = fault_mask;
        state->snapshot.prot_level = PROT_LEVEL_5_LATCH;
        state->snapshot.bus_voltage_v = prot_sanitize_float(state->meas.bus_voltage_v);
        state->snapshot.charger_voltage_v = prot_sanitize_float(state->meas.charger_voltage_v);
        state->snapshot.current_a = prot_sanitize_float(state->meas.current_a);
        state->snapshot.power_w = prot_sanitize_float(state->meas.power_w);
        state->snapshot.timestamp_ms = (state->tick_ms != 0U) ? state->tick_ms : hal_get_tick_ms();
    } else {
        state->snapshot.latched_fault_mask |= fault_mask;
    }
}

void bms_protection_reset(void)
{
    s_ov_ms = 0U;
    s_uv_ms = 0U;
    s_chg_oc_ms = 0U;
    s_dis_oc_ms = 0U;
    s_charger_ov_ms = 0U;
    s_branch_fault_hold_mask = 0U;
}

bool bms_protection_init(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }

    bms_protection_reset();
    state->prot_level = PROT_LEVEL_1_NORMAL;
    state->active_faults = 0U;
    state->warning_flags = 0U;
    state->fault_latched = false;
    prot_clear_snapshot(state);
    return true;
}

bool bms_protection_is_recovery_safe(const bms_system_state_t *state)
{
    float bus_v;
    float curr_a;
    float prev_curr_a;
    float chg_pin_v;
    float chg_v;

    if (state == NULL) {
        return false;
    }
    if (!state->meas.ina226_ok || !state->meas.vsense_ok) {
        return false;
    }
    if (relay_ctrl_has_mismatch(state)) {
        return false;
    }

    bus_v = state->meas.bus_voltage_v;
    curr_a = state->meas.current_a;
    prev_curr_a = state->meas.prev_current_a;
    chg_pin_v = state->meas.charger_pin_v;
    chg_v = state->meas.charger_voltage_v;

    if (!isfinite(bus_v) || !isfinite(curr_a) || !isfinite(prev_curr_a) ||
        !isfinite(chg_pin_v) || !isfinite(chg_v)) {
        return false;
    }
    if ((bus_v <= PROT_BAT_UV_WARN_V) || (bus_v >= PROT_BAT_OV_WARN_V)) {
        return false;
    }
    if ((curr_a <= -PROT_DIS_OC_WARN_A) || (curr_a >= PROT_CHG_OC_WARN_A)) {
        return false;
    }
    if (fabsf(curr_a - prev_curr_a) >= PROT_DI_DT_MAX_A_PER_STEP) {
        return false;
    }
    if (chg_pin_v > ADC_PIN_MAX_SAFE_V) {
        return false;
    }
    if (state->meas.charger_present && (chg_v >= PROT_CHARGER_OV_WARN_V)) {
        return false;
    }

    return true;
}

bool bms_protection_request_fault_clear(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }

    (void)relay_ctrl_sync(state);
    if (!bms_protection_is_recovery_safe(state)) {
        return false;
    }

    state->fault_latched = false;
    state->active_faults = 0U;
    state->warning_flags = 0U;
    state->prot_level = PROT_LEVEL_1_NORMAL;
    prot_clear_snapshot(state);
    bms_protection_reset();

    if (state->mode == BMS_MODE_FAULT) {
        state->mode = hal_relay_read_cmd(RELAY_1_MAIN) ? BMS_MODE_STANDBY : BMS_MODE_STARTUP;
    }
    return true;
}

bool bms_protection_step(bms_system_state_t *state, uint32_t dt_ms)
{
    uint32_t warn_mask = 0U;
    uint32_t branch_mask = 0U;
    uint32_t latch_mask = 0U;
    uint32_t effective_branch;
    uint32_t all_faults;
    float bus_v;
    float curr_a;
    float prev_curr_a;
    float chg_pin_v;
    float chg_v;
    bool ina_v_ok;
    bool ina_i_ok;
    bool vsense_ok;

    if (state == NULL) {
        return false;
    }
    if (dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    (void)relay_ctrl_sync(state);

    bus_v = state->meas.bus_voltage_v;
    curr_a = state->meas.current_a;
    prev_curr_a = state->meas.prev_current_a;
    chg_pin_v = state->meas.charger_pin_v;
    chg_v = state->meas.charger_voltage_v;

    ina_v_ok = state->meas.ina226_ok && isfinite(bus_v);
    ina_i_ok = state->meas.ina226_ok && isfinite(curr_a);
    vsense_ok = state->meas.vsense_ok;

    /* (7) FAULT_INA226_DISCONNECTED (0 ms -> Level 4/5) */
    if (!ina_v_ok || !ina_i_ok ||
        (bus_v < INA226_BUS_VALID_MIN_V) ||
        (bus_v > INA226_BUS_VALID_MAX_V)) {
        latch_mask |= FAULT_INA226_DISCONNECTED;
    }

    /* (5) FAULT_SHORT_CIRCUIT (0 ms -> Level 4/5) */
    if (ina_i_ok &&
        ((fabsf(curr_a) >= PROT_SHORT_CIRCUIT_A) ||
         (isfinite(prev_curr_a) && (fabsf(curr_a - prev_curr_a) >= PROT_DI_DT_MAX_A_PER_STEP)))) {
        latch_mask |= FAULT_SHORT_CIRCUIT;
    }

    /* (9) FAULT_RELAY_NO_RESPONSE (0 ms -> Level 4/5) */
    if (relay_ctrl_has_mismatch(state)) {
        latch_mask |= FAULT_RELAY_NO_RESPONSE;
    }

    /* Critical battery OV/UV (0 ms -> Level 4/5) */
    if (ina_v_ok) {
        if (bus_v >= PROT_BAT_OV_CRIT_V) {
            latch_mask |= FAULT_BAT_OVERVOLTAGE;
        }
        if (bus_v <= PROT_BAT_UV_CRIT_V) {
            latch_mask |= FAULT_BAT_UNDERVOLTAGE;
        }
    }

    /* (8) FAULT_VSENSE_FAULT (0 ms -> Level 3 branch) */
    if (!vsense_ok || !isfinite(chg_pin_v) || (chg_pin_v > ADC_PIN_MAX_SAFE_V)) {
        branch_mask |= FAULT_VSENSE_FAULT;
    }

    /* (1) & (2) Battery OV/UV warning and debounced Level 3 trip */
    if (ina_v_ok) {
        if (bus_v >= PROT_BAT_OV_WARN_V) {
            warn_mask |= FAULT_BAT_OVERVOLTAGE;
        }
        if (prot_update_debounce(&s_ov_ms, bus_v >= PROT_BAT_OV_TRIP_V, dt_ms)) {
            branch_mask |= FAULT_BAT_OVERVOLTAGE;
        }

        if (bus_v <= PROT_BAT_UV_WARN_V) {
            warn_mask |= FAULT_BAT_UNDERVOLTAGE;
        }
        if (prot_update_debounce(&s_uv_ms, bus_v <= PROT_BAT_UV_TRIP_V, dt_ms)) {
            branch_mask |= FAULT_BAT_UNDERVOLTAGE;
        }
    } else {
        s_ov_ms = 0U;
        s_uv_ms = 0U;
    }

    /* (3) & (4) Charge/Discharge OC warning and debounced Level 3 trip */
    if (ina_i_ok) {
        if (curr_a >= PROT_CHG_OC_WARN_A) {
            warn_mask |= FAULT_CHG_OVERCURRENT;
        }
        if (prot_update_debounce(&s_chg_oc_ms, curr_a >= PROT_CHG_OC_TRIP_A, dt_ms)) {
            branch_mask |= FAULT_CHG_OVERCURRENT;
        }

        if (curr_a <= -PROT_DIS_OC_WARN_A) {
            warn_mask |= FAULT_DIS_OVERCURRENT;
        }
        if (prot_update_debounce(&s_dis_oc_ms, curr_a <= -PROT_DIS_OC_TRIP_A, dt_ms)) {
            branch_mask |= FAULT_DIS_OVERCURRENT;
        }
    } else {
        s_chg_oc_ms = 0U;
        s_dis_oc_ms = 0U;
    }

    /* (6) Charger OV warning and debounced Level 3 trip */
    if (vsense_ok && state->meas.charger_present && isfinite(chg_v)) {
        if (chg_v >= PROT_CHARGER_OV_WARN_V) {
            warn_mask |= FAULT_CHARGER_OVERVOLTAGE;
        }
        if (prot_update_debounce(&s_charger_ov_ms, chg_v >= PROT_CHARGER_OV_TRIP_V, dt_ms)) {
            branch_mask |= FAULT_CHARGER_OVERVOLTAGE;
        }
    } else {
        s_charger_ov_ms = 0U;
    }

    /* Level 3 branch hold mask with anti-chattering release rules */
    s_branch_fault_hold_mask |= branch_mask;

    if (ina_v_ok && (bus_v < PROT_BAT_OV_WARN_V)) {
        s_branch_fault_hold_mask &= ~FAULT_BAT_OVERVOLTAGE;
    }
    if (ina_v_ok && (bus_v > PROT_BAT_UV_WARN_V)) {
        s_branch_fault_hold_mask &= ~FAULT_BAT_UNDERVOLTAGE;
    }
    if (vsense_ok && ((!state->meas.charger_present) || (isfinite(chg_v) && (chg_v < PROT_CHARGER_OV_WARN_V)))) {
        s_branch_fault_hold_mask &= ~FAULT_CHARGER_OVERVOLTAGE;
    }
    if (vsense_ok && isfinite(chg_pin_v) && (chg_pin_v <= ADC_PIN_MAX_SAFE_V)) {
        s_branch_fault_hold_mask &= ~FAULT_VSENSE_FAULT;
    }
    if ((!state->charge_enabled_req || !state->meas.charger_present) &&
        ina_i_ok && (curr_a < PROT_CHG_OC_WARN_A)) {
        s_branch_fault_hold_mask &= ~FAULT_CHG_OVERCURRENT;
    }
    if (!state->load_enabled_req && ina_i_ok && (curr_a > -PROT_DIS_OC_WARN_A)) {
        s_branch_fault_hold_mask &= ~FAULT_DIS_OVERCURRENT;
    }

    effective_branch = branch_mask | s_branch_fault_hold_mask;
    state->warning_flags = warn_mask;

    if ((latch_mask != 0U) || state->fault_latched) {
        all_faults = latch_mask | effective_branch | state->snapshot.latched_fault_mask;
        if (!state->fault_latched) {
            state->prot_level = PROT_LEVEL_4_ISOLATE;
            state->mode = BMS_MODE_FAULT;
            state->active_faults = all_faults;
            (void)relay_ctrl_apply_protection(state);
        }
        state->fault_latched = true;
        state->prot_level = PROT_LEVEL_5_LATCH;
        state->mode = BMS_MODE_FAULT;
        state->active_faults = all_faults;
        prot_capture_snapshot(state, latch_mask | effective_branch);
        (void)relay_ctrl_apply_protection(state);
    } else if (effective_branch != 0U) {
        state->active_faults = effective_branch;
        state->prot_level = PROT_LEVEL_3_BRANCH;
        state->mode = BMS_MODE_FAULT;
        (void)relay_ctrl_apply_protection(state);
    } else if (warn_mask != 0U) {
        state->active_faults = 0U;
        state->prot_level = PROT_LEVEL_2_WARNING;
    } else {
        state->active_faults = 0U;
        state->prot_level = PROT_LEVEL_1_NORMAL;
    }

    return true;
}
