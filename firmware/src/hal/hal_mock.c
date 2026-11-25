#if defined(USE_HAL_DRIVER)
#error "hal_mock.c is host-only; exclude it from the STM32 target build"
#endif
#if !defined(BMS_HOST_SIM)
#error "hal_mock.c requires -DBMS_HOST_SIM"
#endif

#include "hal_interface.h"
#include <stddef.h>
#include <string.h>

static bool s_mock_ready = false;
static bool s_initialized = false;
static uint32_t s_tick_ms = 0U;
static bool s_i2c_online = true;
static uint16_t s_ina226_regs[256];
static uint16_t s_adc_raw = 0U;
static bool s_adc_fault = false;
static bool s_spi_fault = false;
static bool s_relay_cmd[RELAY_COUNT];
static bool s_relay_override_en[RELAY_COUNT];
static bool s_relay_forced_fb[RELAY_COUNT];
static hal_mock_relay_event_t s_relay_log[HAL_MOCK_RELAY_LOG_SIZE];
static uint16_t s_relay_log_write_idx = 0U;
static uint16_t s_relay_log_count = 0U;
static hal_mock_oled_state_t s_oled;

static void mock_ensure_ready(void)
{
    if (!s_mock_ready) {
        hal_mock_reset();
    }
}

static bool mock_ina226_reg_is_valid(uint8_t reg)
{
    return (reg <= INA226_REG_ALERT_LIMIT) ||
           (reg == INA226_REG_MANUFACTURER_ID) ||
           (reg == INA226_REG_DIE_ID);
}

static bool mock_ina226_reg_is_writable(uint8_t reg)
{
    return (reg == INA226_REG_CONFIG) ||
           (reg == INA226_REG_CALIBRATION) ||
           (reg == INA226_REG_MASK_ENABLE) ||
           (reg == INA226_REG_ALERT_LIMIT);
}

static void mock_append_relay_log(uint8_t relay_id, bool closed)
{
    s_relay_log[s_relay_log_write_idx].relay_id = relay_id;
    s_relay_log[s_relay_log_write_idx].closed = closed;
    s_relay_log[s_relay_log_write_idx].tick_ms = s_tick_ms;
    s_relay_log_write_idx = (uint16_t)((s_relay_log_write_idx + 1U) % HAL_MOCK_RELAY_LOG_SIZE);
    if (s_relay_log_count < HAL_MOCK_RELAY_LOG_SIZE) {
        s_relay_log_count++;
    }
}

void hal_mock_reset(void)
{
    uint32_t i;

    s_mock_ready = true;
    s_initialized = false;
    s_tick_ms = 0U;
    s_i2c_online = true;

    (void)memset(s_ina226_regs, 0, sizeof(s_ina226_regs));
    s_ina226_regs[INA226_REG_CONFIG] = INA226_CONFIG_RESET_VALUE;
    s_ina226_regs[INA226_REG_MANUFACTURER_ID] = INA226_MANUFACTURER_ID_VALUE;
    s_ina226_regs[INA226_REG_DIE_ID] = INA226_DIE_ID_VALUE;

    s_adc_raw = 0U;
    s_adc_fault = false;
    s_spi_fault = false;

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        s_relay_cmd[i] = false;
        s_relay_override_en[i] = false;
        s_relay_forced_fb[i] = false;
    }

    (void)memset(s_relay_log, 0, sizeof(s_relay_log));
    s_relay_log_write_idx = 0U;
    s_relay_log_count = 0U;

    (void)memset(&s_oled, 0, sizeof(s_oled));
    s_oled.cs_pin = true;
    s_oled.dc_pin = false;
    s_oled.res_pin = false;
}

bool hal_init(void)
{
    mock_ensure_ready();
    hal_relay_open_all();
    s_oled.cs_pin = true;
    s_oled.dc_pin = false;
    s_oled.res_pin = true;
    s_initialized = true;
    return true;
}

void hal_relay_open_all(void)
{
    static const bms_relay_id_t k_open_order[RELAY_COUNT] = {
        RELAY_3_LOAD,
        RELAY_2_CHARGE,
        RELAY_4_AUX,
        RELAY_1_MAIN
    };
    uint32_t i;

    mock_ensure_ready();
    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        bms_relay_id_t id = k_open_order[i];
        s_relay_cmd[id] = false;
        mock_append_relay_log((uint8_t)id, false);
    }
}

bool hal_i2c3_is_device_ready(uint8_t dev_addr7)
{
    mock_ensure_ready();
    if (!s_initialized || !s_i2c_online || (dev_addr7 > 0x7FU)) {
        return false;
    }
    return (dev_addr7 == INA226_I2C_ADDR);
}

