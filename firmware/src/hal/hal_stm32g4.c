#if defined(USE_HAL_DRIVER)

#if !defined(STM32G473xx)
#error "hal_stm32g4.c requires -DSTM32G473xx"
#endif

#include "stm32g4xx_hal.h"
#include "hal_interface.h"
#include <stddef.h>

/* STM32CubeMX timing for I2C3 with HSI16 (16 MHz) kernel clock at 100 kHz Standard-mode */
#define BMS_I2C3_TIMING_HSI16_100KHZ 0x00303D5BU

static SPI_HandleTypeDef s_hspi1;
static I2C_HandleTypeDef s_hi2c3;
static ADC_HandleTypeDef s_hadc1;
static bool s_hal_initialized = false;
static bool s_relay_cmd[RELAY_COUNT];

static const uint16_t s_relay_pins[RELAY_COUNT] = {
    GPIO_PIN_0, /* RELAY_1_MAIN: PC0 */
    GPIO_PIN_1, /* RELAY_2_CHARGE: PC1 */
    GPIO_PIN_2, /* RELAY_3_LOAD: PC2 */
    GPIO_PIN_3  /* RELAY_4_AUX: PC3 */
};

static void hal_i2c3_bus_recovery(void)
{
    GPIO_InitTypeDef gpio_init = {0};
    uint32_t i;

    gpio_init.Pin = GPIO_PIN_8 | GPIO_PIN_9;
    gpio_init.Mode = GPIO_MODE_OUTPUT_OD;
    gpio_init.Pull = GPIO_PULLUP;
    gpio_init.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8 | GPIO_PIN_9, GPIO_PIN_SET);
    HAL_GPIO_Init(GPIOC, &gpio_init);

    for (i = 0U; i < 9U; i++) {
        if (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_9) == GPIO_PIN_SET) {
            break;
        }
        HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_RESET);
        hal_delay_ms(1U);
        HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_SET);
        hal_delay_ms(1U);
    }

    HAL_GPIO_WritePin(GPIOC, GPIO_PIN_9, GPIO_PIN_RESET);
    hal_delay_ms(1U);
    HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_SET);
    hal_delay_ms(1U);
    HAL_GPIO_WritePin(GPIOC, GPIO_PIN_9, GPIO_PIN_SET);
    hal_delay_ms(1U);
}

static bool hal_system_clock_config(void)
{
    RCC_OscInitTypeDef osc_init = {0};
    RCC_ClkInitTypeDef clk_init = {0};

    HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1_BOOST);

    osc_init.OscillatorType = RCC_OSCILLATORTYPE_HSI;
    osc_init.HSIState = RCC_HSI_ON;
    osc_init.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    osc_init.PLL.PLLState = RCC_PLL_ON;
    osc_init.PLL.PLLSource = RCC_PLLSOURCE_HSI;
    osc_init.PLL.PLLM = RCC_PLLM_DIV4;
    osc_init.PLL.PLLN = 85U;
    osc_init.PLL.PLLP = RCC_PLLP_DIV2;
    osc_init.PLL.PLLQ = RCC_PLLQ_DIV2;
    osc_init.PLL.PLLR = RCC_PLLR_DIV2;
    if (HAL_RCC_OscConfig(&osc_init) != HAL_OK) {
        return false;
    }

    clk_init.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK |
                         RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    clk_init.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    clk_init.AHBCLKDivider = RCC_SYSCLK_DIV1;
    clk_init.APB1CLKDivider = RCC_HCLK_DIV1;
    clk_init.APB2CLKDivider = RCC_HCLK_DIV1;
    if (HAL_RCC_ClockConfig(&clk_init, FLASH_LATENCY_4) != HAL_OK) {
        return false;
    }

    return true;
}

