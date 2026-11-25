#ifndef BMS_CONFIG_H
#define BMS_CONFIG_H

/*
 * Hardware assumptions for STM32G473VET6 4S BMS:
 * 1. Relay driver stage uses external pull resistors holding all relays in the
 *    OPEN state from power-on until hal_init() configures GPIOC (STM32G4 GPIO
 *    pins default to analog high-Z after reset).
 * 2. I2C3 lines (PC8 SCL, PC9 SDA) have external 4.7 kOhm pull-up resistors.
 * 3. RELAY_ACTIVE_HIGH selects relay coil polarity (1 = active-high, 0 = active-low).
 */

/* A. GPIO port IDs and STM32G473VET6 pin mapping */
#define BMS_PORT_A                      0U
#define BMS_PORT_B                      1U
#define BMS_PORT_C                      2U

#define OLED_SCK_PORT                   BMS_PORT_A
#define OLED_SCK_PIN                    5U
#define OLED_MOSI_PORT                  BMS_PORT_A
#define OLED_MOSI_PIN                   7U
#define OLED_RES_PORT                   BMS_PORT_B
#define OLED_RES_PIN                    5U
#define OLED_CS_PORT                    BMS_PORT_B
#define OLED_CS_PIN                     6U
#define OLED_DC_PORT                    BMS_PORT_B
#define OLED_DC_PIN                     7U

#define INA226_SCL_PORT                 BMS_PORT_C
#define INA226_SCL_PIN                  8U
#define INA226_SDA_PORT                 BMS_PORT_C
#define INA226_SDA_PIN                  9U

#define VSENSE_ADC_PORT                 BMS_PORT_A
#define VSENSE_ADC_PIN                  0U

#define RELAY1_MAIN_PORT                BMS_PORT_C
#define RELAY1_MAIN_PIN                 0U
#define RELAY2_CHARGE_PORT              BMS_PORT_C
#define RELAY2_CHARGE_PIN               1U
#define RELAY3_LOAD_PORT                BMS_PORT_C
#define RELAY3_LOAD_PIN                 2U
#define RELAY4_AUX_PORT                 BMS_PORT_C
#define RELAY4_AUX_PIN                  3U

#define SWD_SWDIO_PORT                  BMS_PORT_A
#define SWD_SWDIO_PIN                   13U
#define SWD_SWCLK_PORT                  BMS_PORT_A
#define SWD_SWCLK_PIN                   14U

#define OLED_SPI_INSTANCE               1U
#define INA226_I2C_INSTANCE             3U
#define VSENSE_ADC_INSTANCE             1U
#define VSENSE_ADC_CHANNEL              1U
#define RELAY_ACTIVE_HIGH               1U

/* B. 4S battery pack parameters */
#define BMS_CELL_COUNT                  4U
#define BMS_NOMINAL_V                   14.8f
#define BMS_FULL_V                      16.8f
#define BMS_EMPTY_V                     12.0f
#define BMS_NOMINAL_CAPACITY_AH         10.0f
#define BMS_CHARGE_EFFICIENCY           0.95f
#define BMS_INITIAL_SOC_PCT             80.0f

/* C. INA226 current/voltage sensor and shunt configuration */
#define INA226_I2C_ADDR                 0x40U
#define INA226_SHUNT_OHM                0.002f
#define INA226_SHUNT_MAX_V              0.08192f
#define INA226_CURRENT_SIGN             1
#define INA226_BUS_VALID_MIN_V          6.0f
#define INA226_BUS_VALID_MAX_V          22.0f

