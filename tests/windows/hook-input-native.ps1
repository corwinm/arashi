$ErrorActionPreference = "Stop"

# Native acceptance for the built arashi-windows-x64.exe. It covers terminal-capable
# PowerShell Read-Host and cmd set /p, plus disabled/unavailable immediate EOF.
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$binary = Join-Path $root "bin\arashi-windows-x64.exe"
if (-not (Test-Path $binary)) { throw "Built CLI is missing: $binary" }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("arashi hook %TEAM% !&() " + [guid]::NewGuid())
$repo = Join-Path $temp "repo"
$testHome = Join-Path $temp "home"
$hooks = Join-Path $testHome ".arashi\hooks"
$record = Join-Path $temp "hook-input.log"
$ptyHelper = Join-Path $PSScriptRoot "pty-command.mjs"
New-Item -ItemType Directory -Force -Path $repo, $hooks | Out-Null
$previousHome = $env:HOME
$previousTeam = $env:TEAM
$env:HOME = $testHome
$env:TEAM = "EXPANDED-PATH-MUST-NOT-BE-USED"
$env:HOOK_INPUT_RECORD = $record

function Invoke-Checked([string[]]$Command) {
  & $Command[0] $Command[1..($Command.Length - 1)]
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $($Command -join ' ')" }
}

function Set-HookTimeout([int]$Milliseconds) {
  $configPath = Join-Path $repo ".arashi\config.json"
  $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
  if ($null -eq $config.hooks) {
    $config | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
  }
  $config.hooks | Add-Member -Force -NotePropertyName timeout -NotePropertyValue $Milliseconds
  $json = $config | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($configPath, $json, [Text.UTF8Encoding]::new($false))
}

function Invoke-PtySession([string]$Prompt, [string]$Response, [string[]]$Command) {
  $resultPath = Join-Path $temp ("pty-result-" + [guid]::NewGuid() + ".json")
  $config = @{
    command = $Command
    cwd = $repo
    prompt = $Prompt
    response = $Response
    resultPath = $resultPath
    timeoutMs = 30000
  } | ConvertTo-Json -Compress
  $encodedConfig = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
  & node $ptyHelper --session $encodedConfig
  if ($LASTEXITCODE -ne 0) {
    $details = if (Test-Path $resultPath) { Get-Content -Raw -Path $resultPath } else { "no result" }
    throw "ConPTY session harness failed: $LASTEXITCODE; $details"
  }
  return Get-Content -Raw -Path $resultPath | ConvertFrom-Json
}

function Assert-ProcessStopped([int]$ProcessId, [string]$Scenario) {
  if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    throw "$Scenario left hook process $ProcessId running"
  }
}

