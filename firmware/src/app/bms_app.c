#include "bms_app.h"
#include "hal_interface.h"
#include "ina226.h"
#include "voltage_sensor.h"
#include "relay_ctrl.h"
#include "ssd1309_oled.h"
#include "bms_estimator.h"
#include "bms_protection.h"
#include "bms_state_machine.h"
#include <math.h>
#include <stddef.h>
#include <string.h>

static bms_history_entry_t s_history[BMS_HISTORY_CAPACITY];
static uint16_t s_history_head = 0U;
static uint16_t s_history_count = 0U;
static bms_mode_t s_prev_mode = BMS_MODE_STARTUP;
static bms_prot_level_t s_prev_prot_level = PROT_LEVEL_1_NORMAL;
static uint32_t s_prev_faults = 0U;
static bool s_oled_ready = false;

static float app_sanitize_float(float v)
{
    return isfinite(v) ? v : 0.0f;
}

static void app_record_history(const bms_system_state_t *state)
{
    bms_history_entry_t *slot;

    if (state == NULL) {
        return;
    }

    slot = &s_history[s_history_head];
    slot->timestamp_ms = state->tick_ms;
    slot->mode = state->mode;
    slot->prot_level = state->prot_level;
    slot->fault_mask = state->active_faults;
    slot->bus_voltage_v = app_sanitize_float(state->meas.bus_voltage_v);
    slot->current_a = app_sanitize_float(state->meas.current_a);
    slot->soc_pct = app_sanitize_float(state->energy.soc_pct);

    s_history_head = (uint16_t)((s_history_head + 1U) % BMS_HISTORY_CAPACITY);
    if (s_history_count < BMS_HISTORY_CAPACITY) {
        s_history_count++;
    }
}

void bms_app_reset(void)
{
    (void)memset(s_history, 0, sizeof(s_history));
    s_history_head = 0U;
    s_history_count = 0U;
    s_prev_mode = BMS_MODE_STARTUP;
    s_prev_prot_level = PROT_LEVEL_1_NORMAL;
    s_prev_faults = 0U;
    s_oled_ready = false;
}

bool bms_app_init(bms_system_state_t *state)
{
    uint32_t now;

    if (state == NULL) {
        return false;
    }

    bms_app_reset();
    (void)bms_system_state_init(state);
    (void)relay_ctrl_init(state);
    (void)bms_estimator_init(state);
    (void)bms_protection_init(state);
    (void)bms_state_machine_init(state);

    if (ina226_init()) {
        (void)ina226_read(&state->meas);
    } else {
        state->meas.ina226_ok = false;
    }

    if (voltage_sensor_init()) {
        (void)voltage_sensor_read(&state->meas);
    } else {
        state->meas.vsense_ok = false;
    }

    now = hal_get_tick_ms();
    state->tick_ms = now;
    state->last_control_tick_ms = now;
    state->last_oled_tick_ms = now;
    state->last_page_switch_tick_ms = now;

    s_oled_ready = ssd1309_init();
    (void)ssd1309_render_page(state, state->current_oled_page);
    if (s_oled_ready) {
        (void)ssd1309_flush();
    }

    s_prev_mode = state->mode;
    s_prev_prot_level = state->prot_level;
    s_prev_faults = state->active_faults;
    app_record_history(state);

    return true;
}

