import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    CHARGE_CONFIRM_TIMEOUT_MS,
    DISCHARGE_CONFIRM_TIMEOUT_MS,
    ESTIMATOR_MAX_DT_MS,
    OCV_REST_QUALIFY_MS,
    STARTUP_PRECHARGE_MS
} from '../sim/bms_config.mjs';

import {
    BMS_MODE_CHARGE,
    BMS_MODE_CHARGE_CONFIRM,
    BMS_MODE_DISCHARGE,
    BMS_MODE_DISCHARGE_CONFIRM,
    BMS_MODE_FAULT,
    BMS_MODE_STANDBY,
    BMS_MODE_STARTUP,
    FAULT_VSENSE_FAULT,
    PROT_LEVEL_1_NORMAL,
    PROT_LEVEL_2_WARNING,
    PROT_LEVEL_3_BRANCH,
    PROT_LEVEL_4_ISOLATE,
    RELAY_1_MAIN,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    RELAY_COUNT,
    WARN_NO_CHARGE_CURRENT,
    WARN_NO_LOAD_CURRENT,
    createDefaultSystemState
} from '../sim/bms_types.mjs';

import {
    hal_init,
    hal_mock_clear_relay_log,
    hal_mock_get_relay_event,
    hal_mock_get_relay_log_count,
    hal_mock_reset,
    hal_mock_set_relay_feedback_override,
    hal_relay_read_cmd
} from '../sim/hal_mock.mjs';

import {
    bms_estimator_apply_rest_ocv_correction,
    bms_estimator_get_rest_time_ms,
    bms_estimator_init,
    bms_estimator_ocv_to_soc_pct,
    bms_estimator_step
} from '../sim/core/bms_estimator.mjs';

import {
    bms_state_machine_init,
    bms_state_machine_is_charge_complete,
    bms_state_machine_is_charger_valid,
    bms_state_machine_reset,
    bms_state_machine_step
} from '../sim/core/bms_state_machine.mjs';

function approx(actual, expected, eps = 1e-4, msg) {
    assert.ok(
        Math.abs(actual - expected) <= eps,
        msg ?? `Expected ${actual} to be within ${eps} of ${expected}`
    );
}

function makeHealthyMeas(state, bus_v = 14.8, current_a = 0, charger_v = 0) {
    state.meas.ina226_ok = true;
    state.meas.bus_voltage_v = bus_v;
    state.meas.current_a = current_a;
    state.meas.vsense_ok = true;
    state.meas.charger_voltage_v = charger_v;
    state.meas.charger_present = charger_v >= 5.0;
}

function runStartupPrecharge(state) {
    assert.equal(bms_state_machine_step(state, 10), true);
    assert.equal(bms_state_machine_step(state, 10), true);
    assert.equal(bms_state_machine_step(state, 10), true);
    assert.equal(state.mode, BMS_MODE_STANDBY);
    assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
    assert.equal(hal_relay_read_cmd(RELAY_4_AUX), false);
}

