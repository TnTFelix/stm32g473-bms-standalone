import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as cfg from '../sim/bms_config.mjs';
import {
    BMS_PORT_A,
    BMS_PORT_B,
    BMS_PORT_C,
    BMS_PORT_NAMES,
    BMS_CONFIG,
    bms_pin_name,
    OLED_SCK_PORT,
    OLED_SCK_PIN,
    OLED_MOSI_PORT,
    OLED_MOSI_PIN,
    OLED_RES_PORT,
    OLED_RES_PIN,
    OLED_CS_PORT,
    OLED_CS_PIN,
    OLED_DC_PORT,
    OLED_DC_PIN,
    INA226_SCL_PORT,
    INA226_SCL_PIN,
    INA226_SDA_PORT,
    INA226_SDA_PIN,
    VSENSE_ADC_PORT,
    VSENSE_ADC_PIN,
    RELAY1_MAIN_PORT,
    RELAY1_MAIN_PIN,
    RELAY2_CHARGE_PORT,
    RELAY2_CHARGE_PIN,
    RELAY3_LOAD_PORT,
    RELAY3_LOAD_PIN,
    RELAY4_AUX_PORT,
    RELAY4_AUX_PIN,
    SWD_SWDIO_PORT,
    SWD_SWDIO_PIN,
    SWD_SWCLK_PORT,
    SWD_SWCLK_PIN,
    OLED_SPI_INSTANCE,
    INA226_I2C_INSTANCE,
    VSENSE_ADC_INSTANCE,
    VSENSE_ADC_CHANNEL,
    BMS_CELL_COUNT,
    BMS_NOMINAL_V,
    BMS_FULL_V,
    BMS_EMPTY_V,
    BMS_CHARGE_EFFICIENCY,
    BMS_INITIAL_SOC_PCT,
    INA226_I2C_ADDR,
    INA226_SHUNT_OHM,
    INA226_SHUNT_MAX_V,
    INA226_BUS_VALID_MIN_V,
    INA226_BUS_VALID_MAX_V,
    ADC_VREF_V,
    ADC_RESOLUTION,
    ADC_PIN_MAX_SAFE_V,
    VSENSE_DIVIDER_RATIO,
    CHARGER_PRESENT_MIN_V,
    CHARGER_VALID_MIN_V,
    CHARGER_VALID_MAX_V,
    CHARGE_CURRENT_MIN_A,
    CHARGE_DONE_CURRENT_A,
    CHARGE_DONE_VOLTAGE_V,
    REST_CURRENT_THRESHOLD_A,
    CHARGE_CV_COMPENSATION,
    PROT_BAT_OV_WARN_V,
    PROT_BAT_OV_TRIP_V,
    PROT_BAT_OV_CRIT_V,
    PROT_BAT_UV_WARN_V,
    PROT_BAT_UV_TRIP_V,
    PROT_BAT_UV_CRIT_V,
    PROT_CHG_OC_WARN_A,
    PROT_CHG_OC_TRIP_A,
    PROT_DIS_OC_WARN_A,
    PROT_DIS_OC_TRIP_A,
    PROT_SHORT_CIRCUIT_A,
    PROT_DI_DT_MAX_A_PER_STEP,
    PROT_CHARGER_OV_WARN_V,
    PROT_CHARGER_OV_TRIP_V,
    PROT_DEBOUNCE_NORM_MS,
    PROT_DEBOUNCE_FAST_MS,
    CONTROL_LOOP_PERIOD_MS,
    OLED_REFRESH_PERIOD_MS,
    OLED_AUTO_PAGE_MS,
    OLED_WIDTH,
    OLED_HEIGHT,
    OLED_BUFFER_SIZE,
    OLED_RESET_PULSE_MS,
    OLED_RESET_RECOVERY_MS
} from '../sim/bms_config.mjs';

import {
    BMS_MODE_STARTUP,
    BMS_MODE_CHARGE,
    BMS_MODE_DISCHARGE,
    BMS_MODE_STANDBY,
    BMS_MODE_FAULT,
    BMS_MODE_CHARGE_CONFIRM,
    BMS_MODE_DISCHARGE_CONFIRM,
    BMS_MODE_COUNT,
    BMS_MODE,
    PROT_LEVEL_1_NORMAL,
    PROT_LEVEL_2_WARNING,
    PROT_LEVEL_3_BRANCH,
    PROT_LEVEL_4_ISOLATE,
    PROT_LEVEL_5_LATCH,
    PROT_LEVEL_COUNT,
    PROT_LEVEL,
    FAULT_NONE,
    FAULT_BAT_OVERVOLTAGE,
    FAULT_BAT_UNDERVOLTAGE,
    FAULT_CHG_OVERCURRENT,
    FAULT_DIS_OVERCURRENT,
    FAULT_SHORT_CIRCUIT,
    FAULT_CHARGER_OVERVOLTAGE,
    FAULT_INA226_DISCONNECTED,
    FAULT_VSENSE_FAULT,
    FAULT_RELAY_NO_RESPONSE,
    FAULT_COUNT,
    FAULT_ALL_MASK,
    FAULT,
    RELAY_1_MAIN,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    RELAY_COUNT,
    RELAY_ID,
    OLED_PAGE_OVERVIEW,
    OLED_PAGE_CHARGER,
    OLED_PAGE_RELAYS,
    OLED_PAGE_DIAGNOSTICS,
    OLED_PAGE_COUNT,
    OLED_PAGE,
    createDefaultSystemState,
    bms_system_state_init
} from '../sim/bms_types.mjs';

import {
    hal_init,
    hal_relay_open_all,
    hal_i2c3_is_device_ready,
    hal_i2c3_write_reg16,
    hal_i2c3_read_reg16,
    hal_adc_pa0_read_raw,
    hal_adc_pa0_read_pin_voltage,
    hal_relay_write,
    hal_relay_read_cmd,
    hal_relay_read_feedback,
    hal_oled_reset,
    hal_oled_write_cmd,
    hal_oled_write_data,
    hal_get_tick_ms,
    hal_delay_ms,
    hal_mock_reset,
    hal_mock_set_i2c_online,
    hal_mock_set_ina226_register,
    hal_mock_get_ina226_register,
    hal_mock_set_adc_pa0_raw,
    hal_mock_set_adc_pa0_pin_voltage,
    hal_mock_set_adc_fault,
    hal_mock_set_spi_fault,
    hal_mock_set_relay_feedback_override,
    hal_mock_set_tick_ms,
    hal_mock_advance_tick_ms,
    hal_mock_is_initialized,
    hal_mock_get_oled_state,
    hal_mock_get_relay_log_count,
    hal_mock_get_relay_event,
    hal_mock_clear_relay_log
} from '../sim/hal_mock.mjs';

