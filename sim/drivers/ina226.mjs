import {
    INA226_BUS_LSB_V,
    INA226_BUS_REG_MAX,
    INA226_BUS_VALID_MAX_V,
    INA226_BUS_VALID_MIN_V,
    INA226_CALIBRATION_VALUE,
    INA226_CONFIG_RESET_VALUE,
    INA226_CURRENT_SIGN,
    INA226_DIE_ID_VALUE,
    INA226_FILTER_ALPHA,
    INA226_I2C_ADDR,
    INA226_MANUFACTURER_ID_VALUE,
    INA226_REG_BUS_V,
    INA226_REG_CALIBRATION,
    INA226_REG_CONFIG,
    INA226_REG_DIE_ID,
    INA226_REG_MANUFACTURER_ID,
    INA226_REG_SHUNT_V,
    INA226_SHUNT_LSB_MV,
    INA226_SHUNT_MAX_V,
    INA226_SHUNT_OHM,
    PROT_DI_DT_MAX_A_PER_STEP,
    PROT_SHORT_CIRCUIT_A
} from '../bms_config.mjs';

import {
    hal_i2c3_is_device_ready,
    hal_i2c3_read_reg16,
    hal_i2c3_write_reg16
} from '../hal_mock.mjs';

let s_initialized = false;
let s_active_addr = INA226_I2C_ADDR;
let s_filter_primed = false;
let s_filtered_bus_v = 0;
let s_filtered_shunt_mv = 0;
let s_last_raw_current_a = 0;
let s_prev_raw_current_a = 0;

function clearFilterState() {
    s_filter_primed = false;
    s_filtered_bus_v = 0;
    s_filtered_shunt_mv = 0;
    s_last_raw_current_a = 0;
    s_prev_raw_current_a = 0;
}

export function ina226_reset() {
    s_initialized = false;
    s_active_addr = INA226_I2C_ADDR;
    clearFilterState();
}

function tryInitAddr(addr) {
    const outMfg = { value: 0 };
    const outDie = { value: 0 };

    if (!hal_i2c3_is_device_ready(addr)) {
        return false;
    }
    if (!hal_i2c3_read_reg16(addr, INA226_REG_MANUFACTURER_ID, outMfg) ||
        outMfg.value !== INA226_MANUFACTURER_ID_VALUE) {
        return false;
    }
    if (!hal_i2c3_read_reg16(addr, INA226_REG_DIE_ID, outDie) ||
        outDie.value !== INA226_DIE_ID_VALUE) {
        return false;
    }
    if (!hal_i2c3_write_reg16(addr, INA226_REG_CONFIG, INA226_CONFIG_RESET_VALUE)) {
        return false;
    }
    if (!hal_i2c3_write_reg16(addr, INA226_REG_CALIBRATION, INA226_CALIBRATION_VALUE)) {
        return false;
    }

    s_active_addr = addr;
    s_initialized = true;
    return true;
}

export function ina226_init() {
    ina226_reset();

    if (tryInitAddr(INA226_I2C_ADDR)) {
        return true;
    }
    for (let addr = 0x40; addr <= 0x4F; addr++) {
        if (addr !== INA226_I2C_ADDR && tryInitAddr(addr)) {
            return true;
        }
    }
    return false;
}

