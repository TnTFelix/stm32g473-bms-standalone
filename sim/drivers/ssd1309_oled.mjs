import {
    OLED_BUFFER_SIZE,
    OLED_WIDTH
} from '../bms_config.mjs';

import {
    BMS_MODE_CHARGE,
    BMS_MODE_DISCHARGE,
    BMS_MODE_FAULT,
    BMS_MODE_STANDBY,
    BMS_MODE_STARTUP,
    FAULT_BAT_OVERVOLTAGE,
    FAULT_BAT_UNDERVOLTAGE,
    FAULT_CHARGER_OVERVOLTAGE,
    FAULT_CHG_OVERCURRENT,
    FAULT_DIS_OVERCURRENT,
    FAULT_INA226_DISCONNECTED,
    FAULT_RELAY_NO_RESPONSE,
    FAULT_SHORT_CIRCUIT,
    FAULT_VSENSE_FAULT,
    OLED_PAGE_CHARGER,
    OLED_PAGE_COUNT,
    OLED_PAGE_DIAGNOSTICS,
    OLED_PAGE_OVERVIEW,
    OLED_PAGE_RELAYS,
    RELAY_2_CHARGE,
    RELAY_COUNT
} from '../bms_types.mjs';

import {
    hal_oled_reset,
    hal_oled_write_cmd,
    hal_oled_write_data
} from '../hal_mock.mjs';

export const SSD1309_TEXT_LINES = 8;
export const SSD1309_LINE_MAX_CHARS = 21;

const s_framebuffer = new Uint8Array(OLED_BUFFER_SIZE);
const s_text_lines = Array.from({ length: SSD1309_TEXT_LINES }, () => '');
let s_oled_initialized = false;

const K_DIGITS = [
    [0x3E, 0x51, 0x49, 0x45, 0x3E],
    [0x00, 0x42, 0x7F, 0x40, 0x00],
    [0x42, 0x61, 0x51, 0x49, 0x46],
    [0x21, 0x41, 0x45, 0x4B, 0x31],
    [0x18, 0x14, 0x12, 0x7F, 0x10],
    [0x27, 0x45, 0x45, 0x45, 0x39],
    [0x3C, 0x4A, 0x49, 0x49, 0x30],
    [0x01, 0x71, 0x09, 0x05, 0x03],
    [0x36, 0x49, 0x49, 0x49, 0x36],
    [0x06, 0x49, 0x49, 0x29, 0x1E]
];

const K_ALPHA = [
    [0x7E, 0x11, 0x11, 0x11, 0x7E],
    [0x7F, 0x49, 0x49, 0x49, 0x36],
    [0x3E, 0x41, 0x41, 0x41, 0x22],
    [0x7F, 0x41, 0x41, 0x22, 0x1C],
    [0x7F, 0x49, 0x49, 0x49, 0x41],
    [0x7F, 0x09, 0x09, 0x09, 0x01],
    [0x3E, 0x41, 0x49, 0x49, 0x7A],
    [0x7F, 0x08, 0x08, 0x08, 0x7F],
    [0x00, 0x41, 0x7F, 0x41, 0x00],
    [0x20, 0x40, 0x41, 0x3F, 0x01],
    [0x7F, 0x08, 0x14, 0x22, 0x41],
    [0x7F, 0x40, 0x40, 0x40, 0x40],
    [0x7F, 0x02, 0x0C, 0x02, 0x7F],
    [0x7F, 0x04, 0x08, 0x10, 0x7F],
    [0x3E, 0x41, 0x41, 0x41, 0x3E],
    [0x7F, 0x09, 0x09, 0x09, 0x06],
    [0x3E, 0x41, 0x51, 0x21, 0x5E],
    [0x7F, 0x09, 0x19, 0x29, 0x46],
    [0x46, 0x49, 0x49, 0x49, 0x31],
    [0x01, 0x01, 0x7F, 0x01, 0x01],
    [0x3F, 0x40, 0x40, 0x40, 0x3F],
    [0x1F, 0x20, 0x40, 0x20, 0x1F],
    [0x3F, 0x40, 0x38, 0x40, 0x3F],
    [0x63, 0x14, 0x08, 0x14, 0x63],
    [0x07, 0x08, 0x70, 0x08, 0x07],
    [0x61, 0x51, 0x49, 0x45, 0x43]
];