function approx(actual, expected, eps = 1e-9, msg) {
    assert.ok(
        Math.abs(actual - expected) <= eps,
        msg ?? `Expected ${actual} to be within ${eps} of ${expected}`
    );
}

describe('Group A: Hardware Pin Mapping & Peripheral Instances (SPEC §1)', () => {
    const signals = [
        ['OLED_SCK', OLED_SCK_PORT, OLED_SCK_PIN, 'PA5'],
        ['OLED_MOSI', OLED_MOSI_PORT, OLED_MOSI_PIN, 'PA7'],
        ['OLED_RES', OLED_RES_PORT, OLED_RES_PIN, 'PB5'],
        ['OLED_CS', OLED_CS_PORT, OLED_CS_PIN, 'PB6'],
        ['OLED_DC', OLED_DC_PORT, OLED_DC_PIN, 'PB7'],
        ['INA226_SCL', INA226_SCL_PORT, INA226_SCL_PIN, 'PC8'],
        ['INA226_SDA', INA226_SDA_PORT, INA226_SDA_PIN, 'PC9'],
        ['VSENSE_ADC', VSENSE_ADC_PORT, VSENSE_ADC_PIN, 'PA0'],
        ['RELAY1_MAIN', RELAY1_MAIN_PORT, RELAY1_MAIN_PIN, 'PC0'],
        ['RELAY2_CHARGE', RELAY2_CHARGE_PORT, RELAY2_CHARGE_PIN, 'PC1'],
        ['RELAY3_LOAD', RELAY3_LOAD_PORT, RELAY3_LOAD_PIN, 'PC2'],
        ['RELAY4_AUX', RELAY4_AUX_PORT, RELAY4_AUX_PIN, 'PC3'],
        ['SWD_SWDIO', SWD_SWDIO_PORT, SWD_SWDIO_PIN, 'PA13'],
        ['SWD_SWCLK', SWD_SWCLK_PORT, SWD_SWCLK_PIN, 'PA14']
    ];

    test('P1-A1: All 14 STM32G473VET6 signals match exact pin names', () => {
        for (const [name, port, pin, expected] of signals) {
            assert.equal(bms_pin_name(port, pin), expected, `Pin mismatch for ${name}`);
        }
    });

    test('P1-A2: All 14 (port, pin) pairs are unique, valid, and BMS_PORT_NAMES matches', () => {
        const seen = new Set();
        for (const [, port, pin] of signals) {
            assert.ok([BMS_PORT_A, BMS_PORT_B, BMS_PORT_C].includes(port));
            assert.ok(Number.isInteger(pin) && pin >= 0 && pin <= 15);
            const key = `${port}:${pin}`;
            assert.equal(seen.has(key), false, `Duplicate pin assignment ${key}`);
            seen.add(key);
        }
        assert.equal(seen.size, 14);
        assert.equal(BMS_PORT_NAMES[OLED_CS_PORT], 'GPIOB');
    });

    test('P1-A3: Peripheral instances and INA226 7-bit address', () => {
        assert.equal(INA226_I2C_ADDR, 0x40);
        assert.ok(INA226_I2C_ADDR <= 0x7F);
        assert.equal(OLED_SPI_INSTANCE, 1);
        assert.equal(INA226_I2C_INSTANCE, 3);
        assert.equal(VSENSE_ADC_INSTANCE, 1);
        assert.equal(VSENSE_ADC_CHANNEL, 1);
    });

    test('P1-A4: bms_pin_name returns null for invalid port or pin', () => {
        assert.equal(bms_pin_name(3, 0), null);
        assert.equal(bms_pin_name(0, 16), null);
        assert.equal(bms_pin_name(0, 1.5), null);
    });

    test('P1-A5: Relay indices match PC0..PC3 pin numbers', () => {
        const relayPins = [RELAY1_MAIN_PIN, RELAY2_CHARGE_PIN, RELAY3_LOAD_PIN, RELAY4_AUX_PIN];
        assert.equal(relayPins[RELAY_1_MAIN], 0);
        assert.equal(relayPins[RELAY_2_CHARGE], 1);
        assert.equal(relayPins[RELAY_3_LOAD], 2);
        assert.equal(relayPins[RELAY_4_AUX], 3);
    });
});

