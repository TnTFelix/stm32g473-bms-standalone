#ifndef INA226_H
#define INA226_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

void     ina226_reset(void);
bool     ina226_init(void);
bool     ina226_read(bms_measurements_t *meas);
float    ina226_get_last_raw_current_a(void);
uint16_t ina226_encode_bus_voltage_reg(float bus_v);
uint16_t ina226_encode_shunt_current_reg(float current_a);

#endif /* INA226_H */
