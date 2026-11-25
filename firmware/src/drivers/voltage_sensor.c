#include "voltage_sensor.h"
#include "hal_interface.h"
#include <stddef.h>

static bool s_vsense_initialized = false;
static bool s_vsense_filter_primed = false;
static float s_vsense_filtered_pin_v = 0.0f;

static void voltage_sensor_clear_filter(void)
{
    s_vsense_filter_primed = false;
    s_vsense_filtered_pin_v = 0.0f;
}

void voltage_sensor_reset(void)
{
    s_vsense_initialized = false;
    voltage_sensor_clear_filter();
}

bool voltage_sensor_init(void)
{
    uint16_t raw = 0U;
    float pin_v;

    voltage_sensor_reset();

    if (!hal_adc_pa0_read_raw(&raw)) {
        return false;
    }

    pin_v = ((float)raw / (float)ADC_RESOLUTION) * ADC_VREF_V;
    if (pin_v > ADC_PIN_MAX_SAFE_V) {
        return false;
    }

    s_vsense_initialized = true;
    return true;
}

bool voltage_sensor_read(bms_measurements_t *meas)
{
    uint16_t raw = 0U;
    float raw_pin_v;

    if (meas == NULL) {
        return false;
    }

    if (!s_vsense_initialized) {
        meas->vsense_ok = false;
        meas->charger_present = false;
        return false;
    }

    if (!hal_adc_pa0_read_raw(&raw)) {
        voltage_sensor_clear_filter();
        meas->charger_adc_raw = 0U;
        meas->charger_pin_v = 0.0f;
        meas->charger_voltage_v = 0.0f;
        meas->charger_present = false;
        meas->vsense_ok = false;
        return false;
    }

    raw_pin_v = ((float)raw / (float)ADC_RESOLUTION) * ADC_VREF_V;
    if (raw_pin_v > ADC_PIN_MAX_SAFE_V) {
        voltage_sensor_clear_filter();
        meas->charger_adc_raw = raw;
        meas->charger_pin_v = raw_pin_v;
        meas->charger_voltage_v = raw_pin_v * VSENSE_DIVIDER_RATIO;
        meas->charger_present = false;
        meas->vsense_ok = false;
        return false;
    }

    if (!s_vsense_filter_primed) {
        s_vsense_filtered_pin_v = raw_pin_v;
        s_vsense_filter_primed = true;
    } else {
        s_vsense_filtered_pin_v = (VSENSE_FILTER_ALPHA * raw_pin_v) +
                                  ((1.0f - VSENSE_FILTER_ALPHA) * s_vsense_filtered_pin_v);
    }

    meas->charger_adc_raw = raw;
    meas->charger_pin_v = s_vsense_filtered_pin_v;
    meas->charger_voltage_v = s_vsense_filtered_pin_v * VSENSE_DIVIDER_RATIO;
    meas->charger_present = (meas->charger_voltage_v >= CHARGER_PRESENT_MIN_V);
    meas->vsense_ok = true;
    return true;
}

float voltage_sensor_raw_to_charger_v(uint16_t raw)
{
    uint16_t clamped = (raw > ADC_RESOLUTION) ? (uint16_t)ADC_RESOLUTION : raw;
    return ((float)clamped / (float)ADC_RESOLUTION) * ADC_VREF_V * VSENSE_DIVIDER_RATIO;
}