describe('Group B: Physical Configuration Sanity & Immutability', () => {
    test('P1-B1: Shunt resistor 2 mOhm handles 15 A and 25 A short-circuit without saturation', () => {
        assert.equal(INA226_SHUNT_OHM, 0.002);
        assert.notEqual(INA226_SHUNT_OHM, 0.1);
        approx(15 * INA226_SHUNT_OHM, 0.030);
        assert.ok(15 * INA226_SHUNT_OHM <= INA226_SHUNT_MAX_V);
        approx(15 * 15 * INA226_SHUNT_OHM, 0.45);
        const maxMeasurableI = INA226_SHUNT_MAX_V / INA226_SHUNT_OHM;
        approx(maxMeasurableI, 40.96);
        assert.ok(maxMeasurableI >= PROT_SHORT_CIRCUIT_A);
        assert.ok(0.1 * 15 > INA226_SHUNT_MAX_V);
    });

    test('P1-B2: 4S pack voltages match 4 cells', () => {
        assert.ok(BMS_EMPTY_V < BMS_NOMINAL_V && BMS_NOMINAL_V < BMS_FULL_V);
        approx(BMS_FULL_V, 4.2 * BMS_CELL_COUNT);
        approx(BMS_EMPTY_V, 3.0 * 4);
        approx(BMS_NOMINAL_V, 3.7 * 4);
    });

    test('P1-B3: Battery voltage protection ordering', () => {
        assert.ok(
            PROT_BAT_UV_CRIT_V < PROT_BAT_UV_TRIP_V &&
            PROT_BAT_UV_TRIP_V < PROT_BAT_UV_WARN_V &&
            PROT_BAT_UV_WARN_V < BMS_NOMINAL_V &&
            BMS_NOMINAL_V < PROT_BAT_OV_WARN_V &&
            PROT_BAT_OV_WARN_V < PROT_BAT_OV_TRIP_V &&
            PROT_BAT_OV_TRIP_V < PROT_BAT_OV_CRIT_V
        );
        assert.ok(PROT_BAT_OV_WARN_V < BMS_FULL_V && BMS_FULL_V < PROT_BAT_OV_TRIP_V);
        assert.equal(PROT_BAT_UV_TRIP_V, BMS_EMPTY_V);
        assert.ok(INA226_BUS_VALID_MIN_V < PROT_BAT_UV_CRIT_V);
        assert.ok(PROT_BAT_OV_CRIT_V < INA226_BUS_VALID_MAX_V);
    });

    test('P1-B4: Current and charger overvoltage protection ordering', () => {
        assert.ok(PROT_CHG_OC_WARN_A < PROT_CHG_OC_TRIP_A);
        assert.ok(PROT_DIS_OC_WARN_A < PROT_DIS_OC_TRIP_A && PROT_DIS_OC_TRIP_A < PROT_SHORT_CIRCUIT_A);
        assert.ok(PROT_DI_DT_MAX_A_PER_STEP > 0);
        assert.ok(PROT_CHARGER_OV_WARN_V < PROT_CHARGER_OV_TRIP_V);
    });

    test('P1-B5: Voltage sensor PA0 divider range covers charger OV trip', () => {
        assert.ok(
            CHARGER_PRESENT_MIN_V < CHARGER_VALID_MIN_V &&
            CHARGER_VALID_MIN_V < CHARGER_VALID_MAX_V &&
            CHARGER_VALID_MAX_V <= PROT_CHARGER_OV_WARN_V
        );
        approx(ADC_VREF_V * VSENSE_DIVIDER_RATIO, 3.3 * 5.987);
        assert.ok(ADC_VREF_V * VSENSE_DIVIDER_RATIO >= PROT_CHARGER_OV_TRIP_V);
        assert.ok(ADC_PIN_MAX_SAFE_V < ADC_VREF_V);
        approx(ADC_PIN_MAX_SAFE_V * VSENSE_DIVIDER_RATIO, 3.25 * 5.987);
        assert.ok(ADC_PIN_MAX_SAFE_V * VSENSE_DIVIDER_RATIO >= PROT_CHARGER_OV_TRIP_V);
        assert.equal(ADC_RESOLUTION, 4095);
    });

    test('P1-B6: Mode detection thresholds and SOC bounds', () => {
        assert.ok(REST_CURRENT_THRESHOLD_A < CHARGE_CURRENT_MIN_A && CHARGE_CURRENT_MIN_A <= CHARGE_DONE_CURRENT_A);
        assert.ok(CHARGE_DONE_VOLTAGE_V <= BMS_FULL_V);
        assert.ok(BMS_CHARGE_EFFICIENCY > 0 && BMS_CHARGE_EFFICIENCY <= 1);
        assert.ok(BMS_INITIAL_SOC_PCT >= 0 && BMS_INITIAL_SOC_PCT <= 100);
        assert.ok(CHARGE_CV_COMPENSATION >= 1);
    });

    test('P1-B7: Loop periods, debounce, and OLED geometry', () => {
        assert.equal(OLED_REFRESH_PERIOD_MS / CONTROL_LOOP_PERIOD_MS, 20);
        assert.equal(OLED_AUTO_PAGE_MS % OLED_REFRESH_PERIOD_MS, 0);
        assert.equal(PROT_DEBOUNCE_NORM_MS, 3 * CONTROL_LOOP_PERIOD_MS);
        assert.equal(PROT_DEBOUNCE_FAST_MS, 0);
        assert.equal(OLED_BUFFER_SIZE, (OLED_WIDTH * OLED_HEIGHT) / 8);
        assert.equal(OLED_RESET_PULSE_MS + OLED_RESET_RECOVERY_MS, 20);
    });

    test('P1-B8: Config objects and module exports are immutable', () => {
        assert.equal(Object.isFrozen(BMS_CONFIG), true);
        assert.throws(() => { cfg.BMS_FULL_V = 99; }, TypeError);
        assert.throws(() => { BMS_CONFIG.BMS_FULL_V = 99; }, TypeError);
    });
});

describe('Group C: Data Types, Enums & Fault Bitmasks', () => {
    test('P1-C1: Enum values match specification', () => {
        assert.equal(BMS_MODE_STARTUP, 0);
        assert.equal(BMS_MODE_CHARGE, 1);
        assert.equal(BMS_MODE_DISCHARGE, 2);
        assert.equal(BMS_MODE_STANDBY, 3);
        assert.equal(BMS_MODE_FAULT, 4);
        assert.equal(BMS_MODE_CHARGE_CONFIRM, 5);
        assert.equal(BMS_MODE_DISCHARGE_CONFIRM, 6);
        assert.equal(BMS_MODE_COUNT, 7);

        assert.equal(PROT_LEVEL_1_NORMAL, 1);
        assert.equal(PROT_LEVEL_2_WARNING, 2);
        assert.equal(PROT_LEVEL_3_BRANCH, 3);
        assert.equal(PROT_LEVEL_4_ISOLATE, 4);
        assert.equal(PROT_LEVEL_5_LATCH, 5);
        assert.equal(PROT_LEVEL_COUNT, 5);

        assert.equal(RELAY_1_MAIN, 0);
        assert.equal(RELAY_2_CHARGE, 1);
        assert.equal(RELAY_3_LOAD, 2);
        assert.equal(RELAY_4_AUX, 3);
        assert.equal(RELAY_COUNT, 4);

        assert.equal(OLED_PAGE_OVERVIEW, 0);
        assert.equal(OLED_PAGE_CHARGER, 1);
        assert.equal(OLED_PAGE_RELAYS, 2);
        assert.equal(OLED_PAGE_DIAGNOSTICS, 3);
        assert.equal(OLED_PAGE_COUNT, 4);
    });

    test('P1-C2: 9 distinct fault bits combine cleanly into FAULT_ALL_MASK', () => {
        const faults = [
            FAULT_BAT_OVERVOLTAGE,
            FAULT_BAT_UNDERVOLTAGE,
            FAULT_CHG_OVERCURRENT,
            FAULT_DIS_OVERCURRENT,
            FAULT_SHORT_CIRCUIT,
            FAULT_CHARGER_OVERVOLTAGE,
            FAULT_INA226_DISCONNECTED,
            FAULT_VSENSE_FAULT,
            FAULT_RELAY_NO_RESPONSE
        ];
        assert.equal(FAULT_COUNT, 9);
        assert.equal(FAULT_NONE, 0);
        assert.equal(FAULT_ALL_MASK, 0x1FF);
        assert.equal(faults.reduce((acc, f) => acc | f, 0), FAULT_ALL_MASK);
        assert.equal(new Set(faults).size, 9);

        const combined = FAULT_SHORT_CIRCUIT | FAULT_RELAY_NO_RESPONSE;
        assert.notEqual(combined & FAULT_RELAY_NO_RESPONSE, 0);
        assert.equal(combined, 0x110);
    });

    test('P1-C3: Grouped enum objects are frozen and have expected sizes', () => {
        for (const obj of [BMS_MODE, PROT_LEVEL, FAULT, RELAY_ID, OLED_PAGE]) {
            assert.equal(Object.isFrozen(obj), true);
        }
        assert.equal(Object.keys(PROT_LEVEL).length, PROT_LEVEL_COUNT);
        assert.equal(Object.keys(BMS_MODE).length, BMS_MODE_COUNT);
    });
});

