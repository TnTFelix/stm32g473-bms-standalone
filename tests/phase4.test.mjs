import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    ESTIMATOR_MAX_DT_MS,
    INA226_REG_BUS_V,
    INA226_REG_SHUNT_V
} from '../sim/bms_config.mjs';

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
    RELAY_1_MAIN,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    RELAY_COUNT,
    createDefaultSystemState
} from '../sim/bms_types.mjs';

import {
    hal_init,
    hal_mock_clear_relay_log,
    hal_mock_get_relay_event,
    hal_mock_get_relay_log_count,
    hal_mock_reset,
    hal_mock_set_ina226_register,
    hal_mock_set_relay_feedback_override,
    hal_mock_set_tick_ms,
    hal_relay_read_cmd
} from '../sim/hal_mock.mjs';

import {
    ina226_encode_bus_voltage_reg,
    ina226_encode_shunt_current_reg,
    ina226_init,
    ina226_read
} from '../sim/drivers/ina226.mjs';

import {
    relay_ctrl_apply_protection,
    relay_ctrl_has_mismatch,
    relay_ctrl_init,
    relay_ctrl_isolate_all,
    relay_ctrl_set,
    relay_ctrl_sync
} from '../sim/drivers/relay_ctrl.mjs';

import {
    bms_protection_init,
    bms_protection_is_recovery_safe,
    bms_protection_request_fault_clear,
    bms_protection_reset,
    bms_protection_step
} from '../sim/core/bms_protection.mjs';

function makeSafeState() {
    const state = createDefaultSystemState();
    assert.equal(bms_protection_init(state), true);
    state.mode = BMS_MODE_STANDBY;
    state.meas.ina226_ok = true;
    state.meas.bus_voltage_v = 14.8;
    state.meas.current_a = 0.0;
    state.meas.prev_current_a = 0.0;
    state.meas.power_w = 0.0;
    state.meas.vsense_ok = true;
    state.meas.charger_pin_v = 0.0;
    state.meas.charger_voltage_v = 0.0;
    state.meas.charger_present = false;
    return state;
}

describe('Suite 1: relay_ctrl Driver, Cross-Locks & Level 4 Isolation Sequence (P4-A1..A5)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_protection_reset();
    });

    test('P4-A1: Validate null/invalid state, relay_id bounds, and closed type', () => {
        assert.equal(relay_ctrl_init(null), false);
        assert.equal(relay_ctrl_sync(null), false);
        assert.equal(relay_ctrl_has_mismatch(null), false);
        assert.equal(relay_ctrl_isolate_all(null), false);
        assert.equal(relay_ctrl_apply_protection(null), false);

        const state = makeSafeState();
        assert.equal(relay_ctrl_set(null, RELAY_1_MAIN, true), false);
        for (const badId of [-1, 4, 1.5, '0', null]) {
            assert.equal(relay_ctrl_set(state, badId, true), false);
        }
        for (const badClosed of [1, 'true', null]) {
            assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, badClosed), false);
        }
    });

    test('P4-A2: Relay set/sync and welded contact mismatch detection', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_init(state), true);
        assert.equal(relay_ctrl_has_mismatch(state), false);

        for (let r = 0; r < RELAY_COUNT; r++) {
            assert.equal(relay_ctrl_set(state, r, true), true);
            assert.equal(state.relays.cmd[r], true);
            assert.equal(state.relays.feedback[r], true);
            assert.equal(state.relays.fault_mismatch[r], false);
        }

        assert.equal(hal_mock_set_relay_feedback_override(RELAY_2_CHARGE, true, false), true);
        assert.equal(relay_ctrl_sync(state), true);
        assert.equal(relay_ctrl_has_mismatch(state), true);
        assert.equal(state.relays.fault_mismatch[RELAY_2_CHARGE], true);
    });

    test('P4-A3: Level 4 isolation executes R3 -> R2 -> R4 -> R1 order', () => {
        const state = makeSafeState();
        for (let r = 0; r < RELAY_COUNT; r++) {
            assert.equal(relay_ctrl_set(state, r, true), true);
        }
        hal_mock_clear_relay_log();

        assert.equal(relay_ctrl_isolate_all(state), true);
        for (let r = 0; r < RELAY_COUNT; r++) {
            assert.equal(hal_relay_read_cmd(r), false);
            assert.equal(state.relays.cmd[r], false);
        }

        assert.equal(hal_mock_get_relay_log_count(), 4);
        const order = [];
        for (let i = 0; i < 4; i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            assert.equal(ev.closed, false);
            order.push(ev.relay_id);
        }
        assert.deepEqual(order, [RELAY_3_LOAD, RELAY_2_CHARGE, RELAY_4_AUX, RELAY_1_MAIN]);
    });

    test('P4-A4: Cross-locking blocks unsafe relay closes while permitting opens', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);

        state.fault_latched = true;
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), false);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), false);
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, false), true);

        state.fault_latched = false;
        state.prot_level = PROT_LEVEL_4_ISOLATE;
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), false);

        state.prot_level = PROT_LEVEL_3_BRANCH;
        state.active_faults = FAULT_VSENSE_FAULT;
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), false);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), true);

        state.active_faults = FAULT_CHG_OVERCURRENT;
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), false);

        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, false), true);
        state.active_faults = FAULT_DIS_OVERCURRENT;
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), false);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);
    });

    test('P4-A5: relay_ctrl_apply_protection enforces Level 3 branch cutoff vs Level 4/5 isolation', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), true);

        state.prot_level = PROT_LEVEL_3_BRANCH;
        state.active_faults = FAULT_CHG_OVERCURRENT;
        assert.equal(relay_ctrl_apply_protection(state), true);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);

        state.active_faults = FAULT_DIS_OVERCURRENT;
        assert.equal(relay_ctrl_apply_protection(state), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);

        hal_mock_clear_relay_log();
        state.prot_level = PROT_LEVEL_4_ISOLATE;
        assert.equal(relay_ctrl_apply_protection(state), true);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
        const order = [];
        for (let i = 0; i < hal_mock_get_relay_log_count(); i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            order.push(ev.relay_id);
        }
        assert.deepEqual(order, [RELAY_3_LOAD, RELAY_2_CHARGE, RELAY_4_AUX, RELAY_1_MAIN]);
    });
});

