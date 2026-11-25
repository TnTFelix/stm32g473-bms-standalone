import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
    ESTIMATOR_MAX_DT_MS,
    INA226_REG_BUS_V,
    INA226_REG_SHUNT_V,
    OLED_BUFFER_SIZE,
    VSENSE_DIVIDER_RATIO
} from '../sim/bms_config.mjs';

import {
    BMS_MODE_CHARGE,
    BMS_MODE_DISCHARGE,
    BMS_MODE_FAULT,
    BMS_MODE_STANDBY,
    BMS_MODE_STARTUP,
    FAULT_INA226_DISCONNECTED,
    FAULT_RELAY_NO_RESPONSE,
    FAULT_SHORT_CIRCUIT,
    OLED_PAGE_CHARGER,
    OLED_PAGE_DIAGNOSTICS,
    OLED_PAGE_OVERVIEW,
    OLED_PAGE_RELAYS,
    PROT_LEVEL_1_NORMAL,
    PROT_LEVEL_3_BRANCH,
    PROT_LEVEL_5_LATCH,
    RELAY_1_MAIN,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    createDefaultSystemState
} from '../sim/bms_types.mjs';

import {
    hal_init,
    hal_mock_clear_relay_log,
    hal_mock_get_oled_state,
    hal_mock_get_relay_event,
    hal_mock_get_relay_log_count,
    hal_mock_reset,
    hal_mock_set_adc_pa0_pin_voltage,
    hal_mock_set_i2c_online,
    hal_mock_set_ina226_register,
    hal_mock_set_relay_feedback_override,
    hal_mock_set_spi_fault,
    hal_mock_set_tick_ms,
    hal_relay_read_cmd
} from '../sim/hal_mock.mjs';

import {
    ina226_encode_bus_voltage_reg,
    ina226_encode_shunt_current_reg
} from '../sim/drivers/ina226.mjs';

import {
    SSD1309_LINE_MAX_CHARS,
    SSD1309_TEXT_LINES,
    ssd1309_clear_buffer,
    ssd1309_draw_text_line,
    ssd1309_flush,
    ssd1309_get_framebuffer,
    ssd1309_get_text_line,
    ssd1309_init,
    ssd1309_mode_label,
    ssd1309_render_page,
    ssd1309_reset_state
} from '../sim/drivers/ssd1309_oled.mjs';

import {
    BMS_HISTORY_CAPACITY,
    bms_app_get_history_count,
    bms_app_get_history_entry,
    bms_app_init,
    bms_app_next_page,
    bms_app_request_fault_clear,
    bms_app_reset,
    bms_app_set_page,
    bms_app_step
} from '../sim/app/bms_app.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function injectSensors(busV, currentA, chargerV) {
    hal_mock_set_ina226_register(INA226_REG_BUS_V, ina226_encode_bus_voltage_reg(busV));
    hal_mock_set_ina226_register(INA226_REG_SHUNT_V, ina226_encode_shunt_current_reg(currentA));
    hal_mock_set_adc_pa0_pin_voltage(chargerV / VSENSE_DIVIDER_RATIO);
}

function assertAllLinesFit() {
    for (let i = 0; i < SSD1309_TEXT_LINES; i++) {
        const line = ssd1309_get_text_line(i);
        assert.equal(typeof line, 'string');
        assert.ok(line.length <= SSD1309_LINE_MAX_CHARS, `Line ${i} too long (${line.length}): "${line}"`);
    }
}

