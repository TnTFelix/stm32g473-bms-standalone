#ifndef BMS_ESTIMATOR_H
#define BMS_ESTIMATOR_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

bool     bms_estimator_init(bms_system_state_t *state);
float    bms_estimator_calc_efficiency_pct(float energy_in_wh, float energy_out_wh);
float    bms_estimator_ocv_to_soc_pct(float ocv_v);
bool     bms_estimator_apply_rest_ocv_correction(bms_system_state_t *state);
uint32_t bms_estimator_get_rest_time_ms(void);
bool     bms_estimator_step(bms_system_state_t *state, uint32_t dt_ms);

#endif /* BMS_ESTIMATOR_H */
