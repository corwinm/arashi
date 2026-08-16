$ErrorActionPreference = "Stop"

# RED acceptance for issue #271 inline PowerShell/cmd production adapters. This file is
# invoked by hook-input-native.ps1 so the existing native Windows CI job owns reachability.
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$binary = Join-Path $root "bin\arashi-windows-x64.exe"
if (-not (Test-Path $binary)) { throw "Built CLI is missing: $binary" }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("arashi inline %TEAM% !&() " + [guid]::NewGuid())
$repo = Join-Path $temp "repo with spaces"
$record = Join-Path ([IO.Path]::GetTempPath()) ("arashi-inline-record-" + [guid]::NewGuid() + ".log")
$ttyRecord = Join-Path $temp "inline tty.log"
$ptyHelper = Join-Path $PSScriptRoot "pty-command.mjs"
$previousHome = $env:HOME
$previousTeam = $env:TEAM
$previousRecord = $env:ARASHI_TEST_RECORD
New-Item -ItemType Directory -Force -Path $repo | Out-Null
$env:HOME = Join-Path $temp "home"
$env:TEAM = "EXPANSION-MUST-NOT-LEAK"
$env:ARASHI_TEST_RECORD = $record

function Invoke-Checked([string[]]$Command) {
  & $Command[0] $Command[1..($Command.Length - 1)]
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $($Command -join ' ')" }
}

function Write-ConfigScripts([hashtable]$Scripts, [int]$Timeout = 30000) {
  $configPath = Join-Path $repo ".arashi\config.json"
  $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
  $config | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{
    timeout = $Timeout
    scripts = [pscustomobject]$Scripts
  }) -Force
  $json = $config | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($configPath, $json, [Text.UTF8Encoding]::new($false))
}

function Invoke-PtySession([string]$Prompt, [string]$Response, [string[]]$Command) {
  $resultPath = Join-Path $temp ("inline-pty-result-" + [guid]::NewGuid() + ".json")
  $config = @{
    command = $Command
    cwd = $repo
    prompt = $Prompt
    response = $Response
    resultPath = $resultPath
    timeoutMs = 120000
  } | ConvertTo-Json -Compress
  $encodedConfig = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
  & node $ptyHelper --session $encodedConfig
  if ($LASTEXITCODE -ne 0) {
    $details = if (Test-Path $resultPath) { Get-Content -Raw -Path $resultPath } else { "no result" }
    throw "Inline ConPTY session failed: $LASTEXITCODE; $details"
  }
  return Get-Content -Raw -Path $resultPath | ConvertFrom-Json
}

