TARGET ?= host_sim

HOST_CC ?= gcc
HOST_CFLAGS = -std=c99 -Wall -Wextra -Wpedantic -Werror -O2 -DBMS_HOST_SIM -Iinclude
HOST_LDFLAGS = -lm
HOST_SRCS = src/main.c src/hal/hal_mock.c src/drivers/ina226.c src/drivers/voltage_sensor.c src/core/bms_estimator.c src/core/bms_state_machine.c src/drivers/relay_ctrl.c src/core/bms_protection.c src/drivers/ssd1309_oled.c src/app/bms_app.c
HOST_BIN = build/host/bms_host_sim

ARM_CC = arm-none-eabi-gcc
ARM_OBJCOPY = arm-none-eabi-objcopy
ARM_SIZE = arm-none-eabi-size
MCUFLAGS = -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
DEFS = -DUSE_HAL_DRIVER -DSTM32G473xx
CUBE_DIR ?= ../STM32CubeG4
LDSCRIPT ?= STM32G473VETX_FLASH.ld

CUBE_INC = \
	-Iinclude \
	-I$(CUBE_DIR)/Drivers/STM32G4xx_HAL_Driver/Inc \
	-I$(CUBE_DIR)/Drivers/STM32G4xx_HAL_Driver/Inc/Legacy \
	-I$(CUBE_DIR)/Drivers/CMSIS/Device/ST/STM32G4xx/Include \
	-I$(CUBE_DIR)/Drivers/CMSIS/Include

ARM_CFLAGS = $(MCUFLAGS) $(DEFS) $(CUBE_INC) -std=c99 -Wall -Wextra -Wpedantic -O2 -ffunction-sections -fdata-sections
ARM_LDFLAGS = $(MCUFLAGS) -T$(LDSCRIPT) -specs=nano.specs -specs=nosys.specs -Wl,-u,_printf_float -Wl,--gc-sections -lm

HAL_DRV_DIR = $(CUBE_DIR)/Drivers/STM32G4xx_HAL_Driver/Src
CMSIS_DEV_DIR = $(CUBE_DIR)/Drivers/CMSIS/Device/ST/STM32G4xx/Source/Templates

STM32_PROJ_SRCS = src/main.c src/hal/hal_stm32g4.c src/drivers/ina226.c src/drivers/voltage_sensor.c src/core/bms_estimator.c src/core/bms_state_machine.c src/drivers/relay_ctrl.c src/core/bms_protection.c src/drivers/ssd1309_oled.c src/app/bms_app.c
STM32_HAL_SRCS = \
	$(HAL_DRV_DIR)/stm32g4xx_hal.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_cortex.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_rcc.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_rcc_ex.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_pwr.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_pwr_ex.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_gpio.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_flash.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_flash_ex.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_spi.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_spi_ex.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_i2c.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_i2c_ex.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_adc.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_adc_ex.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_dma.c \
	$(HAL_DRV_DIR)/stm32g4xx_hal_dma_ex.c \
	$(CMSIS_DEV_DIR)/system_stm32g4xx.c

STM32_ASM_SRCS = $(CMSIS_DEV_DIR)/gcc/startup_stm32g473xx.s

STM32_ELF = build/stm32g473/bms4s.elf
STM32_HEX = build/stm32g473/bms4s.hex
STM32_BIN = build/stm32g473/bms4s.bin

.PHONY: all host_sim run_host stm32g473 flash clean

all: $(TARGET)

host_sim: $(HOST_BIN)

$(HOST_BIN): $(HOST_SRCS)
	@mkdir -p $(dir $@)
	$(HOST_CC) $(HOST_CFLAGS) $(HOST_SRCS) -o $@ $(HOST_LDFLAGS)

run_host: host_sim
	./$(HOST_BIN)

stm32g473:
ifeq ($(wildcard $(CUBE_DIR)/Drivers/STM32G4xx_HAL_Driver/Inc/stm32g4xx_hal.h),)
	$(error STM32CubeG4 not found at CUBE_DIR=$(CUBE_DIR). Set CUBE_DIR and ensure stm32g4xx_hal_conf.h enables ADC, I2C, SPI, GPIO, RCC, PWR, FLASH, CORTEX, and DMA)
endif
	@mkdir -p build/stm32g473
	$(ARM_CC) $(ARM_CFLAGS) $(STM32_PROJ_SRCS) $(STM32_HAL_SRCS) $(STM32_ASM_SRCS) -o $(STM32_ELF) $(ARM_LDFLAGS)
	$(ARM_OBJCOPY) -O ihex $(STM32_ELF) $(STM32_HEX)
	$(ARM_OBJCOPY) -O binary -S $(STM32_ELF) $(STM32_BIN)
	$(ARM_SIZE) $(STM32_ELF)

flash: stm32g473
	ST-LINK_CLI -c SWD -P $(STM32_HEX) -V -Rst

clean:
	rm -rf build
