import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    ADC_PIN_MAX_SAFE_V,
    ADC_RESOLUTION,
    ADC_VREF_V,
    ESTIMATOR_AVG_CURRENT_ALPHA,
    ESTIMATOR_MAX_DT_MS,
    INA226_BUS_REG_MAX,
    INA226_CALIBRATION_VALUE,
    INA226_CONFIG_RESET_VALUE,
    INA226_CURRENT_LSB_A,
    INA226_FILTER_ALPHA,
    INA226_REG_BUS_V,
    INA226_REG_CALIBRATION,
    INA226_REG_CONFIG,
    INA226_REG_DIE_ID,
    INA226_REG_MANUFACTURER_ID,
    INA226_REG_SHUNT_V,
    INA226_SHUNT_OHM,
    VSENSE_DIVIDER_RATIO,
    VSENSE_FILTER_ALPHA
} from '../sim/bms_config.mjs';

import { createDefaultSystemState } from '../sim/bms_types.mjs';

import {
    hal_init,
    hal_mock_get_ina226_register,
    hal_mock_reset,
    hal_mock_set_adc_fault,
    hal_mock_set_adc_pa0_pin_voltage,
    hal_mock_set_i2c_online,
    hal_mock_set_ina226_register
} from '../sim/hal_mock.mjs';

import {
    ina226_encode_bus_voltage_reg,
    ina226_encode_shunt_current_reg,
    ina226_get_last_raw_current_a,
    ina226_init,
    ina226_read,
    ina226_reset
} from '../sim/drivers/ina226.mjs';

import {
    voltage_sensor_init,
    voltage_sensor_raw_to_charger_v,
    voltage_sensor_read,
    voltage_sensor_reset
} from '../sim/drivers/voltage_sensor.mjs';

import {
    bms_estimator_calc_efficiency_pct,
    bms_estimator_init,
    bms_estimator_step
} from '../sim/core/bms_estimator.mjs';

function approx(actual, expected, eps = 1e-6, msg) {
    assert.ok(
        Math.abs(actual - expected) <= eps,
        msg ?? `Expected ${actual} to be within ${eps} of ${expected}`
    );
}

function injectIna226(bus_v, current_a) {
    assert.equal(hal_mock_set_ina226_register(INA226_REG_BUS_V, ina226_encode_bus_voltage_reg(bus_v)), true);
    assert.equal(hal_mock_set_ina226_register(INA226_REG_SHUNT_V, ina226_encode_shunt_current_reg(current_a)), true);
}

