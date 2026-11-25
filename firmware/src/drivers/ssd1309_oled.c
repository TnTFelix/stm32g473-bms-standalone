#include "ssd1309_oled.h"
#include "hal_interface.h"
#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

static uint8_t s_framebuffer[OLED_BUFFER_SIZE];
static char s_text_lines[SSD1309_TEXT_LINES][SSD1309_LINE_MAX_CHARS + 1U];
static bool s_oled_initialized = false;

static void ssd1309_lookup_glyph(char ch, uint8_t out_cols[5])
{
    static const uint8_t k_digits[10][5] = {
        {0x3E, 0x51, 0x49, 0x45, 0x3E}, /* 0 */
        {0x00, 0x42, 0x7F, 0x40, 0x00}, /* 1 */
        {0x42, 0x61, 0x51, 0x49, 0x46}, /* 2 */
        {0x21, 0x41, 0x45, 0x4B, 0x31}, /* 3 */
        {0x18, 0x14, 0x12, 0x7F, 0x10}, /* 4 */
        {0x27, 0x45, 0x45, 0x45, 0x39}, /* 5 */
        {0x3C, 0x4A, 0x49, 0x49, 0x30}, /* 6 */
        {0x01, 0x71, 0x09, 0x05, 0x03}, /* 7 */
        {0x36, 0x49, 0x49, 0x49, 0x36}, /* 8 */
        {0x06, 0x49, 0x49, 0x29, 0x1E}  /* 9 */
    };
    static const uint8_t k_alpha[26][5] = {
        {0x7E, 0x11, 0x11, 0x11, 0x7E}, /* A */
        {0x7F, 0x49, 0x49, 0x49, 0x36}, /* B */
        {0x3E, 0x41, 0x41, 0x41, 0x22}, /* C */
        {0x7F, 0x41, 0x41, 0x22, 0x1C}, /* D */
        {0x7F, 0x49, 0x49, 0x49, 0x41}, /* E */
        {0x7F, 0x09, 0x09, 0x09, 0x01}, /* F */
        {0x3E, 0x41, 0x49, 0x49, 0x7A}, /* G */
        {0x7F, 0x08, 0x08, 0x08, 0x7F}, /* H */
        {0x00, 0x41, 0x7F, 0x41, 0x00}, /* I */
        {0x20, 0x40, 0x41, 0x3F, 0x01}, /* J */
        {0x7F, 0x08, 0x14, 0x22, 0x41}, /* K */
        {0x7F, 0x40, 0x40, 0x40, 0x40}, /* L */
        {0x7F, 0x02, 0x0C, 0x02, 0x7F}, /* M */
        {0x7F, 0x04, 0x08, 0x10, 0x7F}, /* N */
        {0x3E, 0x41, 0x41, 0x41, 0x3E}, /* O */
        {0x7F, 0x09, 0x09, 0x09, 0x06}, /* P */
        {0x3E, 0x41, 0x51, 0x21, 0x5E}, /* Q */
        {0x7F, 0x09, 0x19, 0x29, 0x46}, /* R */
        {0x46, 0x49, 0x49, 0x49, 0x31}, /* S */
        {0x01, 0x01, 0x7F, 0x01, 0x01}, /* T */
        {0x3F, 0x40, 0x40, 0x40, 0x3F}, /* U */
        {0x1F, 0x20, 0x40, 0x20, 0x1F}, /* V */
        {0x3F, 0x40, 0x38, 0x40, 0x3F}, /* W */
        {0x63, 0x14, 0x08, 0x14, 0x63}, /* X */
        {0x07, 0x08, 0x70, 0x08, 0x07}, /* Y */
        {0x61, 0x51, 0x49, 0x45, 0x43}  /* Z */
    };
    static const uint8_t k_space[5]    = {0x00, 0x00, 0x00, 0x00, 0x00};
    static const uint8_t k_dot[5]      = {0x00, 0x60, 0x60, 0x00, 0x00};
    static const uint8_t k_colon[5]    = {0x00, 0x36, 0x36, 0x00, 0x00};
    static const uint8_t k_plus[5]     = {0x08, 0x08, 0x3E, 0x08, 0x08};
    static const uint8_t k_minus[5]    = {0x08, 0x08, 0x08, 0x08, 0x08};
    static const uint8_t k_slash[5]    = {0x20, 0x10, 0x08, 0x04, 0x02};
    static const uint8_t k_percent[5]  = {0x23, 0x13, 0x08, 0x64, 0x62};
    static const uint8_t k_lbracket[5] = {0x00, 0x7F, 0x41, 0x41, 0x00};
    static const uint8_t k_rbracket[5] = {0x00, 0x41, 0x41, 0x7F, 0x00};
    static const uint8_t k_hash[5]     = {0x14, 0x7F, 0x14, 0x7F, 0x14};
    static const uint8_t k_under[5]    = {0x40, 0x40, 0x40, 0x40, 0x40};
    static const uint8_t k_bang[5]     = {0x00, 0x00, 0x5F, 0x00, 0x00};
    static const uint8_t k_equal[5]    = {0x14, 0x14, 0x14, 0x14, 0x14};
    static const uint8_t k_box[5]      = {0x7F, 0x41, 0x41, 0x41, 0x7F};
    const uint8_t *src = k_box;
    uint32_t i;

    if (out_cols == NULL) {
        return;
    }

    if ((ch >= 'a') && (ch <= 'z')) {
        ch = (char)(ch - ('a' - 'A'));
    }

    if ((ch >= '0') && (ch <= '9')) {
        src = k_digits[(uint8_t)(ch - '0')];
    } else if ((ch >= 'A') && (ch <= 'Z')) {
        src = k_alpha[(uint8_t)(ch - 'A')];
    } else if (ch == ' ') {
        src = k_space;
    } else if (ch == '.') {
        src = k_dot;
    } else if (ch == ':') {
        src = k_colon;
    } else if (ch == '+') {
        src = k_plus;
    } else if (ch == '-') {
        src = k_minus;
    } else if (ch == '/') {
        src = k_slash;
    } else if (ch == '%') {
        src = k_percent;
    } else if (ch == '[') {
        src = k_lbracket;
    } else if (ch == ']') {
        src = k_rbracket;
    } else if (ch == '#') {
        src = k_hash;
    } else if (ch == '_') {
        src = k_under;
    } else if (ch == '!') {
        src = k_bang;
    } else if (ch == '=') {
        src = k_equal;
    }

    for (i = 0U; i < 5U; i++) {
        out_cols[i] = src[i];
    }
}

