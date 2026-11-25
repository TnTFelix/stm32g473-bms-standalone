import {
    ADC_RESOLUTION,
    ADC_VREF_V,
    INA226_CONFIG_RESET_VALUE,
    INA226_DIE_ID_VALUE,
    INA226_I2C_ADDR,
    INA226_MANUFACTURER_ID_VALUE,
    INA226_REG_ALERT_LIMIT,
    INA226_REG_CALIBRATION,
    INA226_REG_CONFIG,
    INA226_REG_DIE_ID,
    INA226_REG_MANUFACTURER_ID,
    INA226_REG_MASK_ENABLE,
    OLED_BUFFER_SIZE,
    OLED_RESET_PULSE_MS,
    OLED_RESET_RECOVERY_MS
} from './bms_config.mjs';

import {
    RELAY_1_MAIN,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    RELAY_COUNT
} from './bms_types.mjs';

export const HAL_MOCK_OLED_CMD_LOG_SIZE = 256;
export const HAL_MOCK_RELAY_LOG_SIZE = 64;

let s_initialized = false;
let s_tick_ms = 0;
let s_i2c_online = true;
let s_ina226_regs = new Uint16Array(256);
let s_adc_raw = 0;
let s_adc_fault = false;
let s_spi_fault = false;
let s_relay_cmd = [false, false, false, false];
let s_relay_override_en = [false, false, false, false];
let s_relay_forced_fb = [false, false, false, false];
let s_relay_log = [];
let s_oled_reset_count = 0;
let s_oled_cmd_count = 0;
let s_oled_cmd_log = [];
let s_oled_data_write_count = 0;
let s_oled_last_data_len = 0;
let s_oled_last_data = new Uint8Array(OLED_BUFFER_SIZE);
let s_oled_cs_pin = true;
let s_oled_dc_pin = false;
let s_oled_res_pin = false;

function isUint8(v) {
    return Number.isInteger(v) && v >= 0 && v <= 0xFF;
}

function isUint16(v) {
    return Number.isInteger(v) && v >= 0 && v <= 0xFFFF;
}

function isOutObject(obj) {
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj);
}

function isValidRelayId(relay_id) {
    return Number.isInteger(relay_id) && relay_id >= 0 && relay_id < RELAY_COUNT;
}

function assertUint32Arg(v, name) {
    if (typeof v !== 'number') {
        throw new TypeError(`${name} must be a number`);
    }
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) {
        throw new RangeError(`${name} must be an integer in [0, 0xFFFFFFFF]`);
    }
}

function assertBoolArg(v, name) {
    if (typeof v !== 'boolean') {
        throw new TypeError(`${name} must be a boolean`);
    }
}

function ina226RegIsValid(reg) {
    return (reg >= 0 && reg <= INA226_REG_ALERT_LIMIT) ||
        reg === INA226_REG_MANUFACTURER_ID ||
        reg === INA226_REG_DIE_ID;
}

function ina226RegIsWritable(reg) {
    return reg === INA226_REG_CONFIG ||
        reg === INA226_REG_CALIBRATION ||
        reg === INA226_REG_MASK_ENABLE ||
        reg === INA226_REG_ALERT_LIMIT;
}

function appendRelayLog(relay_id, closed) {
    s_relay_log.push({
        relay_id,
        closed,
        tick_ms: s_tick_ms
    });
    if (s_relay_log.length > HAL_MOCK_RELAY_LOG_SIZE) {
        s_relay_log.shift();
    }
}

export function hal_mock_reset() {
    s_initialized = false;
    s_tick_ms = 0;
    s_i2c_online = true;

    s_ina226_regs.fill(0);
    s_ina226_regs[INA226_REG_CONFIG] = INA226_CONFIG_RESET_VALUE;
    s_ina226_regs[INA226_REG_MANUFACTURER_ID] = INA226_MANUFACTURER_ID_VALUE;
    s_ina226_regs[INA226_REG_DIE_ID] = INA226_DIE_ID_VALUE;

    s_adc_raw = 0;
    s_adc_fault = false;
    s_spi_fault = false;

    for (let i = 0; i < RELAY_COUNT; i++) {
        s_relay_cmd[i] = false;
        s_relay_override_en[i] = false;
        s_relay_forced_fb[i] = false;
    }

    s_relay_log = [];
    s_oled_reset_count = 0;
    s_oled_cmd_count = 0;
    s_oled_cmd_log = [];
    s_oled_data_write_count = 0;
    s_oled_last_data_len = 0;
    s_oled_last_data.fill(0);
    s_oled_cs_pin = true;
    s_oled_dc_pin = false;
    s_oled_res_pin = false;
}