describe('Suite 1: INA226 Calibration & Register Encoding (P2-A1..A4)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        ina226_reset();
        voltage_sensor_reset();
    });

    test('P2-A1: Calibration constant and EMA filter alphas', () => {
        const expectedCal = Math.floor(0.00512 / (INA226_CURRENT_LSB_A * INA226_SHUNT_OHM));
        assert.equal(expectedCal, 2560);
        assert.equal(INA226_CALIBRATION_VALUE, 0x0A00);
        assert.ok(INA226_CALIBRATION_VALUE <= 0x7FFF);
        assert.ok(INA226_FILTER_ALPHA > 0 && INA226_FILTER_ALPHA <= 1);
        assert.ok(VSENSE_FILTER_ALPHA > 0 && VSENSE_FILTER_ALPHA <= 1);
        assert.ok(ESTIMATOR_AVG_CURRENT_ALPHA > 0 && ESTIMATOR_AVG_CURRENT_ALPHA <= 1);
    });

    test('P2-A2: ina226_encode_bus_voltage_reg conversions and clamping', () => {
        assert.equal(ina226_encode_bus_voltage_reg(14.8), 11840);
        assert.equal(ina226_encode_bus_voltage_reg(16.8), 13440);
        assert.equal(ina226_encode_bus_voltage_reg(0), 0);
        assert.equal(ina226_encode_bus_voltage_reg(-5), 0);
        assert.equal(ina226_encode_bus_voltage_reg(Number.NaN), 0);
        assert.equal(ina226_encode_bus_voltage_reg(50), INA226_BUS_REG_MAX);
        assert.equal(ina226_encode_bus_voltage_reg(Infinity), 0x7FFF);
    });

    test('P2-A3: ina226_encode_shunt_current_reg signed 2s complement and saturation', () => {
        assert.equal(ina226_encode_shunt_current_reg(5.0), 4000);
        assert.equal(ina226_encode_shunt_current_reg(-12.0), 0xDA80);
        assert.equal(ina226_encode_shunt_current_reg(-40.96), 0x8000);
        assert.equal(ina226_encode_shunt_current_reg(40.95875), 0x7FFF);
        assert.equal(ina226_encode_shunt_current_reg(100), 0x7FFF);
        assert.equal(ina226_encode_shunt_current_reg(-100), 0x8000);
        assert.equal(ina226_encode_shunt_current_reg(Number.NaN), 0);
        assert.equal(ina226_encode_shunt_current_reg(0), 0);
    });

    test('P2-A4: ina226_init verifies IDs, writes config/cal, and fails on bus/ID/init errors', () => {
        assert.equal(ina226_init(), true);
        assert.equal(hal_mock_get_ina226_register(INA226_REG_CONFIG), INA226_CONFIG_RESET_VALUE);
        assert.equal(hal_mock_get_ina226_register(INA226_REG_CALIBRATION), 0x0A00);

        hal_mock_set_i2c_online(false);
        assert.equal(ina226_init(), false);

        hal_mock_set_i2c_online(true);
        assert.equal(hal_mock_set_ina226_register(INA226_REG_MANUFACTURER_ID, 0x1234), true);
        assert.equal(ina226_init(), false);

        hal_mock_reset();
        hal_init();
        assert.equal(hal_mock_set_ina226_register(INA226_REG_DIE_ID, 0x9999), true);
        assert.equal(ina226_init(), false);

        hal_mock_reset();
        assert.equal(ina226_init(), false);
    });
});

