import {
    FAULT_BAT_OVERVOLTAGE,
    FAULT_BAT_UNDERVOLTAGE,
    FAULT_CHARGER_OVERVOLTAGE,
    FAULT_CHG_OVERCURRENT,
    FAULT_DIS_OVERCURRENT,
    FAULT_INA226_DISCONNECTED,
    FAULT_RELAY_NO_RESPONSE,
    FAULT_SHORT_CIRCUIT,
    FAULT_VSENSE_FAULT,
    PROT_LEVEL_3_BRANCH,
    PROT_LEVEL_4_ISOLATE,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    RELAY_COUNT
} from '../bms_types.mjs';

import {
    hal_relay_open_all,
    hal_relay_read_cmd,
    hal_relay_read_feedback,
    hal_relay_write
} from '../hal_mock.mjs';

const RC_ISOLATE_MASK = FAULT_SHORT_CIRCUIT | FAULT_INA226_DISCONNECTED | FAULT_RELAY_NO_RESPONSE;
const RC_CHG_BRANCH_MASK = FAULT_BAT_OVERVOLTAGE | FAULT_CHG_OVERCURRENT | FAULT_CHARGER_OVERVOLTAGE | FAULT_VSENSE_FAULT;
const RC_LOAD_BRANCH_MASK = FAULT_BAT_UNDERVOLTAGE | FAULT_DIS_OVERCURRENT;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidState(state) {
    return isPlainObject(state) && isPlainObject(state.relays) && isPlainObject(state.meas);
}

export function relay_ctrl_init(state) {
    if (!isValidState(state)) {
        return false;
    }

    hal_relay_open_all();
    return relay_ctrl_sync(state);
}

export function relay_ctrl_sync(state) {
    if (!isPlainObject(state) || !isPlainObject(state.relays)) {
        return false;
    }

    for (let i = 0; i < RELAY_COUNT; i++) {
        state.relays.cmd[i] = hal_relay_read_cmd(i);
        state.relays.feedback[i] = hal_relay_read_feedback(i);
        state.relays.fault_mismatch[i] = (state.relays.cmd[i] !== state.relays.feedback[i]);
    }
    return true;
}

export function relay_ctrl_has_mismatch(state) {
    if (!isPlainObject(state) || !isPlainObject(state.relays)) {
        return false;
    }

    for (let i = 0; i < RELAY_COUNT; i++) {
        const cmd = hal_relay_read_cmd(i);
        const fb = hal_relay_read_feedback(i);
        if ((cmd !== fb) || Boolean(state.relays.fault_mismatch[i])) {
            return true;
        }
    }
    return false;
}

export function relay_ctrl_set(state, relay_id, closed) {
    if (!isValidState(state)) {
        return false;
    }
    if (!Number.isInteger(relay_id) || relay_id < 0 || relay_id >= RELAY_COUNT || typeof closed !== 'boolean') {
        return false;
    }

    if (closed) {
        let blocked = false;
        if (state.fault_latched ||
            (state.prot_level >= PROT_LEVEL_4_ISOLATE) ||
            ((state.active_faults & RC_ISOLATE_MASK) !== 0)) {
            blocked = true;
        } else if (relay_id === RELAY_2_CHARGE) {
            if ((!state.meas.vsense_ok) ||
                ((state.active_faults & RC_CHG_BRANCH_MASK) !== 0) ||
                ((state.prot_level === PROT_LEVEL_3_BRANCH) && (state.active_faults === 0))) {
                blocked = true;
            }
        } else if (relay_id === RELAY_3_LOAD) {
            if (((state.active_faults & RC_LOAD_BRANCH_MASK) !== 0) ||
                ((state.prot_level === PROT_LEVEL_3_BRANCH) && (state.active_faults === 0))) {
                blocked = true;
            }
        }

        if (blocked) {
            relay_ctrl_sync(state);
            return false;
        }
    }

    const ok = hal_relay_write(relay_id, closed);
    relay_ctrl_sync(state);
    return ok;
}

export function relay_ctrl_isolate_all(state) {
    if (!isPlainObject(state) || !isPlainObject(state.relays)) {
        return false;
    }

    hal_relay_open_all();
    return relay_ctrl_sync(state);
}

export function relay_ctrl_apply_protection(state) {
    if (!isValidState(state)) {
        return false;
    }

    if (state.fault_latched ||
        (state.prot_level >= PROT_LEVEL_4_ISOLATE) ||
        ((state.active_faults & RC_ISOLATE_MASK) !== 0)) {
        let any_closed = false;
        for (let i = 0; i < RELAY_COUNT; i++) {
            if (hal_relay_read_cmd(i)) {
                any_closed = true;
                break;
            }
        }
        if (any_closed) {
            return relay_ctrl_isolate_all(state);
        }
        return relay_ctrl_sync(state);
    }

    if ((state.prot_level === PROT_LEVEL_3_BRANCH) || (state.active_faults !== 0)) {
        const chg_fault = (!state.meas.vsense_ok) || ((state.active_faults & RC_CHG_BRANCH_MASK) !== 0);
        const load_fault = ((state.active_faults & RC_LOAD_BRANCH_MASK) !== 0);

        if (chg_fault) {
            if (hal_relay_read_cmd(RELAY_2_CHARGE)) {
                hal_relay_write(RELAY_2_CHARGE, false);
            }
            if (hal_relay_read_cmd(RELAY_4_AUX)) {
                hal_relay_write(RELAY_4_AUX, false);
            }
        }
        if (load_fault) {
            if (hal_relay_read_cmd(RELAY_3_LOAD)) {
                hal_relay_write(RELAY_3_LOAD, false);
            }
            if (hal_relay_read_cmd(RELAY_4_AUX)) {
                hal_relay_write(RELAY_4_AUX, false);
            }
        }
        if (!chg_fault && !load_fault) {
            if (hal_relay_read_cmd(RELAY_2_CHARGE)) {
                hal_relay_write(RELAY_2_CHARGE, false);
            }
            if (hal_relay_read_cmd(RELAY_3_LOAD)) {
                hal_relay_write(RELAY_3_LOAD, false);
            }
            if (hal_relay_read_cmd(RELAY_4_AUX)) {
                hal_relay_write(RELAY_4_AUX, false);
            }
        }
        return relay_ctrl_sync(state);
    }

    return relay_ctrl_sync(state);
}
