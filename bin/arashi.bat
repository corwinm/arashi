@echo off
REM Wrapper for arashi.exe to support piping to tools like fzf on Windows
REM This closes stdin before executing the binary

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

REM Execute the binary with stdin closed
REM In Windows, we use <NUL to close/redirect stdin
"%BINARY%" %* <NUL