bool bms_app_step(bms_system_state_t *state, uint32_t dt_ms)
{
    bool entered_fault;

    if (state == NULL) {
        return false;
    }
    if (dt_ms > ESTIMATOR_MAX_DT_MS) {
        return false;
    }

    state->tick_ms = (uint32_t)(state->tick_ms + dt_ms);

    /* Priority 1: 10 ms sensing, estimation, 5-level protection, state machine & relays */
    (void)ina226_read(&state->meas);
    (void)voltage_sensor_read(&state->meas);
    (void)bms_estimator_step(state, dt_ms);
    (void)bms_protection_step(state, dt_ms);
    (void)bms_state_machine_step(state, dt_ms);
    (void)relay_ctrl_apply_protection(state);
    state->last_control_tick_ms = state->tick_ms;

    if ((state->mode != s_prev_mode) ||
        (state->prot_level != s_prev_prot_level) ||
        (state->active_faults != s_prev_faults)) {
        app_record_history(state);

        entered_fault = ((state->prot_level >= PROT_LEVEL_3_BRANCH) || (state->mode == BMS_MODE_FAULT)) &&
                        (s_prev_prot_level < PROT_LEVEL_3_BRANCH) &&
                        (s_prev_mode != BMS_MODE_FAULT);
        if (entered_fault && state->oled_auto_cycle) {
            state->current_oled_page = OLED_PAGE_DIAGNOSTICS;
            state->last_page_switch_tick_ms = state->tick_ms;
        }

        s_prev_mode = state->mode;
        s_prev_prot_level = state->prot_level;
        s_prev_faults = state->active_faults;
    }

    /* Priority 2: Low-priority OLED auto-cycle (3000 ms) and refresh (200 ms) */
    if (state->oled_auto_cycle &&
        (state->mode != BMS_MODE_FAULT) &&
        (state->prot_level < PROT_LEVEL_3_BRANCH) &&
        ((uint32_t)(state->tick_ms - state->last_page_switch_tick_ms) >= OLED_AUTO_PAGE_MS)) {
        state->current_oled_page = (bms_oled_page_t)(((uint32_t)state->current_oled_page + 1U) % (uint32_t)OLED_PAGE_COUNT);
        state->last_page_switch_tick_ms = state->tick_ms;
    }

    if ((uint32_t)(state->tick_ms - state->last_oled_tick_ms) >= OLED_REFRESH_PERIOD_MS) {
        state->last_oled_tick_ms = state->tick_ms;
        (void)ssd1309_render_page(state, state->current_oled_page);
        (void)ssd1309_flush();
    }

    return true;
}

bool bms_app_next_page(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }

    state->current_oled_page = (bms_oled_page_t)(((uint32_t)state->current_oled_page + 1U) % (uint32_t)OLED_PAGE_COUNT);
    state->last_page_switch_tick_ms = state->tick_ms;
    (void)ssd1309_render_page(state, state->current_oled_page);
    (void)ssd1309_flush();
    return true;
}

bool bms_app_set_page(bms_system_state_t *state, bms_oled_page_t page)
{
    if (state == NULL) {
        return false;
    }
    if ((uint32_t)page >= (uint32_t)OLED_PAGE_COUNT) {
        return false;
    }

    state->current_oled_page = page;
    state->last_page_switch_tick_ms = state->tick_ms;
    (void)ssd1309_render_page(state, state->current_oled_page);
    (void)ssd1309_flush();
    return true;
}

bool bms_app_request_fault_clear(bms_system_state_t *state)
{
    if (state == NULL) {
        return false;
    }
    if (!bms_protection_request_fault_clear(state)) {
        return false;
    }

    if (!hal_relay_read_cmd(RELAY_1_MAIN)) {
        bms_state_machine_reset();
    }

    s_prev_mode = state->mode;
    s_prev_prot_level = state->prot_level;
    s_prev_faults = state->active_faults;
    app_record_history(state);

    (void)ssd1309_render_page(state, state->current_oled_page);
    (void)ssd1309_flush();
    return true;
}

uint16_t bms_app_get_history_count(void)
{
    return s_history_count;
}

bool bms_app_get_history_entry(uint16_t index, bms_history_entry_t *out_entry)
{
    uint16_t oldest_idx;
    uint16_t slot;

    if (out_entry == NULL) {
        return false;
    }
    (void)memset(out_entry, 0, sizeof(*out_entry));

    if (index >= s_history_count) {
        return false;
    }

    oldest_idx = (uint16_t)((s_history_head + BMS_HISTORY_CAPACITY - s_history_count) % BMS_HISTORY_CAPACITY);
    slot = (uint16_t)((oldest_idx + index) % BMS_HISTORY_CAPACITY);
    *out_entry = s_history[slot];
    return true;
}
