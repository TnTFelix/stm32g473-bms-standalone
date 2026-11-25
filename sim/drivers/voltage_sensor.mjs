import {
    ADC_PIN_MAX_SAFE_V,
    ADC_RESOLUTION,
    ADC_VREF_V,
    CHARGER_PRESENT_MIN_V,
    VSENSE_DIVIDER_RATIO,
    VSENSE_FILTER_ALPHA
} from '../bms_config.mjs';

import { hal_adc_pa0_read_raw } from '../hal_mock.mjs';

let s_vsense_initialized = false;
let s_vsense_filter_primed = false;
let s_vsense_filtered_pin_v = 0;

function clearFilter() {
    s_vsense_filter_primed = false;
    s_vsense_filtered_pin_v = 0;
}

export function voltage_sensor_reset() {
    s_vsense_initialized = false;
    clearFilter();
}

export function voltage_sensor_init() {
    const outRaw = { value: 0 };

    voltage_sensor_reset();

    if (!hal_adc_pa0_read_raw(outRaw)) {
        return false;
    }

    const pin_v = (outRaw.value / ADC_RESOLUTION) * ADC_VREF_V;
    if (pin_v > ADC_PIN_MAX_SAFE_V) {
        return false;
    }

    s_vsense_initialized = true;
    return true;
}

export function voltage_sensor_read(meas) {
    if (meas === null || typeof meas !== 'object' || Array.isArray(meas)) {
        return false;
    }

    if (!s_vsense_initialized) {
        meas.vsense_ok = false;
        meas.charger_present = false;
        return false;
    }

    const outRaw = { value: 0 };
    if (!hal_adc_pa0_read_raw(outRaw)) {
        clearFilter();
        meas.charger_adc_raw = 0;
        meas.charger_pin_v = 0;
        meas.charger_voltage_v = 0;
        meas.charger_present = false;
        meas.vsense_ok = false;
        return false;
    }

    const raw = outRaw.value;
    const raw_pin_v = (raw / ADC_RESOLUTION) * ADC_VREF_V;
    if (raw_pin_v > ADC_PIN_MAX_SAFE_V) {
        clearFilter();
        meas.charger_adc_raw = raw;
        meas.charger_pin_v = raw_pin_v;
        meas.charger_voltage_v = raw_pin_v * VSENSE_DIVIDER_RATIO;
        meas.charger_present = false;
        meas.vsense_ok = false;
        return false;
    }

    if (!s_vsense_filter_primed) {
        s_vsense_filtered_pin_v = raw_pin_v;
        s_vsense_filter_primed = true;
    } else {
        s_vsense_filtered_pin_v = (VSENSE_FILTER_ALPHA * raw_pin_v) +
            ((1 - VSENSE_FILTER_ALPHA) * s_vsense_filtered_pin_v);
    }

    meas.charger_adc_raw = raw;
    meas.charger_pin_v = s_vsense_filtered_pin_v;
    meas.charger_voltage_v = s_vsense_filtered_pin_v * VSENSE_DIVIDER_RATIO;
    meas.charger_present = (meas.charger_voltage_v >= CHARGER_PRESENT_MIN_V);
    meas.vsense_ok = true;
    return true;
}

export function voltage_sensor_raw_to_charger_v(raw) {
    if (!Number.isInteger(raw) || raw < 0 || raw > 0xFFFF) {
        return 0;
    }
    const clamped = (raw > ADC_RESOLUTION) ? ADC_RESOLUTION : raw;
    return (clamped / ADC_RESOLUTION) * ADC_VREF_V * VSENSE_DIVIDER_RATIO;
}