describe('Suite 1: Coulomb Counting SOC & Remaining Capacity (P3-A1..A4)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_state_machine_reset();
    });

    test('P3-A1: Discharge 10 A for 360 s reduces SOC from 80% to 70% (7.0 Ah)', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 14.4;
        state.meas.current_a = -10.0;

        for (let k = 0; k < 360; k++) {
            assert.equal(bms_estimator_step(state, 1000), true);
        }

        approx(state.energy.soc_pct, 70.0);
        approx(state.energy.remaining_capacity_ah, 7.0);
    });

    test('P3-A2: Charge +4 A for 900 s with 0.992 efficiency raises SOC from 50% to 59.92%', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.energy.soc_pct = 50.0;
        state.energy.remaining_capacity_ah = 5.0;
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 15.2;
        state.meas.current_a = 4.0;

        for (let k = 0; k < 900; k++) {
            assert.equal(bms_estimator_step(state, 1000), true);
        }

        approx(state.energy.soc_pct, 59.92);
        approx(state.energy.remaining_capacity_ah, 5.992);
    });

    test('P3-A3: SOC clamps cleanly at 100% upper bound and 0% lower bound', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.energy.soc_pct = 99.5;
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 16.5;
        state.meas.current_a = 10.0;

        for (let k = 0; k < 100; k++) {
            assert.equal(bms_estimator_step(state, 1000), true);
        }
        assert.equal(state.energy.soc_pct, 100.0);
        assert.equal(state.energy.remaining_capacity_ah, 10.0);

        state.energy.soc_pct = 0.5;
        state.meas.bus_voltage_v = 12.1;
        state.meas.current_a = -20.0;
        for (let k = 0; k < 100; k++) {
            assert.equal(bms_estimator_step(state, 1000), true);
        }
        assert.equal(state.energy.soc_pct, 0.0);
        assert.equal(state.energy.remaining_capacity_ah, 0.0);
    });

    test('P3-A4: Sensor error preserves SOC and clears rest timer and time estimates', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 14.8;
        state.meas.current_a = 0.01;
        assert.equal(bms_estimator_step(state, 1000), true);
        assert.equal(bms_estimator_get_rest_time_ms(), 1000);
        const socBeforeFault = state.energy.soc_pct;

        state.meas.ina226_ok = false;
        assert.equal(bms_estimator_step(state, 10), false);
        assert.equal(state.energy.soc_pct, socBeforeFault);
        assert.equal(bms_estimator_get_rest_time_ms(), 0);
        assert.equal(state.energy.remaining_time_min, 0);
        assert.equal(state.energy.estimated_charge_time_min, 0);
    });
});

describe('Suite 2: OCV Mapping & Rest SOC Correction (P3-B1..B5)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_state_machine_reset();
    });

    test('P3-B1: bms_estimator_ocv_to_soc_pct maps 4S NMC OCV-SOC curve 12.0..16.8 V and rejects non-finite', () => {
        approx(bms_estimator_ocv_to_soc_pct(12.0), 0);
        approx(bms_estimator_ocv_to_soc_pct(14.12), 20);
        approx(bms_estimator_ocv_to_soc_pct(14.96), 50);
        approx(bms_estimator_ocv_to_soc_pct(15.88), 80);
        approx(bms_estimator_ocv_to_soc_pct(16.8), 100);
        assert.equal(bms_estimator_ocv_to_soc_pct(11.0), 0);
        assert.equal(bms_estimator_ocv_to_soc_pct(17.5), 100);
        assert.equal(bms_estimator_ocv_to_soc_pct(Number.NaN), 0);
        assert.equal(bms_estimator_ocv_to_soc_pct(Infinity), 0);
        assert.equal(bms_estimator_ocv_to_soc_pct('x'), 0);
    });

    test('P3-B2: Rest OCV correction blends 10% OCV SOC into current SOC', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 14.96; /* 50% on 4S NMC OCV curve */
        state.meas.current_a = 0.02;

        assert.equal(bms_estimator_apply_rest_ocv_correction(state), true);
        approx(state.energy.soc_pct, 77.0);
        approx(state.energy.remaining_capacity_ah, 7.7);
    });

    test('P3-B3: Reject OCV correction on null, offline sensor, active current, or out-of-range voltage', () => {
        assert.equal(bms_estimator_apply_rest_ocv_correction(null), false);

        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = false;
        state.meas.bus_voltage_v = 14.4;
        state.meas.current_a = 0.0;
        assert.equal(bms_estimator_apply_rest_ocv_correction(state), false);

        state.meas.ina226_ok = true;
        state.meas.current_a = 0.05;
        assert.equal(bms_estimator_apply_rest_ocv_correction(state), false);

        state.meas.current_a = 0.01;
        for (const badV of [5.5, 22.5, Number.NaN]) {
            state.meas.bus_voltage_v = badV;
            assert.equal(bms_estimator_apply_rest_ocv_correction(state), false);
        }
    });

    test('P3-B4: Auto OCV correction triggers at 30 min (1800000 ms) continuous rest and resets accumulator', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 14.96; /* 50% on 4S NMC OCV curve */
        state.meas.current_a = 0.01;

        for (let k = 0; k < 2999; k++) {
            assert.equal(bms_estimator_step(state, 600), true);
        }
        assert.equal(bms_estimator_get_rest_time_ms(), OCV_REST_QUALIFY_MS - 600);
        assert.ok(state.energy.soc_pct > 79.9);

        assert.equal(bms_estimator_step(state, 600), true);
        assert.equal(bms_estimator_get_rest_time_ms(), 0);
        approx(state.energy.soc_pct, 77.0, 0.2);
    });

    test('P3-B5: Current pulse resets rest accumulator without applying OCV correction', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 14.4;
        state.meas.current_a = 0.01;

        for (let k = 0; k < 200; k++) {
            assert.equal(bms_estimator_step(state, 10), true);
        }
        assert.equal(bms_estimator_get_rest_time_ms(), 2000);

        state.meas.current_a = -0.2;
        assert.equal(bms_estimator_step(state, 10), true);
        assert.equal(bms_estimator_get_rest_time_ms(), 0);
        assert.ok(state.energy.soc_pct > 79.9);
    });
});