describe('Suite 1: SSD1309 OLED 4-Page Driver (P5-A1..A6)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        ssd1309_reset_state();
        bms_app_reset();
    });

    test('P5-A1: ssd1309_init resets, configures SSD1309 commands, flushes 1024 bytes, and detects SPI fault', () => {
        assert.equal(ssd1309_init(), true);
        const st = hal_mock_get_oled_state();
        assert.equal(st.reset_count, 1);
        assert.ok(st.cmd_log.includes(0xAE));
        assert.ok(st.cmd_log.includes(0x20));
        assert.ok(st.cmd_log.includes(0x00));
        assert.ok(st.cmd_log.includes(0xAF));
        assert.equal(st.last_data_len, OLED_BUFFER_SIZE);

        hal_mock_set_spi_fault(true);
        assert.equal(ssd1309_init(), false);
        assert.equal(ssd1309_flush(), false);
    });

    test('P5-A2: Text line bounds, 21-char clipping, and real 5x7 glyph bitmap pixels', () => {
        assert.equal(ssd1309_draw_text_line(0, null), false);
        assert.equal(ssd1309_draw_text_line(8, 'ABC'), false);
        assert.equal(ssd1309_get_text_line(8), null);

        const longStr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        assert.equal(ssd1309_draw_text_line(0, longStr), true);
        assert.equal(ssd1309_get_text_line(0).length, 21);
        assert.equal(ssd1309_get_text_line(0), 'ABCDEFGHIJKLMNOPQRSTU');

        const fb = ssd1309_get_framebuffer();
        assert.equal(fb.some((b) => b !== 0), true);

        ssd1309_clear_buffer();
        const cleared = ssd1309_get_framebuffer();
        assert.equal(cleared.every((b) => b === 0), true);
    });

    test('P5-A3: OLED_PAGE_OVERVIEW renders U, I, P, SOC, T, level, mode and sanitizes NaN', () => {
        assert.equal(ssd1309_render_page(null, OLED_PAGE_OVERVIEW), false);
        const state = createDefaultSystemState();
        assert.equal(ssd1309_render_page(state, 4), false);

        state.mode = BMS_MODE_CHARGE;
        state.prot_level = PROT_LEVEL_1_NORMAL;
        state.meas.bus_voltage_v = 16.1;
        state.meas.current_a = 3.25;
        state.meas.power_w = 52.3;
        state.energy.soc_pct = 82;
        state.energy.estimated_charge_time_min = 35;

        assert.equal(ssd1309_render_page(state, OLED_PAGE_OVERVIEW), true);
        assertAllLinesFit();
        assert.ok(ssd1309_get_text_line(0).includes('4S BMS'));
        assert.ok(ssd1309_get_text_line(0).includes(ssd1309_mode_label(BMS_MODE_CHARGE)));
        assert.ok(ssd1309_get_text_line(0).includes('L1'));
        assert.ok(ssd1309_get_text_line(1).includes('U:16.10V'));
        assert.ok(ssd1309_get_text_line(1).includes('I:+3.25A'));
        assert.ok(ssd1309_get_text_line(2).includes('P:52.3W'));
        assert.ok(ssd1309_get_text_line(2).includes('Tchg:35m'));
        assert.ok(ssd1309_get_text_line(3).includes('BAT:['));
        assert.ok(ssd1309_get_text_line(3).includes('82%'));

        state.meas.bus_voltage_v = Number.NaN;
        state.meas.current_a = Infinity;
        assert.equal(ssd1309_render_page(state, OLED_PAGE_OVERVIEW), true);
        for (let i = 0; i < SSD1309_TEXT_LINES; i++) {
            assert.equal(ssd1309_get_text_line(i).includes('NaN'), false);
            assert.equal(ssd1309_get_text_line(i).includes('Infinity'), false);
        }
        assert.ok(ssd1309_get_text_line(4).includes('Uc:'));
        assert.ok(ssd1309_get_text_line(5).includes('Ei:'));
        assert.ok(ssd1309_get_text_line(6).includes('R1:'));
        assert.ok(ssd1309_get_text_line(7).includes('I:'));
    });

    test('P5-A4: OLED_PAGE_CHARGER renders CHG, Uc, Ub, Ic, Pc, R2, VS within 21 chars', () => {
        const state = createDefaultSystemState();
        state.meas.charger_present = true;
        state.meas.charger_voltage_v = 16.8;
        state.meas.bus_voltage_v = 15.2;
        state.meas.current_a = 4.0;
        state.energy.charge_power_w = 60.8;
        state.relays.cmd[RELAY_2_CHARGE] = true;
        state.meas.vsense_ok = true;

        assert.equal(ssd1309_render_page(state, OLED_PAGE_CHARGER), true);
        assertAllLinesFit();
        assert.ok(ssd1309_get_text_line(0).includes('CHG:YES'));
        assert.ok(ssd1309_get_text_line(1).includes('Uc:16.80V'));
        assert.ok(ssd1309_get_text_line(1).includes('Ub:15.20V'));
        assert.ok(ssd1309_get_text_line(2).includes('Ic:4.00A'));
        assert.ok(ssd1309_get_text_line(2).includes('Pc:60.8W'));
        assert.ok(ssd1309_get_text_line(3).includes('R2:ON'));
        assert.ok(ssd1309_get_text_line(3).includes('VS:OK'));
    });

    test('P5-A5: OLED_PAGE_RELAYS renders R1..R4 cmd/feedback/mismatch accurately', () => {
        const state = createDefaultSystemState();
        state.relays.cmd[0] = true;
        state.relays.feedback[0] = true;
        state.relays.fault_mismatch[0] = false;
        state.relays.cmd[1] = false;
        state.relays.feedback[1] = true;
        state.relays.fault_mismatch[1] = true;

        assert.equal(ssd1309_render_page(state, OLED_PAGE_RELAYS), true);
        assertAllLinesFit();
        assert.equal(ssd1309_get_text_line(0), 'R1 C:ON F:ON OK');
        assert.equal(ssd1309_get_text_line(1), 'R2 C:OFF F:ON ERR');
        assert.equal(ssd1309_get_text_line(2), 'R3 C:OFF F:OFF OK');
        assert.equal(ssd1309_get_text_line(3), 'R4 C:OFF F:OFF OK');
    });

    test('P5-A6: OLED_PAGE_DIAGNOSTICS renders fault flags, sensor health, latch, and snapshot', () => {
        const state = createDefaultSystemState();
        state.meas.ina226_ok = true;
        state.meas.vsense_ok = true;
        assert.equal(ssd1309_render_page(state, OLED_PAGE_DIAGNOSTICS), true);
        assertAllLinesFit();
        assert.equal(ssd1309_get_text_line(3), 'SNAP:NONE');

        state.prot_level = PROT_LEVEL_5_LATCH;
        state.active_faults = FAULT_SHORT_CIRCUIT;
        state.fault_latched = true;
        state.meas.ina226_ok = false;
        state.meas.vsense_ok = false;
        state.snapshot.valid = true;
        state.snapshot.latched_fault_mask = FAULT_SHORT_CIRCUIT;
        state.snapshot.bus_voltage_v = 14.5;
        state.snapshot.current_a = -28.0;

        assert.equal(ssd1309_render_page(state, OLED_PAGE_DIAGNOSTICS), true);
        assertAllLinesFit();
        assert.equal(ssd1309_get_text_line(0), 'P4 DIAG L5 F:0x010');
        assert.equal(ssd1309_get_text_line(1), 'INA:ERR VS:ERR');
        assert.equal(ssd1309_get_text_line(2), 'LAT:YES M:0x010');
        assert.equal(ssd1309_get_text_line(3), 'SNAP:14.5V -28.0A');
        assert.equal(ssd1309_get_text_line(4), 'ERR:SHORT_CKT');
    });
});