describe('Suite 2: Levels 1-3 Protection, Debounce & Anti-Chattering (P4-B1..B7)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_protection_reset();
    });

    test('P4-B1: Normal operation and invalid input guards', () => {
        assert.equal(bms_protection_step(null, 10), false);
        const state = makeSafeState();
        state.meas.current_a = -2.0;
        state.meas.prev_current_a = -2.0;
        state.meas.charger_voltage_v = 16.0;
        state.meas.charger_pin_v = 16.0 / 6.0;
        state.meas.charger_present = true;

        assert.equal(bms_protection_step(state, ESTIMATOR_MAX_DT_MS + 1), false);
        assert.equal(bms_protection_step(state, -1), false);
        assert.equal(bms_protection_step(state, 1.5), false);

        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
        assert.equal(state.active_faults, 0);
        assert.equal(state.warning_flags, 0);
    });

    test('P4-B2: Level 2 warnings across all 5 thresholds and <30 ms glitch debounce', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), true);

        state.meas.bus_voltage_v = 16.65;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_2_WARNING);
        assert.equal(state.warning_flags, FAULT_BAT_OVERVOLTAGE);

        state.meas.bus_voltage_v = 12.6;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.warning_flags, FAULT_BAT_UNDERVOLTAGE);

        state.meas.bus_voltage_v = 14.8;
        state.meas.current_a = 4.5;
        state.meas.prev_current_a = 4.5;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.warning_flags, FAULT_CHG_OVERCURRENT);

        state.meas.current_a = -13.5;
        state.meas.prev_current_a = -13.5;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.warning_flags, FAULT_DIS_OVERCURRENT);

        state.meas.current_a = 0.0;
        state.meas.prev_current_a = 0.0;
        state.meas.charger_present = true;
        state.meas.charger_voltage_v = 17.2;
        state.meas.charger_pin_v = 17.2 / 6.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.warning_flags, FAULT_CHARGER_OVERVOLTAGE);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);

        /* 20 ms transient OV spike (< 30 ms) must not trip Level 3 */
        state.meas.charger_present = false;
        state.meas.charger_voltage_v = 0;
        state.meas.charger_pin_v = 0;
        state.meas.bus_voltage_v = 16.87;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_2_WARNING);
        assert.equal(state.active_faults, 0);

        state.meas.bus_voltage_v = 15.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
    });

    test('P4-B3: Battery OV and UV Level 3 trips at 30 ms with warning-threshold hysteresis', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), true);

        state.meas.bus_voltage_v = 16.87;
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_protection_step(state, 10), true);
        }
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.notEqual(state.active_faults & FAULT_BAT_OVERVOLTAGE, 0);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);

        state.meas.bus_voltage_v = 16.8;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);

        state.meas.bus_voltage_v = 16.5;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);

        state.meas.bus_voltage_v = 11.9;
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_protection_step(state, 10), true);
        }
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.notEqual(state.active_faults & FAULT_BAT_UNDERVOLTAGE, 0);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);

        state.meas.bus_voltage_v = 12.2;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);

        state.meas.bus_voltage_v = 12.8;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
    });

    test('P4-B4: Charge overcurrent holds branch lock at 0 A until charge request/charger removed', () => {
        const state = makeSafeState();
        state.charge_enabled_req = true;
        state.meas.charger_present = true;
        state.meas.charger_voltage_v = 16.0;
        state.meas.charger_pin_v = 16.0 / 6.0;
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);

        state.meas.current_a = 5.2;
        state.meas.prev_current_a = 5.2;
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_protection_step(state, 10), true);
        }
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.notEqual(state.active_faults & FAULT_CHG_OVERCURRENT, 0);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);

        /* Current drops to 0 A after R2 opens -> hold must prevent chattering */
        state.meas.current_a = 0.0;
        state.meas.prev_current_a = 0.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.notEqual(state.active_faults & FAULT_CHG_OVERCURRENT, 0);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), false);

        state.charge_enabled_req = false;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
    });

    test('P4-B5: Discharge overcurrent holds branch lock at 0 A until load_enabled_req cleared', () => {
        const state = makeSafeState();
        state.load_enabled_req = true;
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), true);

        state.meas.current_a = -15.5;
        state.meas.prev_current_a = -15.5;
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_protection_step(state, 10), true);
        }
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.notEqual(state.active_faults & FAULT_DIS_OVERCURRENT, 0);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);

        state.meas.current_a = 0.0;
        state.meas.prev_current_a = 0.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), false);

        state.load_enabled_req = false;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
    });

    test('P4-B6: Charger overvoltage trips Level 3 at 30 ms and releases below 17.2 V', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), true);

        state.meas.charger_present = true;
        state.meas.charger_voltage_v = 17.6;
        state.meas.charger_pin_v = 17.6 / 6.0;
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_protection_step(state, 10), true);
        }
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.notEqual(state.active_faults & FAULT_CHARGER_OVERVOLTAGE, 0);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);

        state.meas.charger_voltage_v = 17.3;
        state.meas.charger_pin_v = 17.3 / 6.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);

        state.meas.charger_voltage_v = 16.8;
        state.meas.charger_pin_v = 16.8 / 6.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
    });

    test('P4-B7: FAULT_VSENSE_FAULT acts instantaneously (0 ms) on charge branch only', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);

        state.meas.charger_pin_v = 3.28;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.notEqual(state.active_faults & FAULT_VSENSE_FAULT, 0);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);

        state.meas.vsense_ok = true;
        state.meas.charger_pin_v = 2.5;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
    });
});