const K_SPACE    = [0x00, 0x00, 0x00, 0x00, 0x00];
const K_DOT      = [0x00, 0x60, 0x60, 0x00, 0x00];
const K_COLON    = [0x00, 0x36, 0x36, 0x00, 0x00];
const K_PLUS     = [0x08, 0x08, 0x3E, 0x08, 0x08];
const K_MINUS    = [0x08, 0x08, 0x08, 0x08, 0x08];
const K_SLASH    = [0x20, 0x10, 0x08, 0x04, 0x02];
const K_PERCENT  = [0x23, 0x13, 0x08, 0x64, 0x62];
const K_LBRACKET = [0x00, 0x7F, 0x41, 0x41, 0x00];
const K_RBRACKET = [0x00, 0x41, 0x41, 0x7F, 0x00];
const K_HASH     = [0x14, 0x7F, 0x14, 0x7F, 0x14];
const K_UNDER    = [0x40, 0x40, 0x40, 0x40, 0x40];
const K_BANG     = [0x00, 0x00, 0x5F, 0x00, 0x00];
const K_EQUAL    = [0x14, 0x14, 0x14, 0x14, 0x14];
const K_BOX      = [0x7F, 0x41, 0x41, 0x41, 0x7F];

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function lookupGlyph(ch) {
    const code = ch.toUpperCase().charCodeAt(0);
    if (code >= 48 && code <= 57) {
        return K_DIGITS[code - 48];
    }
    if (code >= 65 && code <= 90) {
        return K_ALPHA[code - 65];
    }
    if (ch === ' ') return K_SPACE;
    if (ch === '.') return K_DOT;
    if (ch === ':') return K_COLON;
    if (ch === '+') return K_PLUS;
    if (ch === '-') return K_MINUS;
    if (ch === '/') return K_SLASH;
    if (ch === '%') return K_PERCENT;
    if (ch === '[') return K_LBRACKET;
    if (ch === ']') return K_RBRACKET;
    if (ch === '#') return K_HASH;
    if (ch === '_') return K_UNDER;
    if (ch === '!') return K_BANG;
    if (ch === '=') return K_EQUAL;
    return K_BOX;
}

function clampFloat(v, minV, maxV) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        return 0;
    }
    if (v < minV) return minV;
    if (v > maxV) return maxV;
    if (v === 0) return 0;
    return v;
}

function formatSigned1(v) {
    const rounded = clampFloat(Math.round(v * 10) / 10, -999.9, 999.9);
    return (rounded >= 0 ? '+' : '') + rounded.toFixed(1);
}

function formatSigned2(v) {
    const rounded = clampFloat(Math.round(v * 100) / 100, -999.99, 999.99);
    return (rounded >= 0 ? '+' : '') + rounded.toFixed(2);
}

function padRight(str, width) {
    if (str.length >= width) {
        return str.slice(0, width);
    }
    return str + ' '.repeat(width - str.length);
}

function invertRow(lineIdx) {
    if (lineIdx < 0 || lineIdx >= SSD1309_TEXT_LINES) {
        return;
    }
    const pageOffset = lineIdx * OLED_WIDTH;
    for (let col = 0; col < OLED_WIDTH; col++) {
        s_framebuffer[pageOffset + col] = (~s_framebuffer[pageOffset + col]) & 0xFF;
    }
}

function drawBatteryBar(lineIdx, socPct) {
    if (lineIdx < 0 || lineIdx >= SSD1309_TEXT_LINES) {
        return;
    }
    const pageOffset = lineIdx * OLED_WIDTH;
    const xStart = 24;
    const barW = 72;
    const fillW = Math.min(barW - 4, Math.max(0, Math.round((socPct / 100) * (barW - 4))));

    s_framebuffer[pageOffset + xStart] = 0x7E;
    for (let x = 1; x < barW - 1; x++) {
        s_framebuffer[pageOffset + xStart + x] = (x >= 2 && x < 2 + fillW) ? 0x7E : 0x42;
    }
    s_framebuffer[pageOffset + xStart + barW - 1] = 0x7E;
    s_framebuffer[pageOffset + xStart + barW] = 0x18;
    s_framebuffer[pageOffset + xStart + barW + 1] = 0x18;
}