static float ssd1309_clamp_float(float v, float min_v, float max_v)
{
    if (!isfinite(v)) {
        return 0.0f;
    }
    if (v < min_v) {
        return min_v;
    }
    if (v > max_v) {
        return max_v;
    }
    if (v == 0.0f) {
        return 0.0f;
    }
    return v;
}

static void ssd1309_invert_row(uint8_t line_idx)
{
    uint32_t page_offset;
    uint32_t col;

    if (line_idx >= SSD1309_TEXT_LINES) {
        return;
    }

    page_offset = (uint32_t)line_idx * OLED_WIDTH;
    for (col = 0U; col < OLED_WIDTH; col++) {
        s_framebuffer[page_offset + col] = (uint8_t)(~s_framebuffer[page_offset + col]);
    }
}

static void ssd1309_draw_battery_bar(uint8_t line_idx, float soc_pct)
{
    uint32_t page_offset;
    uint32_t x_start = 24U;
    uint32_t bar_w = 72U;
    uint32_t fill_w;
    uint32_t x;

    if (line_idx >= SSD1309_TEXT_LINES) {
        return;
    }

    page_offset = (uint32_t)line_idx * OLED_WIDTH;
    fill_w = (uint32_t)((soc_pct / 100.0f) * (float)(bar_w - 4U) + 0.5f);
    if (fill_w > (bar_w - 4U)) {
        fill_w = bar_w - 4U;
    }

    s_framebuffer[page_offset + x_start] = 0x7EU;
    for (x = 1U; x < (bar_w - 1U); x++) {
        if ((x >= 2U) && (x < (2U + fill_w))) {
            s_framebuffer[page_offset + x_start + x] = 0x7EU;
        } else {
            s_framebuffer[page_offset + x_start + x] = 0x42U;
        }
    }
    s_framebuffer[page_offset + x_start + bar_w - 1U] = 0x7EU;
    s_framebuffer[page_offset + x_start + bar_w] = 0x18U;
    s_framebuffer[page_offset + x_start + bar_w + 1U] = 0x18U;
}

