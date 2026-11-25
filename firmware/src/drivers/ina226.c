#include "ina226.h"
#include "hal_interface.h"
#include <math.h>
#include <stddef.h>

static bool s_initialized = false;
static uint8_t s_active_addr = INA226_I2C_ADDR;
static bool s_filter_primed = false;
static float s_filtered_bus_v = 0.0f;
static float s_filtered_shunt_mv = 0.0f;
static float s_last_raw_current_a = 0.0f;
static float s_prev_raw_current_a = 0.0f;

static void ina226_clear_filter_state(void)
{
    s_filter_primed = false;
    s_filtered_bus_v = 0.0f;
    s_filtered_shunt_mv = 0.0f;
    s_last_raw_current_a = 0.0f;
    s_prev_raw_current_a = 0.0f;
}

void ina226_reset(void)
{
    s_initialized = false;
    s_active_addr = INA226_I2C_ADDR;
    ina226_clear_filter_state();
}

static bool ina226_try_init_addr(uint8_t addr)
{
    uint16_t mfg_id = 0U;
    uint16_t die_id = 0U;

    if (!hal_i2c3_is_device_ready(addr)) {
        return false;
    }
    if (!hal_i2c3_read_reg16(addr, INA226_REG_MANUFACTURER_ID, &mfg_id)) {
        return false;
    }
    if (mfg_id != INA226_MANUFACTURER_ID_VALUE) {
        return false;
    }
    if (!hal_i2c3_read_reg16(addr, INA226_REG_DIE_ID, &die_id)) {
        return false;
    }
    if (die_id != INA226_DIE_ID_VALUE) {
        return false;
    }
    if (!hal_i2c3_write_reg16(addr, INA226_REG_CONFIG, INA226_CONFIG_RESET_VALUE)) {
        return false;
    }
    if (!hal_i2c3_write_reg16(addr, INA226_REG_CALIBRATION, INA226_CALIBRATION_VALUE)) {
        return false;
    }

    s_active_addr = addr;
    s_initialized = true;
    return true;
}

bool ina226_init(void)
{
    uint8_t addr;

    ina226_reset();

    if (ina226_try_init_addr(INA226_I2C_ADDR)) {
        return true;
    }
    for (addr = 0x40U; addr <= 0x4FU; addr++) {
        if ((addr != INA226_I2C_ADDR) && ina226_try_init_addr(addr)) {
            return true;
        }
    }

    return false;
}

bool ina226_read(bms_measurements_t *meas)
{
    uint16_t reg_bus = 0U;
    uint16_t reg_shunt = 0U;
    float raw_bus_v;
    int16_t signed_shunt;
    float raw_shunt_mv;
    float raw_current_a;
    bool is_surge;

    if (meas == NULL) {
        return false;
    }

    meas->prev_current_a = meas->current_a;

    if (!s_initialized ||
        !hal_i2c3_is_device_ready(s_active_addr) ||
        !hal_i2c3_read_reg16(s_active_addr, INA226_REG_BUS_V, &reg_bus) ||
        !hal_i2c3_read_reg16(s_active_addr, INA226_REG_SHUNT_V, &reg_shunt)) {
        ina226_clear_filter_state();
        meas->bus_voltage_v = 0.0f;
        meas->shunt_voltage_mv = 0.0f;
        meas->current_a = 0.0f;
        meas->power_w = 0.0f;
        meas->ina226_ok = false;
        return false;
    }

    raw_bus_v = (float)reg_bus * INA226_BUS_LSB_V;
    signed_shunt = (int16_t)reg_shunt;
    raw_shunt_mv = (float)signed_shunt * INA226_SHUNT_LSB_MV;
    raw_current_a = (float)INA226_CURRENT_SIGN * ((raw_shunt_mv * 0.001f) / INA226_SHUNT_OHM);

    if ((reg_bus > INA226_BUS_REG_MAX) ||
        (raw_bus_v < INA226_BUS_VALID_MIN_V) ||
        (raw_bus_v > INA226_BUS_VALID_MAX_V) ||
        (fabsf(raw_shunt_mv * 0.001f) > (INA226_SHUNT_MAX_V + 1e-4f))) {
        ina226_clear_filter_state();
        meas->bus_voltage_v = raw_bus_v;
        meas->shunt_voltage_mv = raw_shunt_mv;
        meas->current_a = 0.0f;
        meas->power_w = 0.0f;
        meas->ina226_ok = false;
        return false;
    }

    is_surge = (fabsf(raw_current_a) >= PROT_SHORT_CIRCUIT_A) ||
               (s_filter_primed && (fabsf(raw_current_a - s_prev_raw_current_a) >= PROT_DI_DT_MAX_A_PER_STEP));

    if (!s_filter_primed) {
        s_filtered_bus_v = raw_bus_v;
        s_filtered_shunt_mv = raw_shunt_mv;
        s_filter_primed = true;
    } else {
        s_filtered_bus_v = (INA226_FILTER_ALPHA * raw_bus_v) +
                           ((1.0f - INA226_FILTER_ALPHA) * s_filtered_bus_v);
        if (is_surge) {
            s_filtered_shunt_mv = raw_shunt_mv;
        } else {
            s_filtered_shunt_mv = (INA226_FILTER_ALPHA * raw_shunt_mv) +
                                  ((1.0f - INA226_FILTER_ALPHA) * s_filtered_shunt_mv);
        }
    }

    s_prev_raw_current_a = raw_current_a;
    s_last_raw_current_a = raw_current_a;

    meas->bus_voltage_v = s_filtered_bus_v;
    meas->shunt_voltage_mv = s_filtered_shunt_mv;
    meas->current_a = (float)INA226_CURRENT_SIGN * ((s_filtered_shunt_mv * 0.001f) / INA226_SHUNT_OHM);
    meas->power_w = meas->bus_voltage_v * meas->current_a;
    meas->ina226_ok = true;
    return true;
}

float ina226_get_last_raw_current_a(void)
{
    return s_last_raw_current_a;
}

uint16_t ina226_encode_bus_voltage_reg(float bus_v)
{
    float counts;

    if ((bus_v != bus_v) || (bus_v <= 0.0f)) {
        return 0U;
    }
    if (!isfinite(bus_v)) {
        return INA226_BUS_REG_MAX;
    }

    counts = bus_v / INA226_BUS_LSB_V;
    if (counts >= (float)INA226_BUS_REG_MAX) {
        return INA226_BUS_REG_MAX;
    }
    return (uint16_t)floorf(counts + 0.5f);
}

uint16_t ina226_encode_shunt_current_reg(float current_a)
{
    float counts;
    int32_t rounded;

    if (current_a != current_a) {
        return 0U;
    }

    counts = (current_a * INA226_SHUNT_OHM * 1000.0f * (float)INA226_CURRENT_SIGN) / INA226_SHUNT_LSB_MV;
    if (counts >= 32767.0f) {
        rounded = 32767;
    } else if (counts <= -32768.0f) {
        rounded = -32768;
    } else {
        rounded = (counts >= 0.0f) ? (int32_t)floorf(counts + 0.5f) : (int32_t)ceilf(counts - 0.5f);
    }

    return (uint16_t)((int16_t)rounded);
}