describe('Suite 2: bms_app Orchestration, 10 ms > 200 ms Priority & SPI Fault Tolerance (P5-B1..B5)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        ssd1309_reset_state();
        bms_app_reset();
    });

    test('P5-B1: bms_app_init tolerates SPI fault and bms_app_step validates inputs', () => {
        assert.equal(bms_app_init(null), false);

        hal_mock_set_spi_fault(true);
        const state = createDefaultSystemState();
        injectSensors(14.8, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);
        assert.equal(bms_app_get_history_count(), 1);
        for (let i = 0; i < 4; i++) {
            assert.equal(hal_relay_read_cmd(i), false);
        }

        assert.equal(bms_app_step(null, 10), false);
        assert.equal(bms_app_step(state, ESTIMATOR_MAX_DT_MS + 1), false);
        assert.equal(bms_app_step(state, -1), false);
        assert.equal(bms_app_step(state, 1.5), false);
    });

    test('P5-B2: OLED refreshes strictly at 200 ms and handles 32-bit tick wraparound', () => {
        hal_mock_set_tick_ms(0xFFFFFFF0);
        const state = createDefaultSystemState();
        injectSensors(14.8, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);
        const initialWrites = hal_mock_get_oled_state().data_write_count;

        for (let k = 0; k < 19; k++) {
            assert.equal(bms_app_step(state, 10), true);
            assert.equal(hal_mock_get_oled_state().data_write_count, initialWrites);
        }

        assert.equal(bms_app_step(state, 10), true);
        assert.equal(hal_mock_get_oled_state().data_write_count, initialWrites + 1);
        assert.equal(state.tick_ms, 0xB8);
    });

    test('P5-B3: SPI fault never delays 0 ms short-circuit isolation', () => {
        const state = createDefaultSystemState();
        injectSensors(14.8, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);

        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        state.load_enabled_req = true;
        injectSensors(14.5, -5.0, 0.0);
        assert.equal(bms_app_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_DISCHARGE);

        hal_mock_set_spi_fault(true);
        hal_mock_clear_relay_log();
        injectSensors(14.0, -30.0, 0.0);
        assert.equal(bms_app_step(state, 10), true);

        assert.equal(state.fault_latched, true);
        assert.equal(state.prot_level, PROT_LEVEL_5_LATCH);
        assert.equal(state.mode, BMS_MODE_FAULT);

        const order = [];
        for (let i = 0; i < hal_mock_get_relay_log_count(); i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            order.push(ev.relay_id);
        }
        assert.deepEqual(order, [RELAY_3_LOAD, RELAY_2_CHARGE, RELAY_4_AUX, RELAY_1_MAIN]);
    });

    test('P5-B4: Manual/auto page switching (3000 ms) and sticky auto-jump to Page 4 on fault', () => {
        const state = createDefaultSystemState();
        injectSensors(14.8, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);
        assert.equal(state.current_oled_page, OLED_PAGE_OVERVIEW);

        assert.equal(bms_app_set_page(state, 4), false);
        assert.equal(bms_app_next_page(state), true);
        assert.equal(state.current_oled_page, OLED_PAGE_CHARGER);
        assert.equal(bms_app_set_page(state, OLED_PAGE_OVERVIEW), true);

        for (let k = 0; k < 300; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.current_oled_page, OLED_PAGE_CHARGER);

        for (let k = 0; k < 300; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.current_oled_page, OLED_PAGE_RELAYS);

        /* Trigger fault -> auto jumps to OLED_PAGE_DIAGNOSTICS and holds across 3000 ms */
        injectSensors(14.0, -26.0, 0.0);
        assert.equal(bms_app_step(state, 10), true);
        assert.equal(state.current_oled_page, OLED_PAGE_DIAGNOSTICS);

        for (let k = 0; k < 350; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.current_oled_page, OLED_PAGE_DIAGNOSTICS);
    });

    test('P5-B5: History ring buffer avoids steady-state spam and retains latest 16 transitions', () => {
        const state = createDefaultSystemState();
        injectSensors(14.8, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        const countAfterStartup = bms_app_get_history_count();
        for (let k = 0; k < 50; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(bms_app_get_history_count(), countAfterStartup);

        state.load_enabled_req = true;
        for (let k = 0; k < 20; k++) {
            injectSensors(14.6, -5.0, 0.0);
            assert.equal(bms_app_step(state, 10), true);
            assert.equal(bms_app_step(state, 10), true);
            injectSensors(14.8, 0.0, 0.0);
            for (let s = 0; s < 8; s++) {
                assert.equal(bms_app_step(state, 10), true);
            }
        }

        assert.equal(bms_app_get_history_count(), BMS_HISTORY_CAPACITY);
        const out = {};
        assert.equal(bms_app_get_history_entry(16, out), false);
        assert.equal(bms_app_get_history_entry(0, null), false);
        assert.equal(bms_app_get_history_entry(0, out), true);
        const newest = {};
        assert.equal(bms_app_get_history_entry(15, newest), true);
        assert.ok(newest.timestamp_ms >= out.timestamp_ms);
    });
});

