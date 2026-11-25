cmake_minimum_required(VERSION 3.16)

set(BMS_TARGET "host_sim" CACHE STRING "host_sim or stm32g473")
set(CUBE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../STM32CubeG4" CACHE PATH "Path to STM32CubeG4 repository")
set(LDSCRIPT "${CMAKE_CURRENT_SOURCE_DIR}/STM32G473VETX_FLASH.ld" CACHE FILEPATH "STM32G473 linker script")

if(BMS_TARGET STREQUAL "stm32g473")
    set(CMAKE_SYSTEM_NAME Generic)
    set(CMAKE_SYSTEM_PROCESSOR arm)
    set(CMAKE_C_COMPILER arm-none-eabi-gcc)
    set(CMAKE_ASM_COMPILER arm-none-eabi-gcc)
    set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
    project(bms4s C ASM)
else()
    project(bms4s C)
endif()

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(BMS_TARGET STREQUAL "stm32g473")
    if(NOT EXISTS "${CUBE_DIR}")
        message(FATAL_ERROR "STM32CubeG4 not found at CUBE_DIR=${CUBE_DIR}. Provide CUBE_DIR and enable ADC, I2C, SPI, GPIO, RCC, PWR, FLASH, CORTEX, DMA in stm32g4xx_hal_conf.h.")
    endif()

    set(HAL_DRV_DIR "${CUBE_DIR}/Drivers/STM32G4xx_HAL_Driver/Src")
    set(CMSIS_DEV_DIR "${CUBE_DIR}/Drivers/CMSIS/Device/ST/STM32G4xx/Source/Templates")

    add_executable(bms4s.elf
        src/main.c
        src/hal/hal_stm32g4.c
        src/drivers/ina226.c
        src/drivers/voltage_sensor.c
        src/core/bms_estimator.c
        src/core/bms_state_machine.c
        src/drivers/relay_ctrl.c
        src/core/bms_protection.c
        src/drivers/ssd1309_oled.c
        src/app/bms_app.c
        ${HAL_DRV_DIR}/stm32g4xx_hal.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_cortex.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_rcc.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_rcc_ex.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_pwr.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_pwr_ex.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_gpio.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_flash.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_flash_ex.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_spi.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_spi_ex.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_i2c.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_i2c_ex.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_adc.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_adc_ex.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_dma.c
        ${HAL_DRV_DIR}/stm32g4xx_hal_dma_ex.c
        ${CMSIS_DEV_DIR}/system_stm32g4xx.c
        ${CMSIS_DEV_DIR}/gcc/startup_stm32g473xx.s
    )

    target_include_directories(bms4s.elf PRIVATE
        include
        ${CUBE_DIR}/Drivers/STM32G4xx_HAL_Driver/Inc
        ${CUBE_DIR}/Drivers/STM32G4xx_HAL_Driver/Inc/Legacy
        ${CUBE_DIR}/Drivers/CMSIS/Device/ST/STM32G4xx/Include
        ${CUBE_DIR}/Drivers/CMSIS/Include
    )

    target_compile_definitions(bms4s.elf PRIVATE
        USE_HAL_DRIVER
        STM32G473xx
    )

    target_compile_options(bms4s.elf PRIVATE
        -mcpu=cortex-m4
        -mthumb
        -mfpu=fpv4-sp-d16
        -mfloat-abi=hard
        -Wall
        -Wextra
        -Wpedantic
        -O2
        -ffunction-sections
        -fdata-sections
    )

    target_link_options(bms4s.elf PRIVATE
        -mcpu=cortex-m4
        -mthumb
        -mfpu=fpv4-sp-d16
        -mfloat-abi=hard
        -T${LDSCRIPT}
        -specs=nano.specs
        -specs=nosys.specs
        -Wl,-u,_printf_float
        -Wl,--gc-sections
    )

    target_link_libraries(bms4s.elf PRIVATE m)
else()
    add_executable(bms_host_sim
        src/main.c
        src/hal/hal_mock.c
        src/drivers/ina226.c
        src/drivers/voltage_sensor.c
        src/core/bms_estimator.c
        src/core/bms_state_machine.c
        src/drivers/relay_ctrl.c
        src/core/bms_protection.c
        src/drivers/ssd1309_oled.c
        src/app/bms_app.c
    )

    target_include_directories(bms_host_sim PRIVATE include)
    target_compile_definitions(bms_host_sim PRIVATE BMS_HOST_SIM)
    target_compile_options(bms_host_sim PRIVATE -Wall -Wextra -Wpedantic -Werror -O2)
    target_link_libraries(bms_host_sim PRIVATE m)
endif()
