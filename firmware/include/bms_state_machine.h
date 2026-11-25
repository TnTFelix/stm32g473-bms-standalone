#ifndef BMS_STATE_MACHINE_H
#define BMS_STATE_MACHINE_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

void bms_state_machine_reset(void);
bool bms_state_machine_init(bms_system_state_t *state);
bool bms_state_machine_is_charger_valid(const bms_measurements_t *meas);
bool bms_state_machine_is_charge_complete(const bms_measurements_t *meas);
bool bms_state_machine_step(bms_system_state_t *state, uint32_t dt_ms);

#endif /* BMS_STATE_MACHINE_H */
