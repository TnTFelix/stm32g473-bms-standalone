#include "bms_config.h"
#include "bms_types.h"
#include "hal_interface.h"
#include "bms_app.h"
#include <stddef.h>

static bms_system_state_t g_bms_state;
static bool g_app_initialized = false;

static bool bms_all_relays_open(void)
{
    uint32_t i;

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        if (hal_relay_read_cmd((bms_relay_id_t)i)) {
            return false;
        }
    }
    return true;
}

static void bms_main_step(void)
{
    uint32_t now = hal_get_tick_ms();
    uint32_t dt = (uint32_t)(now - g_bms_state.last_control_tick_ms);

    if (dt >= CONTROL_LOOP_PERIOD_MS) {
        if (g_app_initialized) {
            uint32_t step_dt = (dt > ESTIMATOR_MAX_DT_MS) ? ESTIMATOR_MAX_DT_MS : dt;
            (void)bms_app_step(&g_bms_state, step_dt);
        } else {
            g_bms_state.last_control_tick_ms = now;
            g_bms_state.tick_ms = now;
            if (!bms_all_relays_open()) {
                hal_relay_open_all();
            }
        }
    }

    hal_delay_ms(1U);
}

int main(void)
{
    bool hal_ok = hal_init();
    uint32_t start_tick;

    (void)bms_system_state_init(&g_bms_state);

    if (hal_ok) {
        g_app_initialized = bms_app_init(&g_bms_state);
        g_bms_state.oled_auto_cycle = false;
    } else {
        g_app_initialized = false;
        g_bms_state.mode = BMS_MODE_FAULT;
        g_bms_state.prot_level = PROT_LEVEL_5_LATCH;
        g_bms_state.fault_latched = true;
        hal_relay_open_all();
    }

    start_tick = hal_get_tick_ms();
    g_bms_state.tick_ms = start_tick;
    g_bms_state.last_control_tick_ms = start_tick;
    g_bms_state.last_oled_tick_ms = start_tick;
    g_bms_state.last_page_switch_tick_ms = start_tick;

#if defined(BMS_HOST_SIM)
#define BMS_HOST_SIM_RUN_MS 1000U
    while ((uint32_t)(hal_get_tick_ms() - start_tick) < BMS_HOST_SIM_RUN_MS) {
        bms_main_step();
    }
    return bms_all_relays_open() ? 0 : 1;
#else
    for (;;) {
        bms_main_step();
    }
#endif
}