function Assert-NoCreateArtifacts([string]$BranchName, [string]$Scenario) {
  $branchPath = $BranchName -replace "/", "\"
  $worktreePath = Join-Path $repo (".arashi\worktrees\repo-" + $branchPath)
  if (Test-Path $worktreePath) { throw "$Scenario left worktree $worktreePath" }
  & git -C $repo show-ref --verify --quiet "refs/heads/$BranchName"
  if ($LASTEXITCODE -eq 0) { throw "$Scenario left branch $BranchName" }
  $global:LASTEXITCODE = 0
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
    Invoke-Checked -Command @($binary, "init", "--no-discover")
    $hooks = Join-Path $repo ".arashi\hooks"

    $generatedCmd = Join-Path $hooks "pre-create.cmd.example"
    if (-not (Test-Path $generatedCmd)) { throw "Generated cmd hook is missing: $generatedCmd" }
    $activeGeneratedCmd = Join-Path $repo ".arashi\hooks\pre-create.cmd"
    Copy-Item $generatedCmd $activeGeneratedCmd
    & node $ptyHelper $binary $repo y "Continue pre-create?" create feature/generated-cmd
    if ($LASTEXITCODE -ne 0) { throw "Generated cmd hook acceptance failed: $LASTEXITCODE" }
    Remove-Item $activeGeneratedCmd

    @'
$answer = Read-Host "wrapper answer"
if ($env:ARASHI_HOOK_INPUT -ne "tty") { exit 89 }
if ($answer -ne "yes") { exit 90 }
Add-Content -Path $env:HOOK_INPUT_RECORD -Value "$env:WRAPPER_KIND`:tty:yes"
'@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    $env:WRAPPER_KIND = "powershell-wrapper"
    & node $ptyHelper powershell.exe $repo yes "wrapper answer" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "bin\arashi.ps1") create feature/wrapper-powershell
    if ($LASTEXITCODE -ne 0) { throw "PowerShell wrapper acceptance failed: $LASTEXITCODE" }
    $env:WRAPPER_KIND = "javascript-wrapper"
    & node $ptyHelper node.exe $repo yes "wrapper answer" (Join-Path $root "bin\arashi.js") create feature/wrapper-javascript
    if ($LASTEXITCODE -ne 0) { throw "JavaScript wrapper acceptance failed: $LASTEXITCODE" }
    $env:WRAPPER_KIND = "batch-wrapper"
    & node $ptyHelper cmd.exe $repo yes "wrapper answer" /d /e:on /v:off /s /c call (Join-Path $root "bin\arashi.bat") create feature/wrapper-batch
    if ($LASTEXITCODE -ne 0) { throw "Batch wrapper acceptance failed: $LASTEXITCODE" }
    Remove-Item (Join-Path $hooks "pre-create.ps1")
    Remove-Item Env:WRAPPER_KIND -ErrorAction SilentlyContinue

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

    if (-not (Test-Path $ptyHelper)) { throw "PTY helper is missing: $ptyHelper" }
    @'
$answer = Read-Host "tty answer"
if ($env:ARASHI_HOOK_INPUT -ne "tty") { exit 95 }
if ($answer -ne "yes") { exit 96 }
Add-Content -Path $env:HOOK_INPUT_RECORD -Value "powershell:tty:yes"
'@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    & node $ptyHelper $binary $repo yes "tty answer" create feature/tty
    if ($LASTEXITCODE -ne 0) { throw "PowerShell terminal hook acceptance failed: $LASTEXITCODE" }

    Remove-Item (Join-Path $hooks "pre-create.ps1")
    @'
@echo off
if not "%ARASHI_HOOK_INPUT%"=="tty" exit /b 97
set /p "answer=tty answer> "
if /i not "%answer%"=="yes" exit /b 98
echo cmd:tty:yes>>"%HOOK_INPUT_RECORD%"
exit /b 0
'@ | Set-Content -Encoding ASCII -Path (Join-Path $hooks "pre-remove.cmd")
    & node $ptyHelper $binary $repo yes "tty answer" remove feature/tty --force
    if ($LASTEXITCODE -ne 0) {
      $observed = (Get-Content -Path $record -ErrorAction SilentlyContinue) -join "; "
      throw "cmd terminal hook acceptance failed: $LASTEXITCODE; records: $observed"
    }

    @'
@echo off
if not "%ARASHI_HOOK_INPUT%"=="disabled" exit /b 99
set "answer="
set /p "answer=disabled answer> "
if defined answer exit /b 100
echo cmd:disabled:immediate EOF>>"%HOOK_INPUT_RECORD%"
exit /b 0
'@ | Set-Content -Encoding ASCII -Path (Join-Path $hooks "pre-remove.cmd")
    Invoke-Checked -Command @($binary, "remove", "feature/disabled", "--force", "--no-hook-input")

    Remove-Item (Join-Path $hooks "pre-remove.cmd")
    Set-HookTimeout 10000
    @'