describe('Group D: Safe Default System State & Sealing', () => {
    test('P1-D1: createDefaultSystemState initializes safe defaults', () => {
        const s = createDefaultSystemState();
        assert.equal(s.mode, BMS_MODE_STARTUP);
        assert.equal(s.prot_level, PROT_LEVEL_1_NORMAL);
        assert.notEqual(s.prot_level, 0);
        assert.equal(s.active_faults, 0);
        assert.equal(s.warning_flags, 0);
        assert.equal(s.fault_latched, false);
        assert.equal(s.load_enabled_req, false);
        assert.equal(s.charge_enabled_req, false);
        assert.equal(s.current_oled_page, OLED_PAGE_OVERVIEW);
        assert.equal(s.oled_auto_cycle, true);
        assert.equal(s.energy.soc_pct, 80);
        approx(s.energy.remaining_capacity_ah, 8);
        assert.equal(s.energy.efficiency_pct, 100);
        assert.equal(s.meas.ina226_ok, false);
        assert.equal(s.meas.vsense_ok, false);
        assert.equal(s.snapshot.valid, false);
        assert.equal(s.snapshot.prot_level, PROT_LEVEL_1_NORMAL);
        assert.deepEqual(s.relays.cmd, [false, false, false, false]);
        assert.deepEqual(s.relays.feedback, [false, false, false, false]);
        assert.deepEqual(s.relays.fault_mismatch, [false, false, false, false]);
    });

    test('P1-D2: Instances are independent and do not share arrays or nested objects', () => {
        const a = createDefaultSystemState();
        a.relays.cmd[0] = true;
        const b = createDefaultSystemState();
        assert.equal(b.relays.cmd[0], false);
    });

    test('P1-D3: Root, nested objects, and relay arrays are sealed against expansion', () => {
        const s = createDefaultSystemState();
        assert.throws(() => { s.meas.bogus = 1; }, TypeError);
        assert.throws(() => { s.relays.cmd[4] = true; }, TypeError);
        assert.throws(() => { s.relays.cmd.push(true); }, TypeError);
    });

    test('P1-D4: bms_system_state_init validates input and resets dirty state', () => {
        assert.equal(bms_system_state_init(null), false);
        assert.equal(bms_system_state_init(undefined), false);
        assert.equal(bms_system_state_init(42), false);
        assert.equal(bms_system_state_init([]), false);

        const s = createDefaultSystemState();
        s.mode = BMS_MODE_FAULT;
        s.active_faults = FAULT_ALL_MASK;
        s.relays.cmd[0] = true;
        s.energy.soc_pct = 5;

        assert.equal(bms_system_state_init(s), true);
        assert.deepStrictEqual(s, createDefaultSystemState());
    });
});

describe('Group E: Safe HAL Initialization', () => {
    beforeEach(() => {
        hal_mock_reset();
    });

    test('P1-E1: Pre-init blocks closes and bus ops but permits safe relay open', () => {
        assert.equal(hal_mock_is_initialized(), false);
        assert.equal(hal_relay_write(RELAY_1_MAIN, true), false);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
        assert.equal(hal_relay_write(RELAY_1_MAIN, false), true);

        const out = { value: 99 };
        assert.equal(hal_i2c3_read_reg16(0x40, 0x00, out), false);
        assert.equal(out.value, 0);
        assert.equal(hal_oled_write_cmd(0xAE), false);
    });

    test('P1-E2: hal_init opens all relays in safe order and idles OLED pins', () => {
        assert.equal(hal_init(), true);
        assert.equal(hal_mock_is_initialized(), true);

        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(hal_relay_read_cmd(i), false);
            assert.equal(hal_relay_read_feedback(i), false);
        }

        assert.equal(hal_mock_get_relay_log_count(), 4);
        const order = [];
        for (let i = 0; i < 4; i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            assert.equal(ev.closed, false);
            order.push(ev.relay_id);
        }
        assert.deepEqual(order, [2, 1, 3, 0]);

        const oled = hal_mock_get_oled_state();
        assert.equal(oled.cs_pin, true);
        assert.equal(oled.dc_pin, false);
        assert.equal(oled.res_pin, true);
    });

    test('P1-E3: Warm re-init re-opens all relays', () => {
        assert.equal(hal_init(), true);
        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(hal_relay_write(i, true), true);
        }
        assert.equal(hal_init(), true);
        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(hal_relay_read_cmd(i), false);
            assert.equal(hal_relay_read_feedback(i), false);
        }
    });

    test('P1-E4: hal_init preserves injected tick, ADC fault, and I2C offline state', () => {
        hal_mock_set_tick_ms(1234);
        hal_mock_set_adc_fault(true);
        hal_mock_set_i2c_online(false);

        assert.equal(hal_init(), true);
        assert.equal(hal_get_tick_ms(), 1234);

        const out = { value: 55 };
        assert.equal(hal_adc_pa0_read_raw(out), false);
        assert.equal(out.value, 0);
        assert.equal(hal_i2c3_is_device_ready(0x40), false);
        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(hal_relay_read_cmd(i), false);
        }
    });

    test('P1-E5: Welded relay contact override remains observable across hal_init', () => {
        assert.equal(hal_mock_set_relay_feedback_override(RELAY_1_MAIN, true, true), true);
        assert.equal(hal_init(), true);

        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
        assert.equal(hal_relay_read_feedback(RELAY_1_MAIN), true);
        for (const r of [RELAY_2_CHARGE, RELAY_3_LOAD, RELAY_4_AUX]) {
            assert.equal(hal_relay_read_cmd(r), false);
            assert.equal(hal_relay_read_feedback(r), false);
        }
    });

    test('P1-E6: System state relays match HAL cmd after hal_init', () => {
        assert.equal(hal_init(), true);
        const state = createDefaultSystemState();
        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(state.relays.cmd[i], hal_relay_read_cmd(i));
        }
    });
});