static void ssd1309_draw_hdivider(uint8_t line_idx)
{
    uint32_t page_offset;
    uint32_t col;

    if (line_idx >= SSD1309_TEXT_LINES) {
        return;
    }

    page_offset = (uint32_t)line_idx * OLED_WIDTH;
    for (col = 0U; col < OLED_WIDTH; col++) {
        s_framebuffer[page_offset + col] = 0x08U;
    }
}

static const char *ssd1309_fault_name(uint32_t fault_mask)
{
    if ((fault_mask & (uint32_t)FAULT_SHORT_CIRCUIT) != 0U) {
        return "SHORT_CKT";
    }
    if ((fault_mask & (uint32_t)FAULT_INA226_DISCONNECTED) != 0U) {
        return "INA_NO_ACK";
    }
    if ((fault_mask & (uint32_t)FAULT_RELAY_NO_RESPONSE) != 0U) {
        return "RLY_ERR";
    }
    if ((fault_mask & (uint32_t)FAULT_BAT_OVERVOLTAGE) != 0U) {
        return "BAT_OV";
    }
    if ((fault_mask & (uint32_t)FAULT_BAT_UNDERVOLTAGE) != 0U) {
        return "BAT_UV";
    }
    if ((fault_mask & (uint32_t)FAULT_CHG_OVERCURRENT) != 0U) {
        return "CHG_OC";
    }
    if ((fault_mask & (uint32_t)FAULT_DIS_OVERCURRENT) != 0U) {
        return "DIS_OC";
    }
    if ((fault_mask & (uint32_t)FAULT_CHARGER_OVERVOLTAGE) != 0U) {
        return "CHG_OV";
    }
    if ((fault_mask & (uint32_t)FAULT_VSENSE_FAULT) != 0U) {
        return "VSENSE_ERR";
    }
    return "ALL_OK";
}

void ssd1309_reset_state(void)
{
    ssd1309_clear_buffer();
    s_oled_initialized = false;
}

bool ssd1309_init(void)
{
    static const uint8_t k_init_cmds[11] = {
        0xAEU,
        0x20U, 0x00U,
        0x81U, 0xCFU,
        0xA1U,
        0xC8U,
        0xA8U, 0x3FU,
        0xA6U,
        0xAFU
    };
    uint32_t i;

    ssd1309_reset_state();

    if (!hal_oled_reset()) {
        return false;
    }

    for (i = 0U; i < 11U; i++) {
        if (!hal_oled_write_cmd(k_init_cmds[i])) {
            return false;
        }
    }

    if (!ssd1309_flush()) {
        return false;
    }

    s_oled_initialized = true;
    return true;
}

void ssd1309_clear_buffer(void)
{
    uint32_t i;

    (void)memset(s_framebuffer, 0, sizeof(s_framebuffer));
    for (i = 0U; i < SSD1309_TEXT_LINES; i++) {
        (void)memset(s_text_lines[i], 0, sizeof(s_text_lines[i]));
    }
}

bool ssd1309_draw_text_line(uint8_t line_idx, const char *text)
{
    uint32_t page_offset;
    uint32_t char_idx;
    uint8_t glyph[5];
    uint32_t col;

    if (text == NULL) {
        return false;
    }
    if (line_idx >= SSD1309_TEXT_LINES) {
        return false;
    }

    (void)memset(s_text_lines[line_idx], 0, sizeof(s_text_lines[line_idx]));
    for (char_idx = 0U; (char_idx < SSD1309_LINE_MAX_CHARS) && (text[char_idx] != '\0'); char_idx++) {
        s_text_lines[line_idx][char_idx] = text[char_idx];
    }
    s_text_lines[line_idx][char_idx] = '\0';

    page_offset = (uint32_t)line_idx * OLED_WIDTH;
    (void)memset(&s_framebuffer[page_offset], 0, OLED_WIDTH);

    for (char_idx = 0U; s_text_lines[line_idx][char_idx] != '\0'; char_idx++) {
        uint32_t base_x = char_idx * 6U;
        ssd1309_lookup_glyph(s_text_lines[line_idx][char_idx], glyph);
        for (col = 0U; col < 5U; col++) {
            if ((base_x + col) < OLED_WIDTH) {
                s_framebuffer[page_offset + base_x + col] = glyph[col];
            }
        }
    }

    return true;
}

