#ifndef BMS_PROTECTION_H
#define BMS_PROTECTION_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

void bms_protection_reset(void);
bool bms_protection_init(bms_system_state_t *state);
bool bms_protection_is_recovery_safe(const bms_system_state_t *state);
bool bms_protection_request_fault_clear(bms_system_state_t *state);
bool bms_protection_step(bms_system_state_t *state, uint32_t dt_ms);

#endif /* BMS_PROTECTION_H */