describe('Suite 3: Levels 4-5 Instantaneous Trip, Isolation, Latch & Snapshot (P4-C1..C6)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_protection_reset();
    });

    test('P4-C1: FAULT_SHORT_CIRCUIT >= 25 A isolates all relays at 0 ms and captures snapshot', () => {
        const state = makeSafeState();
        for (let r = 0; r < RELAY_COUNT; r++) {
            assert.equal(relay_ctrl_set(state, r, true), true);
        }
        hal_mock_clear_relay_log();

        state.tick_ms = 420;
        state.meas.current_a = -25.5;
        state.meas.prev_current_a = -25.5;
        state.meas.power_w = 14.8 * -25.5;

        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_5_LATCH);
        assert.equal(state.fault_latched, true);
        assert.equal(state.mode, BMS_MODE_FAULT);
        assert.notEqual(state.active_faults & FAULT_SHORT_CIRCUIT, 0);
        assert.equal(state.snapshot.valid, true);
        assert.equal(state.snapshot.current_a, -25.5);
        assert.equal(state.snapshot.timestamp_ms, 420);

        const order = [];
        for (let i = 0; i < 4; i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            order.push(ev.relay_id);
        }
        assert.deepEqual(order, [RELAY_3_LOAD, RELAY_2_CHARGE, RELAY_4_AUX, RELAY_1_MAIN]);
    });

    test('P4-C2: FAULT_SHORT_CIRCUIT |dI/dt| >= 15 A/step triggers 0 ms from meas and ina226_read', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);

        state.meas.prev_current_a = -2.0;
        state.meas.current_a = -18.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_5_LATCH);
        assert.notEqual(state.active_faults & FAULT_SHORT_CIRCUIT, 0);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);

        /* Verify integration with ina226_read 0 -> -25 A surge preservation */
        hal_mock_reset();
        hal_init();
        bms_protection_reset();
        assert.equal(ina226_init(), true);
        const s2 = makeSafeState();
        assert.equal(relay_ctrl_set(s2, RELAY_1_MAIN, true), true);

        assert.equal(hal_mock_set_ina226_register(INA226_REG_BUS_V, ina226_encode_bus_voltage_reg(14.8)), true);
        assert.equal(hal_mock_set_ina226_register(INA226_REG_SHUNT_V, ina226_encode_shunt_current_reg(0.0)), true);
        assert.equal(ina226_read(s2.meas), true);

        assert.equal(hal_mock_set_ina226_register(INA226_REG_SHUNT_V, ina226_encode_shunt_current_reg(-25.0)), true);
        assert.equal(ina226_read(s2.meas), true);
        assert.equal(bms_protection_step(s2, 10), true);
        assert.equal(s2.prot_level, PROT_LEVEL_5_LATCH);
        assert.notEqual(s2.active_faults & FAULT_SHORT_CIRCUIT, 0);
    });

    test('P4-C3: FAULT_INA226_DISCONNECTED and NaN values sanitize snapshot floats', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        state.meas.ina226_ok = false;
        state.meas.bus_voltage_v = Number.NaN;
        state.meas.current_a = Infinity;
        state.meas.power_w = Number.NaN;

        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_5_LATCH);
        assert.notEqual(state.active_faults & FAULT_INA226_DISCONNECTED, 0);
        assert.equal(state.snapshot.valid, true);
        assert.equal(Number.isFinite(state.snapshot.bus_voltage_v), true);
        assert.equal(Number.isFinite(state.snapshot.current_a), true);
        assert.equal(Number.isFinite(state.snapshot.power_w), true);
        assert.equal(state.snapshot.bus_voltage_v, 0);
    });

    test('P4-C4: FAULT_RELAY_NO_RESPONSE isolates remaining relays on contact mismatch', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_2_CHARGE, true), true);
        assert.equal(relay_ctrl_set(state, RELAY_3_LOAD, true), true);

        assert.equal(hal_mock_set_relay_feedback_override(RELAY_2_CHARGE, true, false), true);
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.prot_level, PROT_LEVEL_5_LATCH);
        assert.notEqual(state.active_faults & FAULT_RELAY_NO_RESPONSE, 0);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);
        assert.equal(hal_relay_read_cmd(RELAY_4_AUX), false);
    });

    test('P4-C5: Critical battery OV (>=17.2 V) and UV (<=11.2 V) trip Level 5 at 0 ms', () => {
        const sOv = makeSafeState();
        assert.equal(relay_ctrl_set(sOv, RELAY_1_MAIN, true), true);
        sOv.meas.bus_voltage_v = 17.25;
        assert.equal(bms_protection_step(sOv, 10), true);
        assert.equal(sOv.prot_level, PROT_LEVEL_5_LATCH);
        assert.notEqual(sOv.active_faults & FAULT_BAT_OVERVOLTAGE, 0);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);

        hal_mock_reset();
        hal_init();
        bms_protection_reset();
        const sUv = makeSafeState();
        assert.equal(relay_ctrl_set(sUv, RELAY_1_MAIN, true), true);
        sUv.meas.bus_voltage_v = 11.1;
        assert.equal(bms_protection_step(sUv, 10), true);
        assert.equal(sUv.prot_level, PROT_LEVEL_5_LATCH);
        assert.notEqual(sUv.active_faults & FAULT_BAT_UNDERVOLTAGE, 0);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
    });

    test('P4-C6: First snapshot measurement fields and timestamp remain immutable across later faults', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);

        hal_mock_set_tick_ms(500);
        state.tick_ms = 500;
        state.meas.bus_voltage_v = 14.5;
        state.meas.current_a = -26.0;
        state.meas.prev_current_a = -26.0;
        assert.equal(bms_protection_step(state, 10), true);

        hal_mock_set_tick_ms(900);
        state.tick_ms = 900;
        state.meas.bus_voltage_v = 15.0;
        state.meas.current_a = 0.0;
        state.meas.prev_current_a = 0.0;
        state.meas.ina226_ok = false;
        assert.equal(bms_protection_step(state, 10), true);

        assert.equal(state.snapshot.bus_voltage_v, 14.5);
        assert.equal(state.snapshot.current_a, -26.0);
        assert.equal(state.snapshot.timestamp_ms, 500);
        assert.notEqual(state.snapshot.latched_fault_mask & FAULT_SHORT_CIRCUIT, 0);
        assert.notEqual(state.snapshot.latched_fault_mask & FAULT_INA226_DISCONNECTED, 0);
    });
});