describe('Suite 2: INA226 Read, EMA, Short-Circuit Surge & Recovery (P2-B1..B7)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        ina226_reset();
        voltage_sensor_reset();
    });

    test('P2-B1: Reject invalid meas object and uninitialized ina226_read', () => {
        assert.equal(ina226_read(null), false);
        assert.equal(ina226_read(undefined), false);
        assert.equal(ina226_read([]), false);

        const state = createDefaultSystemState();
        state.meas.ina226_ok = true;
        assert.equal(ina226_read(state.meas), false);
        assert.equal(state.meas.ina226_ok, false);
    });

    test('P2-B2: Charge and discharge readings compute current, shunt_mv, and power_w', () => {
        assert.equal(ina226_init(), true);
        const state = createDefaultSystemState();

        injectIna226(15.2, 5.0);
        assert.equal(ina226_read(state.meas), true);
        assert.equal(state.meas.ina226_ok, true);
        approx(state.meas.bus_voltage_v, 15.2);
        approx(state.meas.shunt_voltage_mv, 10.0);
        approx(state.meas.current_a, 5.0);
        approx(state.meas.power_w, 76.0);
        approx(ina226_get_last_raw_current_a(), 5.0);

        ina226_reset();
        assert.equal(ina226_init(), true);
        injectIna226(14.4, -12.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.bus_voltage_v, 14.4);
        approx(state.meas.shunt_voltage_mv, -24.0);
        approx(state.meas.current_a, -12.0);
        approx(state.meas.power_w, -172.8);
        approx(ina226_get_last_raw_current_a(), -12.0);
    });

    test('P2-B3: Normal-step EMA convergence and prev_current_a tracking', () => {
        assert.equal(ina226_init(), true);
        const state = createDefaultSystemState();

        injectIna226(14.8, 2.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.current_a, 2.0);
        approx(state.meas.prev_current_a, 0.0);

        injectIna226(14.8, 4.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.prev_current_a, 2.0);
        approx(state.meas.current_a, 3.0);

        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.prev_current_a, 3.0);
        approx(state.meas.current_a, 3.5);

        for (let k = 0; k < 25; k++) {
            assert.equal(ina226_read(state.meas), true);
        }
        approx(state.meas.current_a, 4.0, 1e-5);
    });

    test('P2-B4: Short-circuit and high dI/dt surge bypass EMA immediately', () => {
        assert.equal(ina226_init(), true);
        const state = createDefaultSystemState();

        injectIna226(14.8, 0.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.current_a, 0.0);

        injectIna226(14.8, -25.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.current_a, -25.0);
        approx(state.meas.prev_current_a, 0.0);
        approx(ina226_get_last_raw_current_a(), -25.0);

        ina226_reset();
        assert.equal(ina226_init(), true);
        injectIna226(14.8, -2.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.current_a, -2.0);

        injectIna226(14.8, -18.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.current_a, -18.0);
        approx(Math.abs(state.meas.current_a - state.meas.prev_current_a), 16.0);

        assert.equal(hal_mock_set_ina226_register(INA226_REG_SHUNT_V, 0x8000), true);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.current_a, -40.96);
    });

    test('P2-B5: Out-of-range bus voltage preserves raw diagnostic bus_v and clears current/power', () => {
        assert.equal(ina226_init(), true);
        const state = createDefaultSystemState();

        injectIna226(5.5, 2.0);
        assert.equal(ina226_read(state.meas), false);
        assert.equal(state.meas.ina226_ok, false);
        assert.equal(state.meas.current_a, 0);
        assert.equal(state.meas.power_w, 0);
        approx(state.meas.bus_voltage_v, 5.5);
        assert.equal(ina226_get_last_raw_current_a(), 0);

        injectIna226(22.5, 2.0);
        assert.equal(ina226_read(state.meas), false);
        assert.equal(state.meas.ina226_ok, false);
        assert.equal(state.meas.current_a, 0);
        assert.equal(state.meas.power_w, 0);
        approx(state.meas.bus_voltage_v, 22.5);

        assert.equal(hal_mock_set_ina226_register(INA226_REG_BUS_V, 0x8000), true);
        assert.equal(ina226_read(state.meas), false);
        assert.equal(state.meas.ina226_ok, false);
        assert.equal(state.meas.current_a, 0);
        assert.equal(state.meas.power_w, 0);
        approx(state.meas.bus_voltage_v, 0x8000 * 0.00125);
    });

    test('P2-B6: Mid-operation I2C disconnect zeroes meas fields and sets ina226_ok=false', () => {
        assert.equal(ina226_init(), true);
        const state = createDefaultSystemState();
        injectIna226(15.0, 3.0);
        assert.equal(ina226_read(state.meas), true);

        hal_mock_set_i2c_online(false);
        assert.equal(ina226_read(state.meas), false);
        assert.equal(state.meas.ina226_ok, false);
        assert.equal(state.meas.bus_voltage_v, 0);
        assert.equal(state.meas.current_a, 0);
        assert.equal(state.meas.power_w, 0);
    });

    test('P2-B7: Filter resets on fault so recovery uses fresh first sample directly', () => {
        assert.equal(ina226_init(), true);
        const state = createDefaultSystemState();

        injectIna226(16.0, 4.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.bus_voltage_v, 16.0);
        approx(state.meas.current_a, 4.0);

        hal_mock_set_i2c_online(false);
        assert.equal(ina226_read(state.meas), false);

        hal_mock_set_i2c_online(true);
        injectIna226(13.0, -6.0);
        assert.equal(ina226_read(state.meas), true);
        approx(state.meas.bus_voltage_v, 13.0);
        approx(state.meas.current_a, -6.0);
    });
});