Write-Output "WINDOWS-REFUSAL-STDOUT"
[Console]::Error.WriteLine("WINDOWS-REFUSAL-STDERR")
$answer = Read-Host "refusal answer"
if ($env:ARASHI_HOOK_INPUT -ne "tty") { exit 101 }
if ($answer -ne "yes") { exit 102 }
'@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    $refusalResult = Invoke-PtySession "refusal answer" "no" @($binary, "create", "feature/windows-refusal")
    if ($refusalResult.exitCode -eq 0) { throw "Refused built CLI unexpectedly succeeded" }
    if (-not $refusalResult.reused) { throw "Terminal was not reusable after refusal" }
    if (([regex]::Matches($refusalResult.output, "WINDOWS-REFUSAL-STDOUT")).Count -ne 1) {
      throw "Refusal stdout was not forwarded exactly once"
    }
    if (([regex]::Matches($refusalResult.output, "WINDOWS-REFUSAL-STDERR")).Count -ne 1) {
      throw "Refusal stderr was not forwarded exactly once"
    }
    Assert-NoCreateArtifacts "feature/windows-refusal" "refusal"
    Add-Content -Path $record -Value "windows:refusal:exact-output"

    Set-HookTimeout 2000
    $timeoutPid = Join-Path $temp "timeout-hook.pid"
    @"
Set-Content -NoNewline -Path '$timeoutPid' -Value `$PID
`$null = Read-Host "timeout answer"
"@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    $timeoutResult = Invoke-PtySession "timeout answer" "__NO_INPUT__" @($binary, "create", "feature/windows-timeout")
    if ($timeoutResult.exitCode -eq 0) { throw "Timed-out built CLI unexpectedly succeeded" }
    if (-not $timeoutResult.reused) { throw "Terminal was not reusable after timeout" }
    Assert-ProcessStopped ([int](Get-Content -Raw -Path $timeoutPid)) "timeout"
    Assert-NoCreateArtifacts "feature/windows-timeout" "timeout"
    Add-Content -Path $record -Value "windows:timeout:cleanup"
    Add-Content -Path $record -Value "windows:terminal:reused"

    Set-HookTimeout 10000
    $interruptPid = Join-Path $temp "interrupt-hook.pid"
    @"
Set-Content -NoNewline -Path '$interruptPid' -Value `$PID
`$null = Read-Host "interrupt answer"
"@ | Set-Content -Path (Join-Path $hooks "pre-create.ps1")
    $interruptResult = Invoke-PtySession "interrupt answer" "__CTRL_C__" @($binary, "create", "feature/windows-interrupt")
    if ($interruptResult.exitCode -eq 0) { throw "Interrupted built CLI unexpectedly succeeded" }
    if (-not $interruptResult.reused) { throw "Terminal was not reusable after interruption" }
    Assert-ProcessStopped ([int](Get-Content -Raw -Path $interruptPid)) "interruption"
    Assert-NoCreateArtifacts "feature/windows-interrupt" "interruption"
    Add-Content -Path $record -Value "windows:interrupt:cleanup"
  }
  finally {
    Pop-Location
  }

  $actual = Get-Content -Path $record
  $expected = @(
    "powershell-wrapper:tty:yes",
    "javascript-wrapper:tty:yes",
    "batch-wrapper:tty:yes",
    "powershell:disabled:immediate EOF",
    "powershell:unavailable:immediate EOF",
    "powershell:tty:yes",
    "cmd:tty:yes",
    "cmd:disabled:immediate EOF",
    "windows:refusal:exact-output",
    "windows:timeout:cleanup",
    "windows:terminal:reused",
    "windows:interrupt:cleanup"
  )
  if (Compare-Object $expected $actual) {
    throw "Native hook-input record did not match. Actual: $($actual -join '; ')"
  }
}
finally {
  $env:HOME = $previousHome
  if ($null -eq $previousTeam) {
    Remove-Item Env:TEAM -ErrorAction SilentlyContinue
  }
  else {
    $env:TEAM = $previousTeam
  }
  Remove-Item Env:HOOK_INPUT_RECORD -ErrorAction SilentlyContinue
  Remove-Item Env:WRAPPER_KIND -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