describe('Suite 3: Level 3 vs Level 5 Recovery & Full-System Integration (P5-C1..C4)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        ssd1309_reset_state();
        bms_app_reset();
    });

    test('P5-C1: Level 3 recovery keeps R1 closed and returns to STANDBY without re-precharging R4', () => {
        const state = createDefaultSystemState();
        injectSensors(14.8, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }

        state.load_enabled_req = true;
        /* Ramp gently below dI/dt short-circuit limit to trigger Level 3 discharge OC */
        injectSensors(14.6, -8.0, 0.0);
        for (let k = 0; k < 6; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        injectSensors(14.5, -15.5, 0.0);
        for (let k = 0; k < 6; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);

        /* Current decays to 0 after R3 opens while load_enabled_req stays true (Level 3 hold) */
        injectSensors(14.7, -8.0, 0.0);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        injectSensors(14.8, 0.0, 0.0);
        for (let k = 0; k < 8; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.prot_level, PROT_LEVEL_3_BRANCH);
        assert.equal(state.mode, BMS_MODE_FAULT);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);

        assert.equal(bms_app_request_fault_clear(state), true);
        assert.equal(state.mode, BMS_MODE_STANDBY);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
        assert.equal(hal_relay_read_cmd(RELAY_4_AUX), false);

        state.load_enabled_req = false;
        assert.equal(bms_app_step(state, 10), true);
        assert.equal(state.mode, BMS_MODE_STANDBY);
        assert.equal(hal_relay_read_cmd(RELAY_4_AUX), false);
    });

    test('P5-C2: Level 5 recovery requires safe conditions and full pre-charge restart', () => {
        const state = createDefaultSystemState();
        injectSensors(14.8, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }

        injectSensors(14.2, -26.0, 0.0);
        assert.equal(bms_app_step(state, 10), true);
        assert.equal(state.fault_latched, true);
        assert.equal(bms_app_request_fault_clear(state), false);

        injectSensors(14.8, 0.0, 0.0);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(bms_app_request_fault_clear(state), true);
        assert.equal(state.mode, BMS_MODE_STARTUP);

        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.mode, BMS_MODE_STANDBY);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), true);
    });

    test('P5-C3: Full lifecycle integration from STARTUP through CHARGE, DISCHARGE, I2C loss, and recovery', () => {
        const state = createDefaultSystemState();
        injectSensors(15.2, 0.0, 0.0);
        assert.equal(bms_app_init(state), true);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.mode, BMS_MODE_STANDBY);

        /* Charge */
        state.charge_enabled_req = true;
        injectSensors(16.4, 3.0, 16.4);
        for (let k = 0; k < 20; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.mode, BMS_MODE_CHARGE);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), true);

        /* Full cutoff */
        injectSensors(16.78, 0.10, 16.8);
        for (let k = 0; k < 10; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);
        assert.equal(state.mode, BMS_MODE_STANDBY);

        /* Discharge */
        state.charge_enabled_req = false;
        state.load_enabled_req = true;
        injectSensors(14.8, -5.0, 0.0);
        const socBeforeDis = state.energy.soc_pct;
        for (let k = 0; k < 50; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.mode, BMS_MODE_DISCHARGE);
        assert.ok(state.energy.soc_pct < socBeforeDis);
        assert.ok(state.energy.remaining_time_min > 0);

        /* INA226 disconnect latch */
        hal_mock_set_i2c_online(false);
        assert.equal(bms_app_step(state, 10), true);
        assert.equal(state.fault_latched, true);
        assert.notEqual(state.active_faults & FAULT_INA226_DISCONNECTED, 0);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);

        /* Safe recovery */
        state.load_enabled_req = false;
        hal_mock_set_i2c_online(true);
        injectSensors(14.8, 0.0, 0.0);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(bms_app_request_fault_clear(state), true);
        for (let k = 0; k < 3; k++) {
            assert.equal(bms_app_step(state, 10), true);
        }
        assert.equal(state.mode, BMS_MODE_STANDBY);
    });

    test('P5-C4: CLI sim/run_sim.mjs runs cleanly with exit code 0 and prints all 4 OLED pages + history', () => {
        const stdout = execFileSync(process.execPath, [join(ROOT, 'sim', 'run_sim.mjs')], {
            cwd: ROOT,
            encoding: 'utf8'
        });
        assert.ok(stdout.includes('4S BMS'));
        assert.ok(stdout.includes('P2 CHARGER'));
        assert.ok(stdout.includes('R1 C:'));
        assert.ok(stdout.includes('P4 DIAG'));
        assert.ok(stdout.includes('BMS HISTORY'));
    });
});