bool hal_i2c3_write_reg16(uint8_t dev_addr7, uint8_t reg, uint16_t value)
{
    mock_ensure_ready();
    if (!s_initialized || !s_i2c_online || (dev_addr7 > 0x7FU) ||
        (dev_addr7 != INA226_I2C_ADDR) || !mock_ina226_reg_is_writable(reg)) {
        return false;
    }
    s_ina226_regs[reg] = value;
    return true;
}

bool hal_i2c3_read_reg16(uint8_t dev_addr7, uint8_t reg, uint16_t *out_value)
{
    mock_ensure_ready();
    if (out_value == NULL) {
        return false;
    }
    *out_value = 0U;

    if (!s_initialized || !s_i2c_online || (dev_addr7 > 0x7FU) ||
        (dev_addr7 != INA226_I2C_ADDR) || !mock_ina226_reg_is_valid(reg)) {
        return false;
    }

    *out_value = s_ina226_regs[reg];
    return true;
}

bool hal_adc_pa0_read_raw(uint16_t *out_raw)
{
    uint16_t clamped;

    mock_ensure_ready();
    if (out_raw == NULL) {
        return false;
    }
    *out_raw = 0U;

    if (!s_initialized || s_adc_fault) {
        return false;
    }

    clamped = (s_adc_raw > ADC_RESOLUTION) ? (uint16_t)ADC_RESOLUTION : s_adc_raw;
    *out_raw = clamped;
    return true;
}

bool hal_adc_pa0_read_pin_voltage(float *out_pin_v)
{
    uint16_t raw = 0U;

    mock_ensure_ready();
    if (out_pin_v == NULL) {
        return false;
    }
    *out_pin_v = 0.0f;

    if (!hal_adc_pa0_read_raw(&raw)) {
        return false;
    }

    *out_pin_v = ((float)raw / (float)ADC_RESOLUTION) * ADC_VREF_V;
    return true;
}

bool hal_relay_write(bms_relay_id_t relay_id, bool closed)
{
    mock_ensure_ready();
    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }
    if (!s_initialized && closed) {
        return false;
    }

    s_relay_cmd[relay_id] = closed;
    mock_append_relay_log((uint8_t)relay_id, closed);
    return true;
}

bool hal_relay_read_cmd(bms_relay_id_t relay_id)
{
    mock_ensure_ready();
    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }
    return s_relay_cmd[relay_id];
}

bool hal_relay_read_feedback(bms_relay_id_t relay_id)
{
    mock_ensure_ready();
    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }
    return s_relay_override_en[relay_id] ? s_relay_forced_fb[relay_id] : s_relay_cmd[relay_id];
}

bool hal_oled_reset(void)
{
    mock_ensure_ready();
    if (!s_initialized) {
        return false;
    }

    s_oled.res_pin = false;
    hal_delay_ms(OLED_RESET_PULSE_MS);
    s_oled.res_pin = true;
    hal_delay_ms(OLED_RESET_RECOVERY_MS);
    s_oled.reset_count++;
    return true;
}

bool hal_oled_write_cmd(uint8_t cmd)
{
    mock_ensure_ready();
    if (!s_initialized || s_spi_fault) {
        return false;
    }

    s_oled.dc_pin = false;
    s_oled.cs_pin = false;
    s_oled.cmd_count++;

    if (s_oled.cmd_log_len < HAL_MOCK_OLED_CMD_LOG_SIZE) {
        s_oled.cmd_log[s_oled.cmd_log_len] = cmd;
        s_oled.cmd_log_len++;
    } else {
        (void)memmove(&s_oled.cmd_log[0], &s_oled.cmd_log[1], (size_t)(HAL_MOCK_OLED_CMD_LOG_SIZE - 1U));
        s_oled.cmd_log[HAL_MOCK_OLED_CMD_LOG_SIZE - 1U] = cmd;
    }

    s_oled.cs_pin = true;
    s_oled.dc_pin = false;
    return true;
}

bool hal_oled_write_data(const uint8_t *data, uint16_t len)
{
    mock_ensure_ready();
    if (data == NULL) {
        return false;
    }
    if ((len == 0U) || (len > OLED_BUFFER_SIZE)) {
        return false;
    }
    if (!s_initialized || s_spi_fault) {
        return false;
    }

    s_oled.dc_pin = true;
    s_oled.cs_pin = false;
    (void)memset(s_oled.last_data, 0, sizeof(s_oled.last_data));
    (void)memcpy(s_oled.last_data, data, (size_t)len);
    s_oled.last_data_len = len;
    s_oled.data_write_count++;
    s_oled.cs_pin = true;
    s_oled.dc_pin = true;
    return true;
}

