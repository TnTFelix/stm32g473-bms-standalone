#ifndef BMS_TYPES_H
#define BMS_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include "bms_config.h"

#define BMS_MODE_COUNT      5U
#define PROT_LEVEL_COUNT    5U
#define FAULT_COUNT         9U
#define FAULT_ALL_MASK      0x01FFU

typedef enum {
    BMS_MODE_STARTUP = 0,
    BMS_MODE_CHARGE = 1,
    BMS_MODE_DISCHARGE = 2,
    BMS_MODE_STANDBY = 3,
    BMS_MODE_FAULT = 4
} bms_mode_t;

typedef enum {
    PROT_LEVEL_1_NORMAL = 1,
    PROT_LEVEL_2_WARNING = 2,
    PROT_LEVEL_3_BRANCH = 3,
    PROT_LEVEL_4_ISOLATE = 4,
    PROT_LEVEL_5_LATCH = 5
} bms_prot_level_t;

typedef enum {
    FAULT_NONE = 0x0000U,
    FAULT_BAT_OVERVOLTAGE = (1U << 0),
    FAULT_BAT_UNDERVOLTAGE = (1U << 1),
    FAULT_CHG_OVERCURRENT = (1U << 2),
    FAULT_DIS_OVERCURRENT = (1U << 3),
    FAULT_SHORT_CIRCUIT = (1U << 4),
    FAULT_CHARGER_OVERVOLTAGE = (1U << 5),
    FAULT_INA226_DISCONNECTED = (1U << 6),
    FAULT_VSENSE_FAULT = (1U << 7),
    FAULT_RELAY_NO_RESPONSE = (1U << 8)
} bms_fault_code_t;

typedef enum {
    RELAY_1_MAIN = 0,
    RELAY_2_CHARGE = 1,
    RELAY_3_LOAD = 2,
    RELAY_4_AUX = 3,
    RELAY_COUNT = 4
} bms_relay_id_t;

typedef enum {
    OLED_PAGE_OVERVIEW = 0,
    OLED_PAGE_CHARGER = 1,
    OLED_PAGE_RELAYS = 2,
    OLED_PAGE_DIAGNOSTICS = 3,
    OLED_PAGE_COUNT = 4
} bms_oled_page_t;

typedef struct {
    float bus_voltage_v;
    float shunt_voltage_mv;
    float current_a;
    float prev_current_a;
    float power_w;
    uint16_t charger_adc_raw;
    float charger_pin_v;
    float charger_voltage_v;
    bool charger_present;
    bool ina226_ok;
    bool vsense_ok;
} bms_measurements_t;

typedef struct {
    float charge_power_w;
    float discharge_power_w;
    float energy_in_wh;
    float energy_out_wh;
    float charge_capacity_ah;
    float discharge_capacity_ah;
    float soc_pct;
    float remaining_capacity_ah;
    float avg_charge_current_a;
    float avg_discharge_current_a;
    float remaining_time_min;
    float estimated_charge_time_min;
    float efficiency_pct;
} bms_energy_state_t;

typedef struct {
    bool cmd[RELAY_COUNT];
    bool feedback[RELAY_COUNT];
    bool fault_mismatch[RELAY_COUNT];
} bms_relay_state_t;

typedef struct {
    bool valid;
    uint32_t latched_fault_mask;
    bms_prot_level_t prot_level;
    float bus_voltage_v;
    float charger_voltage_v;
    float current_a;
    float power_w;
    uint32_t timestamp_ms;
} bms_fault_snapshot_t;

typedef struct {
    bms_mode_t mode;
    bms_prot_level_t prot_level;
    uint32_t active_faults;
    uint32_t warning_flags;
    bool fault_latched;
    bool load_enabled_req;
    bool charge_enabled_req;
    uint32_t tick_ms;
    uint32_t last_control_tick_ms;
    uint32_t last_oled_tick_ms;
    uint32_t last_page_switch_tick_ms;
    bms_oled_page_t current_oled_page;
    bool oled_auto_cycle;
    bms_measurements_t meas;
    bms_energy_state_t energy;
    bms_relay_state_t relays;
    bms_fault_snapshot_t snapshot;
} bms_system_state_t;

static inline bool bms_system_state_init(bms_system_state_t *state)
{
    uint32_t i;

    if (state == NULL) {
        return false;
    }

    (void)memset(state, 0, sizeof(*state));
    state->mode = BMS_MODE_STARTUP;
    state->prot_level = PROT_LEVEL_1_NORMAL;
    state->snapshot.prot_level = PROT_LEVEL_1_NORMAL;
    state->current_oled_page = OLED_PAGE_OVERVIEW;
    state->oled_auto_cycle = true;
    state->energy.soc_pct = BMS_INITIAL_SOC_PCT;
    state->energy.remaining_capacity_ah = BMS_NOMINAL_CAPACITY_AH * (BMS_INITIAL_SOC_PCT / 100.0f);
    state->energy.efficiency_pct = 100.0f;

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        state->relays.cmd[i] = false;
        state->relays.feedback[i] = false;
        state->relays.fault_mismatch[i] = false;
    }

    return true;
}

#endif /* BMS_TYPES_H */
