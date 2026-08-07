$ErrorActionPreference = "Stop"

# Native acceptance for the built arashi-windows-x64.exe. It covers terminal-capable
# PowerShell Read-Host and cmd set /p, plus disabled/unavailable immediate EOF.
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$binary = Join-Path $root "bin\arashi-windows-x64.exe"
if (-not (Test-Path $binary)) { throw "Built CLI is missing: $binary" }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("arashi-hook-input-" + [guid]::NewGuid())
$repo = Join-Path $temp "repo"
$testHome = Join-Path $temp "home"
$hooks = Join-Path $testHome ".arashi\hooks"
$record = Join-Path $temp "hook-input.log"
New-Item -ItemType Directory -Force -Path $repo, $hooks | Out-Null
$previousHome = $env:HOME
$env:HOME = $testHome
$env:HOOK_INPUT_RECORD = $record

function Invoke-Checked([string[]]$Command) {
  & $Command[0] $Command[1..($Command.Length - 1)]
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $($Command -join ' ')" }
}

try {
  Invoke-Checked -Command @("git", "-C", $repo, "init", "-b", "main")
  Invoke-Checked -Command @("git", "-C", $repo, "config", "user.email", "test@example.com")
  Invoke-Checked -Command @("git", "-C", $repo, "config", "user.name", "Test User")
  Set-Content -Path (Join-Path $repo "README.md") -Value "test"
  Invoke-Checked -Command @("git", "-C", $repo, "add", ".")
  Invoke-Checked -Command @("git", "-C", $repo, "commit", "-m", "initial")
  Push-Location $repo
  try {
    Invoke-Checked -Command @($binary, "init", "--zero-config")

    @'
$answer = Read-Host "disabled answer"
if ($env:ARASHI_HOOK_INPUT -ne "disabled") { exit 91 }
if (-not [string]::IsNullOrEmpty($answer)) { exit 92 }
Add-Content -Path $env:HOOK_INPUT_RECORD -Value "powershell:disabled:immediate EOF"
'@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    Invoke-Checked -Command @($binary, "create", "feature/disabled", "--json")

    @'
$answer = Read-Host "unavailable answer"
if ($env:ARASHI_HOOK_INPUT -ne "unavailable") { exit 93 }
if (-not [string]::IsNullOrEmpty($answer)) { exit 94 }
Add-Content -Path $env:HOOK_INPUT_RECORD -Value "powershell:unavailable:immediate EOF"
'@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    Invoke-Checked -Command @($binary, "create", "feature/unavailable")

    $winpty = Get-Command winpty.exe -ErrorAction SilentlyContinue
    $winptyPath = if ($winpty) { $winpty.Source } else { "C:\Program Files\Git\usr\bin\winpty.exe" }
    if (-not (Test-Path $winptyPath)) { throw "winpty.exe is required for terminal acceptance" }
    @'
$answer = Read-Host "tty answer"
if ($env:ARASHI_HOOK_INPUT -ne "tty") { exit 95 }
if ($answer -ne "yes") { exit 96 }
Add-Content -Path $env:HOOK_INPUT_RECORD -Value "powershell:tty:yes"
'@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    "yes" | & $winptyPath -Xallow-non-tty $binary create feature/tty
    if ($LASTEXITCODE -ne 0) { throw "PowerShell terminal hook acceptance failed: $LASTEXITCODE" }

    Remove-Item (Join-Path $hooks "pre-create.ps1")
    @'
@echo off
if not "%ARASHI_HOOK_INPUT%"=="tty" exit /b 97
set /p "answer=tty answer> "
if /i not "%answer%"=="yes" exit /b 98
echo cmd:tty:yes>>"%HOOK_INPUT_RECORD%"
'@ | Set-Content -Path (Join-Path $hooks "pre-remove.cmd")
    "yes" | & $winptyPath -Xallow-non-tty $binary remove feature/tty --force
    if ($LASTEXITCODE -ne 0) { throw "cmd terminal hook acceptance failed: $LASTEXITCODE" }

    @'
@echo off
if not "%ARASHI_HOOK_INPUT%"=="disabled" exit /b 99
set "answer="
set /p "answer=disabled answer> "
if defined answer exit /b 100
echo cmd:disabled:immediate EOF>>"%HOOK_INPUT_RECORD%"
'@ | Set-Content -Path (Join-Path $hooks "pre-remove.cmd")
    Invoke-Checked -Command @($binary, "remove", "feature/disabled", "--force", "--no-hook-input")
  }
  finally {
    Pop-Location
  }

  $actual = Get-Content -Path $record
  $expected = @(
    "powershell:disabled:immediate EOF",
    "powershell:unavailable:immediate EOF",
    "powershell:tty:yes",
    "cmd:tty:yes",
    "cmd:disabled:immediate EOF"
  )
  if (Compare-Object $expected $actual) {
    throw "Native hook-input record did not match. Actual: $($actual -join '; ')"
  }
}
finally {
  $env:HOME = $previousHome
  Remove-Item Env:HOOK_INPUT_RECORD -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
