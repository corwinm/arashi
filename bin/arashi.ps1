# PowerShell wrapper for arashi.exe on Windows
# Preserve stdin so interactive commands like `arashi switch` can prompt

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Binary = Join-Path $ScriptDir "arashi.bin.exe"

# Use platform-specific binary if main binary doesn't exist
if (-not (Test-Path $Binary)) {
    $Binary = Join-Path $ScriptDir "arashi-windows-x64.exe"
}

# Check if binary exists
if (-not (Test-Path $Binary)) {
    Write-Error "Error: arashi binary not found at $Binary"
    exit 1
}

# Execute with inherited stdio so prompts remain interactive
& $Binary @args
if ($LASTEXITCODE -ne $null) {
    exit $LASTEXITCODE
}

exit 0
