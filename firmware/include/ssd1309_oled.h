#ifndef SSD1309_OLED_H
#define SSD1309_OLED_H

#include <stdint.h>
#include <stdbool.h>
#include "bms_config.h"
#include "bms_types.h"

#define SSD1309_TEXT_LINES      8U
#define SSD1309_LINE_MAX_CHARS  21U

void           ssd1309_reset_state(void);
bool           ssd1309_init(void);
void           ssd1309_clear_buffer(void);
bool           ssd1309_draw_text_line(uint8_t line_idx, const char *text);
bool           ssd1309_render_page(const bms_system_state_t *state, bms_oled_page_t page);
bool           ssd1309_flush(void);
const uint8_t *ssd1309_get_framebuffer(void);
const char    *ssd1309_get_text_line(uint8_t line_idx);
const char    *ssd1309_mode_label(bms_mode_t mode);

#endif /* SSD1309_OLED_H */
