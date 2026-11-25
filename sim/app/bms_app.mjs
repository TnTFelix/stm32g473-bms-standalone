import {
    ESTIMATOR_MAX_DT_MS,
    OLED_AUTO_PAGE_MS,
    OLED_REFRESH_PERIOD_MS
} from '../bms_config.mjs';

import {
    BMS_MODE_FAULT,
    BMS_MODE_STARTUP,
    OLED_PAGE_COUNT,
    OLED_PAGE_DIAGNOSTICS,
    PROT_LEVEL_1_NORMAL,
    PROT_LEVEL_3_BRANCH,
    RELAY_1_MAIN,
    bms_system_state_init
} from '../bms_types.mjs';

import { hal_get_tick_ms, hal_relay_read_cmd } from '../hal_mock.mjs';
import { ina226_init, ina226_read } from '../drivers/ina226.mjs';
import { voltage_sensor_init, voltage_sensor_read } from '../drivers/voltage_sensor.mjs';
import { relay_ctrl_apply_protection, relay_ctrl_init } from '../drivers/relay_ctrl.mjs';
import { ssd1309_flush, ssd1309_init, ssd1309_render_page } from '../drivers/ssd1309_oled.mjs';
import { bms_estimator_init, bms_estimator_step } from '../core/bms_estimator.mjs';
import {
    bms_protection_init,
    bms_protection_request_fault_clear,
    bms_protection_step
} from '../core/bms_protection.mjs';
import {
    bms_state_machine_init,
    bms_state_machine_reset,
    bms_state_machine_step
} from '../core/bms_state_machine.mjs';

export const BMS_HISTORY_CAPACITY = 16;

let s_history = [];
let s_prev_mode = BMS_MODE_STARTUP;
let s_prev_prot_level = PROT_LEVEL_1_NORMAL;
let s_prev_faults = 0;
let s_oled_ready = false;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeFloat(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
}

function recordHistory(state) {
    s_history.push({
        timestamp_ms: state.tick_ms >>> 0,
        mode: state.mode,
        prot_level: state.prot_level,
        fault_mask: state.active_faults >>> 0,
        bus_voltage_v: sanitizeFloat(state.meas.bus_voltage_v),
        current_a: sanitizeFloat(state.meas.current_a),
        soc_pct: sanitizeFloat(state.energy.soc_pct)
    });
    if (s_history.length > BMS_HISTORY_CAPACITY) {
        s_history.shift();
    }
}

export function bms_app_reset() {
    s_history = [];
    s_prev_mode = BMS_MODE_STARTUP;
    s_prev_prot_level = PROT_LEVEL_1_NORMAL;
    s_prev_faults = 0;
    s_oled_ready = false;
}

export function bms_app_init(state) {
    if (!isPlainObject(state)) {
        return false;
    }

    bms_app_reset();
    if (!bms_system_state_init(state)) {
        return false;
    }

    relay_ctrl_init(state);
    bms_estimator_init(state);
    bms_protection_init(state);
    bms_state_machine_init(state);

    if (ina226_init()) {
        ina226_read(state.meas);
    } else {
        state.meas.ina226_ok = false;
    }

    if (voltage_sensor_init()) {
        voltage_sensor_read(state.meas);
    } else {
        state.meas.vsense_ok = false;
    }

    const now = hal_get_tick_ms() >>> 0;
    state.tick_ms = now;
    state.last_control_tick_ms = now;
    state.last_oled_tick_ms = now;
    state.last_page_switch_tick_ms = now;

    s_oled_ready = ssd1309_init();
    ssd1309_render_page(state, state.current_oled_page);
    if (s_oled_ready) {
        ssd1309_flush();
    }

    s_prev_mode = state.mode;
    s_prev_prot_level = state.prot_level;
    s_prev_faults = state.active_faults;
    recordHistory(state);

    return true;
}