function drawHDivider(lineIdx) {
    if (lineIdx < 0 || lineIdx >= SSD1309_TEXT_LINES) {
        return;
    }
    const pageOffset = lineIdx * OLED_WIDTH;
    s_framebuffer.fill(0x08, pageOffset, pageOffset + OLED_WIDTH);
}

function faultName(faultMask) {
    if ((faultMask & FAULT_SHORT_CIRCUIT) !== 0) return 'SHORT_CKT';
    if ((faultMask & FAULT_INA226_DISCONNECTED) !== 0) return 'INA_NO_ACK';
    if ((faultMask & FAULT_RELAY_NO_RESPONSE) !== 0) return 'RLY_ERR';
    if ((faultMask & FAULT_BAT_OVERVOLTAGE) !== 0) return 'BAT_OV';
    if ((faultMask & FAULT_BAT_UNDERVOLTAGE) !== 0) return 'BAT_UV';
    if ((faultMask & FAULT_CHG_OVERCURRENT) !== 0) return 'CHG_OC';
    if ((faultMask & FAULT_DIS_OVERCURRENT) !== 0) return 'DIS_OC';
    if ((faultMask & FAULT_CHARGER_OVERVOLTAGE) !== 0) return 'CHG_OV';
    if ((faultMask & FAULT_VSENSE_FAULT) !== 0) return 'VSENSE_ERR';
    return 'ALL_OK';
}

export function ssd1309_reset_state() {
    ssd1309_clear_buffer();
    s_oled_initialized = false;
}

export function ssd1309_init() {
    const initCmds = [
        0xAE,
        0x20, 0x00,
        0x81, 0xCF,
        0xA1,
        0xC8,
        0xA8, 0x3F,
        0xA6,
        0xAF
    ];

    ssd1309_reset_state();

    if (!hal_oled_reset()) {
        return false;
    }

    for (const cmd of initCmds) {
        if (!hal_oled_write_cmd(cmd)) {
            return false;
        }
    }

    if (!ssd1309_flush()) {
        return false;
    }

    s_oled_initialized = true;
    return true;
}

export function ssd1309_clear_buffer() {
    s_framebuffer.fill(0);
    for (let i = 0; i < SSD1309_TEXT_LINES; i++) {
        s_text_lines[i] = '';
    }
}

export function ssd1309_draw_text_line(line_idx, text) {
    if (typeof text !== 'string') {
        return false;
    }
    if (!Number.isInteger(line_idx) || line_idx < 0 || line_idx >= SSD1309_TEXT_LINES) {
        return false;
    }

    const clipped = text.slice(0, SSD1309_LINE_MAX_CHARS);
    s_text_lines[line_idx] = clipped;

    const pageOffset = line_idx * OLED_WIDTH;
    s_framebuffer.fill(0, pageOffset, pageOffset + OLED_WIDTH);

    for (let charIdx = 0; charIdx < clipped.length; charIdx++) {
        const baseX = charIdx * 6;
        const glyph = lookupGlyph(clipped[charIdx]);
        for (let col = 0; col < 5; col++) {
            if (baseX + col < OLED_WIDTH) {
                s_framebuffer[pageOffset + baseX + col] = glyph[col];
            }
        }
    }

    return true;
}