describe('Suite 4: Manual Fault Recovery After Level 5 Latch (P4-D1..D4)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_protection_reset();
    });

    test('P4-D1: Level 5 latch never auto-clears even after measurements return to normal', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        state.meas.current_a = -26.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.fault_latched, true);

        state.meas.current_a = 0.0;
        state.meas.prev_current_a = 0.0;
        for (let k = 0; k < 10; k++) {
            assert.equal(bms_protection_step(state, 10), true);
        }
        assert.equal(state.fault_latched, true);
        assert.equal(state.prot_level, PROT_LEVEL_5_LATCH);
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), false);
    });

    test('P4-D2: Reject bms_protection_request_fault_clear when any safety check fails', () => {
        const state = makeSafeState();
        state.meas.current_a = -26.0;
        assert.equal(bms_protection_step(state, 10), true);
        state.meas.current_a = 0.0;
        state.meas.prev_current_a = 0.0;

        const unsafeMutations = [
            (s) => { s.meas.ina226_ok = false; },
            (s) => { s.meas.vsense_ok = false; },
            (s) => { s.meas.bus_voltage_v = 16.75; },
            (s) => { s.meas.bus_voltage_v = 12.5; },
            (s) => { s.meas.current_a = 4.6; s.meas.prev_current_a = 4.6; },
            (s) => { s.meas.current_a = -14.0; s.meas.prev_current_a = -14.0; },
            (s) => { s.meas.charger_present = true; s.meas.charger_voltage_v = 17.2; },
            (s) => { hal_mock_set_relay_feedback_override(RELAY_1_MAIN, true, true); }
        ];

        for (const mutate of unsafeMutations) {
            const testState = makeSafeState();
            testState.fault_latched = true;
            testState.prot_level = PROT_LEVEL_5_LATCH;
            testState.mode = BMS_MODE_FAULT;
            hal_mock_set_relay_feedback_override(RELAY_1_MAIN, false, false);
            mutate(testState);
            assert.equal(bms_protection_is_recovery_safe(testState), false);
            assert.equal(bms_protection_request_fault_clear(testState), false);
            assert.equal(testState.fault_latched, true);
        }
    });

    test('P4-D3: Manual fault clear resets latch, snapshot, and transitions to STARTUP when R1 open', () => {
        const state = makeSafeState();
        assert.equal(relay_ctrl_set(state, RELAY_1_MAIN, true), true);
        state.meas.current_a = -26.0;
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);

        state.meas.current_a = 0.0;
        state.meas.prev_current_a = 0.0;
        state.meas.charger_present = true;
        state.meas.charger_voltage_v = 16.0;
        state.meas.charger_pin_v = 16.0 / 6.0;

        assert.equal(bms_protection_request_fault_clear(state), true);
        assert.equal(state.fault_latched, false);
        assert.equal(state.active_faults, 0);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
        assert.equal(state.snapshot.valid, false);
        assert.equal(state.mode, BMS_MODE_STARTUP);
    });

    test('P4-D4: Null guard on fault clear and recovery after clearing stuck relay override', () => {
        assert.equal(bms_protection_request_fault_clear(null), false);

        const state = makeSafeState();
        assert.equal(hal_mock_set_relay_feedback_override(RELAY_2_CHARGE, true, true), true);
        assert.equal(bms_protection_step(state, 10), true);
        assert.equal(state.fault_latched, true);
        assert.equal(bms_protection_request_fault_clear(state), false);

        assert.equal(hal_mock_set_relay_feedback_override(RELAY_2_CHARGE, false, false), true);
        assert.equal(bms_protection_request_fault_clear(state), true);
        assert.equal(state.fault_latched, false);
        assert.equal(state.prot_level, PROT_LEVEL_1_NORMAL);
    });
});
