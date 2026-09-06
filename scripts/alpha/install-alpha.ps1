#requires -Version 5.1
# Local, opt-in native alpha bundle only. No interpreter or PATH fallback.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Helper = Join-Path $PSScriptRoot 'arashi2-setup.exe'
if (-not (Test-Path -LiteralPath $Helper -PathType Leaf) -or
    ((Get-Item -LiteralPath $Helper -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    [Console]::Error.WriteLine('Missing or unsafe native arashi2-setup.exe beside this launcher. Obtain the complete trusted alpha bundle for this platform.')
    exit 1
}
& $Helper @args
exit $LASTEXITCODE