bool ssd1309_render_page(const bms_system_state_t *state, bms_oled_page_t page)
{
    char line[SSD1309_LINE_MAX_CHARS + 1U];
    char bar[11];
    float bus_v;
    float curr_a;
    float power_w;
    float soc_pct;
    float chg_v;
    float chg_i;
    float chg_p;
    float vpin_v;
    float ein_wh;
    float eout_wh;
    float qchg_ah;
    float qdis_ah;
    float eff_pct;
    float rem_m;
    float chg_m;
    float snap_v;
    float snap_i;
    uint32_t prot_lvl;
    uint32_t filled_bars;
    uint32_t uptime_s;
    uint32_t i;

    if (state == NULL) {
        return false;
    }
    if ((uint32_t)page >= (uint32_t)OLED_PAGE_COUNT) {
        return false;
    }

    ssd1309_clear_buffer();

    bus_v = ssd1309_clamp_float(state->meas.bus_voltage_v, -999.9f, 999.9f);
    curr_a = ssd1309_clamp_float(state->meas.current_a, -999.9f, 999.9f);
    power_w = ssd1309_clamp_float(state->meas.power_w, -999.9f, 999.9f);
    soc_pct = ssd1309_clamp_float(state->energy.soc_pct, 0.0f, 100.0f);
    chg_v = ssd1309_clamp_float(state->meas.charger_voltage_v, 0.0f, 999.9f);
    chg_i = (curr_a > 0.0f) ? curr_a : 0.0f;
    chg_p = ssd1309_clamp_float(state->energy.charge_power_w, 0.0f, 999.9f);
    vpin_v = ssd1309_clamp_float(state->meas.charger_pin_v, 0.0f, 99.9f);
    ein_wh = ssd1309_clamp_float(state->energy.energy_in_wh, 0.0f, 999.9f);
    eout_wh = ssd1309_clamp_float(state->energy.energy_out_wh, 0.0f, 999.9f);
    qchg_ah = ssd1309_clamp_float(state->energy.charge_capacity_ah, 0.0f, 999.9f);
    qdis_ah = ssd1309_clamp_float(state->energy.discharge_capacity_ah, 0.0f, 999.9f);
    eff_pct = ssd1309_clamp_float(state->energy.efficiency_pct, 0.0f, 100.0f);
    (void)qdis_ah;
    rem_m = ssd1309_clamp_float(state->energy.remaining_time_min, 0.0f, 9999.0f);
    chg_m = ssd1309_clamp_float(state->energy.estimated_charge_time_min, 0.0f, 9999.0f);
    snap_v = ssd1309_clamp_float(state->snapshot.bus_voltage_v, -999.9f, 999.9f);
    snap_i = ssd1309_clamp_float(state->snapshot.current_a, -999.9f, 999.9f);
    prot_lvl = (uint32_t)state->prot_level;
    uptime_s = state->tick_ms / 1000U;
    if (uptime_s > 999999U) {
        uptime_s = 999999U;
    }

    filled_bars = (uint32_t)((soc_pct / 10.0f) + 0.5f);
    if (filled_bars > 10U) {
        filled_bars = 10U;
    }
    for (i = 0U; i < 10U; i++) {
        bar[i] = (i < filled_bars) ? '#' : '-';
    }
    bar[10] = '\0';

    if (page == OLED_PAGE_OVERVIEW) {
        uint32_t err_mask = (state->active_faults != 0U)
                                ? state->active_faults
                                : state->snapshot.latched_fault_mask;

        (void)snprintf(line, sizeof(line), "4S BMS  %-7s L%u",
                       ssd1309_mode_label(state->mode),
                       (unsigned int)prot_lvl);
        (void)ssd1309_draw_text_line(0U, line);
        ssd1309_invert_row(0U);

        (void)snprintf(line, sizeof(line), "U:%.2fV I:%+.2fA", bus_v, curr_a);
        (void)ssd1309_draw_text_line(1U, line);

        if ((state->mode == BMS_MODE_CHARGE) && (chg_m > 0.0f)) {
            (void)snprintf(line, sizeof(line), "P:%.1fW Tchg:%.0fm", power_w, chg_m);
        } else if (rem_m > 0.0f) {
            (void)snprintf(line, sizeof(line), "P:%.1fW Trem:%.0fm", power_w, rem_m);
        } else {
            (void)snprintf(line, sizeof(line), "P:%.1fW T:--", power_w);
        }
        (void)ssd1309_draw_text_line(2U, line);

        (void)snprintf(line, sizeof(line), "BAT:[%s] %3.0f%%", bar, soc_pct);
        (void)ssd1309_draw_text_line(3U, line);
        ssd1309_draw_battery_bar(3U, soc_pct);

        (void)snprintf(line, sizeof(line), "Uc:%.2fV CHG:%s",
                       chg_v,
                       state->meas.charger_present ? "YES" : "NO");
        (void)ssd1309_draw_text_line(4U, line);

        (void)snprintf(line, sizeof(line), "Ei:%.2f Eo:%.2fWh", ein_wh, eout_wh);
        (void)ssd1309_draw_text_line(5U, line);

        (void)snprintf(line, sizeof(line), "R1:%u R2:%u R3:%u R4:%u",
                       state->relays.cmd[0] ? 1U : 0U,
                       state->relays.cmd[1] ? 1U : 0U,
                       state->relays.cmd[2] ? 1U : 0U,
                       state->relays.cmd[3] ? 1U : 0U);
        (void)ssd1309_draw_text_line(6U, line);

        (void)snprintf(line, sizeof(line), "I:%s V:%s %s",
                       state->meas.ina226_ok ? "OK" : "ER",
                       state->meas.vsense_ok ? "OK" : "ER",
                       ssd1309_fault_name(err_mask));
        (void)ssd1309_draw_text_line(7U, line);
    } else if (page == OLED_PAGE_CHARGER) {
        (void)snprintf(line, sizeof(line), "P2 CHARGER CHG:%s", state->meas.charger_present ? "YES" : "NO");
        (void)ssd1309_draw_text_line(0U, line);
        ssd1309_invert_row(0U);

        (void)snprintf(line, sizeof(line), "Uc:%.2fV Ub:%.2fV", chg_v, bus_v);
        (void)ssd1309_draw_text_line(1U, line);

        (void)snprintf(line, sizeof(line), "Ic:%.2fA Pc:%.1fW", chg_i, chg_p);
        (void)ssd1309_draw_text_line(2U, line);

        (void)snprintf(line, sizeof(line), "R2:%s VS:%s",
                       state->relays.cmd[RELAY_2_CHARGE] ? "ON" : "OFF",
                       state->meas.vsense_ok ? "OK" : "ERR");
        (void)ssd1309_draw_text_line(3U, line);

        (void)snprintf(line, sizeof(line), "PA0:%.2fV Eff:%.0f%%", vpin_v, eff_pct);
        (void)ssd1309_draw_text_line(4U, line);

        (void)snprintf(line, sizeof(line), "Ein:%.2fWh Qc:%.2fAh", ein_wh, qchg_ah);
        (void)ssd1309_draw_text_line(5U, line);

        if (chg_m > 0.0f) {
            (void)snprintf(line, sizeof(line), "Tchg:%.0fm Full:16.8V", chg_m);
        } else {
            (void)snprintf(line, sizeof(line), "Tchg:-- Full:16.8V");
        }
        (void)ssd1309_draw_text_line(6U, line);

        (void)snprintf(line, sizeof(line), "%-7s L%u SOC:%3.0f%%",
                       ssd1309_mode_label(state->mode),
                       (unsigned int)prot_lvl,
                       soc_pct);
        (void)ssd1309_draw_text_line(7U, line);
    } else if (page == OLED_PAGE_RELAYS) {
        for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
            (void)snprintf(line, sizeof(line), "R%u C:%s F:%s %s",
                           (unsigned int)(i + 1U),
                           state->relays.cmd[i] ? "ON" : "OFF",
                           state->relays.feedback[i] ? "ON" : "OFF",
                           state->relays.fault_mismatch[i] ? "ERR" : "OK");
            (void)ssd1309_draw_text_line((uint8_t)i, line);
        }

        (void)snprintf(line, sizeof(line), "---------------------");
        (void)ssd1309_draw_text_line(4U, line);
        ssd1309_draw_hdivider(4U);

        (void)snprintf(line, sizeof(line), "R1:MAIN   R2:CHARGE");
        (void)ssd1309_draw_text_line(5U, line);

        (void)snprintf(line, sizeof(line), "R3:LOAD   R4:AUX/PC");
        (void)ssd1309_draw_text_line(6U, line);

        (void)snprintf(line, sizeof(line), "P3 RLY %-7s L%u",
                       ssd1309_mode_label(state->mode),
                       (unsigned int)prot_lvl);
        (void)ssd1309_draw_text_line(7U, line);
        ssd1309_invert_row(7U);
    } else if (page == OLED_PAGE_DIAGNOSTICS) {
        uint32_t err_mask = (state->active_faults != 0U)
                                ? state->active_faults
                                : state->snapshot.latched_fault_mask;

        (void)snprintf(line, sizeof(line), "P4 DIAG L%u F:0x%03X",
                       (unsigned int)prot_lvl,
                       (unsigned int)(state->active_faults & 0x0FFFU));
        (void)ssd1309_draw_text_line(0U, line);
        ssd1309_invert_row(0U);

        (void)snprintf(line, sizeof(line), "INA:%s VS:%s",
                       state->meas.ina226_ok ? "OK" : "ERR",
                       state->meas.vsense_ok ? "OK" : "ERR");
        (void)ssd1309_draw_text_line(1U, line);

        (void)snprintf(line, sizeof(line), "LAT:%s M:0x%03X",
                       state->fault_latched ? "YES" : "NO",
                       (unsigned int)(state->snapshot.latched_fault_mask & 0x0FFFU));
        (void)ssd1309_draw_text_line(2U, line);

        if (state->snapshot.valid) {
            (void)snprintf(line, sizeof(line), "SNAP:%.1fV %+.1fA", snap_v, snap_i);
        } else {
            (void)snprintf(line, sizeof(line), "SNAP:NONE");
        }
        (void)ssd1309_draw_text_line(3U, line);

        (void)snprintf(line, sizeof(line), "ERR:%s", ssd1309_fault_name(err_mask));
        (void)ssd1309_draw_text_line(4U, line);

        (void)snprintf(line, sizeof(line), "W:0x%03X MODE:%-7s",
                       (unsigned int)(state->warning_flags & 0x0FFFU),
                       ssd1309_mode_label(state->mode));
        (void)ssd1309_draw_text_line(5U, line);

        (void)snprintf(line, sizeof(line), "R1:%u R2:%u R3:%u R4:%u",
                       state->relays.cmd[0] ? 1U : 0U,
                       state->relays.cmd[1] ? 1U : 0U,
                       state->relays.cmd[2] ? 1U : 0U,
                       state->relays.cmd[3] ? 1U : 0U);
        (void)ssd1309_draw_text_line(6U, line);

        (void)snprintf(line, sizeof(line), "T:%lus %s",
                       (unsigned long)uptime_s,
                       state->fault_latched ? "LATCHED" : "READY");
        (void)ssd1309_draw_text_line(7U, line);
    }

    return true;
}

