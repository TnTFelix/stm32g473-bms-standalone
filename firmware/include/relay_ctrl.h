#ifndef RELAY_CTRL_H
#define RELAY_CTRL_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

bool relay_ctrl_init(bms_system_state_t *state);
bool relay_ctrl_sync(bms_system_state_t *state);
bool relay_ctrl_has_mismatch(const bms_system_state_t *state);
bool relay_ctrl_set(bms_system_state_t *state, bms_relay_id_t relay_id, bool closed);
bool relay_ctrl_isolate_all(bms_system_state_t *state);
bool relay_ctrl_apply_protection(bms_system_state_t *state);

#endif /* RELAY_CTRL_H */