bool hal_init(void)
{
    GPIO_InitTypeDef gpio_init = {0};
    RCC_PeriphCLKInitTypeDef periph_clk = {0};
    ADC_ChannelConfTypeDef adc_chan = {0};
    bool ok = true;

    if (!s_hal_initialized) {
        if (HAL_Init() != HAL_OK) {
            ok = false;
        }
        if (!hal_system_clock_config()) {
            ok = false;
        }

        __HAL_RCC_GPIOA_CLK_ENABLE();
        __HAL_RCC_GPIOB_CLK_ENABLE();
        __HAL_RCC_GPIOC_CLK_ENABLE();

        /* Drive relay ODR to safe OPEN level before configuring PC0..PC3 as outputs */
        hal_relay_open_all();

        gpio_init.Pin = GPIO_PIN_0 | GPIO_PIN_1 | GPIO_PIN_2 | GPIO_PIN_3;
        gpio_init.Mode = GPIO_MODE_OUTPUT_PP;
        gpio_init.Pull = GPIO_NOPULL;
        gpio_init.Speed = GPIO_SPEED_FREQ_LOW;
        HAL_GPIO_Init(GPIOC, &gpio_init);

        /* Preset OLED control pins (PB6 CS=HIGH, PB7 DC=LOW, PB5 RES=HIGH) before output init */
        HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);
        HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, GPIO_PIN_RESET);
        HAL_GPIO_WritePin(GPIOB, GPIO_PIN_5, GPIO_PIN_SET);

        gpio_init.Pin = GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_7;
        gpio_init.Mode = GPIO_MODE_OUTPUT_PP;
        gpio_init.Pull = GPIO_NOPULL;
        gpio_init.Speed = GPIO_SPEED_FREQ_LOW;
        HAL_GPIO_Init(GPIOB, &gpio_init);

        /* Configure SPI1 on PA5 (SCK) and PA7 (MOSI) for OLED SSD1309 */
        __HAL_RCC_SPI1_CLK_ENABLE();
        gpio_init.Pin = GPIO_PIN_5 | GPIO_PIN_7;
        gpio_init.Mode = GPIO_MODE_AF_PP;
        gpio_init.Pull = GPIO_NOPULL;
        gpio_init.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
        gpio_init.Alternate = GPIO_AF5_SPI1;
        HAL_GPIO_Init(GPIOA, &gpio_init);

        s_hspi1.Instance = SPI1;
        s_hspi1.Init.Mode = SPI_MODE_MASTER;
        s_hspi1.Init.Direction = SPI_DIRECTION_2LINES;
        s_hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
        s_hspi1.Init.CLKPolarity = SPI_POLARITY_LOW;
        s_hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;
        s_hspi1.Init.NSS = SPI_NSS_SOFT;
        s_hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_32;
        s_hspi1.Init.FirstBit = SPI_FIRSTBIT_MSB;
        s_hspi1.Init.TIMode = SPI_TIMODE_DISABLE;
        s_hspi1.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
        s_hspi1.Init.CRCPolynomial = 7U;
        s_hspi1.Init.CRCLength = SPI_CRC_LENGTH_DATASIZE;
        s_hspi1.Init.NSSPMode = SPI_NSS_PULSE_DISABLE;
        if (HAL_SPI_Init(&s_hspi1) != HAL_OK) {
            ok = false;
        }

        /* Configure I2C3 on PC8 (SCL) and PC9 (SDA) with HSI16 clock for INA226 */
        hal_i2c3_bus_recovery();

        periph_clk.PeriphClockSelection = RCC_PERIPHCLK_I2C3;
        periph_clk.I2c3ClockSelection = RCC_I2C3CLKSOURCE_HSI;
        if (HAL_RCCEx_PeriphCLKConfig(&periph_clk) != HAL_OK) {
            ok = false;
        }

        __HAL_RCC_I2C3_CLK_ENABLE();
        gpio_init.Pin = GPIO_PIN_8 | GPIO_PIN_9;
        gpio_init.Mode = GPIO_MODE_AF_OD;
        gpio_init.Pull = GPIO_PULLUP;
        gpio_init.Speed = GPIO_SPEED_FREQ_LOW;
        gpio_init.Alternate = GPIO_AF8_I2C3;
        HAL_GPIO_Init(GPIOC, &gpio_init);

        s_hi2c3.Instance = I2C3;
        s_hi2c3.Init.Timing = BMS_I2C3_TIMING_HSI16_100KHZ;
        s_hi2c3.Init.OwnAddress1 = 0U;
        s_hi2c3.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
        s_hi2c3.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
        s_hi2c3.Init.OwnAddress2 = 0U;
        s_hi2c3.Init.OwnAddress2Masks = I2C_OA2_NOMASK;
        s_hi2c3.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
        s_hi2c3.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
        if (HAL_I2C_Init(&s_hi2c3) != HAL_OK) {
            ok = false;
        }
        if (HAL_I2CEx_ConfigAnalogFilter(&s_hi2c3, I2C_ANALOGFILTER_ENABLE) != HAL_OK) {
            ok = false;
        }
        if (HAL_I2CEx_ConfigDigitalFilter(&s_hi2c3, 0U) != HAL_OK) {
            ok = false;
        }

        /* Configure ADC1 Channel 1 on PA0 for charger voltage divider */
        periph_clk.PeriphClockSelection = RCC_PERIPHCLK_ADC12;
        periph_clk.Adc12ClockSelection = RCC_ADC12CLKSOURCE_SYSCLK;
        if (HAL_RCCEx_PeriphCLKConfig(&periph_clk) != HAL_OK) {
            ok = false;
        }

        __HAL_RCC_ADC12_CLK_ENABLE();
        gpio_init.Pin = GPIO_PIN_0;
        gpio_init.Mode = GPIO_MODE_ANALOG;
        gpio_init.Pull = GPIO_NOPULL;
        gpio_init.Speed = GPIO_SPEED_FREQ_LOW;
        gpio_init.Alternate = 0U;
        HAL_GPIO_Init(GPIOA, &gpio_init);

        s_hadc1.Instance = ADC1;
        s_hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
        s_hadc1.Init.Resolution = ADC_RESOLUTION_12B;
        s_hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
        s_hadc1.Init.GainCompensation = 0U;
        s_hadc1.Init.ScanConvMode = ADC_SCAN_DISABLE;
        s_hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
        s_hadc1.Init.LowPowerAutoWait = DISABLE;
        s_hadc1.Init.ContinuousConvMode = DISABLE;
        s_hadc1.Init.NbrOfConversion = 1U;
        s_hadc1.Init.DiscontinuousConvMode = DISABLE;
        s_hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;
        s_hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
        s_hadc1.Init.DMAContinuousRequests = DISABLE;
        s_hadc1.Init.Overrun = ADC_OVR_DATA_OVERWRITTEN;
        s_hadc1.Init.OversamplingMode = DISABLE;
        if (HAL_ADC_Init(&s_hadc1) != HAL_OK) {
            ok = false;
        }

        adc_chan.Channel = ADC_CHANNEL_1;
        adc_chan.Rank = ADC_REGULAR_RANK_1;
        adc_chan.SamplingTime = ADC_SAMPLETIME_247CYCLES_5;
        adc_chan.SingleDiff = ADC_SINGLE_ENDED;
        adc_chan.OffsetNumber = ADC_OFFSET_NONE;
        adc_chan.Offset = 0U;
        if (HAL_ADC_ConfigChannel(&s_hadc1, &adc_chan) != HAL_OK) {
            ok = false;
        }
        if (HAL_ADCEx_Calibration_Start(&s_hadc1, ADC_SINGLE_ENDED) != HAL_OK) {
            ok = false;
        }

        hal_relay_open_all();
        s_hal_initialized = ok;
        return ok;
    }

    hal_relay_open_all();
    return true;
}

