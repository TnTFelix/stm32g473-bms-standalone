import {
    BMS_FULL_V,
    CHARGE_CURRENT_MIN_A,
    CHARGE_DONE_CURRENT_A,
    CHARGE_DONE_VOLTAGE_V,
    CHARGE_CONFIRM_TIMEOUT_MS,
    CHARGE_REENABLE_HYST_V,
    CHARGER_VALID_MAX_V,
    CHARGER_VALID_MIN_V,
    DISCHARGE_CONFIRM_TIMEOUT_MS,
    DISCHARGE_CURRENT_MIN_A,
    ESTIMATOR_MAX_DT_MS,
    INA226_BUS_VALID_MAX_V,
    INA226_BUS_VALID_MIN_V,
    PROT_BAT_OV_TRIP_V,
    PROT_BAT_UV_TRIP_V,
    STARTUP_PRECHARGE_MS
} from '../bms_config.mjs';

import {
    BMS_MODE_CHARGE,
    BMS_MODE_CHARGE_CONFIRM,
    BMS_MODE_DISCHARGE,
    BMS_MODE_DISCHARGE_CONFIRM,
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
    PROT_LEVEL_2_WARNING,
    PROT_LEVEL_3_BRANCH,
    PROT_LEVEL_4_ISOLATE,
    RELAY_1_MAIN,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    RELAY_COUNT,
    WARN_NO_CHARGE_CURRENT,
    WARN_NO_LOAD_CURRENT
} from '../bms_types.mjs';

import {
    hal_relay_open_all,
    hal_relay_read_cmd,
    hal_relay_read_feedback,
    hal_relay_write
} from '../hal_mock.mjs';

let s_startup_complete = false;
let s_precharge_accum_ms = 0;
let s_charge_done_latched = false;
let s_charge_confirm_ms = 0;
let s_discharge_confirm_ms = 0;
let s_charge_confirm_failed = false;
let s_discharge_confirm_failed = false;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function smSyncRelays(state) {
    for (let i = 0; i < RELAY_COUNT; i++) {
        state.relays.cmd[i] = hal_relay_read_cmd(i);
        state.relays.feedback[i] = hal_relay_read_feedback(i);
        state.relays.fault_mismatch[i] = (state.relays.cmd[i] !== state.relays.feedback[i]);
    }
}

function smSetRelay(id, closed) {
    if (hal_relay_read_cmd(id) !== closed) {
        if (!hal_relay_write(id, closed)) {
            return false;
        }
    }
    return hal_relay_read_cmd(id) === closed;
}

function smAnyRelayClosed() {
    for (let i = 0; i < RELAY_COUNT; i++) {
        if (hal_relay_read_cmd(i)) {
            return true;
        }
    }
    return false;
}

export function bms_state_machine_reset() {
    s_startup_complete = false;
    s_precharge_accum_ms = 0;
    s_charge_done_latched = false;
    s_charge_confirm_ms = 0;
    s_discharge_confirm_ms = 0;
    s_charge_confirm_failed = false;
    s_discharge_confirm_failed = false;
}

export function bms_state_machine_init(state) {
    if (!isPlainObject(state) || !isPlainObject(state.relays)) {
        return false;
    }

    bms_state_machine_reset();
    hal_relay_open_all();
    state.mode = BMS_MODE_STARTUP;
    smSyncRelays(state);
    return true;
}

export function bms_state_machine_is_charger_valid(meas) {
    if (!isPlainObject(meas)) {
        return false;
    }
    if (!meas.vsense_ok || !meas.charger_present ||
        typeof meas.charger_voltage_v !== 'number' || !Number.isFinite(meas.charger_voltage_v)) {
        return false;
    }
    return meas.charger_voltage_v >= CHARGER_VALID_MIN_V &&
        meas.charger_voltage_v <= CHARGER_VALID_MAX_V;
}

export function bms_state_machine_is_charge_complete(meas) {
    if (!isPlainObject(meas)) {
        return false;
    }
    if (!meas.ina226_ok ||
        typeof meas.bus_voltage_v !== 'number' || !Number.isFinite(meas.bus_voltage_v) ||
        typeof meas.current_a !== 'number' || !Number.isFinite(meas.current_a)) {
        return false;
    }
    return meas.bus_voltage_v >= CHARGE_DONE_VOLTAGE_V &&
        meas.current_a >= 0 &&
        meas.current_a <= CHARGE_DONE_CURRENT_A;
}

