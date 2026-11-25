#ifndef HAL_INTERFACE_H
#define HAL_INTERFACE_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

/* Core HAL API (15 functions implemented in both hal_stm32g4.c and hal_mock.c) */
bool     hal_init(void);
void     hal_relay_open_all(void);
bool     hal_i2c3_is_device_ready(uint8_t dev_addr7);
bool     hal_i2c3_write_reg16(uint8_t dev_addr7, uint8_t reg, uint16_t value);
bool     hal_i2c3_read_reg16(uint8_t dev_addr7, uint8_t reg, uint16_t *out_value);
bool     hal_adc_pa0_read_raw(uint16_t *out_raw);
bool     hal_adc_pa0_read_pin_voltage(float *out_pin_v);
bool     hal_relay_write(bms_relay_id_t relay_id, bool closed);
bool     hal_relay_read_cmd(bms_relay_id_t relay_id);
bool     hal_relay_read_feedback(bms_relay_id_t relay_id);
bool     hal_oled_reset(void);
bool     hal_oled_write_cmd(uint8_t cmd);
bool     hal_oled_write_data(const uint8_t *data, uint16_t len);
uint32_t hal_get_tick_ms(void);
void     hal_delay_ms(uint32_t ms);

#if defined(BMS_HOST_SIM)

#define HAL_MOCK_OLED_CMD_LOG_SIZE  256U
#define HAL_MOCK_RELAY_LOG_SIZE     64U

typedef struct {
    uint8_t relay_id;
    bool closed;
    uint32_t tick_ms;
} hal_mock_relay_event_t;

typedef struct {
    uint32_t reset_count;
    uint32_t cmd_count;
    uint16_t cmd_log_len;
    uint8_t cmd_log[HAL_MOCK_OLED_CMD_LOG_SIZE];
    uint32_t data_write_count;
    uint16_t last_data_len;
    uint8_t last_data[OLED_BUFFER_SIZE];
    bool cs_pin;
    bool dc_pin;
    bool res_pin;
} hal_mock_oled_state_t;

/* Host mock control and inspection API (16 functions, hal_mock.c only) */
void     hal_mock_reset(void);
void     hal_mock_set_i2c_online(bool online);
bool     hal_mock_set_ina226_register(uint8_t reg, uint16_t value);
uint16_t hal_mock_get_ina226_register(uint8_t reg);
bool     hal_mock_set_adc_pa0_raw(uint16_t raw);
bool     hal_mock_set_adc_pa0_pin_voltage(float pin_v);
void     hal_mock_set_adc_fault(bool fault);
void     hal_mock_set_spi_fault(bool fault);
bool     hal_mock_set_relay_feedback_override(bms_relay_id_t relay_id, bool override_enabled, bool forced_feedback);
void     hal_mock_set_tick_ms(uint32_t tick_ms);
void     hal_mock_advance_tick_ms(uint32_t delta_ms);
bool     hal_mock_is_initialized(void);
const hal_mock_oled_state_t *hal_mock_get_oled_state(void);
uint16_t hal_mock_get_relay_log_count(void);
bool     hal_mock_get_relay_event(uint16_t index, hal_mock_relay_event_t *out_event);
void     hal_mock_clear_relay_log(void);

#endif /* BMS_HOST_SIM */

#endif /* HAL_INTERFACE_H */
