#include "relay_ctrl.h"
#include "hal_interface.h"
#include <stddef.h>

#define RC_ISOLATE_MASK     (FAULT_SHORT_CIRCUIT | FAULT_INA226_DISCONNECTED | FAULT_RELAY_NO_RESPONSE)
#define RC_CHG_BRANCH_MASK  (FAULT_BAT_OVERVOLTAGE | FAULT_CHG_OVERCURRENT | FAULT_CHARGER_OVERVOLTAGE | FAULT_VSENSE_FAULT)
#define RC_LOAD_BRANCH_MASK (FAULT_BAT_UNDERVOLTAGE | FAULT_DIS_OVERCURRENT)

bool relay_ctrl_init(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }

    hal_relay_open_all();
    return relay_ctrl_sync(state);
}

bool relay_ctrl_sync(bms_system_state_t *state)
{
    uint32_t i;

    if (state == NULL) {
        return false;
    }

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        bms_relay_id_t id = (bms_relay_id_t)i;
        state->relays.cmd[i] = hal_relay_read_cmd(id);
        state->relays.feedback[i] = hal_relay_read_feedback(id);
        state->relays.fault_mismatch[i] = (state->relays.cmd[i] != state->relays.feedback[i]);
    }

    return true;
}

bool relay_ctrl_has_mismatch(const bms_system_state_t *state)
{
    uint32_t i;

    if (state == NULL) {
        return false;
    }

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        bms_relay_id_t id = (bms_relay_id_t)i;
        bool cmd = hal_relay_read_cmd(id);
        bool fb = hal_relay_read_feedback(id);
        if ((cmd != fb) || state->relays.fault_mismatch[i]) {
            return true;
        }
    }

    return false;
}

bool relay_ctrl_set(bms_system_state_t *state, bms_relay_id_t relay_id, bool closed)
{
    bool ok;
    bool blocked = false;

    if (state == NULL) {
        return false;
    }
    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }

    if (closed) {
        if (state->fault_latched ||
            (state->prot_level >= PROT_LEVEL_4_ISOLATE) ||
            ((state->active_faults & RC_ISOLATE_MASK) != 0U)) {
            blocked = true;
        } else if (relay_id == RELAY_2_CHARGE) {
            if ((!state->meas.vsense_ok) ||
                ((state->active_faults & RC_CHG_BRANCH_MASK) != 0U) ||
                ((state->prot_level == PROT_LEVEL_3_BRANCH) && (state->active_faults == 0U))) {
                blocked = true;
            }
        } else if (relay_id == RELAY_3_LOAD) {
            if (((state->active_faults & RC_LOAD_BRANCH_MASK) != 0U) ||
                ((state->prot_level == PROT_LEVEL_3_BRANCH) && (state->active_faults == 0U))) {
                blocked = true;
            }
        }

        if (blocked) {
            (void)relay_ctrl_sync(state);
            return false;
        }
    }

    ok = hal_relay_write(relay_id, closed);
    (void)relay_ctrl_sync(state);
    return ok;
}

bool relay_ctrl_isolate_all(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }

    hal_relay_open_all();
    return relay_ctrl_sync(state);
}

bool relay_ctrl_apply_protection(bms_system_state_t *state)
{
    uint32_t i;
    bool any_closed = false;
    bool chg_fault;
    bool load_fault;

    if (state == NULL) {
        return false;
    }

    if (state->fault_latched ||
        (state->prot_level >= PROT_LEVEL_4_ISOLATE) ||
        ((state->active_faults & RC_ISOLATE_MASK) != 0U)) {
        for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
            if (hal_relay_read_cmd((bms_relay_id_t)i)) {
                any_closed = true;
                break;
            }
        }
        if (any_closed) {
            return relay_ctrl_isolate_all(state);
        }
        return relay_ctrl_sync(state);
    }

    if ((state->prot_level == PROT_LEVEL_3_BRANCH) || (state->active_faults != 0U)) {
        chg_fault = (!state->meas.vsense_ok) || ((state->active_faults & RC_CHG_BRANCH_MASK) != 0U);
        load_fault = ((state->active_faults & RC_LOAD_BRANCH_MASK) != 0U);

        if (chg_fault) {
            if (hal_relay_read_cmd(RELAY_2_CHARGE)) {
                (void)hal_relay_write(RELAY_2_CHARGE, false);
            }
            if (hal_relay_read_cmd(RELAY_4_AUX)) {
                (void)hal_relay_write(RELAY_4_AUX, false);
            }
        }
        if (load_fault) {
            if (hal_relay_read_cmd(RELAY_3_LOAD)) {
                (void)hal_relay_write(RELAY_3_LOAD, false);
            }
            if (hal_relay_read_cmd(RELAY_4_AUX)) {
                (void)hal_relay_write(RELAY_4_AUX, false);
            }
        }
        if (!chg_fault && !load_fault) {
            if (hal_relay_read_cmd(RELAY_2_CHARGE)) {
                (void)hal_relay_write(RELAY_2_CHARGE, false);
            }
            if (hal_relay_read_cmd(RELAY_3_LOAD)) {
                (void)hal_relay_write(RELAY_3_LOAD, false);
            }
            if (hal_relay_read_cmd(RELAY_4_AUX)) {
                (void)hal_relay_write(RELAY_4_AUX, false);
            }
        }
        return relay_ctrl_sync(state);
    }

    return relay_ctrl_sync(state);
}
