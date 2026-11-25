import {
    INA226_REG_BUS_V,
    INA226_REG_SHUNT_V,
    VSENSE_DIVIDER_RATIO
} from './bms_config.mjs';

import {
    OLED_PAGE_CHARGER,
    OLED_PAGE_DIAGNOSTICS,
    OLED_PAGE_OVERVIEW,
    OLED_PAGE_RELAYS,
    createDefaultSystemState
} from './bms_types.mjs';

import {
    hal_init,
    hal_mock_reset,
    hal_mock_set_adc_pa0_pin_voltage,
    hal_mock_set_ina226_register
} from './hal_mock.mjs';

import {
    ina226_encode_bus_voltage_reg,
    ina226_encode_shunt_current_reg
} from './drivers/ina226.mjs';

import {
    SSD1309_TEXT_LINES,
    ssd1309_get_text_line,
    ssd1309_mode_label,
    ssd1309_render_page
} from './drivers/ssd1309_oled.mjs';

import {
    bms_app_get_history_count,
    bms_app_get_history_entry,
    bms_app_init,
    bms_app_request_fault_clear,
    bms_app_set_page,
    bms_app_step
} from './app/bms_app.mjs';

function injectSensors(busV, currentA, chargerV) {
    hal_mock_set_ina226_register(INA226_REG_BUS_V, ina226_encode_bus_voltage_reg(busV));
    hal_mock_set_ina226_register(INA226_REG_SHUNT_V, ina226_encode_shunt_current_reg(currentA));
    hal_mock_set_adc_pa0_pin_voltage(chargerV / VSENSE_DIVIDER_RATIO);
}

function printOledScreen(title) {
    console.log(`\n=== ${title} ===`);
    for (let i = 0; i < SSD1309_TEXT_LINES; i++) {
        console.log(`  | ${ssd1309_get_text_line(i).padEnd(21, ' ')} |`);
    }
}

function runSimulation() {
    hal_mock_reset();
    hal_init();

    const state = createDefaultSystemState();
    injectSensors(14.8, 0.0, 0.0);
    bms_app_init(state);

    /* 1. Startup pre-charge (30 ms) -> STANDBY */
    for (let k = 0; k < 3; k++) {
        bms_app_step(state, 10);
    }
    console.log(`[1] After precharge: mode=${ssd1309_mode_label(state.mode)}, R1=${state.relays.cmd[0]}`);

    /* 2. Plug charger 16.4 V, charge +3.0 A for 500 ms -> CHARGE */
    state.charge_enabled_req = true;
    injectSensors(16.4, 3.0, 16.4);
    for (let k = 0; k < 50; k++) {
        bms_app_step(state, 10);
    }
    bms_app_set_page(state, OLED_PAGE_OVERVIEW);
    printOledScreen('OLED Page 1 (CHARGE)');
    bms_app_set_page(state, OLED_PAGE_CHARGER);
    printOledScreen('OLED Page 2 (CHARGER)');

    /* 3. Charge full (16.78 V, +0.10 A) -> auto cutoff R2 -> STANDBY */
    injectSensors(16.78, 0.10, 16.8);
    for (let k = 0; k < 10; k++) {
        bms_app_step(state, 10);
    }
    console.log(`[3] Charge complete: mode=${ssd1309_mode_label(state.mode)}, R2=${state.relays.cmd[1]}`);

    /* 4. Unplug charger, enable load -5.0 A for 500 ms -> DISCHARGE */
    state.charge_enabled_req = false;
    state.load_enabled_req = true;
    injectSensors(14.6, -5.0, 0.0);
    for (let k = 0; k < 50; k++) {
        bms_app_step(state, 10);
    }
    bms_app_set_page(state, OLED_PAGE_RELAYS);
    printOledScreen('OLED Page 3 (RELAYS - DISCHARGE)');

    /* 5. Level 2 Warning (-13.8 A) */
    injectSensors(14.3, -13.8, 0.0);
    for (let k = 0; k < 6; k++) {
        bms_app_step(state, 10);
    }
    console.log(`[5] Warning: prot_level=L${state.prot_level}, warning_flags=0x${state.warning_flags.toString(16)}`);

    /* 6. Short circuit (-28.0 A, 0 ms) -> Level 5 Latch + Isolate + Auto Page 4 */
    injectSensors(13.9, -28.0, 0.0);
    bms_app_step(state, 10);
    for (let k = 0; k < 20; k++) {
        bms_app_step(state, 10);
    }
    printOledScreen('OLED Page 4 (AUTO DIAGNOSTICS AFTER SHORT CIRCUIT)');

    /* 7. Fault clear rejection while unsafe, then safe recovery -> STANDBY */
    const rejected = bms_app_request_fault_clear(state);
    console.log(`[7a] Fault clear while unsafe: ${rejected}`);

    state.load_enabled_req = false;
    injectSensors(14.8, 0.0, 0.0);
    for (let k = 0; k < 3; k++) {
        bms_app_step(state, 10);
    }
    const cleared = bms_app_request_fault_clear(state);
    console.log(`[7b] Fault clear when safe: ${cleared}, mode=${ssd1309_mode_label(state.mode)}`);

    for (let k = 0; k < 3; k++) {
        bms_app_step(state, 10);
    }
    console.log(`[7c] Recovered after precharge: mode=${ssd1309_mode_label(state.mode)}, R1=${state.relays.cmd[0]}`);

    /* 8. Final summary of all 4 OLED pages and history log */
    for (const [page, label] of [
        [OLED_PAGE_OVERVIEW, 'FINAL PAGE 1 OVERVIEW'],
        [OLED_PAGE_CHARGER, 'FINAL PAGE 2 CHARGER'],
        [OLED_PAGE_RELAYS, 'FINAL PAGE 3 RELAYS'],
        [OLED_PAGE_DIAGNOSTICS, 'FINAL PAGE 4 DIAGNOSTICS']
    ]) {
        ssd1309_render_page(state, page);
        printOledScreen(label);
    }

    const histCount = bms_app_get_history_count();
    console.log(`\n=== BMS HISTORY (${histCount} entries) ===`);
    for (let i = 0; i < histCount; i++) {
        const entry = {};
        if (bms_app_get_history_entry(i, entry)) {
            console.log(
                `  #${i} t=${entry.timestamp_ms}ms mode=${ssd1309_mode_label(entry.mode)} ` +
                `L${entry.prot_level} fault=0x${entry.fault_mask.toString(16).toUpperCase().padStart(3, '0')} ` +
                `U=${entry.bus_voltage_v.toFixed(2)}V I=${entry.current_a.toFixed(2)}A SOC=${entry.soc_pct.toFixed(1)}%`
            );
        }
    }
}

runSimulation();
