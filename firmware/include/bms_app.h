#ifndef BMS_APP_H
#define BMS_APP_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

#define BMS_HISTORY_CAPACITY 16U

typedef struct {
    uint32_t timestamp_ms;
    bms_mode_t mode;
    bms_prot_level_t prot_level;
    uint32_t fault_mask;
    float bus_voltage_v;
    float current_a;
    float soc_pct;
} bms_history_entry_t;

void     bms_app_reset(void);
bool     bms_app_init(bms_system_state_t *state);
bool     bms_app_step(bms_system_state_t *state, uint32_t dt_ms);
bool     bms_app_next_page(bms_system_state_t *state);
bool     bms_app_set_page(bms_system_state_t *state, bms_oled_page_t page);
bool     bms_app_request_fault_clear(bms_system_state_t *state);
uint16_t bms_app_get_history_count(void);
bool     bms_app_get_history_entry(uint16_t index, bms_history_entry_t *out_entry);

#endif /* BMS_APP_H */