#define INA226_REG_CONFIG               0x00U
#define INA226_REG_SHUNT_V              0x01U
#define INA226_REG_BUS_V                0x02U
#define INA226_REG_POWER                0x03U
#define INA226_REG_CURRENT              0x04U
#define INA226_REG_CALIBRATION          0x05U
#define INA226_REG_MASK_ENABLE          0x06U
#define INA226_REG_ALERT_LIMIT          0x07U
#define INA226_REG_MANUFACTURER_ID      0xFEU
#define INA226_REG_DIE_ID               0xFFU
#define INA226_MANUFACTURER_ID_VALUE    0x5449U
#define INA226_DIE_ID_VALUE             0x2260U
#define INA226_CONFIG_RESET_VALUE       0x4127U
#define INA226_BUS_LSB_V                0.00125f
#define INA226_SHUNT_LSB_MV             0.0025f
#define INA226_CURRENT_LSB_A            0.001f
#define INA226_CALIBRATION_VALUE        2560U
#define INA226_BUS_REG_MAX              0x7FFFU
#define INA226_FILTER_ALPHA             0.50f

/* D. Charger input voltage sensor on ADC1 PA0 */
#define ADC_VREF_V                      3.3f
#define ADC_RESOLUTION                  4095U
#define ADC_PIN_MAX_SAFE_V              3.25f
#define VSENSE_DIVIDER_RATIO            6.0f
#define VSENSE_FILTER_ALPHA             0.40f
#define CHARGER_PRESENT_MIN_V           5.0f
#define CHARGER_VALID_MIN_V             13.0f
#define CHARGER_VALID_MAX_V             17.2f

/* E. Mode detection thresholds */
#define CHARGE_CURRENT_MIN_A            0.10f
#define DISCHARGE_CURRENT_MIN_A         0.10f
#define CHARGE_DONE_CURRENT_A           0.15f
#define CHARGE_DONE_VOLTAGE_V           16.75f
#define REST_CURRENT_THRESHOLD_A        0.05f
#define CHARGE_CV_COMPENSATION          1.15f
#define CHARGE_REENABLE_HYST_V          0.30f
#define OCV_REST_QUALIFY_MS             3000U
#define OCV_CORRECTION_BLEND            0.10f
#define STARTUP_PRECHARGE_MS            30U
#define ESTIMATOR_AVG_CURRENT_ALPHA     0.20f
#define ESTIMATOR_MAX_DT_MS             60000U

/* F. Protection thresholds, debounce, loop periods and OLED geometry */
#define PROT_BAT_OV_WARN_V              16.7f
#define PROT_BAT_OV_TRIP_V              16.9f
#define PROT_BAT_OV_CRIT_V              17.2f
#define PROT_BAT_UV_WARN_V              12.6f
#define PROT_BAT_UV_TRIP_V              12.0f
#define PROT_BAT_UV_CRIT_V              11.2f
#define PROT_CHG_OC_WARN_A              4.5f
#define PROT_CHG_OC_TRIP_A              5.0f
#define PROT_DIS_OC_WARN_A              13.5f
#define PROT_DIS_OC_TRIP_A              15.0f
#define PROT_SHORT_CIRCUIT_A            25.0f
#define PROT_DI_DT_MAX_A_PER_STEP       15.0f
#define PROT_CHARGER_OV_WARN_V          17.2f
#define PROT_CHARGER_OV_TRIP_V          17.5f
#define PROT_DEBOUNCE_NORM_MS           30U
#define PROT_DEBOUNCE_FAST_MS           0U
#define CONTROL_LOOP_PERIOD_MS          10U
#define OLED_REFRESH_PERIOD_MS          200U
#define OLED_AUTO_PAGE_MS               3000U
#define OLED_WIDTH                      128U
#define OLED_HEIGHT                     64U
#define OLED_BUFFER_SIZE                1024U

/* G. HAL timing and system clock constants */
#define OLED_RESET_PULSE_MS             10U
#define OLED_RESET_RECOVERY_MS          10U
#define BMS_I2C_TIMEOUT_MS              5U
#define BMS_SPI_TIMEOUT_MS              10U
#define BMS_ADC_TIMEOUT_MS              2U
#define BMS_SYSCLK_HZ                   170000000U

#endif /* BMS_CONFIG_H */