describe('Group F: I2C3 Mock Behavior', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
    });

    test('P1-F1: Device ready checks valid 7-bit INA226 address', () => {
        assert.equal(hal_i2c3_is_device_ready(0x40), true);
        assert.equal(hal_i2c3_is_device_ready(0x41), false);
        assert.equal(hal_i2c3_is_device_ready(0x80), false);
        assert.equal(hal_i2c3_is_device_ready(-1), false);
        assert.equal(hal_i2c3_is_device_ready(1.5), false);
    });

    test('P1-F2: Read INA226 default reset and ID registers', () => {
        const out = { value: 0 };
        assert.equal(hal_i2c3_read_reg16(0x40, 0xFE, out), true);
        assert.equal(out.value, 0x5449);
        assert.equal(hal_i2c3_read_reg16(0x40, 0xFF, out), true);
        assert.equal(out.value, 0x2260);
        assert.equal(hal_i2c3_read_reg16(0x40, 0x00, out), true);
        assert.equal(out.value, 0x4127);
    });

    test('P1-F3: Write writable INA226 registers and boundary 0xFFFF', () => {
        const out = { value: 0 };
        assert.equal(hal_i2c3_write_reg16(0x40, 0x05, 0x0A00), true);
        assert.equal(hal_i2c3_read_reg16(0x40, 0x05, out), true);
        assert.equal(out.value, 0x0A00);
        assert.equal(hal_mock_get_ina226_register(0x05), 0x0A00);

        assert.equal(hal_i2c3_write_reg16(0x40, 0x00, 0x4527), true);
        assert.equal(hal_i2c3_write_reg16(0x40, 0x07, 0xFFFF), true);
        assert.equal(hal_mock_get_ina226_register(0x07), 0xFFFF);
    });

    test('P1-F4: Reject bus writes to read-only registers without modifying values', () => {
        assert.equal(hal_i2c3_write_reg16(0x40, 0x02, 0x9999), false);
        assert.equal(hal_mock_get_ina226_register(0x02), 0x0000);
        assert.equal(hal_i2c3_write_reg16(0x40, 0xFE, 0x1111), false);
        assert.equal(hal_mock_get_ina226_register(0xFE), 0x5449);
    });

    test('P1-F5: Reject invalid registers and clear out.value to 0', () => {
        for (const reg of [0x08, 0xFD]) {
            const out = { value: 0x1234 };
            assert.equal(hal_i2c3_read_reg16(0x40, reg, out), false);
            assert.equal(out.value, 0);
            assert.equal(hal_i2c3_write_reg16(0x40, reg, 0x0001), false);
        }
    });

    test('P1-F6: Reject invalid out-object, out-of-range values, and wrong address', () => {
        assert.equal(hal_i2c3_read_reg16(0x40, 0x00, null), false);
        assert.equal(hal_i2c3_read_reg16(0x40, 0x00, undefined), false);
        assert.equal(hal_i2c3_read_reg16(0x40, 0x00, 5), false);

        assert.equal(hal_i2c3_write_reg16(0x40, 0x05, 0x10000), false);
        assert.equal(hal_i2c3_write_reg16(0x40, 0x05, -1), false);
        assert.equal(hal_i2c3_write_reg16(0x40, 0x05, 1.5), false);
        assert.equal(hal_i2c3_write_reg16(0x40, 256, 1), false);

        const out = { value: 99 };
        assert.equal(hal_i2c3_read_reg16(0x41, 0x00, out), false);
        assert.equal(out.value, 0);
        assert.equal(hal_i2c3_write_reg16(0x41, 0x00, 0x4127), false);
    });

    test('P1-F7: Offline I2C mode blocks all bus operations and restores on online', () => {
        hal_mock_set_i2c_online(false);
        assert.equal(hal_i2c3_is_device_ready(0x40), false);
        const out = { value: 0x5555 };
        assert.equal(hal_i2c3_read_reg16(0x40, 0x00, out), false);
        assert.equal(out.value, 0);
        assert.equal(hal_i2c3_write_reg16(0x40, 0x05, 0x1234), false);
        assert.equal(hal_mock_get_ina226_register(0x05), 0);

        hal_mock_set_i2c_online(true);
        assert.equal(hal_i2c3_is_device_ready(0x40), true);
        assert.equal(hal_i2c3_write_reg16(0x40, 0x05, 0x1234), true);
        assert.equal(hal_i2c3_read_reg16(0x40, 0x05, out), true);
        assert.equal(out.value, 0x1234);
    });

    test('P1-F8: Backdoor register injection and inspection', () => {
        assert.equal(hal_mock_set_ina226_register(0x01, 0x1234), true);
        const out = { value: 0 };
        assert.equal(hal_i2c3_read_reg16(0x40, 0x01, out), true);
        assert.equal(out.value, 0x1234);

        assert.equal(hal_mock_set_ina226_register(0x08, 0x1111), false);
        assert.equal(hal_mock_set_ina226_register(0x05, 0x10000), false);
        assert.equal(hal_mock_get_ina226_register(0x08), 0);
    });

    test('P1-F9: hal_mock_set_i2c_online throws TypeError on non-boolean', () => {
        assert.throws(() => hal_mock_set_i2c_online('yes'), TypeError);
    });
});

