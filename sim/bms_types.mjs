import { BMS_INITIAL_SOC_PCT, BMS_NOMINAL_CAPACITY_AH } from './bms_config.mjs';

export const BMS_MODE_COUNT = 5;
export const PROT_LEVEL_COUNT = 5;
export const FAULT_COUNT = 9;
export const FAULT_ALL_MASK = 0x01FF;

export const BMS_MODE_STARTUP = 0;
export const BMS_MODE_CHARGE = 1;
export const BMS_MODE_DISCHARGE = 2;
export const BMS_MODE_STANDBY = 3;
export const BMS_MODE_FAULT = 4;

export const BMS_MODE = Object.freeze({
    BMS_MODE_STARTUP,
    BMS_MODE_CHARGE,
    BMS_MODE_DISCHARGE,
    BMS_MODE_STANDBY,
    BMS_MODE_FAULT
});

export const PROT_LEVEL_1_NORMAL = 1;
export const PROT_LEVEL_2_WARNING = 2;
export const PROT_LEVEL_3_BRANCH = 3;
export const PROT_LEVEL_4_ISOLATE = 4;
export const PROT_LEVEL_5_LATCH = 5;

export const PROT_LEVEL = Object.freeze({
    PROT_LEVEL_1_NORMAL,
    PROT_LEVEL_2_WARNING,
    PROT_LEVEL_3_BRANCH,
    PROT_LEVEL_4_ISOLATE,
    PROT_LEVEL_5_LATCH
});

export const FAULT_NONE = 0x0000;
export const FAULT_BAT_OVERVOLTAGE = 0x0001;
export const FAULT_BAT_UNDERVOLTAGE = 0x0002;
export const FAULT_CHG_OVERCURRENT = 0x0004;
export const FAULT_DIS_OVERCURRENT = 0x0008;
export const FAULT_SHORT_CIRCUIT = 0x0010;
export const FAULT_CHARGER_OVERVOLTAGE = 0x0020;
export const FAULT_INA226_DISCONNECTED = 0x0040;
export const FAULT_VSENSE_FAULT = 0x0080;
export const FAULT_RELAY_NO_RESPONSE = 0x0100;

export const FAULT = Object.freeze({
    FAULT_NONE,
    FAULT_BAT_OVERVOLTAGE,
    FAULT_BAT_UNDERVOLTAGE,
    FAULT_CHG_OVERCURRENT,
    FAULT_DIS_OVERCURRENT,
    FAULT_SHORT_CIRCUIT,
    FAULT_CHARGER_OVERVOLTAGE,
    FAULT_INA226_DISCONNECTED,
    FAULT_VSENSE_FAULT,
    FAULT_RELAY_NO_RESPONSE
});

export const RELAY_1_MAIN = 0;
export const RELAY_2_CHARGE = 1;
export const RELAY_3_LOAD = 2;
export const RELAY_4_AUX = 3;
export const RELAY_COUNT = 4;

export const RELAY_ID = Object.freeze({
    RELAY_1_MAIN,
    RELAY_2_CHARGE,
    RELAY_3_LOAD,
    RELAY_4_AUX,
    RELAY_COUNT
});

export const OLED_PAGE_OVERVIEW = 0;
export const OLED_PAGE_CHARGER = 1;
export const OLED_PAGE_RELAYS = 2;
export const OLED_PAGE_DIAGNOSTICS = 3;
export const OLED_PAGE_COUNT = 4;

export const OLED_PAGE = Object.freeze({
    OLED_PAGE_OVERVIEW,
    OLED_PAGE_CHARGER,
    OLED_PAGE_RELAYS,
    OLED_PAGE_DIAGNOSTICS,
    OLED_PAGE_COUNT
});

export function createDefaultSystemState() {
    const meas = Object.seal({
        bus_voltage_v: 0,
        shunt_voltage_mv: 0,
        current_a: 0,
        prev_current_a: 0,
        power_w: 0,
        charger_adc_raw: 0,
        charger_pin_v: 0,
        charger_voltage_v: 0,
        charger_present: false,
        ina226_ok: false,
        vsense_ok: false
    });

    const energy = Object.seal({
        charge_power_w: 0,
        discharge_power_w: 0,
        energy_in_wh: 0,
        energy_out_wh: 0,
        charge_capacity_ah: 0,
        discharge_capacity_ah: 0,
        soc_pct: BMS_INITIAL_SOC_PCT,
        remaining_capacity_ah: BMS_NOMINAL_CAPACITY_AH * (BMS_INITIAL_SOC_PCT / 100),
        avg_charge_current_a: 0,
        avg_discharge_current_a: 0,
        remaining_time_min: 0,
        estimated_charge_time_min: 0,
        efficiency_pct: 100
    });

    const relays = Object.seal({
        cmd: Object.seal([false, false, false, false]),
        feedback: Object.seal([false, false, false, false]),
        fault_mismatch: Object.seal([false, false, false, false])
    });

    const snapshot = Object.seal({
        valid: false,
        latched_fault_mask: 0,
        prot_level: PROT_LEVEL_1_NORMAL,
        bus_voltage_v: 0,
        charger_voltage_v: 0,
        current_a: 0,
        power_w: 0,
        timestamp_ms: 0
    });

    return Object.seal({
        mode: BMS_MODE_STARTUP,
        prot_level: PROT_LEVEL_1_NORMAL,
        active_faults: 0,
        warning_flags: 0,
        fault_latched: false,
        load_enabled_req: false,
        charge_enabled_req: false,
        tick_ms: 0,
        last_control_tick_ms: 0,
        last_oled_tick_ms: 0,
        last_page_switch_tick_ms: 0,
        current_oled_page: OLED_PAGE_OVERVIEW,
        oled_auto_cycle: true,
        meas,
        energy,
        relays,
        snapshot
    });
}

export function bms_system_state_init(state) {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
        return false;
    }

    const fresh = createDefaultSystemState();
    for (const key of Object.keys(fresh)) {
        state[key] = fresh[key];
    }

    return true;
}