export function bms_state_machine_step(state, dt_ms) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) || !isPlainObject(state.relays)) {
        return false;
    }
    if (!Number.isInteger(dt_ms) || dt_ms < 0 || dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    const bus_v = state.meas.bus_voltage_v;
    const curr_a = state.meas.current_a;
    const meas_finite = typeof bus_v === 'number' && Number.isFinite(bus_v) &&
        typeof curr_a === 'number' && Number.isFinite(curr_a);
    const bus_in_valid_range = meas_finite &&
        bus_v >= INA226_BUS_VALID_MIN_V &&
        bus_v <= INA226_BUS_VALID_MAX_V;

    const isolate_fault = (!state.meas.ina226_ok) ||
        (!bus_in_valid_range) ||
        state.fault_latched ||
        (state.prot_level >= PROT_LEVEL_4_ISOLATE) ||
        ((state.active_faults & (FAULT_SHORT_CIRCUIT | FAULT_INA226_DISCONNECTED | FAULT_RELAY_NO_RESPONSE)) !== 0);

    const startup_fault = (!s_startup_complete) &&
        (isolate_fault ||
            (!state.meas.vsense_ok) ||
            (state.active_faults !== 0) ||
            (state.prot_level >= PROT_LEVEL_3_BRANCH) ||
            (bus_v <= PROT_BAT_UV_TRIP_V) ||
            (bus_v >= PROT_BAT_OV_TRIP_V));

    const chg_branch_fault = (!state.meas.vsense_ok) ||
        ((state.active_faults & (FAULT_BAT_OVERVOLTAGE | FAULT_CHG_OVERCURRENT | FAULT_CHARGER_OVERVOLTAGE | FAULT_VSENSE_FAULT)) !== 0);

    const load_branch_fault = ((state.active_faults & (FAULT_BAT_UNDERVOLTAGE | FAULT_DIS_OVERCURRENT)) !== 0);

    const branch_fault = s_startup_complete &&
        (chg_branch_fault ||
            load_branch_fault ||
            (state.prot_level === PROT_LEVEL_3_BRANCH) ||
            (state.active_faults !== 0));

    if (isolate_fault || startup_fault) {
        state.mode = BMS_MODE_FAULT;
        s_startup_complete = false;
        s_precharge_accum_ms = 0;
        s_charge_confirm_ms = 0;
        s_discharge_confirm_ms = 0;
        if (smAnyRelayClosed()) {
            hal_relay_open_all();
        }
        smSyncRelays(state);
        return true;
    }

    if (branch_fault) {
        state.mode = BMS_MODE_FAULT;
        s_charge_confirm_ms = 0;
        s_discharge_confirm_ms = 0;
        if (chg_branch_fault) {
            smSetRelay(RELAY_2_CHARGE, false);
        }
        if (load_branch_fault) {
            smSetRelay(RELAY_3_LOAD, false);
        }
        if (!chg_branch_fault && !load_branch_fault) {
            smSetRelay(RELAY_2_CHARGE, false);
            smSetRelay(RELAY_3_LOAD, false);
        }
        smSetRelay(RELAY_4_AUX, false);
        smSyncRelays(state);
        return true;
    }

    if (!s_startup_complete) {
        smSetRelay(RELAY_2_CHARGE, false);
        smSetRelay(RELAY_3_LOAD, false);
        state.mode = BMS_MODE_STARTUP;

        if (!smSetRelay(RELAY_4_AUX, true)) {
            state.mode = BMS_MODE_FAULT;
            s_startup_complete = false;
            s_precharge_accum_ms = 0;
            hal_relay_open_all();
            smSyncRelays(state);
            return true;
        }

        s_precharge_accum_ms += dt_ms;
        if (s_precharge_accum_ms < STARTUP_PRECHARGE_MS) {
            smSyncRelays(state);
            return true;
        }

        if (!smSetRelay(RELAY_1_MAIN, true)) {
            state.mode = BMS_MODE_FAULT;
            s_startup_complete = false;
            s_precharge_accum_ms = 0;
            hal_relay_open_all();
            smSyncRelays(state);
            return true;
        }

        smSetRelay(RELAY_4_AUX, false);
        s_startup_complete = true;
    }

    smSetRelay(RELAY_4_AUX, false);
    if (!hal_relay_read_cmd(RELAY_1_MAIN)) {
        s_startup_complete = false;
        s_precharge_accum_ms = 0;
        state.mode = BMS_MODE_STARTUP;
        smSyncRelays(state);
        return true;
    }

    if ((!state.meas.charger_present) ||
        (!state.charge_enabled_req) ||
        (bus_v <= (BMS_FULL_V - CHARGE_REENABLE_HYST_V))) {
        s_charge_done_latched = false;
    }
    if (hal_relay_read_cmd(RELAY_2_CHARGE) && bms_state_machine_is_charge_complete(state.meas)) {
        s_charge_done_latched = true;
    }

    if ((!state.charge_enabled_req) || (!state.meas.charger_present)) {
        s_charge_confirm_failed = false;
        s_charge_confirm_ms = 0;
        state.warning_flags &= ~WARN_NO_CHARGE_CURRENT;
    }
    if (!state.load_enabled_req) {
        s_discharge_confirm_failed = false;
        s_discharge_confirm_ms = 0;
        state.warning_flags &= ~WARN_NO_LOAD_CURRENT;
    }

    if (s_charge_confirm_failed) {
        state.warning_flags |= WARN_NO_CHARGE_CURRENT;
        if (state.prot_level < PROT_LEVEL_2_WARNING) {
            state.prot_level = PROT_LEVEL_2_WARNING;
        }
    }
    if (s_discharge_confirm_failed) {
        state.warning_flags |= WARN_NO_LOAD_CURRENT;
        if (state.prot_level < PROT_LEVEL_2_WARNING) {
            state.prot_level = PROT_LEVEL_2_WARNING;
        }
    }

    const allow_charge = state.charge_enabled_req &&
        (!s_charge_done_latched) &&
        (!s_charge_confirm_failed) &&
        bms_state_machine_is_charger_valid(state.meas) &&
        (bus_v < BMS_FULL_V);
    smSetRelay(RELAY_2_CHARGE, allow_charge);

    const allow_load = state.load_enabled_req &&
        (!s_discharge_confirm_failed) &&
        (bus_v > PROT_BAT_UV_TRIP_V);
    smSetRelay(RELAY_3_LOAD, allow_load);

    const r1 = hal_relay_read_cmd(RELAY_1_MAIN);
    const r2 = hal_relay_read_cmd(RELAY_2_CHARGE);
    const r3 = hal_relay_read_cmd(RELAY_3_LOAD);
    if (r1 && r2 && (curr_a >= CHARGE_CURRENT_MIN_A)) {
        s_charge_confirm_ms = 0;
        s_discharge_confirm_ms = 0;
        state.mode = BMS_MODE_CHARGE;
    } else if (r1 && (curr_a <= -DISCHARGE_CURRENT_MIN_A)) {
        s_charge_confirm_ms = 0;
        s_discharge_confirm_ms = 0;
        state.mode = BMS_MODE_DISCHARGE;
    } else if (allow_charge && r1 && r2) {
        s_discharge_confirm_ms = 0;
        s_charge_confirm_ms += dt_ms;
        if (s_charge_confirm_ms >= CHARGE_CONFIRM_TIMEOUT_MS) {
            smSetRelay(RELAY_2_CHARGE, false);
            s_charge_confirm_failed = true;
            s_charge_confirm_ms = 0;
            state.warning_flags |= WARN_NO_CHARGE_CURRENT;
            if (state.prot_level < PROT_LEVEL_2_WARNING) {
                state.prot_level = PROT_LEVEL_2_WARNING;
            }
            state.mode = BMS_MODE_STANDBY;
        } else {
            state.mode = BMS_MODE_CHARGE_CONFIRM;
        }
    } else if (allow_load && r1 && r3) {
        s_charge_confirm_ms = 0;
        s_discharge_confirm_ms += dt_ms;
        if (s_discharge_confirm_ms >= DISCHARGE_CONFIRM_TIMEOUT_MS) {
            smSetRelay(RELAY_3_LOAD, false);
            s_discharge_confirm_failed = true;
            s_discharge_confirm_ms = 0;
            state.warning_flags |= WARN_NO_LOAD_CURRENT;
            if (state.prot_level < PROT_LEVEL_2_WARNING) {
                state.prot_level = PROT_LEVEL_2_WARNING;
            }
            state.mode = BMS_MODE_STANDBY;
        } else {
            state.mode = BMS_MODE_DISCHARGE_CONFIRM;
        }
    } else {
        s_charge_confirm_ms = 0;
        s_discharge_confirm_ms = 0;
        state.mode = BMS_MODE_STANDBY;
    }

    smSyncRelays(state);
    return true;
}
