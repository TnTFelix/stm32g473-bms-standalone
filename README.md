# STM32G473VET6 4S BMS & Supercapacitor Load-Compensation Firmware

Hệ thống giám sát năng lượng và bảo vệ nguồn pin Lithium-ion 4S (14,8 V danh định, 16,8 V sạc đầy, 12,0 V cắt xả, 10 Ah) sử dụng vi điều khiển **STM32G473VET6** (ARM Cortex-M4, 170 MHz, FPU) kết hợp màn hình OLED **SSD1309 128×64** qua giao tiếp SPI1.

## Cấu trúc thư mục

- `firmware/` — Mã nguồn C99 (10 mô-đun cốt lõi: HAL STM32G4 / HAL Mock, driver INA226A, cảm biến áp bộ sạc ADC1, điều khiển khóa chéo 4 relay, hiển thị OLED SSD1309 4 trang, bộ ước lượng Coulomb Counting SOC, bảo vệ 5 cấp với 9 mã lỗi bitmask, máy trạng thái FSM 5 chế độ).
- `sim/` — Bộ mô phỏng hành vi trên máy chủ (Node.js) tương ứng các mô-đun C99.
- `tests/` — Bộ kiểm thử tự động 5 pha (`phase1.test.mjs` .. `phase5.test.mjs`) và kiểm tra đối chiếu tĩnh C99 (`c_firmware_check.test.mjs`, `CF-01..CF-25`).
- `stm32g473_bms_4s.ioc` — Tệp cấu hình chân ngoại vi STM32CubeMX (14 chân trên gói LQFP100).

## Bảng phân bổ chân STM32G473VET6 (14 chân)

| Chức năng | Chân MCU | Ngoại vi / Chế độ | Ghi chú |
| :--- | :---: | :--- | :--- |
| **I2C3 SCL / SDA (INA226A 0x40)** | `PC8`, `PC9` | `I2C3` (AF8, Open-Drain) | 100 kHz HSI16, shunt 2 mΩ (`CAL = 2560`), kéo lên 4,7 kΩ |
| **Áp bộ sạc (cầu phân áp 6:1)** | `PA0` | `ADC1_IN1` (Analog 12-bit) | R1 = 37,5 kΩ / R2 = 7,5 kΩ, giới hạn an toàn ≤ 3,25 V |
| **OLED SSD1309 SPI1 SCK / MOSI** | `PA5`, `PA7` | `SPI1` (AF5, Push-Pull) | Master Mode 0, khung hình 1024 byte, chu kỳ 200 ms |
| **OLED RES / CS / DC** | `PB5`, `PB6`, `PB7` | GPIO Output Push-Pull | Điều khiển reset cứng, chọn chip mềm và lệnh/dữ liệu |
| **Cụm 4 Relay công suất 30 A** | `PC0`, `PC1`, `PC2`, `PC3` | GPIO Output Push-Pull | R1 MAIN, R2 CHARGE, R3 LOAD, R4 AUX/PC (Active-High) |
| **SWD Debug (ST-LINK)** | `PA13`, `PA14` | `SWDIO` / `SWCLK` | Bảo toàn để nạp và gỡ lỗi |

## Kiểm thử mô phỏng & đối chiếu C99

Yêu cầu Node.js >= 20:

```bash
node --test tests/*.test.mjs
node sim/run_sim.mjs
```

Biên dịch và chạy mô phỏng C trên máy tính (`gcc`):

```bash
cd firmware
make run_host
```

## Biên dịch mục tiêu STM32G473VET6

Yêu cầu `arm-none-eabi-gcc` và gói `STM32Cube_FW_G4`:

```powershell
cd firmware
.\build_stm32g473.ps1
```