describe('Suite 3: Remaining & Estimated Charge Time (P3-C1..C4)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_state_machine_reset();
    });

    test('P3-C1: Remaining discharge time at -4.0 A and 80% SOC', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 14.8;
        state.meas.current_a = -4.0;

        assert.equal(bms_estimator_step(state, 10), true);
        approx(state.energy.remaining_time_min, 120.0, 0.05);
        assert.equal(state.energy.estimated_charge_time_min, 0);
    });

    test('P3-C2: Estimated charge time at +4.0 A and 80% SOC with 1.15 CV factor', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 15.6;
        state.meas.current_a = 4.0;

        assert.equal(bms_estimator_step(state, 10), true);
        const expected = (2.0 / (4.0 * 0.992)) * 1.15 * 60.0;
        approx(state.energy.estimated_charge_time_min, expected, 0.05);
        assert.equal(state.energy.remaining_time_min, 0);
    });

    test('P3-C3: Boundary zeroes at 0% discharge, 100% charge, and idle standby', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 12.1;
        state.meas.current_a = -4.0;
        state.energy.soc_pct = 0.0;
        state.energy.remaining_capacity_ah = 0.0;

        assert.equal(bms_estimator_step(state, 10), true);
        assert.equal(state.energy.remaining_time_min, 0);

        state.meas.bus_voltage_v = 16.8;
        state.meas.current_a = 4.0;
        state.energy.soc_pct = 100.0;
        state.energy.remaining_capacity_ah = 10.0;
        assert.equal(bms_estimator_step(state, 10), true);
        assert.equal(state.energy.estimated_charge_time_min, 0);

        state.meas.current_a = 0.02;
        assert.equal(bms_estimator_step(state, 10), true);
        assert.equal(state.energy.remaining_time_min, 0);
        assert.equal(state.energy.estimated_charge_time_min, 0);
    });

    test('P3-C4: Outputs remain finite across edge current and SOC combinations', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        for (const [u, i] of [[14.8, 0], [14.8, -0.05], [14.8, 0.05], [16.8, 5.0], [12.0, -15.0]]) {
            state.meas.bus_voltage_v = u;
            state.meas.current_a = i;
            assert.equal(bms_estimator_step(state, 10), true);
            assert.equal(Number.isFinite(state.energy.remaining_time_min), true);
            assert.equal(Number.isFinite(state.energy.estimated_charge_time_min), true);
        }
    });
});

