# PowerShell wrapper for arashi.exe to support piping to tools like fzf
# This closes stdin before executing the binary

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

# PowerShell way to close stdin and execute
# We redirect stdin from $null which effectively closes it
$process = Start-Process -FilePath $Binary -ArgumentList $args -NoNewWindow -Wait -PassThru -RedirectStandardInput $null
exit $process.ExitCode