describe('Group G: ADC1 PA0 Mock Behavior', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
    });

    test('P1-G1: Raw ADC reads and pin voltage conversion', () => {
        const rawOut = { value: 0 };
        const vOut = { value: 0 };

        assert.equal(hal_mock_set_adc_pa0_raw(0), true);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 0);
        assert.equal(hal_adc_pa0_read_pin_voltage(vOut), true);
        assert.equal(vOut.value, 0);

        assert.equal(hal_mock_set_adc_pa0_raw(4095), true);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 4095);
        assert.equal(hal_adc_pa0_read_pin_voltage(vOut), true);
        approx(vOut.value, 3.3);

        assert.equal(hal_mock_set_adc_pa0_raw(2048), true);
        assert.equal(hal_adc_pa0_read_pin_voltage(vOut), true);
        approx(vOut.value, (2048 / 4095) * 3.3);
    });

    test('P1-G2: Raw saturation on >4095 and rejection on invalid uint16', () => {
        const rawOut = { value: 0 };
        assert.equal(hal_mock_set_adc_pa0_raw(5000), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 4095);

        assert.equal(hal_mock_set_adc_pa0_raw(100), true);
        assert.equal(hal_mock_set_adc_pa0_raw(-1), false);
        assert.equal(hal_mock_set_adc_pa0_raw(70000), false);
        assert.equal(hal_mock_set_adc_pa0_raw(1.5), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 100);
    });

    test('P1-G3: Set pin voltage converts to quantized 12-bit raw', () => {
        const rawOut = { value: 0 };
        const vOut = { value: 0 };

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(2.0), true);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 2482);
        assert.equal(hal_adc_pa0_read_pin_voltage(vOut), true);
        approx(vOut.value, 2.0, 3.3 / 4095);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(0), true);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 0);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(3.3), true);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 4095);
    });

    test('P1-G4: Out-of-range, NaN, Infinity, and wrong type handling for pin voltage', () => {
        const rawOut = { value: 0 };

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(3.5), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 4095);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(-0.2), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 0);

        assert.equal(hal_mock_set_adc_pa0_raw(500), true);
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(Number.NaN), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 0);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(Infinity), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 4095);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(-Infinity), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 0);

        assert.equal(hal_mock_set_adc_pa0_raw(1234), true);
        assert.equal(hal_mock_set_adc_pa0_pin_voltage('abc'), false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 1234);
    });

    test('P1-G5: ADC fault zeros out-params and preserves underlying raw value', () => {
        assert.equal(hal_mock_set_adc_pa0_raw(777), true);
        hal_mock_set_adc_fault(true);

        const rawOut = { value: 999 };
        const vOut = { value: 999 };
        assert.equal(hal_adc_pa0_read_raw(rawOut), false);
        assert.equal(rawOut.value, 0);
        assert.equal(hal_adc_pa0_read_pin_voltage(vOut), false);
        assert.equal(vOut.value, 0);

        hal_mock_set_adc_fault(false);
        assert.equal(hal_adc_pa0_read_raw(rawOut), true);
        assert.equal(rawOut.value, 777);
    });

    test('P1-G6: Null out-object returns false', () => {
        assert.equal(hal_adc_pa0_read_raw(null), false);
        assert.equal(hal_adc_pa0_read_pin_voltage(null), false);
    });

    test('P1-G7: Divider round-trip conversion preserves 14.8 V within 1 LSB', () => {
        const vOut = { value: 0 };
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(14.8 / VSENSE_DIVIDER_RATIO), true);
        assert.equal(hal_adc_pa0_read_pin_voltage(vOut), true);
        approx(vOut.value * VSENSE_DIVIDER_RATIO, 14.8, 6 * (3.3 / 4095));
    });

    test('P1-G8: Uninitialized ADC read fails and zeros out', () => {
        hal_mock_reset();
        const rawOut = { value: 123 };
        assert.equal(hal_adc_pa0_read_raw(rawOut), false);
        assert.equal(rawOut.value, 0);
    });
});