void hal_relay_open_all(void)
{
    static const bms_relay_id_t k_open_order[RELAY_COUNT] = {
        RELAY_3_LOAD,
        RELAY_2_CHARGE,
        RELAY_4_AUX,
        RELAY_1_MAIN
    };
    GPIO_PinState open_level = (RELAY_ACTIVE_HIGH != 0U) ? GPIO_PIN_RESET : GPIO_PIN_SET;
    uint32_t i;

    for (i = 0U; i < (uint32_t)RELAY_COUNT; i++) {
        bms_relay_id_t id = k_open_order[i];
        s_relay_cmd[id] = false;
        HAL_GPIO_WritePin(GPIOC, s_relay_pins[id], open_level);
    }
}

bool hal_i2c3_is_device_ready(uint8_t dev_addr7)
{
    uint16_t addr8;

    if (!s_hal_initialized || (dev_addr7 > 0x7FU)) {
        return false;
    }
    addr8 = (uint16_t)((uint16_t)dev_addr7 << 1);
    return (HAL_I2C_IsDeviceReady(&s_hi2c3, addr8, 2U, BMS_I2C_TIMEOUT_MS) == HAL_OK);
}

bool hal_i2c3_write_reg16(uint8_t dev_addr7, uint8_t reg, uint16_t value)
{
    uint16_t addr8;
    uint8_t buf[2];

    if (!s_hal_initialized || (dev_addr7 > 0x7FU)) {
        return false;
    }
    addr8 = (uint16_t)((uint16_t)dev_addr7 << 1);
    buf[0] = (uint8_t)(value >> 8);
    buf[1] = (uint8_t)(value & 0xFFU);

    return (HAL_I2C_Mem_Write(&s_hi2c3, addr8, reg, I2C_MEMADD_SIZE_8BIT,
                              buf, 2U, BMS_I2C_TIMEOUT_MS) == HAL_OK);
}

bool hal_i2c3_read_reg16(uint8_t dev_addr7, uint8_t reg, uint16_t *out_value)
{
    uint16_t addr8;
    uint8_t buf[2] = {0U, 0U};

    if (out_value == NULL) {
        return false;
    }
    *out_value = 0U;

    if (!s_hal_initialized || (dev_addr7 > 0x7FU)) {
        return false;
    }
    addr8 = (uint16_t)((uint16_t)dev_addr7 << 1);

    if (HAL_I2C_Mem_Read(&s_hi2c3, addr8, reg, I2C_MEMADD_SIZE_8BIT,
                         buf, 2U, BMS_I2C_TIMEOUT_MS) != HAL_OK) {
        return false;
    }

    *out_value = (uint16_t)(((uint16_t)buf[0] << 8) | (uint16_t)buf[1]);
    return true;
}

