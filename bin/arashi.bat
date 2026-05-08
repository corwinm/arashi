@echo off
REM Wrapper for arashi.exe on Windows
REM Preserve stdin so interactive commands like `arashi switch` can prompt

REM Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
set "BINARY=%SCRIPT_DIR%arashi.bin.exe"

REM Use platform-specific binary if main binary doesn't exist
if not exist "%BINARY%" (
    set "BINARY=%SCRIPT_DIR%arashi-windows-x64.exe"
)

REM Check if binary exists
if not exist "%BINARY%" (
    echo Error: arashi binary not found at %BINARY% 1>&2
    exit /b 1
)

REM Execute the binary with inherited stdio
"%BINARY%" %*
