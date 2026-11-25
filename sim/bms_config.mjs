/* A. GPIO port IDs and STM32G473VET6 pin mapping */
export const BMS_PORT_A = 0;
export const BMS_PORT_B = 1;
export const BMS_PORT_C = 2;

export const OLED_SCK_PORT = BMS_PORT_A;
export const OLED_SCK_PIN = 5;
export const OLED_MOSI_PORT = BMS_PORT_A;
export const OLED_MOSI_PIN = 7;
export const OLED_RES_PORT = BMS_PORT_B;
export const OLED_RES_PIN = 5;
export const OLED_CS_PORT = BMS_PORT_B;
export const OLED_CS_PIN = 6;
export const OLED_DC_PORT = BMS_PORT_B;
export const OLED_DC_PIN = 7;

export const INA226_SCL_PORT = BMS_PORT_C;
export const INA226_SCL_PIN = 8;
export const INA226_SDA_PORT = BMS_PORT_C;
export const INA226_SDA_PIN = 9;
export const INA226_ALERT_PORT = BMS_PORT_C;
export const INA226_ALERT_PIN = 13;

export const VSENSE_ADC_PORT = BMS_PORT_A;
export const VSENSE_ADC_PIN = 0;

export const RELAY1_MAIN_PORT = BMS_PORT_C;
export const RELAY1_MAIN_PIN = 0;
export const RELAY2_CHARGE_PORT = BMS_PORT_C;
export const RELAY2_CHARGE_PIN = 1;
export const RELAY3_LOAD_PORT = BMS_PORT_C;
export const RELAY3_LOAD_PIN = 2;
export const RELAY4_AUX_PORT = BMS_PORT_C;
export const RELAY4_AUX_PIN = 3;

export const SWD_SWDIO_PORT = BMS_PORT_A;
export const SWD_SWDIO_PIN = 13;
export const SWD_SWCLK_PORT = BMS_PORT_A;
export const SWD_SWCLK_PIN = 14;

export const OLED_SPI_INSTANCE = 1;
export const INA226_I2C_INSTANCE = 3;
export const VSENSE_ADC_INSTANCE = 1;
export const VSENSE_ADC_CHANNEL = 1;
export const RELAY_ACTIVE_HIGH = 1;

/* B. 4S battery pack parameters */
export const BMS_CELL_COUNT = 4;
export const BMS_NOMINAL_V = 14.8;
export const BMS_FULL_V = 16.8;
export const BMS_EMPTY_V = 12.0;
export const BMS_NOMINAL_CAPACITY_AH = 10.0;
export const BMS_CHARGE_EFFICIENCY = 0.992;
export const BMS_INITIAL_SOC_PCT = 80.0;

/* C. INA226 current/voltage sensor and shunt configuration */
export const INA226_I2C_ADDR = 0x40;
export const INA226_SHUNT_OHM = 0.002;
export const INA226_SHUNT_MAX_V = 0.08192;
export const INA226_CURRENT_SIGN = 1;
export const INA226_BUS_VALID_MIN_V = 6.0;
export const INA226_BUS_VALID_MAX_V = 22.0;

export const INA226_REG_CONFIG = 0x00;
export const INA226_REG_SHUNT_V = 0x01;
export const INA226_REG_BUS_V = 0x02;
export const INA226_REG_POWER = 0x03;
export const INA226_REG_CURRENT = 0x04;
export const INA226_REG_CALIBRATION = 0x05;
export const INA226_REG_MASK_ENABLE = 0x06;
export const INA226_REG_ALERT_LIMIT = 0x07;
export const INA226_REG_MANUFACTURER_ID = 0xFE;
export const INA226_REG_DIE_ID = 0xFF;
export const INA226_MANUFACTURER_ID_VALUE = 0x5449;
export const INA226_DIE_ID_VALUE = 0x2260;
export const INA226_CONFIG_RESET_VALUE = 0x4127;
export const INA226_BUS_LSB_V = 0.00125;
export const INA226_SHUNT_LSB_MV = 0.0025;
export const INA226_CURRENT_LSB_A = 0.001;
export const INA226_CALIBRATION_VALUE = 2560;
export const INA226_BUS_REG_MAX = 0x7FFF;
export const INA226_FILTER_ALPHA = 0.50;

