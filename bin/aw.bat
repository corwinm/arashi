@echo off
REM arashi-managed-alias:aw:v1
REM Arashi Workspace executable alias. Delegate to the adjacent native binary.
set "SCRIPT_DIR=%~dp0"
set "BINARY=%SCRIPT_DIR%arashi.bin.exe"
if not exist "%BINARY%" set "BINARY=%SCRIPT_DIR%arashi-windows-x64.exe"
if not exist "%BINARY%" (
  echo Error: arashi binary not found at %BINARY% 1>&2
  exit /b 1
)
"%BINARY%" %*