export function ina226_read(meas) {
    if (meas === null || typeof meas !== 'object' || Array.isArray(meas)) {
        return false;
    }

    meas.prev_current_a = meas.current_a;

    const outBus = { value: 0 };
    const outShunt = { value: 0 };

    if (!s_initialized ||
        !hal_i2c3_is_device_ready(s_active_addr) ||
        !hal_i2c3_read_reg16(s_active_addr, INA226_REG_BUS_V, outBus) ||
        !hal_i2c3_read_reg16(s_active_addr, INA226_REG_SHUNT_V, outShunt)) {
        clearFilterState();
        meas.bus_voltage_v = 0;
        meas.shunt_voltage_mv = 0;
        meas.current_a = 0;
        meas.power_w = 0;
        meas.ina226_ok = false;
        return false;
    }

    const reg_bus = outBus.value;
    const reg_shunt = outShunt.value;
    const raw_bus_v = reg_bus * INA226_BUS_LSB_V;
    const signed_shunt = (reg_shunt << 16) >> 16;
    const raw_shunt_mv = signed_shunt * INA226_SHUNT_LSB_MV;
    const raw_current_a = INA226_CURRENT_SIGN * ((raw_shunt_mv * 0.001) / INA226_SHUNT_OHM);

    if (reg_bus > INA226_BUS_REG_MAX ||
        raw_bus_v < INA226_BUS_VALID_MIN_V ||
        raw_bus_v > INA226_BUS_VALID_MAX_V ||
        Math.abs(raw_shunt_mv * 0.001) > (INA226_SHUNT_MAX_V + 1e-4)) {
        clearFilterState();
        meas.bus_voltage_v = raw_bus_v;
        meas.shunt_voltage_mv = raw_shunt_mv;
        meas.current_a = 0;
        meas.power_w = 0;
        meas.ina226_ok = false;
        return false;
    }

    const is_surge = (Math.abs(raw_current_a) >= PROT_SHORT_CIRCUIT_A) ||
        (s_filter_primed && (Math.abs(raw_current_a - s_prev_raw_current_a) >= PROT_DI_DT_MAX_A_PER_STEP));

    if (!s_filter_primed) {
        s_filtered_bus_v = raw_bus_v;
        s_filtered_shunt_mv = raw_shunt_mv;
        s_filter_primed = true;
    } else {
        s_filtered_bus_v = (INA226_FILTER_ALPHA * raw_bus_v) +
            ((1 - INA226_FILTER_ALPHA) * s_filtered_bus_v);
        s_filtered_shunt_mv = is_surge
            ? raw_shunt_mv
            : ((INA226_FILTER_ALPHA * raw_shunt_mv) + ((1 - INA226_FILTER_ALPHA) * s_filtered_shunt_mv));
    }

    s_prev_raw_current_a = raw_current_a;
    s_last_raw_current_a = raw_current_a;

    meas.bus_voltage_v = s_filtered_bus_v;
    meas.shunt_voltage_mv = s_filtered_shunt_mv;
    meas.current_a = INA226_CURRENT_SIGN * ((s_filtered_shunt_mv * 0.001) / INA226_SHUNT_OHM);
    meas.power_w = meas.bus_voltage_v * meas.current_a;
    meas.ina226_ok = true;
    return true;
}

export function ina226_get_last_raw_current_a() {
    return s_last_raw_current_a;
}

export function ina226_encode_bus_voltage_reg(bus_v) {
    if (typeof bus_v !== 'number' || Number.isNaN(bus_v) || bus_v <= 0) {
        return 0;
    }
    if (!Number.isFinite(bus_v)) {
        return INA226_BUS_REG_MAX;
    }

    const counts = bus_v / INA226_BUS_LSB_V;
    if (counts >= INA226_BUS_REG_MAX) {
        return INA226_BUS_REG_MAX;
    }
    return Math.floor(counts + 0.5);
}

export function ina226_encode_shunt_current_reg(current_a) {
    if (typeof current_a !== 'number' || Number.isNaN(current_a)) {
        return 0;
    }

    const counts = (current_a * INA226_SHUNT_OHM * 1000 * INA226_CURRENT_SIGN) / INA226_SHUNT_LSB_MV;
    let rounded;
    if (counts >= 32767) {
        rounded = 32767;
    } else if (counts <= -32768) {
        rounded = -32768;
    } else {
        rounded = (counts >= 0) ? Math.floor(counts + 0.5) : Math.ceil(counts - 0.5);
    }

    return rounded & 0xFFFF;
}