export function hal_init() {
    hal_relay_open_all();
    s_oled_cs_pin = true;
    s_oled_dc_pin = false;
    s_oled_res_pin = true;
    s_initialized = true;
    return true;
}

export function hal_relay_open_all() {
    const k_open_order = [
        RELAY_3_LOAD,
        RELAY_2_CHARGE,
        RELAY_4_AUX,
        RELAY_1_MAIN
    ];
    for (let i = 0; i < RELAY_COUNT; i++) {
        const id = k_open_order[i];
        s_relay_cmd[id] = false;
        appendRelayLog(id, false);
    }
}

export function hal_i2c3_is_device_ready(dev_addr7) {
    if (!isUint8(dev_addr7)) {
        return false;
    }
    if (!s_initialized || !s_i2c_online || dev_addr7 > 0x7F) {
        return false;
    }
    return dev_addr7 === INA226_I2C_ADDR;
}

export function hal_i2c3_write_reg16(dev_addr7, reg, value) {
    if (!isUint8(dev_addr7) || !isUint8(reg) || !isUint16(value)) {
        return false;
    }
    if (!s_initialized || !s_i2c_online || dev_addr7 > 0x7F ||
        dev_addr7 !== INA226_I2C_ADDR || !ina226RegIsWritable(reg)) {
        return false;
    }
    s_ina226_regs[reg] = value;
    return true;
}

export function hal_i2c3_read_reg16(dev_addr7, reg, out_value) {
    if (!isOutObject(out_value)) {
        return false;
    }
    out_value.value = 0;

    if (!isUint8(dev_addr7) || !isUint8(reg)) {
        return false;
    }
    if (!s_initialized || !s_i2c_online || dev_addr7 > 0x7F ||
        dev_addr7 !== INA226_I2C_ADDR || !ina226RegIsValid(reg)) {
        return false;
    }

    out_value.value = s_ina226_regs[reg];
    return true;
}

export function hal_adc_pa0_read_raw(out_raw) {
    if (!isOutObject(out_raw)) {
        return false;
    }
    out_raw.value = 0;

    if (!s_initialized || s_adc_fault) {
        return false;
    }

    out_raw.value = s_adc_raw > ADC_RESOLUTION ? ADC_RESOLUTION : s_adc_raw;
    return true;
}

export function hal_adc_pa0_read_pin_voltage(out_pin_v) {
    if (!isOutObject(out_pin_v)) {
        return false;
    }
    out_pin_v.value = 0;

    const raw_out = { value: 0 };
    if (!hal_adc_pa0_read_raw(raw_out)) {
        return false;
    }

    out_pin_v.value = (raw_out.value / ADC_RESOLUTION) * ADC_VREF_V;
    return true;
}

export function hal_relay_write(relay_id, closed) {
    if (!isValidRelayId(relay_id) || typeof closed !== 'boolean') {
        return false;
    }
    if (!s_initialized && closed) {
        return false;
    }

    s_relay_cmd[relay_id] = closed;
    appendRelayLog(relay_id, closed);
    return true;
}

export function hal_relay_read_cmd(relay_id) {
    if (!isValidRelayId(relay_id)) {
        return false;
    }
    return s_relay_cmd[relay_id];
}

export function hal_relay_read_feedback(relay_id) {
    if (!isValidRelayId(relay_id)) {
        return false;
    }
    return s_relay_override_en[relay_id] ? s_relay_forced_fb[relay_id] : s_relay_cmd[relay_id];
}

export function hal_oled_reset() {
    if (!s_initialized) {
        return false;
    }
    s_oled_res_pin = false;
    hal_delay_ms(OLED_RESET_PULSE_MS);
    s_oled_res_pin = true;
    hal_delay_ms(OLED_RESET_RECOVERY_MS);
    s_oled_reset_count++;
    return true;
}

export function hal_oled_write_cmd(cmd) {
    if (!isUint8(cmd)) {
        return false;
    }
    if (!s_initialized || s_spi_fault) {
        return false;
    }

    s_oled_dc_pin = false;
    s_oled_cs_pin = false;
    s_oled_cmd_count++;

    if (s_oled_cmd_log.length >= HAL_MOCK_OLED_CMD_LOG_SIZE) {
        s_oled_cmd_log.shift();
    }
    s_oled_cmd_log.push(cmd);

    s_oled_cs_pin = true;
    s_oled_dc_pin = false;
    return true;
}

