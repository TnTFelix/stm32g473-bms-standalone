#include "bms_state_machine.h"
#include "hal_interface.h"
#include <math.h>
#include <stddef.h>

static bool s_startup_complete = false;
static uint32_t s_precharge_accum_ms = 0U;
static bool s_charge_done_latched = false;

static void sm_sync_relays(bms_system_state_t *state)
{
    uint32_t i;

    if (state == NULL) {
        return;
    }

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        bms_relay_id_t id = (bms_relay_id_t)i;
        state->relays.cmd[i] = hal_relay_read_cmd(id);
        state->relays.feedback[i] = hal_relay_read_feedback(id);
        state->relays.fault_mismatch[i] = (state->relays.cmd[i] != state->relays.feedback[i]);
    }
}

static bool sm_set_relay(bms_relay_id_t id, bool closed)
{
    if (hal_relay_read_cmd(id) != closed) {
        if (!hal_relay_write(id, closed)) {
            return false;
        }
    }
    return (hal_relay_read_cmd(id) == closed);
}

static bool sm_any_relay_closed(void)
{
    uint32_t i;

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        if (hal_relay_read_cmd((bms_relay_id_t)i)) {
            return true;
        }
    }
    return false;
}

void bms_state_machine_reset(void)
{
    s_startup_complete = false;
    s_precharge_accum_ms = 0U;
    s_charge_done_latched = false;
}

bool bms_state_machine_init(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }

    bms_state_machine_reset();
    hal_relay_open_all();
    state->mode = BMS_MODE_STARTUP;
    sm_sync_relays(state);
    return true;
}

bool bms_state_machine_is_charger_valid(const bms_measurements_t *meas)
{
    if (meas == NULL) {
        return false;
    }
    if (!meas->vsense_ok || !meas->charger_present || !isfinite(meas->charger_voltage_v)) {
        return false;
    }
    return (meas->charger_voltage_v >= CHARGER_VALID_MIN_V) &&
           (meas->charger_voltage_v <= CHARGER_VALID_MAX_V);
}

bool bms_state_machine_is_charge_complete(const bms_measurements_t *meas)
{
    if (meas == NULL) {
        return false;
    }
    if (!meas->ina226_ok || !isfinite(meas->bus_voltage_v) || !isfinite(meas->current_a)) {
        return false;
    }
    return (meas->bus_voltage_v >= CHARGE_DONE_VOLTAGE_V) &&
           (meas->current_a >= 0.0f) &&
           (meas->current_a <= CHARGE_DONE_CURRENT_A);
}