/* D. Charger input voltage sensor on ADC1 PA0 (E96: R1 = 37.4 kOhm, R2 = 7.5 kOhm) */
export const ADC_VREF_V = 3.3;
export const ADC_RESOLUTION = 4095;
export const ADC_PIN_MAX_SAFE_V = 3.25;
export const VSENSE_DIVIDER_RATIO = 5.987;
export const VSENSE_FILTER_ALPHA = 0.40;
export const CHARGER_PRESENT_MIN_V = 5.0;
export const CHARGER_VALID_MIN_V = 13.0;
export const CHARGER_VALID_MAX_V = 17.2;

/* E. Mode detection thresholds */
export const CHARGE_CURRENT_MIN_A = 0.10;
export const DISCHARGE_CURRENT_MIN_A = 0.10;
export const CHARGE_DONE_CURRENT_A = 0.15;
export const CHARGE_DONE_VOLTAGE_V = 16.75;
export const REST_CURRENT_THRESHOLD_A = 0.05;
export const CHARGE_CV_COMPENSATION = 1.15;
export const CHARGE_REENABLE_HYST_V = 0.30;
export const CHARGE_CONFIRM_TIMEOUT_MS = 2000;
export const DISCHARGE_CONFIRM_TIMEOUT_MS = 2000;
export const OCV_REST_QUALIFY_MS = 1800000;
export const OCV_CORRECTION_BLEND = 0.10;
export const STARTUP_PRECHARGE_MS = 30;
export const ESTIMATOR_AVG_CURRENT_ALPHA = 0.20;
export const ESTIMATOR_MAX_DT_MS = 60000;

/* F. Protection thresholds, debounce, loop periods and OLED geometry */
export const PROT_BAT_OV_WARN_V = 16.65;
export const PROT_BAT_OV_TRIP_V = 16.85;
export const PROT_BAT_OV_CRIT_V = 16.90;
export const PROT_BAT_UV_WARN_V = 12.6;
export const PROT_BAT_UV_TRIP_V = 12.0;
export const PROT_BAT_UV_CRIT_V = 11.4;
export const PROT_CHG_OC_WARN_A = 4.5;
export const PROT_CHG_OC_TRIP_A = 5.0;
export const PROT_DIS_OC_WARN_A = 13.5;
export const PROT_DIS_OC_TRIP_A = 15.0;
export const PROT_SHORT_CIRCUIT_A = 18.0;
export const PROT_DI_DT_MAX_A_PER_STEP = 15.0;
export const PROT_CHARGER_OV_WARN_V = 17.2;
export const PROT_CHARGER_OV_TRIP_V = 17.5;
export const PROT_DEBOUNCE_NORM_MS = 30;
export const PROT_DEBOUNCE_FAST_MS = 0;
export const CONTROL_LOOP_PERIOD_MS = 10;
export const OLED_REFRESH_PERIOD_MS = 200;
export const OLED_AUTO_PAGE_MS = 3000;
export const OLED_WIDTH = 128;
export const OLED_HEIGHT = 64;
export const OLED_BUFFER_SIZE = 1024;

/* G. HAL timing and system clock constants */
export const OLED_RESET_PULSE_MS = 10;
export const OLED_RESET_RECOVERY_MS = 10;
export const BMS_I2C_TIMEOUT_MS = 5;
export const BMS_SPI_TIMEOUT_MS = 10;
export const BMS_ADC_TIMEOUT_MS = 2;
export const BMS_SYSCLK_HZ = 170000000;

export const BMS_PORT_NAMES = Object.freeze(['GPIOA', 'GPIOB', 'GPIOC']);

