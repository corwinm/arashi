# arashi-managed-alias:aw:v1
# Arashi Workspace executable alias. Preserve stdin and delegate to the adjacent native binary.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Binary = Join-Path $ScriptDir "arashi.bin.exe"
if (-not (Test-Path $Binary)) { $Binary = Join-Path $ScriptDir "arashi-windows-x64.exe" }
if (-not (Test-Path $Binary)) { Write-Error "Error: arashi binary not found at $Binary"; exit 1 }
& $Binary @args
if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }
exit 0