try {
  Invoke-Checked @("git", "-C", $repo, "init", "-b", "main")
  Invoke-Checked @("git", "-C", $repo, "config", "user.email", "test@example.com")
  Invoke-Checked @("git", "-C", $repo, "config", "user.name", "Test User")
  [IO.File]::WriteAllText((Join-Path $repo "README.md"), "test`n", [Text.UTF8Encoding]::new($false))
  Invoke-Checked @("git", "-C", $repo, "add", ".")
  Invoke-Checked @("git", "-C", $repo, "commit", "-m", "initial")
  Push-Location $repo
  try {
    Invoke-Checked @($binary, "init", "--no-discover")

    $ttySnippet = @"
`$answer = Read-Host 'inline answer'
if (`$env:ARASHI_HOOK_INPUT -ne 'tty') { exit 71 }
if (`$answer -ne 'yes') { exit 72 }
Add-Content -Path '$ttyRecord' -Value "tty|`$PWD|`$env:ARASHI_HOOK_NAME|`$answer"
"@
    Write-ConfigScripts @{ "pre-create" = @{ powershell = $ttySnippet } }
    $ttyResult = Invoke-PtySession "inline answer" "yes" @($binary, "create", "feature/windows-inline-tty", "--no-progress")
    if ($ttyResult.exitCode -ne 0) { throw "Inline TTY create failed: $($ttyResult.output)" }
    $ttyLine = Get-Content -Raw -Path $ttyRecord
    if ($ttyLine -notmatch '^tty\|' -or $ttyLine -notmatch '\|pre-create\|yes') {
      throw "Inline PowerShell did not receive TTY input/context: $ttyLine"
    }

    $powerShellSnippet = @"
if (`$env:ARASHI_HOOK_INPUT -ne 'disabled') { exit 81 }
if (`$null -ne [Console]::In.ReadLine()) { exit 82 }
Add-Content -Path '$record' -Value "powershell|`$PWD|`$env:ARASHI_HOOK_NAME|%|!|&|()"
"@
    $cmdSnippet = 'if "%ARASHI_HOOK_INPUT%"=="disabled" (set /p ANSWER= && exit /b 83 || (cd>>"%ARASHI_TEST_RECORD%" & echo cmd^|%ARASHI_HOOK_NAME%^|%^|!^|^&^|^(^)>>"%ARASHI_TEST_RECORD%")) else exit /b 84'
    Write-ConfigScripts @{ "pre-create" = @{ powershell = $powerShellSnippet; cmd = $cmdSnippet } }
    Invoke-Checked @($binary, "create", "feature/windows-inline-powershell", "--json")

    Write-ConfigScripts @{ "pre-create" = @{ cmd = $cmdSnippet } }
    Invoke-Checked @($binary, "create", "feature/windows-inline-cmd", "--json")

    $lines = @(Get-Content -Path $record)
    if ($lines.Count -ne 3) { throw "Inline adapters did not execute exactly once each: $($lines -join '; ')" }
    if ($lines[0] -notmatch '^powershell\|' -or $lines[0] -notmatch '\|pre-create\|%\|!\|&\|\(\)$') {
      throw "PowerShell inline adapter lost cwd/environment/metacharacters: $($lines[0])"
    }
    if ($lines[1] -ne $repo) { throw "cmd inline adapter did not run from the exact configured workspace cwd: $($lines[1])" }
    if ($lines[2] -notmatch '^cmd\|' -or $lines[2] -notmatch '\|pre-create\|%\|!\|&\|\(\)$') {
      throw "cmd inline adapter lost environment/metacharacters: $($lines[2])"
    }
    if ($lines[0] -notmatch [regex]::Escape($repo)) {
      throw "PowerShell inline adapter did not run from the exact configured workspace cwd: $($lines[0])"
    }

    Write-ConfigScripts @{ "pre-create" = @{ powershell = "exit 23"; cmd = "echo fallback-must-not-run>>`"$record`"" } }
    $failureJson = (& $binary create feature/windows-inline-fail-fast --json | Out-String)
    if ($LASTEXITCODE -eq 0) { throw "Fail-fast PowerShell snippet unexpectedly succeeded" }
    $failureEnvelope = $failureJson | ConvertFrom-Json
    $failureOutcome = @($failureEnvelope.error.details.hookOutcomes)[0]
    if ($failureOutcome.reasonCode -ne "exit_non_zero" -or $failureOutcome.sourceKind -ne "inline-config") {
      throw "Inline nonzero classification was not preserved: $failureJson"
    }
    $afterFailure = @(Get-Content -Path $record)
    if ($afterFailure.Count -ne 3) { throw "Lower-priority fallback ran after selected interpreter failure" }

    Write-ConfigScripts @{ "pre-create" = @{ powershell = "Start-Sleep -Seconds 10" } } 20
    $timeoutJson = (& $binary create feature/windows-inline-timeout --json | Out-String)
    if ($LASTEXITCODE -eq 0) { throw "Timed-out PowerShell inline snippet unexpectedly succeeded" }
    $timeoutEnvelope = $timeoutJson | ConvertFrom-Json
    $timeoutOutcome = @($timeoutEnvelope.error.details.hookOutcomes)[0]
    if ($timeoutOutcome.reasonCode -ne "timeout" -or $timeoutOutcome.sourceKind -ne "inline-config") {
      throw "Inline timeout classification was not preserved: $timeoutJson"
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  $env:HOME = $previousHome
  $env:TEAM = $previousTeam
  $env:ARASHI_TEST_RECORD = $previousRecord
  Remove-Item -Force -ErrorAction SilentlyContinue $record
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temp
}
