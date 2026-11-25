#ifndef VOLTAGE_SENSOR_H
#define VOLTAGE_SENSOR_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

void  voltage_sensor_reset(void);
bool  voltage_sensor_init(void);
bool  voltage_sensor_read(bms_measurements_t *meas);
float voltage_sensor_raw_to_charger_v(uint16_t raw);

#endif /* VOLTAGE_SENSOR_H */