describe('Suite 3: Voltage Sensor PA0 Driver (P2-C1..C6)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        ina226_reset();
        voltage_sensor_reset();
    });

    test('P2-C1: voltage_sensor_init checks ADC health and PA0 <= 3.25 V safe limit', () => {
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(2.5), true);
        assert.equal(voltage_sensor_init(), true);

        hal_mock_set_adc_fault(true);
        assert.equal(voltage_sensor_init(), false);

        hal_mock_set_adc_fault(false);
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(3.28), true);
        assert.equal(voltage_sensor_init(), false);

        hal_mock_reset();
        assert.equal(voltage_sensor_init(), false);
    });

    test('P2-C2: Invalid meas/uninitialized read and raw_to_charger_v conversion', () => {
        assert.equal(voltage_sensor_read(null), false);

        const state = createDefaultSystemState();
        state.meas.vsense_ok = true;
        state.meas.charger_present = true;
        assert.equal(voltage_sensor_read(state.meas), false);
        assert.equal(state.meas.vsense_ok, false);
        assert.equal(state.meas.charger_present, false);

        assert.equal(voltage_sensor_raw_to_charger_v(0), 0);
        approx(voltage_sensor_raw_to_charger_v(4095), 19.8);
        approx(voltage_sensor_raw_to_charger_v(5000), 19.8);
        assert.equal(voltage_sensor_raw_to_charger_v(-1), 0);
        assert.equal(voltage_sensor_raw_to_charger_v(Number.NaN), 0);
    });

    test('P2-C3: Charger voltage scaling and CHARGER_PRESENT_MIN_V boundary', () => {
        assert.equal(voltage_sensor_init(), true);
        const state = createDefaultSystemState();

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(2.8), true);
        assert.equal(voltage_sensor_read(state.meas), true);
        assert.equal(state.meas.vsense_ok, true);
        assert.equal(state.meas.charger_present, true);
        approx(state.meas.charger_voltage_v, 16.8, 0.01);

        voltage_sensor_reset();
        assert.equal(voltage_sensor_init(), true);
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(4.8 / VSENSE_DIVIDER_RATIO), true);
        assert.equal(voltage_sensor_read(state.meas), true);
        assert.equal(state.meas.vsense_ok, true);
        assert.equal(state.meas.charger_present, false);

        voltage_sensor_reset();
        assert.equal(voltage_sensor_init(), true);
        // 12-bit ADC quantization: raw 1034 -> 4.9996 V (< 5.0 V), raw 1035 -> 5.0044 V (>= 5.0 V)
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(5.005 / VSENSE_DIVIDER_RATIO), true);
        assert.equal(voltage_sensor_read(state.meas), true);
        assert.equal(state.meas.vsense_ok, true);
        assert.equal(state.meas.charger_present, true);
    });

    test('P2-C4: EMA filter primes on first sample and smooths noisy oscillations', () => {
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(14.4 / VSENSE_DIVIDER_RATIO), true);
        assert.equal(voltage_sensor_init(), true);
        const state = createDefaultSystemState();

        assert.equal(voltage_sensor_read(state.meas), true);
        approx(state.meas.charger_voltage_v, 14.4, 0.01);

        const outputs = [];
        for (let k = 0; k < 12; k++) {
            const target = (k % 2 === 0) ? 15.6 : 14.4;
            assert.equal(hal_mock_set_adc_pa0_pin_voltage(target / VSENSE_DIVIDER_RATIO), true);
            assert.equal(voltage_sensor_read(state.meas), true);
            outputs.push(state.meas.charger_voltage_v);
        }
        const maxSwing = Math.max(...outputs.slice(-2)) - Math.min(...outputs.slice(-2));
        assert.ok(maxSwing < 0.6, `Expected EMA to attenuate +/-0.6 V ripple, got swing=${maxSwing}`);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(15.0 / VSENSE_DIVIDER_RATIO), true);
        for (let k = 0; k < 25; k++) {
            assert.equal(voltage_sensor_read(state.meas), true);
        }
        approx(state.meas.charger_voltage_v, 15.0, 0.01);
    });

    test('P2-C5: Raw PA0 > 3.25 V triggers immediate overvoltage fault before EMA', () => {
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(2.5), true);
        assert.equal(voltage_sensor_init(), true);
        const state = createDefaultSystemState();

        assert.equal(voltage_sensor_read(state.meas), true);
        assert.equal(state.meas.vsense_ok, true);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(3.28), true);
        assert.equal(voltage_sensor_read(state.meas), false);
        assert.equal(state.meas.vsense_ok, false);
        assert.equal(state.meas.charger_present, false);
        assert.ok(state.meas.charger_pin_v > ADC_PIN_MAX_SAFE_V);
        approx(state.meas.charger_pin_v, 3.28, ADC_VREF_V / ADC_RESOLUTION);
    });

    test('P2-C6: ADC hardware fault clears meas and resets filter for clean recovery', () => {
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(2.8), true);
        assert.equal(voltage_sensor_init(), true);
        const state = createDefaultSystemState();

        assert.equal(voltage_sensor_read(state.meas), true);
        hal_mock_set_adc_fault(true);
        assert.equal(voltage_sensor_read(state.meas), false);
        assert.equal(state.meas.vsense_ok, false);
        assert.equal(state.meas.charger_present, false);
        assert.equal(state.meas.charger_adc_raw, 0);
        assert.equal(state.meas.charger_pin_v, 0);
        assert.equal(state.meas.charger_voltage_v, 0);

        hal_mock_set_adc_fault(false);
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(2.4), true);
        assert.equal(voltage_sensor_read(state.meas), true);
        approx(state.meas.charger_voltage_v, 14.4, 0.01);
    });
});

