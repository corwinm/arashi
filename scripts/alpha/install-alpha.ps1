#requires -Version 5.1
# Run from a downloaded alpha CI artifact, not the stable installer endpoint.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $Python) {
    [Console]::Error.WriteLine('Alpha setup needs Python 3.9+. Install Python, or manually verify/extract the alpha archive into a NEW private directory; do not replace arashi/aw.')
    exit 1
}
& $Python.Source -B (Join-Path $PSScriptRoot 'alpha_setup.py') @args
exit $LASTEXITCODE