describe('Suite 4: 5-Mode State Machine & Relay Sequencing (P3-D1..D8)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        bms_state_machine_reset();
    });

    test('P3-D1: Init and input validation for bms_state_machine', () => {
        assert.equal(bms_state_machine_init(null), false);
        assert.equal(bms_state_machine_is_charger_valid(null), false);
        assert.equal(bms_state_machine_is_charge_complete(null), false);

        const state = createDefaultSystemState();
        state.mode = BMS_MODE_FAULT;
        assert.equal(bms_state_machine_init(state), true);
        assert.equal(state.mode, BMS_MODE_STARTUP);
        assert.deepEqual(state.relays.cmd, [false, false, false, false]);
        assert.deepEqual(state.relays.feedback, [false, false, false, false]);

        assert.equal(bms_state_machine_step(null, 10), false);
        assert.equal(bms_state_machine_step(state, ESTIMATOR_MAX_DT_MS + 1), false);
        assert.equal(bms_state_machine_step(state, -1), false);
        assert.equal(bms_state_machine_step(state, 1.5), false);
    });

    test('P3-D2: Make-before-break precharge sequence R4 -> R1 -> !R4 transitions STARTUP -> STANDBY', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        hal_mock_clear_relay_log();
        makeHealthyMeas(state, 14.8, 0, 0);

        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_STARTUP);
        assert.equal(hal_relay_read_cmd(RELAY_4_AUX), true);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);

        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_STARTUP);
        assert.equal(hal_relay_read_cmd(RELAY_4_AUX), true);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);

        assert.equal(bms_state_machine_step(state, STARTUP_PRECHARGE_MS - 20), true);
        assert.equal(state.mode, BMS_MODE_STANDBY);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
        assert.equal(hal_relay_read_cmd(RELAY_4_AUX), false);

        const logCount = hal_mock_get_relay_log_count();
        assert.equal(logCount, 3);
        const events = [];
        for (let i = 0; i < 3; i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            events.push([ev.relay_id, ev.closed]);
        }
        assert.deepEqual(events, [
            [RELAY_4_AUX, true],
            [RELAY_1_MAIN, true],
            [RELAY_4_AUX, false]
        ]);
    });

    test('P3-D3: Startup faults lock BMS_MODE_FAULT with all relays OPEN', () => {
        const cases = [
            (s) => { makeHealthyMeas(s, 14.8, 0, 0); s.meas.ina226_ok = false; },
            (s) => { makeHealthyMeas(s, 14.8, 0, 0); s.meas.vsense_ok = false; },
            (s) => { makeHealthyMeas(s, 11.8, 0, 0); },
            (s) => { makeHealthyMeas(s, 17.0, 0, 0); }
        ];

        for (const setup of cases) {
            hal_mock_reset();
            hal_init();
            const state = createDefaultSystemState();
            assert.equal(bms_state_machine_init(state), true);
            setup(state);

            assert.equal(bms_state_machine_step(state, 10), true);
            assert.equal(state.mode, BMS_MODE_FAULT);
            for (let i = 0; i < RELAY_COUNT; i++) {
                assert.equal(hal_relay_read_cmd(i), false);
            }
        }
    });

    test('P3-D4: Mandatory CHARGE rule closes R2 via CHARGE_CONFIRM and requires actual INA226 charging current', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        makeHealthyMeas(state, 15.2, 0, 16.0);
        runStartupPrecharge(state);

        state.charge_enabled_req = true;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);
        assert.equal(state.mode, BMS_MODE_CHARGE_CONFIRM);

        state.meas.current_a = -1.0;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_DISCHARGE);

        state.meas.current_a = 2.0;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_CHARGE);
    });

    test('P3-D5: Charge completion latch and 0.30 V re-enable hysteresis', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        makeHealthyMeas(state, 16.2, 2.0, 16.8);
        runStartupPrecharge(state);

        state.charge_enabled_req = true;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);
        assert.equal(state.mode, BMS_MODE_CHARGE);

        state.meas.bus_voltage_v = 16.75;
        state.meas.current_a = 0.12;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(state.mode, BMS_MODE_STANDBY);

        state.meas.bus_voltage_v = 16.65;
        state.meas.current_a = 0.0;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);

        state.meas.bus_voltage_v = 16.45;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);
    });

    test('P3-D6: Discharge mode switching and undervoltage load cutoff', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        makeHealthyMeas(state, 14.5, 0, 0);
        runStartupPrecharge(state);

        state.load_enabled_req = true;
        state.meas.current_a = -5.0;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);
        assert.equal(state.mode, BMS_MODE_DISCHARGE);

        state.meas.current_a = 0.0;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_DISCHARGE_CONFIRM);

        state.load_enabled_req = false;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_STANDBY);

        state.load_enabled_req = true;
        state.meas.bus_voltage_v = 12.0;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);
    });

    test('P3-D7: Branch fault vs system isolation and post-latch precharge recovery', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        makeHealthyMeas(state, 15.0, 0, 16.0);
        runStartupPrecharge(state);

        state.charge_enabled_req = true;
        state.load_enabled_req = true;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);

        /* Post-startup vsense_ok=false -> branch fault opens R2 only, keeps R1 and R3 */
        state.meas.vsense_ok = false;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_FAULT);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);

        /* Recover vsense_ok -> re-closes R2 into CHARGE_CONFIRM directly without re-precharging */
        state.meas.vsense_ok = true;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_CHARGE_CONFIRM);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);

        /* Level 4 isolate + fault latch -> hal_relay_open_all in R3 -> R2 -> R4 -> R1 order */
        hal_mock_clear_relay_log();
        state.prot_level = PROT_LEVEL_4_ISOLATE;
        state.fault_latched = true;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_FAULT);
        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(hal_relay_read_cmd(i), false);
        }
        assert.equal(hal_mock_get_relay_log_count(), 4);
        const isolateOrder = [];
        for (let i = 0; i < 4; i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            assert.equal(ev.closed, false);
            isolateOrder.push(ev.relay_id);
        }
        assert.deepEqual(isolateOrder, [RELAY_3_LOAD, RELAY_2_CHARGE, RELAY_4_AUX, RELAY_1_MAIN]);

        /* While latched, even healthy sensors keep FAULT and OPEN relays */
        state.prot_level = PROT_LEVEL_1_NORMAL;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_FAULT);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);

        /* After clearing latch, must pass through STARTUP precharge before closing R1 */
        state.fault_latched = false;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_STARTUP);
        assert.equal(hal_relay_read_cmd(RELAY_4_AUX), true);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
    });

    test('P3-D8: Relay feedback mismatch sync detects stuck contact', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        makeHealthyMeas(state, 14.8, 0, 0);
        runStartupPrecharge(state);

        assert.equal(hal_mock_set_relay_feedback_override(RELAY_2_CHARGE, true, true), true);
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.relays.cmd[RELAY_2_CHARGE], false);
        assert.equal(state.relays.feedback[RELAY_2_CHARGE], true);
        assert.equal(state.relays.fault_mismatch[RELAY_2_CHARGE], true);
    });

    test('P3-D9: CHARGE_CONFIRM times out after 2000 ms without current, opens R2 and raises WARN_NO_CHARGE_CURRENT', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        makeHealthyMeas(state, 15.2, 0.0, 16.0);
        runStartupPrecharge(state);

        state.charge_enabled_req = true;
        for (let t = 0; t < CHARGE_CONFIRM_TIMEOUT_MS - 10; t += 10) {
            assert.equal(bms_state_machine_step(state, 10), true);
            assert.equal(state.mode, BMS_MODE_CHARGE_CONFIRM);
            assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);
        }

        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_STANDBY);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.notEqual(state.warning_flags & WARN_NO_CHARGE_CURRENT, 0);
        assert.equal(state.prot_level, PROT_LEVEL_2_WARNING);

        /* Toggling charge request off resets confirmation failure latch */
        state.charge_enabled_req = false;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.warning_flags & WARN_NO_CHARGE_CURRENT, 0);
        state.charge_enabled_req = true;
        state.meas.current_a = 1.5;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_CHARGE);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);
    });

    test('P3-D10: DISCHARGE_CONFIRM times out after 2000 ms without current, opens R3 and raises WARN_NO_LOAD_CURRENT', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_state_machine_init(state), true);
        makeHealthyMeas(state, 14.8, 0.0, 0.0);
        runStartupPrecharge(state);

        state.load_enabled_req = true;
        for (let t = 0; t < DISCHARGE_CONFIRM_TIMEOUT_MS - 10; t += 10) {
            assert.equal(bms_state_machine_step(state, 10), true);
            assert.equal(state.mode, BMS_MODE_DISCHARGE_CONFIRM);
            assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);
        }

        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_STANDBY);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);
        assert.notEqual(state.warning_flags & WARN_NO_LOAD_CURRENT, 0);
        assert.equal(state.prot_level, PROT_LEVEL_2_WARNING);

        /* Toggling load request off resets confirmation failure latch */
        state.load_enabled_req = false;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.warning_flags & WARN_NO_LOAD_CURRENT, 0);
        state.load_enabled_req = true;
        state.meas.current_a = -2.0;
        assert.equal(bms_state_machine_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_DISCHARGE);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);
    });
});