uint32_t hal_get_tick_ms(void)
{
    mock_ensure_ready();
    return s_tick_ms;
}

void hal_delay_ms(uint32_t ms)
{
    mock_ensure_ready();
    s_tick_ms = (uint32_t)(s_tick_ms + ms);
}

void hal_mock_set_i2c_online(bool online)
{
    mock_ensure_ready();
    s_i2c_online = online;
}

bool hal_mock_set_ina226_register(uint8_t reg, uint16_t value)
{
    mock_ensure_ready();
    if (!mock_ina226_reg_is_valid(reg)) {
        return false;
    }
    s_ina226_regs[reg] = value;
    return true;
}

uint16_t hal_mock_get_ina226_register(uint8_t reg)
{
    mock_ensure_ready();
    if (!mock_ina226_reg_is_valid(reg)) {
        return 0U;
    }
    return s_ina226_regs[reg];
}

bool hal_mock_set_adc_pa0_raw(uint16_t raw)
{
    mock_ensure_ready();
    if (raw > ADC_RESOLUTION) {
        s_adc_raw = (uint16_t)ADC_RESOLUTION;
        return false;
    }
    s_adc_raw = raw;
    return true;
}

bool hal_mock_set_adc_pa0_pin_voltage(float pin_v)
{
    uint32_t rounded;

    mock_ensure_ready();
    if (pin_v != pin_v) {
        s_adc_raw = 0U;
        return false;
    }
    if (pin_v < 0.0f) {
        s_adc_raw = 0U;
        return false;
    }
    if (pin_v > ADC_VREF_V) {
        s_adc_raw = (uint16_t)ADC_RESOLUTION;
        return false;
    }

    rounded = (uint32_t)((pin_v / ADC_VREF_V) * (float)ADC_RESOLUTION + 0.5f);
    if (rounded > ADC_RESOLUTION) {
        rounded = ADC_RESOLUTION;
    }
    s_adc_raw = (uint16_t)rounded;
    return true;
}

void hal_mock_set_adc_fault(bool fault)
{
    mock_ensure_ready();
    s_adc_fault = fault;
}

void hal_mock_set_spi_fault(bool fault)
{
    mock_ensure_ready();
    s_spi_fault = fault;
}

bool hal_mock_set_relay_feedback_override(bms_relay_id_t relay_id, bool override_enabled, bool forced_feedback)
{
    mock_ensure_ready();
    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }
    s_relay_override_en[relay_id] = override_enabled;
    s_relay_forced_fb[relay_id] = forced_feedback;
    return true;
}

void hal_mock_set_tick_ms(uint32_t tick_ms)
{
    mock_ensure_ready();
    s_tick_ms = tick_ms;
}

void hal_mock_advance_tick_ms(uint32_t delta_ms)
{
    mock_ensure_ready();
    s_tick_ms = (uint32_t)(s_tick_ms + delta_ms);
}

bool hal_mock_is_initialized(void)
{
    mock_ensure_ready();
    return s_initialized;
}

const hal_mock_oled_state_t *hal_mock_get_oled_state(void)
{
    mock_ensure_ready();
    return &s_oled;
}

uint16_t hal_mock_get_relay_log_count(void)
{
    mock_ensure_ready();
    return s_relay_log_count;
}

bool hal_mock_get_relay_event(uint16_t index, hal_mock_relay_event_t *out_event)
{
    uint16_t oldest_idx;
    uint16_t slot;

    mock_ensure_ready();
    if (out_event == NULL) {
        return false;
    }
    (void)memset(out_event, 0, sizeof(*out_event));

    if (index >= s_relay_log_count) {
        return false;
    }

    oldest_idx = (uint16_t)((s_relay_log_write_idx + HAL_MOCK_RELAY_LOG_SIZE - s_relay_log_count) % HAL_MOCK_RELAY_LOG_SIZE);
    slot = (uint16_t)((oldest_idx + index) % HAL_MOCK_RELAY_LOG_SIZE);
    *out_event = s_relay_log[slot];
    return true;
}

void hal_mock_clear_relay_log(void)
{
    mock_ensure_ready();
    (void)memset(s_relay_log, 0, sizeof(s_relay_log));
    s_relay_log_write_idx = 0U;
    s_relay_log_count = 0U;
}