export function hal_oled_write_data(data, len) {
    if (!(data instanceof Uint8Array) && !Array.isArray(data)) {
        return false;
    }
    if (!isUint16(len) || len === 0 || len > OLED_BUFFER_SIZE || len > data.length) {
        return false;
    }
    for (let i = 0; i < len; i++) {
        if (!isUint8(data[i])) {
            return false;
        }
    }
    if (!s_initialized || s_spi_fault) {
        return false;
    }

    s_oled_dc_pin = true;
    s_oled_cs_pin = false;
    s_oled_last_data.fill(0);
    for (let i = 0; i < len; i++) {
        s_oled_last_data[i] = data[i];
    }
    s_oled_last_data_len = len;
    s_oled_data_write_count++;
    s_oled_cs_pin = true;
    s_oled_dc_pin = true;
    return true;
}

export function hal_get_tick_ms() {
    return s_tick_ms;
}

export function hal_delay_ms(ms) {
    assertUint32Arg(ms, 'ms');
    s_tick_ms = (s_tick_ms + ms) >>> 0;
}

export function hal_mock_set_i2c_online(online) {
    assertBoolArg(online, 'online');
    s_i2c_online = online;
}

export function hal_mock_set_ina226_register(reg, value) {
    if (!isUint8(reg) || !isUint16(value) || !ina226RegIsValid(reg)) {
        return false;
    }
    s_ina226_regs[reg] = value;
    return true;
}

export function hal_mock_get_ina226_register(reg) {
    if (!isUint8(reg) || !ina226RegIsValid(reg)) {
        return 0;
    }
    return s_ina226_regs[reg];
}

export function hal_mock_set_adc_pa0_raw(raw) {
    if (!isUint16(raw)) {
        return false;
    }
    if (raw > ADC_RESOLUTION) {
        s_adc_raw = ADC_RESOLUTION;
        return false;
    }
    s_adc_raw = raw;
    return true;
}

export function hal_mock_set_adc_pa0_pin_voltage(pin_v) {
    if (typeof pin_v !== 'number') {
        return false;
    }
    if (Number.isNaN(pin_v) || pin_v < 0) {
        s_adc_raw = 0;
        return false;
    }
    if (pin_v > ADC_VREF_V) {
        s_adc_raw = ADC_RESOLUTION;
        return false;
    }
    let rounded = Math.floor((pin_v / ADC_VREF_V) * ADC_RESOLUTION + 0.5);
    if (rounded > ADC_RESOLUTION) {
        rounded = ADC_RESOLUTION;
    }
    s_adc_raw = rounded;
    return true;
}

export function hal_mock_set_adc_fault(fault) {
    assertBoolArg(fault, 'fault');
    s_adc_fault = fault;
}

export function hal_mock_set_spi_fault(fault) {
    assertBoolArg(fault, 'fault');
    s_spi_fault = fault;
}

export function hal_mock_set_relay_feedback_override(relay_id, override_enabled, forced_feedback) {
    if (!isValidRelayId(relay_id) ||
        typeof override_enabled !== 'boolean' ||
        typeof forced_feedback !== 'boolean') {
        return false;
    }
    s_relay_override_en[relay_id] = override_enabled;
    s_relay_forced_fb[relay_id] = forced_feedback;
    return true;
}

export function hal_mock_set_tick_ms(tick_ms) {
    assertUint32Arg(tick_ms, 'tick_ms');
    s_tick_ms = tick_ms >>> 0;
}

export function hal_mock_advance_tick_ms(delta_ms) {
    assertUint32Arg(delta_ms, 'delta_ms');
    s_tick_ms = (s_tick_ms + delta_ms) >>> 0;
}

export function hal_mock_is_initialized() {
    return s_initialized;
}

export function hal_mock_get_oled_state() {
    return {
        reset_count: s_oled_reset_count,
        cmd_count: s_oled_cmd_count,
        cmd_log_len: s_oled_cmd_log.length,
        cmd_log: s_oled_cmd_log.slice(),
        data_write_count: s_oled_data_write_count,
        last_data_len: s_oled_last_data_len,
        last_data: new Uint8Array(s_oled_last_data),
        cs_pin: s_oled_cs_pin,
        dc_pin: s_oled_dc_pin,
        res_pin: s_oled_res_pin
    };
}

export function hal_mock_get_relay_log_count() {
    return s_relay_log.length;
}

export function hal_mock_get_relay_event(index, out_event) {
    if (!isOutObject(out_event)) {
        return false;
    }
    out_event.relay_id = 0;
    out_event.closed = false;
    out_event.tick_ms = 0;

    if (!isUint16(index) || index >= s_relay_log.length) {
        return false;
    }

    const ev = s_relay_log[index];
    out_event.relay_id = ev.relay_id;
    out_event.closed = ev.closed;
    out_event.tick_ms = ev.tick_ms;
    return true;
}

export function hal_mock_clear_relay_log() {
    s_relay_log = [];
}

hal_mock_reset();