export function ssd1309_render_page(state, page) {
    if (!isPlainObject(state) ||
        !isPlainObject(state.meas) ||
        !isPlainObject(state.energy) ||
        !isPlainObject(state.relays) ||
        !isPlainObject(state.snapshot)) {
        return false;
    }
    if (!Number.isInteger(page) || page < 0 || page >= OLED_PAGE_COUNT) {
        return false;
    }

    ssd1309_clear_buffer();

    const busV = clampFloat(state.meas.bus_voltage_v, -999.9, 999.9);
    const currA = clampFloat(state.meas.current_a, -999.9, 999.9);
    const powerW = clampFloat(state.meas.power_w, -999.9, 999.9);
    const socPct = clampFloat(state.energy.soc_pct, 0, 100);
    const chgV = clampFloat(state.meas.charger_voltage_v, 0, 999.9);
    const chgI = currA > 0 ? currA : 0;
    const chgP = clampFloat(state.energy.charge_power_w, 0, 999.9);
    const vpinV = clampFloat(state.meas.charger_pin_v, 0, 99.9);
    const einWh = clampFloat(state.energy.energy_in_wh, 0, 999.9);
    const eoutWh = clampFloat(state.energy.energy_out_wh, 0, 999.9);
    const qchgAh = clampFloat(state.energy.charge_capacity_ah, 0, 999.9);
    const qdisAh = clampFloat(state.energy.discharge_capacity_ah, 0, 999.9);
    const effPct = clampFloat(state.energy.efficiency_pct, 0, 100);
    const remM = clampFloat(state.energy.remaining_time_min, 0, 9999);
    const chgM = clampFloat(state.energy.estimated_charge_time_min, 0, 9999);
    const snapV = clampFloat(state.snapshot.bus_voltage_v, -999.9, 999.9);
    const snapI = clampFloat(state.snapshot.current_a, -999.9, 999.9);
    const protLvl = Number.isInteger(state.prot_level) ? state.prot_level : 1;
    const activeFaults = (state.active_faults >>> 0) & 0x0FFF;
    const latchedMask = (state.snapshot.latched_fault_mask >>> 0) & 0x0FFF;
    const warnFlags = (state.warning_flags >>> 0) & 0x0FFF;
    const uptimeS = Math.min(999999, Math.floor((state.tick_ms >>> 0) / 1000));

    const filledBars = Math.min(10, Math.max(0, Math.round(socPct / 10)));
    const bar = '#'.repeat(filledBars) + '-'.repeat(10 - filledBars);

    if (page === OLED_PAGE_OVERVIEW) {
        const errMask = activeFaults !== 0 ? activeFaults : latchedMask;
        ssd1309_draw_text_line(0, `4S BMS  ${padRight(ssd1309_mode_label(state.mode), 7)} L${protLvl}`);
        invertRow(0);

        ssd1309_draw_text_line(1, `U:${busV.toFixed(2)}V I:${formatSigned2(currA)}A`);
        if (state.mode === BMS_MODE_CHARGE && chgM > 0) {
            ssd1309_draw_text_line(2, `P:${powerW.toFixed(1)}W Tchg:${chgM.toFixed(0)}m`);
        } else if (remM > 0) {
            ssd1309_draw_text_line(2, `P:${powerW.toFixed(1)}W Trem:${remM.toFixed(0)}m`);
        } else {
            ssd1309_draw_text_line(2, `P:${powerW.toFixed(1)}W T:--`);
        }

        const socStr = socPct.toFixed(0).padStart(3, ' ');
        ssd1309_draw_text_line(3, `BAT:[${bar}] ${socStr}%`);
        drawBatteryBar(3, socPct);

        ssd1309_draw_text_line(4, `Uc:${chgV.toFixed(2)}V CHG:${state.meas.charger_present ? 'YES' : 'NO'}`);
        ssd1309_draw_text_line(5, `Ei:${einWh.toFixed(2)} Eo:${eoutWh.toFixed(2)}Wh`);
        ssd1309_draw_text_line(6, `R1:${state.relays.cmd[0] ? 1 : 0} R2:${state.relays.cmd[1] ? 1 : 0} R3:${state.relays.cmd[2] ? 1 : 0} R4:${state.relays.cmd[3] ? 1 : 0}`);
        ssd1309_draw_text_line(7, `I:${state.meas.ina226_ok ? 'OK' : 'ER'} V:${state.meas.vsense_ok ? 'OK' : 'ER'} ${faultName(errMask)}`);
    } else if (page === OLED_PAGE_CHARGER) {
        ssd1309_draw_text_line(0, `P2 CHARGER CHG:${state.meas.charger_present ? 'YES' : 'NO'}`);
        invertRow(0);

        ssd1309_draw_text_line(1, `Uc:${chgV.toFixed(2)}V Ub:${busV.toFixed(2)}V`);
        ssd1309_draw_text_line(2, `Ic:${chgI.toFixed(2)}A Pc:${chgP.toFixed(1)}W`);
        ssd1309_draw_text_line(3, `R2:${state.relays.cmd[RELAY_2_CHARGE] ? 'ON' : 'OFF'} VS:${state.meas.vsense_ok ? 'OK' : 'ERR'}`);
        ssd1309_draw_text_line(4, `PA0:${vpinV.toFixed(2)}V Eff:${effPct.toFixed(0)}%`);
        ssd1309_draw_text_line(5, `Ein:${einWh.toFixed(2)}Wh Qc:${qchgAh.toFixed(2)}Ah`);
        ssd1309_draw_text_line(6, chgM > 0 ? `Tchg:${chgM.toFixed(0)}m Full:16.8V` : 'Tchg:-- Full:16.8V');
        ssd1309_draw_text_line(7, `${padRight(ssd1309_mode_label(state.mode), 7)} L${protLvl} SOC:${socPct.toFixed(0).padStart(3, ' ')}%`);
    } else if (page === OLED_PAGE_RELAYS) {
        for (let i = 0; i < RELAY_COUNT; i++) {
            const cmdStr = state.relays.cmd[i] ? 'ON' : 'OFF';
            const fbStr = state.relays.feedback[i] ? 'ON' : 'OFF';
            const stStr = state.relays.fault_mismatch[i] ? 'ERR' : 'OK';
            ssd1309_draw_text_line(i, `R${i + 1} C:${cmdStr} F:${fbStr} ${stStr}`);
        }
        ssd1309_draw_text_line(4, '---------------------');
        drawHDivider(4);
        ssd1309_draw_text_line(5, 'R1:MAIN   R2:CHARGE');
        ssd1309_draw_text_line(6, 'R3:LOAD   R4:AUX/PC');
        ssd1309_draw_text_line(7, `P3 RLY ${padRight(ssd1309_mode_label(state.mode), 7)} L${protLvl}`);
        invertRow(7);
    } else if (page === OLED_PAGE_DIAGNOSTICS) {
        const errMask = activeFaults !== 0 ? activeFaults : latchedMask;
        ssd1309_draw_text_line(0, `P4 DIAG L${protLvl} F:0x${activeFaults.toString(16).toUpperCase().padStart(3, '0')}`);
        invertRow(0);

        ssd1309_draw_text_line(1, `INA:${state.meas.ina226_ok ? 'OK' : 'ERR'} VS:${state.meas.vsense_ok ? 'OK' : 'ERR'}`);
        ssd1309_draw_text_line(2, `LAT:${state.fault_latched ? 'YES' : 'NO'} M:0x${latchedMask.toString(16).toUpperCase().padStart(3, '0')}`);
        ssd1309_draw_text_line(3, state.snapshot.valid ? `SNAP:${snapV.toFixed(1)}V ${formatSigned1(snapI)}A` : 'SNAP:NONE');
        ssd1309_draw_text_line(4, `ERR:${faultName(errMask)}`);
        ssd1309_draw_text_line(5, `W:0x${warnFlags.toString(16).toUpperCase().padStart(3, '0')} MODE:${padRight(ssd1309_mode_label(state.mode), 7)}`);
        ssd1309_draw_text_line(6, `R1:${state.relays.cmd[0] ? 1 : 0} R2:${state.relays.cmd[1] ? 1 : 0} R3:${state.relays.cmd[2] ? 1 : 0} R4:${state.relays.cmd[3] ? 1 : 0}`);
        ssd1309_draw_text_line(7, `T:${uptimeS}s ${state.fault_latched ? 'LATCHED' : 'READY'}`);
    }

    return true;
}

export function ssd1309_flush() {
    const addrCmds = [0x21, 0x00, 0x7F, 0x22, 0x00, 0x07];
    for (const cmd of addrCmds) {
        if (!hal_oled_write_cmd(cmd)) {
            return false;
        }
    }
    return hal_oled_write_data(s_framebuffer, OLED_BUFFER_SIZE);
}

export function ssd1309_get_framebuffer() {
    return new Uint8Array(s_framebuffer);
}

export function ssd1309_get_text_line(line_idx) {
    if (!Number.isInteger(line_idx) || line_idx < 0 || line_idx >= SSD1309_TEXT_LINES) {
        return null;
    }
    return s_text_lines[line_idx];
}

export function ssd1309_mode_label(mode) {
    switch (mode) {
    case BMS_MODE_STARTUP:
        return 'STARTUP';
    case BMS_MODE_CHARGE:
        return 'CHARGE';
    case BMS_MODE_DISCHARGE:
        return 'DISCHRG';
    case BMS_MODE_STANDBY:
        return 'STANDBY';
    case BMS_MODE_FAULT:
        return 'FAULT';
    default:
        return 'UNKNOWN';
    }
}