describe('Group H: Relay Mock & Ring Log Behavior', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        hal_mock_clear_relay_log();
    });

    test('P1-H1: Individual relay write/read_cmd/read_feedback isolation', () => {
        const relays = [RELAY_1_MAIN, RELAY_2_CHARGE, RELAY_3_LOAD, RELAY_4_AUX];
        for (const r of relays) {
            assert.equal(hal_relay_write(r, true), true);
            assert.equal(hal_relay_read_cmd(r), true);
            assert.equal(hal_relay_read_feedback(r), true);
            for (const other of relays) {
                if (other !== r) {
                    assert.equal(hal_relay_read_cmd(other), false);
                }
            }
            assert.equal(hal_relay_write(r, false), true);
            assert.equal(hal_relay_read_cmd(r), false);
            assert.equal(hal_relay_read_feedback(r), false);
        }
    });

    test('P1-H2: Reject invalid relay_id or non-boolean closed without logging', () => {
        for (const badId of [4, -1, 1.5, '0', null, RELAY_COUNT]) {
            assert.equal(hal_relay_write(badId, true), false);
            assert.equal(hal_relay_read_cmd(badId), false);
            assert.equal(hal_relay_read_feedback(badId), false);
        }
        assert.equal(hal_mock_get_relay_log_count(), 0);

        for (const badClosed of [1, 'true', null]) {
            assert.equal(hal_relay_write(RELAY_1_MAIN, badClosed), false);
        }
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
        assert.equal(hal_mock_get_relay_log_count(), 0);
    });

    test('P1-H3: hal_relay_open_all opens all 4 relays in R3 -> R2 -> R4 -> R1 order', () => {
        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(hal_relay_write(i, true), true);
        }
        hal_relay_open_all();

        for (let i = 0; i < RELAY_COUNT; i++) {
            assert.equal(hal_relay_read_cmd(i), false);
            assert.equal(hal_relay_read_feedback(i), false);
        }

        const count = hal_mock_get_relay_log_count();
        assert.equal(count, 8);
        const last4 = [];
        for (let i = count - 4; i < count; i++) {
            const ev = {};
            assert.equal(hal_mock_get_relay_event(i, ev), true);
            assert.equal(ev.closed, false);
            last4.push(ev.relay_id);
        }
        assert.deepEqual(last4, [2, 1, 3, 0]);
    });

    test('P1-H4: Stuck-closed and stuck-open relay overrides', () => {
        assert.equal(hal_mock_set_relay_feedback_override(RELAY_1_MAIN, true, true), true);
        assert.equal(hal_relay_write(RELAY_1_MAIN, false), true);
        assert.equal(hal_relay_read_cmd(RELAY_1_MAIN), false);
        assert.equal(hal_relay_read_feedback(RELAY_1_MAIN), true);

        assert.equal(hal_mock_set_relay_feedback_override(RELAY_3_LOAD, true, false), true);
        assert.equal(hal_relay_write(RELAY_3_LOAD, true), true);
        assert.equal(hal_relay_read_cmd(RELAY_3_LOAD), true);
        assert.equal(hal_relay_read_feedback(RELAY_3_LOAD), false);

        hal_relay_open_all();
        assert.equal(hal_relay_read_feedback(RELAY_1_MAIN), true);

        assert.equal(hal_mock_set_relay_feedback_override(RELAY_1_MAIN, false, false), true);
        assert.equal(hal_relay_read_feedback(RELAY_1_MAIN), false);

        hal_mock_reset();
        hal_init();
        assert.equal(hal_relay_read_feedback(RELAY_1_MAIN), false);
        assert.equal(hal_relay_read_feedback(RELAY_3_LOAD), false);
    });

    test('P1-H5: Override rejects invalid relay_id and non-boolean flags', () => {
        assert.equal(hal_mock_set_relay_feedback_override(4, true, true), false);
        assert.equal(hal_mock_set_relay_feedback_override(RELAY_1_MAIN, 1, true), false);
        assert.equal(hal_mock_set_relay_feedback_override(RELAY_1_MAIN, true, 'yes'), false);
    });

    test('P1-H6: Relay event log records tick_ms and checks bounds/null', () => {
        hal_mock_set_tick_ms(500);
        assert.equal(hal_relay_write(RELAY_2_CHARGE, true), true);
        const ev = {};
        assert.equal(hal_mock_get_relay_event(0, ev), true);
        assert.deepEqual(ev, { relay_id: 1, closed: true, tick_ms: 500 });

        assert.equal(hal_mock_get_relay_event(99, ev), false);
        assert.equal(hal_mock_get_relay_event(0, null), false);
    });

    test('P1-H7: Relay log ring buffer keeps latest 64 events', () => {
        for (let i = 0; i < 70; i++) {
            assert.equal(hal_relay_write(RELAY_4_AUX, i % 2 === 0), true);
        }
        assert.equal(hal_mock_get_relay_log_count(), 64);

        const first = {};
        const last = {};
        assert.equal(hal_mock_get_relay_event(0, first), true);
        assert.equal(first.relay_id, RELAY_4_AUX);
        assert.equal(first.closed, true);

        assert.equal(hal_mock_get_relay_event(63, last), true);
        assert.equal(last.relay_id, RELAY_4_AUX);
        assert.equal(last.closed, false);
    });
});

describe('Group I: SPI1 OLED Mock Behavior', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
    });

    test('P1-I1: Uninitialized OLED calls fail', () => {
        hal_mock_reset();
        assert.equal(hal_oled_reset(), false);
        assert.equal(hal_oled_write_cmd(0xAE), false);
        assert.equal(hal_oled_write_data(new Uint8Array([1, 2, 3]), 3), false);
    });

    test('P1-I2: OLED reset advances tick by 20 ms and updates reset_count and res_pin', () => {
        const t0 = hal_get_tick_ms();
        assert.equal(hal_oled_reset(), true);
        const st = hal_mock_get_oled_state();
        assert.equal(st.reset_count, 1);
        assert.equal(hal_get_tick_ms() - t0, 20);
        assert.equal(st.res_pin, true);
    });

    test('P1-I3: OLED write_cmd logs byte and restores cs_pin/dc_pin', () => {
        assert.equal(hal_oled_write_cmd(0xAE), true);
        const st = hal_mock_get_oled_state();
        assert.equal(st.cmd_count, 1);
        assert.equal(st.cmd_log[st.cmd_log_len - 1], 0xAE);
        assert.equal(st.cs_pin, true);
        assert.equal(st.dc_pin, false);
    });

    test('P1-I4: OLED write_cmd rejects invalid uint8 values', () => {
        for (const bad of [256, -1, 1.5, 'A']) {
            assert.equal(hal_oled_write_cmd(bad), false);
        }
        assert.equal(hal_mock_get_oled_state().cmd_count, 0);
    });

    test('P1-I5: OLED write_data accepts full 1024-byte framebuffer', () => {
        const buf = new Uint8Array(1024).fill(0xAA);
        assert.equal(hal_oled_write_data(buf, 1024), true);
        const st = hal_mock_get_oled_state();
        assert.equal(st.last_data_len, 1024);
        assert.equal(st.last_data.every((b) => b === 0xAA), true);
        assert.equal(st.dc_pin, true);
        assert.equal(st.cs_pin, true);
        assert.equal(st.data_write_count, 1);
    });

    test('P1-I6: Partial OLED write_data zero-pads remainder of last_data', () => {
        assert.equal(hal_oled_write_data(new Uint8Array(1024).fill(0xAA), 1024), true);
        assert.equal(hal_oled_write_data(new Uint8Array(16).fill(0x55), 16), true);
        const st = hal_mock_get_oled_state();
        assert.equal(st.last_data_len, 16);
        for (let i = 0; i < 16; i++) {
            assert.equal(st.last_data[i], 0x55);
        }
        for (let i = 16; i < 1024; i++) {
            assert.equal(st.last_data[i], 0);
        }
    });

    test('P1-I7: OLED write_data enforces length and data validation', () => {
        assert.equal(hal_oled_write_data(new Uint8Array(4), 0), false);
        assert.equal(hal_oled_write_data(new Uint8Array(1025), 1025), false);
        assert.equal(hal_oled_write_data(new Uint8Array(10), 100), false);
        assert.equal(hal_oled_write_data(null, 4), false);
        assert.equal(hal_oled_write_data([1, 256], 2), false);
        assert.equal(hal_oled_write_data([1, 2, 3], 1.5), false);

        const stBefore = hal_mock_get_oled_state();
        assert.equal(stBefore.data_write_count, 0);
        assert.equal(stBefore.last_data_len, 0);

        assert.equal(hal_oled_write_data([1, 2, 3], 3), true);
        const stAfter = hal_mock_get_oled_state();
        assert.equal(stAfter.data_write_count, 1);
        assert.equal(stAfter.last_data_len, 3);
        assert.deepEqual(Array.from(stAfter.last_data.slice(0, 3)), [1, 2, 3]);
    });

    test('P1-I8: OLED cmd_log ring keeps latest 256 commands', () => {
        for (let i = 0; i < 300; i++) {
            assert.equal(hal_oled_write_cmd(i & 0xFF), true);
        }
        const st = hal_mock_get_oled_state();
        assert.equal(st.cmd_count, 300);
        assert.equal(st.cmd_log_len, 256);
        assert.equal(st.cmd_log[0], 44 & 0xFF);
        assert.equal(st.cmd_log[255], 299 & 0xFF);
    });

    test('P1-I9: SPI fault blocks cmd/data without affecting OLED reset', () => {
        hal_mock_set_spi_fault(true);
        assert.equal(hal_oled_write_cmd(0xAE), false);
        assert.equal(hal_oled_write_data(new Uint8Array([1, 2]), 2), false);
        assert.equal(hal_mock_get_oled_state().cmd_count, 0);
        assert.equal(hal_mock_get_oled_state().data_write_count, 0);
        assert.equal(hal_oled_reset(), true);

        hal_mock_set_spi_fault(false);
        assert.equal(hal_oled_write_cmd(0xAF), true);
    });

    test('P1-I10: hal_mock_get_oled_state returns an isolated copy', () => {
        assert.equal(hal_oled_write_data(new Uint8Array([0x77]), 1), true);
        assert.equal(hal_oled_write_cmd(0xAE), true);
        const st = hal_mock_get_oled_state();
        st.last_data[0] = 0x00;
        st.cmd_log.push(1);

        const fresh = hal_mock_get_oled_state();
        assert.equal(fresh.last_data[0], 0x77);
        assert.equal(fresh.cmd_log_len, 1);
        assert.deepEqual(fresh.cmd_log, [0xAE]);
    });
});