bool bms_state_machine_step(bms_system_state_t *state, uint32_t dt_ms)
{
    float bus_v;
    float curr_a;
    bool meas_finite;
    bool bus_in_valid_range;
    bool isolate_fault;
    bool startup_fault;
    bool chg_branch_fault;
    bool load_branch_fault;
    bool branch_fault;
    bool allow_charge;
    bool allow_load;
    bool r1;
    bool r2;

    if (state == NULL) {
        return false;
    }
    if (dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    bus_v = state->meas.bus_voltage_v;
    curr_a = state->meas.current_a;
    meas_finite = isfinite(bus_v) && isfinite(curr_a);
    bus_in_valid_range = meas_finite &&
                         (bus_v >= INA226_BUS_VALID_MIN_V) &&
                         (bus_v <= INA226_BUS_VALID_MAX_V);

    isolate_fault = (!state->meas.ina226_ok) ||
                    (!bus_in_valid_range) ||
                    state->fault_latched ||
                    (state->prot_level >= PROT_LEVEL_4_ISOLATE) ||
                    ((state->active_faults & (FAULT_SHORT_CIRCUIT | FAULT_INA226_DISCONNECTED | FAULT_RELAY_NO_RESPONSE)) != 0U);

    startup_fault = (!s_startup_complete) &&
                    (isolate_fault ||
                     (!state->meas.vsense_ok) ||
                     (state->active_faults != 0U) ||
                     (state->prot_level >= PROT_LEVEL_3_BRANCH) ||
                     (bus_v <= PROT_BAT_UV_TRIP_V) ||
                     (bus_v >= PROT_BAT_OV_TRIP_V));

    chg_branch_fault = (!state->meas.vsense_ok) ||
                       ((state->active_faults & (FAULT_BAT_OVERVOLTAGE | FAULT_CHG_OVERCURRENT | FAULT_CHARGER_OVERVOLTAGE | FAULT_VSENSE_FAULT)) != 0U);

    load_branch_fault = ((state->active_faults & (FAULT_BAT_UNDERVOLTAGE | FAULT_DIS_OVERCURRENT)) != 0U);

    branch_fault = s_startup_complete &&
                   (chg_branch_fault ||
                    load_branch_fault ||
                    (state->prot_level == PROT_LEVEL_3_BRANCH) ||
                    (state->active_faults != 0U));

    /* Priority 1: System isolation or startup failure */
    if (isolate_fault || startup_fault) {
        state->mode = BMS_MODE_FAULT;
        s_startup_complete = false;
        s_precharge_accum_ms = 0U;
        if (sm_any_relay_closed()) {
            hal_relay_open_all();
        }
        sm_sync_relays(state);
        return true;
    }

    /* Priority 2: Post-startup branch-level fault */
    if (branch_fault) {
        state->mode = BMS_MODE_FAULT;
        if (chg_branch_fault) {
            (void)sm_set_relay(RELAY_2_CHARGE, false);
        }
        if (load_branch_fault) {
            (void)sm_set_relay(RELAY_3_LOAD, false);
        }
        if (!chg_branch_fault && !load_branch_fault) {
            (void)sm_set_relay(RELAY_2_CHARGE, false);
            (void)sm_set_relay(RELAY_3_LOAD, false);
        }
        (void)sm_set_relay(RELAY_4_AUX, false);
        sm_sync_relays(state);
        return true;
    }

    /* Priority 3: Startup pre-charge make-before-break sequence */
    if (!s_startup_complete) {
        (void)sm_set_relay(RELAY_2_CHARGE, false);
        (void)sm_set_relay(RELAY_3_LOAD, false);
        state->mode = BMS_MODE_STARTUP;

        if (!sm_set_relay(RELAY_4_AUX, true)) {
            state->mode = BMS_MODE_FAULT;
            s_startup_complete = false;
            s_precharge_accum_ms = 0U;
            hal_relay_open_all();
            sm_sync_relays(state);
            return true;
        }

        s_precharge_accum_ms += dt_ms;
        if (s_precharge_accum_ms < STARTUP_PRECHARGE_MS) {
            sm_sync_relays(state);
            return true;
        }

        if (!sm_set_relay(RELAY_1_MAIN, true)) {
            state->mode = BMS_MODE_FAULT;
            s_startup_complete = false;
            s_precharge_accum_ms = 0U;
            hal_relay_open_all();
            sm_sync_relays(state);
            return true;
        }

        (void)sm_set_relay(RELAY_4_AUX, false);
        s_startup_complete = true;
    }

    /* Normal operation with RELAY_1_MAIN closed */
    (void)sm_set_relay(RELAY_4_AUX, false);
    if (!hal_relay_read_cmd(RELAY_1_MAIN)) {
        s_startup_complete = false;
        s_precharge_accum_ms = 0U;
        state->mode = BMS_MODE_STARTUP;
        sm_sync_relays(state);
        return true;
    }

    if ((!state->meas.charger_present) ||
        (!state->charge_enabled_req) ||
        (bus_v <= (BMS_FULL_V - CHARGE_REENABLE_HYST_V))) {
        s_charge_done_latched = false;
    }
    if (hal_relay_read_cmd(RELAY_2_CHARGE) && bms_state_machine_is_charge_complete(&state->meas)) {
        s_charge_done_latched = true;
    }

    allow_charge = state->charge_enabled_req &&
                   (!s_charge_done_latched) &&
                   bms_state_machine_is_charger_valid(&state->meas) &&
                   (bus_v < BMS_FULL_V);
    (void)sm_set_relay(RELAY_2_CHARGE, allow_charge);

    allow_load = state->load_enabled_req && (bus_v > PROT_BAT_UV_TRIP_V);
    (void)sm_set_relay(RELAY_3_LOAD, allow_load);

    r1 = hal_relay_read_cmd(RELAY_1_MAIN);
    r2 = hal_relay_read_cmd(RELAY_2_CHARGE);
    if (r1 && r2 && (curr_a >= CHARGE_CURRENT_MIN_A)) {
        state->mode = BMS_MODE_CHARGE;
    } else if (r1 && (curr_a <= -DISCHARGE_CURRENT_MIN_A)) {
        state->mode = BMS_MODE_DISCHARGE;
    } else {
        state->mode = BMS_MODE_STANDBY;
    }

    sm_sync_relays(state);
    return true;
}
