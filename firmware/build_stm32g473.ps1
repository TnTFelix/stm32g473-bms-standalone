param(
    [string]$ToolchainBin = "D:\stm32 cube\cubr\STM32CubeIDE_2.0.0\STM32CubeIDE\plugins\com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.13.3.rel1.win32_1.0.100.202509120712\tools\bin",
    [string]$CubeDir = "C:\Users\binhb\STM32Cube\Repository\STM32Cube_FW_G4_V1.6.3"
)

$ErrorActionPreference = "Stop"

$FwRoot   = $PSScriptRoot
$BuildDir = Join-Path $FwRoot "build\stm32g473"
$ObjDir   = Join-Path $BuildDir "obj"
$LdScript = Join-Path $FwRoot "STM32G473VETX_FLASH.ld"

$ArmGcc     = Join-Path $ToolchainBin "arm-none-eabi-gcc.exe"
$ArmObjcopy = Join-Path $ToolchainBin "arm-none-eabi-objcopy.exe"
$ArmSize    = Join-Path $ToolchainBin "arm-none-eabi-size.exe"

if (-not (Test-Path $ArmGcc)) {
    Write-Error "arm-none-eabi-gcc.exe not found at: $ArmGcc"
    exit 1
}
if (-not (Test-Path $CubeDir)) {
    Write-Error "STM32CubeG4 SDK not found at: $CubeDir"
    exit 1
}
if (-not (Test-Path $LdScript)) {
    Write-Error "Linker script not found at: $LdScript"
    exit 1
}

New-Item -ItemType Directory -Force -Path $ObjDir | Out-Null

$HalDrvDir   = Join-Path $CubeDir "Drivers\STM32G4xx_HAL_Driver\Src"
$CmsisDevDir = Join-Path $CubeDir "Drivers\CMSIS\Device\ST\STM32G4xx\Source\Templates"

$IncFlags = @(
    "-I$(Join-Path $FwRoot 'include')",
    "-I$(Join-Path $CubeDir 'Drivers\STM32G4xx_HAL_Driver\Inc')",
    "-I$(Join-Path $CubeDir 'Drivers\STM32G4xx_HAL_Driver\Inc\Legacy')",
    "-I$(Join-Path $CubeDir 'Drivers\CMSIS\Device\ST\STM32G4xx\Include')",
    "-I$(Join-Path $CubeDir 'Drivers\CMSIS\Include')"
)

$McuFlags = @("-mcpu=cortex-m4", "-mthumb", "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard")
$Defs     = @("-DUSE_HAL_DRIVER", "-DSTM32G473xx")

$ProjCFlags = $McuFlags + $Defs + $IncFlags + @(
    "-std=c99", "-Wall", "-Wextra", "-O2",
    "-ffunction-sections", "-fdata-sections", "-g"
)
$HalCFlags = $McuFlags + $Defs + $IncFlags + @(
    "-std=c99", "-w", "-O2",
    "-ffunction-sections", "-fdata-sections"
)

$ProjSrcs = @(
    (Join-Path $FwRoot "src\main.c"),
    (Join-Path $FwRoot "src\hal\hal_stm32g4.c"),
    (Join-Path $FwRoot "src\drivers\ina226.c"),
    (Join-Path $FwRoot "src\drivers\voltage_sensor.c"),
    (Join-Path $FwRoot "src\drivers\relay_ctrl.c"),
    (Join-Path $FwRoot "src\drivers\ssd1309_oled.c"),
    (Join-Path $FwRoot "src\core\bms_estimator.c"),
    (Join-Path $FwRoot "src\core\bms_protection.c"),
    (Join-Path $FwRoot "src\core\bms_state_machine.c"),
    (Join-Path $FwRoot "src\app\bms_app.c")
)

$HalSrcs = @(
    (Join-Path $HalDrvDir "stm32g4xx_hal.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_cortex.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_rcc.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_rcc_ex.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_pwr.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_pwr_ex.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_gpio.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_flash.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_flash_ex.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_spi.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_spi_ex.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_i2c.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_i2c_ex.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_adc.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_adc_ex.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_dma.c"),
    (Join-Path $HalDrvDir "stm32g4xx_hal_dma_ex.c"),
    (Join-Path $CmsisDevDir "system_stm32g4xx.c")
)

$StartupAsm = Join-Path $CmsisDevDir "gcc\startup_stm32g473xx.s"
$Objects = @()

Write-Host "=== Compiling BMS 4S STM32G473VET6 Project Sources ==="
foreach ($src in $ProjSrcs) {
    $obj = Join-Path $ObjDir (([System.IO.Path]::GetFileNameWithoutExtension($src)) + ".o")
    & $ArmGcc @ProjCFlags -c $src -o $obj
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Compilation failed for: $src"
        exit 1
    }
    $Objects += $obj
}

Write-Host "=== Compiling STM32CubeG4 HAL & CMSIS Sources ==="
foreach ($src in $HalSrcs) {
    $obj = Join-Path $ObjDir (([System.IO.Path]::GetFileNameWithoutExtension($src)) + ".o")
    & $ArmGcc @HalCFlags -c $src -o $obj
    if ($LASTEXITCODE -ne 0) {
        Write-Error "HAL compilation failed for: $src"
        exit 1
    }
    $Objects += $obj
}

$StartupObj = Join-Path $ObjDir "startup_stm32g473xx.o"
& $ArmGcc @McuFlags -x assembler-with-cpp -c $StartupAsm -o $StartupObj
if ($LASTEXITCODE -ne 0) {
    Write-Error "Assembly failed for: $StartupAsm"
    exit 1
}
$Objects += $StartupObj

$ElfPath = Join-Path $BuildDir "bms4s.elf"
$HexPath = Join-Path $BuildDir "bms4s.hex"
$BinPath = Join-Path $BuildDir "bms4s.bin"
$MapPath = Join-Path $BuildDir "bms4s.map"

Write-Host "=== Linking ELF ==="
$LdFlags = $McuFlags + @(
    "-T$LdScript",
    "-specs=nano.specs",
    "-specs=nosys.specs",
    "-Wl,-u,_printf_float",
    "-Wl,--gc-sections",
    "-Wl,-Map=$MapPath",
    "-lm"
)
& $ArmGcc @Objects @LdFlags -o $ElfPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "Link failed"
    exit 1
}

Write-Host "=== Generating HEX and BIN ==="
& $ArmObjcopy -O ihex $ElfPath $HexPath
if ($LASTEXITCODE -ne 0) { exit 1 }

& $ArmObjcopy -O binary -S $ElfPath $BinPath
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "=== Firmware Size Summary ==="
& $ArmSize $ElfPath
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "Build succeeded:"
Write-Host "  ELF: $ElfPath"
Write-Host "  HEX: $HexPath"
Write-Host "  BIN: $BinPath"