describe('Group J: System Tick & 32-bit Wraparound', () => {
    beforeEach(() => {
        hal_mock_reset();
    });

    test('P1-J1: Tick set, advance, and delay_ms', () => {
        assert.equal(hal_get_tick_ms(), 0);
        hal_mock_advance_tick_ms(10);
        assert.equal(hal_get_tick_ms(), 10);
        hal_delay_ms(5);
        assert.equal(hal_get_tick_ms(), 15);
        hal_delay_ms(0);
        assert.equal(hal_get_tick_ms(), 15);
        hal_mock_set_tick_ms(1000);
        assert.equal(hal_get_tick_ms(), 1000);
    });

    test('P1-J2: 32-bit unsigned wraparound arithmetic', () => {
        hal_mock_set_tick_ms(0xFFFFFFF0);
        hal_mock_advance_tick_ms(0x20);
        assert.equal(hal_get_tick_ms(), 0x10);
        assert.equal((0x10 - 0xFFFFFFF0) >>> 0, 0x20);

        hal_mock_set_tick_ms(0xFFFFFFFF);
        hal_delay_ms(1);
        assert.equal(hal_get_tick_ms(), 0);
    });

    test('P1-J3: Tick functions throw RangeError / TypeError on bad args', () => {
        assert.throws(() => hal_mock_set_tick_ms(2 ** 32), RangeError);
        assert.throws(() => hal_mock_set_tick_ms(-1), RangeError);
        assert.throws(() => hal_mock_set_tick_ms(1.5), RangeError);
        assert.throws(() => hal_mock_advance_tick_ms(Number.NaN), RangeError);
        assert.throws(() => hal_delay_ms('5'), TypeError);
    });
});

describe('Group K: Full hal_mock_reset()', () => {
    test('P1-K1: hal_mock_reset restores clean factory state across every subsystem', () => {
        assert.equal(hal_init(), true);
        hal_mock_set_tick_ms(999);
        assert.equal(hal_i2c3_write_reg16(0x40, 0x05, 0x1234), true);
        hal_mock_set_i2c_online(false);
        assert.equal(hal_mock_set_adc_pa0_raw(1000), true);
        hal_mock_set_adc_fault(true);
        hal_mock_set_spi_fault(true);
        assert.equal(hal_mock_set_relay_feedback_override(RELAY_1_MAIN, true, true), true);
        assert.equal(hal_relay_write(RELAY_2_CHARGE, true), true);
        assert.equal(hal_oled_reset(), true);

        hal_mock_reset();
        assert.equal(hal_mock_is_initialized(), false);
        assert.equal(hal_get_tick_ms(), 0);

        assert.equal(hal_init(), true);
        assert.equal(hal_i2c3_is_device_ready(0x40), true);
        const regOut = { value: 0 };
        assert.equal(hal_i2c3_read_reg16(0x40, 0x05, regOut), true);
        assert.equal(regOut.value, 0);
        assert.equal(hal_i2c3_read_reg16(0x40, 0x00, regOut), true);
        assert.equal(regOut.value, 0x4127);

        const adcOut = { value: 99 };
        assert.equal(hal_adc_pa0_read_raw(adcOut), true);
        assert.equal(adcOut.value, 0);

        assert.equal(hal_oled_write_cmd(0xAE), true);
        assert.equal(hal_relay_read_feedback(RELAY_1_MAIN), false);
        assert.equal(hal_relay_read_cmd(RELAY_2_CHARGE), false);

        const oled = hal_mock_get_oled_state();
        assert.equal(oled.reset_count, 0);
        assert.equal(oled.data_write_count, 0);
        assert.equal(hal_mock_get_relay_log_count(), 4);
    });
});