bool ssd1309_flush(void)
{
    static const uint8_t k_addr_cmds[6] = {
        0x21U, 0x00U, 0x7FU,
        0x22U, 0x00U, 0x07U
    };
    uint32_t i;

    for (i = 0U; i < 6U; i++) {
        if (!hal_oled_write_cmd(k_addr_cmds[i])) {
            return false;
        }
    }

    return hal_oled_write_data(s_framebuffer, OLED_BUFFER_SIZE);
}

const uint8_t *ssd1309_get_framebuffer(void)
{
    return s_framebuffer;
}

const char *ssd1309_get_text_line(uint8_t line_idx)
{
    if (line_idx >= SSD1309_TEXT_LINES) {
        return NULL;
    }
    return s_text_lines[line_idx];
}

const char *ssd1309_mode_label(bms_mode_t mode)
{
    switch (mode) {
    case BMS_MODE_STARTUP:
        return "STARTUP";
    case BMS_MODE_CHARGE:
        return "CHARGE";
    case BMS_MODE_DISCHARGE:
        return "DISCHRG";
    case BMS_MODE_STANDBY:
        return "STANDBY";
    case BMS_MODE_FAULT:
        return "FAULT";
    case BMS_MODE_CHARGE_CONFIRM:
        return "CHG_CFM";
    case BMS_MODE_DISCHARGE_CONFIRM:
        return "DIS_CFM";
    default:
        return "UNKNOWN";
    }
}