describe('Suite 4: Energy & Efficiency Estimator (P2-D1..D7)', () => {
    beforeEach(() => {
        hal_mock_reset();
        hal_init();
        ina226_reset();
        voltage_sensor_reset();
    });

    test('P2-D1: bms_estimator_init validates input and resets dirty energy state', () => {
        assert.equal(bms_estimator_init(null), false);
        assert.equal(bms_estimator_init(undefined), false);
        assert.equal(bms_estimator_init({}), false);

        const state = createDefaultSystemState();
        state.energy.energy_in_wh = 55;
        state.energy.energy_out_wh = 40;
        state.energy.charge_capacity_ah = 4;
        state.energy.discharge_capacity_ah = 3;
        state.energy.charge_power_w = 100;
        state.energy.soc_pct = 20;
        state.energy.efficiency_pct = 50;

        assert.equal(bms_estimator_init(state), true);
        assert.equal(state.energy.charge_power_w, 0);
        assert.equal(state.energy.discharge_power_w, 0);
        assert.equal(state.energy.energy_in_wh, 0);
        assert.equal(state.energy.energy_out_wh, 0);
        assert.equal(state.energy.charge_capacity_ah, 0);
        assert.equal(state.energy.discharge_capacity_ah, 0);
        assert.equal(state.energy.soc_pct, 80);
        approx(state.energy.remaining_capacity_ah, 8);
        assert.equal(state.energy.efficiency_pct, 100);
    });

    test('P2-D2: bms_estimator_calc_efficiency_pct handles zero-division, clamping, and non-finite inputs', () => {
        assert.equal(bms_estimator_calc_efficiency_pct(0, 0), 100);
        assert.equal(bms_estimator_calc_efficiency_pct(0, 5), 100);
        assert.equal(bms_estimator_calc_efficiency_pct(-1, 5), 100);
        assert.equal(bms_estimator_calc_efficiency_pct(10, 0), 0);
        approx(bms_estimator_calc_efficiency_pct(10, 9.2), 92);
        assert.equal(bms_estimator_calc_efficiency_pct(10, 12), 100);
        assert.equal(bms_estimator_calc_efficiency_pct(Number.NaN, 5), 0);
        assert.equal(bms_estimator_calc_efficiency_pct(10, Infinity), 0);
    });

    test('P2-D3 & P2-D4: Charge then discharge integration updates Wh, Ah, avg currents, and efficiency', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 15.0;
        state.meas.current_a = 4.0;

        for (let k = 0; k < 1000; k++) {
            assert.equal(bms_estimator_step(state, 10), true);
            if (k === 0) {
                approx(state.energy.avg_charge_current_a, 4.0);
            }
        }
        approx(state.energy.charge_power_w, 60.0);
        assert.equal(state.energy.discharge_power_w, 0);
        approx(state.energy.energy_in_wh, (60 * 10) / 3600, 1e-6);
        approx(state.energy.charge_capacity_ah, (4 * 10) / 3600, 1e-6);
        approx(state.energy.avg_charge_current_a, 4.0);
        assert.equal(state.energy.efficiency_pct, 0);

        state.meas.bus_voltage_v = 14.4;
        state.meas.current_a = -3.75;
        for (let k = 0; k < 1000; k++) {
            assert.equal(bms_estimator_step(state, 10), true);
        }
        approx(state.energy.discharge_power_w, 54.0);
        assert.equal(state.energy.charge_power_w, 0);
        approx(state.meas.power_w, -54.0);
        approx(state.energy.energy_out_wh, 0.15, 1e-6);
        approx(state.energy.discharge_capacity_ah, (3.75 * 10) / 3600, 1e-6);
        approx(state.energy.avg_discharge_current_a, 3.75);
        approx(state.energy.efficiency_pct, 90.0, 1e-4);
    });

    test('P2-D5: Zero current and dt_ms=0 update instantaneous power without modifying accumulators', () => {
        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 14.8;
        state.meas.current_a = 0;

        assert.equal(bms_estimator_step(state, 10), true);
        assert.equal(state.energy.charge_power_w, 0);
        assert.equal(state.energy.discharge_power_w, 0);
        assert.equal(state.energy.energy_in_wh, 0);
        assert.equal(state.energy.energy_out_wh, 0);

        state.meas.current_a = 2.5;
        assert.equal(bms_estimator_step(state, 0), true);
        approx(state.energy.charge_power_w, 37.0);
        assert.equal(state.energy.energy_in_wh, 0);
        assert.equal(state.energy.charge_capacity_ah, 0);
    });

    test('P2-D6: Reject invalid state, dt_ms, ina226_ok=false, and non-finite/negative measurements', () => {
        assert.equal(bms_estimator_step(null, 10), false);

        const state = createDefaultSystemState();
        assert.equal(bms_estimator_init(state), true);
        state.meas.ina226_ok = true;
        state.meas.bus_voltage_v = 15.0;
        state.meas.current_a = 2.0;
        assert.equal(bms_estimator_step(state, 1000), true);
        const savedEin = state.energy.energy_in_wh;

        for (const badDt of [ESTIMATOR_MAX_DT_MS + 1, -1, 1.5]) {
            assert.equal(bms_estimator_step(state, badDt), false);
            assert.equal(state.energy.energy_in_wh, savedEin);
        }

        state.meas.ina226_ok = false;
        assert.equal(bms_estimator_step(state, 10), false);
        assert.equal(state.meas.power_w, 0);
        assert.equal(state.energy.charge_power_w, 0);
        assert.equal(state.energy.discharge_power_w, 0);
        assert.equal(state.energy.energy_in_wh, savedEin);

        state.meas.ina226_ok = true;
        for (const [badU, badI] of [[Number.NaN, 1], [Infinity, 1], [-1, 1], [14.8, Number.NaN]]) {
            state.meas.bus_voltage_v = badU;
            state.meas.current_a = badI;
            assert.equal(bms_estimator_step(state, 10), false);
            assert.equal(state.meas.power_w, 0);
            assert.equal(state.energy.charge_power_w, 0);
            assert.equal(state.energy.discharge_power_w, 0);
            assert.equal(state.energy.energy_in_wh, savedEin);
        }
    });

    test('P2-D7: End-to-end Phase 2 pipeline from HAL mock through drivers and estimator', () => {
        const state = createDefaultSystemState();
        assert.equal(ina226_init(), true);
        assert.equal(hal_mock_set_adc_pa0_pin_voltage(16.8 / VSENSE_DIVIDER_RATIO), true);
        assert.equal(voltage_sensor_init(), true);
        assert.equal(bms_estimator_init(state), true);

        injectIna226(16.0, 3.0);
        for (let k = 0; k < 50; k++) {
            assert.equal(ina226_read(state.meas), true);
            assert.equal(voltage_sensor_read(state.meas), true);
            assert.equal(bms_estimator_step(state, 10), true);
        }
        assert.equal(state.meas.charger_present, true);
        approx(state.meas.bus_voltage_v, 16.0);
        approx(state.meas.current_a, 3.0);
        approx(state.energy.energy_in_wh, (48 * 0.5) / 3600, 1e-4);

        assert.equal(hal_mock_set_adc_pa0_pin_voltage(0), true);
        injectIna226(14.8, -5.0);
        for (let k = 0; k < 50; k++) {
            assert.equal(ina226_read(state.meas), true);
            assert.equal(voltage_sensor_read(state.meas), true);
            assert.equal(bms_estimator_step(state, 10), true);
        }
        assert.equal(state.meas.charger_present, false);
        approx(state.meas.current_a, -5.0, 1e-4);
        assert.ok(state.energy.energy_out_wh > 0);
        assert.ok(state.energy.discharge_capacity_ah > 0);
        assert.ok(state.energy.efficiency_pct > 0 && state.energy.efficiency_pct <= 100);
    });
});