export function bms_app_step(state, dt_ms) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) ||
        !isPlainObject(state.energy) || !isPlainObject(state.relays) ||
        !isPlainObject(state.snapshot)) {
        return false;
    }
    if (!Number.isInteger(dt_ms) || dt_ms < 0 || dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    state.tick_ms = (state.tick_ms + dt_ms) >>> 0;

    /* Priority 1: 10 ms sensing, estimation, 5-level protection, state machine & relays */
    ina226_read(state.meas);
    voltage_sensor_read(state.meas);
    bms_estimator_step(state, dt_ms);
    bms_protection_step(state, dt_ms);
    bms_state_machine_step(state, dt_ms);
    relay_ctrl_apply_protection(state);
    state.last_control_tick_ms = state.tick_ms;

    if ((state.mode !== s_prev_mode) ||
        (state.prot_level !== s_prev_prot_level) ||
        (state.active_faults !== s_prev_faults)) {
        recordHistory(state);

        const enteredFault = ((state.prot_level >= PROT_LEVEL_3_BRANCH) || (state.mode === BMS_MODE_FAULT)) &&
            (s_prev_prot_level < PROT_LEVEL_3_BRANCH) &&
            (s_prev_mode !== BMS_MODE_FAULT);
        if (enteredFault && state.oled_auto_cycle) {
            state.current_oled_page = OLED_PAGE_DIAGNOSTICS;
            state.last_page_switch_tick_ms = state.tick_ms;
        }

        s_prev_mode = state.mode;
        s_prev_prot_level = state.prot_level;
        s_prev_faults = state.active_faults;
    }

    /* Priority 2: Low-priority OLED auto-cycle (3000 ms) and refresh (200 ms) */
    if (state.oled_auto_cycle &&
        (state.mode !== BMS_MODE_FAULT) &&
        (state.prot_level < PROT_LEVEL_3_BRANCH) &&
        (((state.tick_ms - state.last_page_switch_tick_ms) >>> 0) >= OLED_AUTO_PAGE_MS)) {
        state.current_oled_page = (state.current_oled_page + 1) % OLED_PAGE_COUNT;
        state.last_page_switch_tick_ms = state.tick_ms;
    }

    if (((state.tick_ms - state.last_oled_tick_ms) >>> 0) >= OLED_REFRESH_PERIOD_MS) {
        state.last_oled_tick_ms = state.tick_ms;
        ssd1309_render_page(state, state.current_oled_page);
        ssd1309_flush();
    }

    return true;
}

export function bms_app_next_page(state) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) ||
        !isPlainObject(state.energy) || !isPlainObject(state.relays) ||
        !isPlainObject(state.snapshot)) {
        return false;
    }

    state.current_oled_page = (state.current_oled_page + 1) % OLED_PAGE_COUNT;
    state.last_page_switch_tick_ms = state.tick_ms;
    ssd1309_render_page(state, state.current_oled_page);
    ssd1309_flush();
    return true;
}

export function bms_app_set_page(state, page) {
    if (!isPlainObject(state) || !isPlainObject(state.meas) ||
        !isPlainObject(state.energy) || !isPlainObject(state.relays) ||
        !isPlainObject(state.snapshot)) {
        return false;
    }
    if (!Number.isInteger(page) || page < 0 || page >= OLED_PAGE_COUNT) {
        return false;
    }

    state.current_oled_page = page;
    state.last_page_switch_tick_ms = state.tick_ms;
    ssd1309_render_page(state, state.current_oled_page);
    ssd1309_flush();
    return true;
}

export function bms_app_request_fault_clear(state) {
    if (!isPlainObject(state)) {
        return false;
    }
    if (!bms_protection_request_fault_clear(state)) {
        return false;
    }

    if (!hal_relay_read_cmd(RELAY_1_MAIN)) {
        bms_state_machine_reset();
    }

    s_prev_mode = state.mode;
    s_prev_prot_level = state.prot_level;
    s_prev_faults = state.active_faults;
    recordHistory(state);

    ssd1309_render_page(state, state.current_oled_page);
    ssd1309_flush();
    return true;
}

export function bms_app_get_history_count() {
    return s_history.length;
}

export function bms_app_get_history_entry(index, out_entry) {
    if (!isPlainObject(out_entry)) {
        return false;
    }

    out_entry.timestamp_ms = 0;
    out_entry.mode = BMS_MODE_STARTUP;
    out_entry.prot_level = PROT_LEVEL_1_NORMAL;
    out_entry.fault_mask = 0;
    out_entry.bus_voltage_v = 0;
    out_entry.current_a = 0;
    out_entry.soc_pct = 0;

    if (!Number.isInteger(index) || index < 0 || index >= s_history.length) {
        return false;
    }

    const src = s_history[index];
    out_entry.timestamp_ms = src.timestamp_ms;
    out_entry.mode = src.mode;
    out_entry.prot_level = src.prot_level;
    out_entry.fault_mask = src.fault_mask;
    out_entry.bus_voltage_v = src.bus_voltage_v;
    out_entry.current_a = src.current_a;
    out_entry.soc_pct = src.soc_pct;
    return true;
}