export const BMS_CONFIG = Object.freeze({
    BMS_PORT_A,
    BMS_PORT_B,
    BMS_PORT_C,
    OLED_SCK_PORT,
    OLED_SCK_PIN,
    OLED_MOSI_PORT,
    OLED_MOSI_PIN,
    OLED_RES_PORT,
    OLED_RES_PIN,
    OLED_CS_PORT,
    OLED_CS_PIN,
    OLED_DC_PORT,
    OLED_DC_PIN,
    INA226_SCL_PORT,
    INA226_SCL_PIN,
    INA226_SDA_PORT,
    INA226_SDA_PIN,
    INA226_ALERT_PORT,
    INA226_ALERT_PIN,
    VSENSE_ADC_PORT,
    VSENSE_ADC_PIN,
    RELAY1_MAIN_PORT,
    RELAY1_MAIN_PIN,
    RELAY2_CHARGE_PORT,
    RELAY2_CHARGE_PIN,
    RELAY3_LOAD_PORT,
    RELAY3_LOAD_PIN,
    RELAY4_AUX_PORT,
    RELAY4_AUX_PIN,
    SWD_SWDIO_PORT,
    SWD_SWDIO_PIN,
    SWD_SWCLK_PORT,
    SWD_SWCLK_PIN,
    OLED_SPI_INSTANCE,
    INA226_I2C_INSTANCE,
    VSENSE_ADC_INSTANCE,
    VSENSE_ADC_CHANNEL,
    RELAY_ACTIVE_HIGH,
    BMS_CELL_COUNT,
    BMS_NOMINAL_V,
    BMS_FULL_V,
    BMS_EMPTY_V,
    BMS_NOMINAL_CAPACITY_AH,
    BMS_CHARGE_EFFICIENCY,
    BMS_INITIAL_SOC_PCT,
    INA226_I2C_ADDR,
    INA226_SHUNT_OHM,
    INA226_SHUNT_MAX_V,
    INA226_CURRENT_SIGN,
    INA226_BUS_VALID_MIN_V,
    INA226_BUS_VALID_MAX_V,
    INA226_REG_CONFIG,
    INA226_REG_SHUNT_V,
    INA226_REG_BUS_V,
    INA226_REG_POWER,
    INA226_REG_CURRENT,
    INA226_REG_CALIBRATION,
    INA226_REG_MASK_ENABLE,
    INA226_REG_ALERT_LIMIT,
    INA226_REG_MANUFACTURER_ID,
    INA226_REG_DIE_ID,
    INA226_MANUFACTURER_ID_VALUE,
    INA226_DIE_ID_VALUE,
    INA226_CONFIG_RESET_VALUE,
    INA226_BUS_LSB_V,
    INA226_SHUNT_LSB_MV,
    INA226_CURRENT_LSB_A,
    INA226_CALIBRATION_VALUE,
    INA226_BUS_REG_MAX,
    INA226_FILTER_ALPHA,
    ADC_VREF_V,
    ADC_RESOLUTION,
    ADC_PIN_MAX_SAFE_V,
    VSENSE_DIVIDER_RATIO,
    VSENSE_FILTER_ALPHA,
    CHARGER_PRESENT_MIN_V,
    CHARGER_VALID_MIN_V,
    CHARGER_VALID_MAX_V,
    CHARGE_CURRENT_MIN_A,
    DISCHARGE_CURRENT_MIN_A,
    CHARGE_DONE_CURRENT_A,
    CHARGE_DONE_VOLTAGE_V,
    REST_CURRENT_THRESHOLD_A,
    CHARGE_CV_COMPENSATION,
    CHARGE_REENABLE_HYST_V,
    CHARGE_CONFIRM_TIMEOUT_MS,
    DISCHARGE_CONFIRM_TIMEOUT_MS,
    OCV_REST_QUALIFY_MS,
    OCV_CORRECTION_BLEND,
    STARTUP_PRECHARGE_MS,
    ESTIMATOR_AVG_CURRENT_ALPHA,
    ESTIMATOR_MAX_DT_MS,
    PROT_BAT_OV_WARN_V,
    PROT_BAT_OV_TRIP_V,
    PROT_BAT_OV_CRIT_V,
    PROT_BAT_UV_WARN_V,
    PROT_BAT_UV_TRIP_V,
    PROT_BAT_UV_CRIT_V,
    PROT_CHG_OC_WARN_A,
    PROT_CHG_OC_TRIP_A,
    PROT_DIS_OC_WARN_A,
    PROT_DIS_OC_TRIP_A,
    PROT_SHORT_CIRCUIT_A,
    PROT_DI_DT_MAX_A_PER_STEP,
    PROT_CHARGER_OV_WARN_V,
    PROT_CHARGER_OV_TRIP_V,
    PROT_DEBOUNCE_NORM_MS,
    PROT_DEBOUNCE_FAST_MS,
    CONTROL_LOOP_PERIOD_MS,
    OLED_REFRESH_PERIOD_MS,
    OLED_AUTO_PAGE_MS,
    OLED_WIDTH,
    OLED_HEIGHT,
    OLED_BUFFER_SIZE,
    OLED_RESET_PULSE_MS,
    OLED_RESET_RECOVERY_MS,
    BMS_I2C_TIMEOUT_MS,
    BMS_SPI_TIMEOUT_MS,
    BMS_ADC_TIMEOUT_MS,
    BMS_SYSCLK_HZ
});

export function bms_pin_name(port_id, pin) {
    if (!Number.isInteger(port_id) || port_id < 0 || port_id > 2) {
        return null;
    }
    if (!Number.isInteger(pin) || pin < 0 || pin > 15) {
        return null;
    }
    const prefixes = ['PA', 'PB', 'PC'];
    return `${prefixes[port_id]}${pin}`;
}