bool hal_adc_pa0_read_raw(uint16_t *out_raw)
{
    HAL_StatusTypeDef status;
    uint32_t raw = 0U;

    if (out_raw == NULL) {
        return false;
    }
    *out_raw = 0U;

    if (!s_hal_initialized) {
        return false;
    }

    if (HAL_ADC_Start(&s_hadc1) != HAL_OK) {
        return false;
    }

    status = HAL_ADC_PollForConversion(&s_hadc1, BMS_ADC_TIMEOUT_MS);
    if (status == HAL_OK) {
        raw = HAL_ADC_GetValue(&s_hadc1);
    }
    (void)HAL_ADC_Stop(&s_hadc1);

    if (status != HAL_OK) {
        return false;
    }

    if (raw > ADC_RESOLUTION) {
        raw = ADC_RESOLUTION;
    }
    *out_raw = (uint16_t)raw;
    return true;
}

bool hal_adc_pa0_read_pin_voltage(float *out_pin_v)
{
    uint16_t raw = 0U;

    if (out_pin_v == NULL) {
        return false;
    }
    *out_pin_v = 0.0f;

    if (!hal_adc_pa0_read_raw(&raw)) {
        return false;
    }

    *out_pin_v = ((float)raw / (float)ADC_RESOLUTION) * ADC_VREF_V;
    return true;
}

bool hal_relay_write(bms_relay_id_t relay_id, bool closed)
{
    GPIO_PinState level;

    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }
    if (!s_hal_initialized && closed) {
        return false;
    }

    level = (closed == (RELAY_ACTIVE_HIGH != 0U)) ? GPIO_PIN_SET : GPIO_PIN_RESET;
    s_relay_cmd[relay_id] = closed;
    HAL_GPIO_WritePin(GPIOC, s_relay_pins[relay_id], level);
    return true;
}

bool hal_relay_read_cmd(bms_relay_id_t relay_id)
{
    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }
    return s_relay_cmd[relay_id];
}

bool hal_relay_read_feedback(bms_relay_id_t relay_id)
{
    GPIO_PinState pin_state;
    bool is_set;

    if ((uint32_t)relay_id >= (uint32_t)RELAY_COUNT) {
        return false;
    }

    /* Hardware has no dedicated auxiliary contact pin; read IDR output pin level */
    pin_state = HAL_GPIO_ReadPin(GPIOC, s_relay_pins[relay_id]);
    is_set = (pin_state == GPIO_PIN_SET);
    return (RELAY_ACTIVE_HIGH != 0U) ? is_set : !is_set;
}

bool hal_oled_reset(void)
{
    if (!s_hal_initialized) {
        return false;
    }

    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_5, GPIO_PIN_RESET);
    hal_delay_ms(OLED_RESET_PULSE_MS);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_5, GPIO_PIN_SET);
    hal_delay_ms(OLED_RESET_RECOVERY_MS);
    return true;
}

bool hal_oled_write_cmd(uint8_t cmd)
{
    HAL_StatusTypeDef status;

    if (!s_hal_initialized) {
        return false;
    }

    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET);
    status = HAL_SPI_Transmit(&s_hspi1, &cmd, 1U, BMS_SPI_TIMEOUT_MS);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);

    return (status == HAL_OK);
}

bool hal_oled_write_data(const uint8_t *data, uint16_t len)
{
    HAL_StatusTypeDef status;

    if (data == NULL) {
        return false;
    }
    if ((len == 0U) || (len > OLED_BUFFER_SIZE)) {
        return false;
    }
    if (!s_hal_initialized) {
        return false;
    }

    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, GPIO_PIN_SET);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET);
    status = HAL_SPI_Transmit(&s_hspi1, (uint8_t *)data, len, BMS_SPI_TIMEOUT_MS);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);

    return (status == HAL_OK);
}

uint32_t hal_get_tick_ms(void)
{
    return HAL_GetTick();
}

void hal_delay_ms(uint32_t ms)
{
    uint32_t start = HAL_GetTick();

    while ((uint32_t)(HAL_GetTick() - start) < ms) {
        __NOP();
    }
}

#if !defined(BMS_HAL_NO_SYSTICK_HANDLER)
void SysTick_Handler(void)
{
    HAL_IncTick();
}
#endif

#else
typedef int hal_stm32g4_requires_use_hal_driver_t; /* keeps ISO C TU non-empty on host */
#endif
