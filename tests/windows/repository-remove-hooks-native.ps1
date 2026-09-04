$ErrorActionPreference = "Stop"

# Native Windows acceptance for canonical repository remove-hook discovery,
# execution, ambiguity diagnostics, and init-generated onboarding examples.
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$binary = Join-Path $root "bin\arashi-windows-x64.exe"
if (-not (Test-Path $binary)) { throw "Built CLI is missing: $binary" }

$temp = Join-Path ([IO.Path]::GetTempPath()) ("arashi repository remove hooks " + [guid]::NewGuid())
$workspace = Join-Path $temp "workspace"
$repository = Join-Path $workspace "repos\repo-a"
$hooks = Join-Path $workspace ".arashi\hooks"
$compatibleHooks = Join-Path $repository ".arashi\hooks"
$record = Join-Path $temp "canonical-execution.txt"
New-Item -ItemType Directory -Force -Path $workspace, $repository | Out-Null

function Invoke-Checked([string[]]$Command) {
  & $Command[0] $Command[1..($Command.Length - 1)]
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $($Command -join ' ')" }
}

function Initialize-Repository([string]$Path) {
  Invoke-Checked -Command @("git", "-C", $Path, "init", "-b", "main")
  Invoke-Checked -Command @("git", "-C", $Path, "config", "user.email", "test@example.com")
  Invoke-Checked -Command @("git", "-C", $Path, "config", "user.name", "Test User")
  Set-Content -LiteralPath (Join-Path $Path "README.md") -Value "test"
  Invoke-Checked -Command @("git", "-C", $Path, "add", ".")
  Invoke-Checked -Command @("git", "-C", $Path, "commit", "-m", "initial")
}

function Add-TestWorktree([string]$Branch) {
  $path = Join-Path $workspace ("worktrees\repo-a-" + ($Branch -replace "/", "-"))
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  Invoke-Checked -Command @("git", "-C", $repository, "branch", $Branch) | Out-Null
  Invoke-Checked -Command @("git", "-C", $repository, "worktree", "add", $path, $Branch) | Out-Null
  return $path
}

try {
  Initialize-Repository $workspace
  Initialize-Repository $repository
  Push-Location $workspace
  try {
    Invoke-Checked -Command @($binary, "init", "--no-discover")

    # Onboarding must generate canonical qualified remove examples for both native shells.
    foreach ($name in @(
      "pre-remove.REPO.ps1.example",
      "post-remove.REPO.ps1.example",
      "pre-remove.REPO.cmd.example",
      "post-remove.REPO.cmd.example"
    )) {
      if (-not (Test-Path (Join-Path $hooks $name))) { throw "Missing generated example: $name" }
    }

    $configPath = Join-Path $workspace ".arashi\config.json"
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $config.repos | Add-Member -NotePropertyName "repo-a" -NotePropertyValue ([pscustomobject]@{
      defaultBranch = "main"
      isBare = $false
      path = "./repos/repo-a"
      worktrees = @()
    })
    [IO.File]::WriteAllText(
      $configPath,
      ($config | ConvertTo-Json -Depth 20),
      [Text.UTF8Encoding]::new($false)
    )

    $canonicalPowerShell = Join-Path $hooks "pre-remove.repo-a.ps1"
    @"
if (`$env:ARASHI_HOOK_TARGET_REPOSITORY -ne "repo-a") { exit 41 }
[IO.File]::WriteAllText('$record', "`$env:ARASHI_HOOK_TARGET_REPOSITORY|`$PWD|`$env:ARASHI_HOOK_SOURCE_PATH")
"@ | Set-Content -LiteralPath $canonicalPowerShell

    # Doctor must discover the canonical qualified definition without classifying it as unsupported.
    $doctorText = (& $binary doctor --json | Out-String)
    $doctorExit = $LASTEXITCODE
    if ($doctorExit -ne 0) { throw "Doctor failed ($doctorExit): $doctorText" }
    $doctor = $doctorText | ConvertFrom-Json
    $unsupported = @($doctor.data.findings | Where-Object {
      $_.code -eq "HOOK_UNSUPPORTED_DEFINITION" -and $_.details.hookFile -eq $canonicalPowerShell
    })
    if ($unsupported.Count -ne 0) { throw "Canonical qualified hook was reported as unsupported" }

    $executionWorktree = Add-TestWorktree "feature/native-qualified-execution"
    $executionText = (& $binary remove $executionWorktree --path --keep-branches --force --json | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Canonical execution failed: $executionText" }
    if (-not (Test-Path $record)) { throw "Canonical qualified hook did not execute" }
    $executionRecord = Get-Content -Raw -LiteralPath $record
    if ($executionRecord -notmatch '^repo-a\|.*repos\\repo-a\|.*pre-remove\.repo-a\.ps1$') {
      throw "Canonical execution context was incorrect: $executionRecord"
    }

    $ambiguityWorktree = Add-TestWorktree "feature/native-qualified-ambiguity"
    New-Item -ItemType Directory -Force -Path $compatibleHooks | Out-Null
    $canonicalPaths = @(
      (Join-Path $hooks "pre-remove.repo-a.ps1"),
      (Join-Path $hooks "pre-remove.repo-a.cmd"),
      (Join-Path $hooks "pre-remove.repo-a.bat")
    )
    $compatiblePaths = @(
      (Join-Path $compatibleHooks "pre-remove.ps1"),
      (Join-Path $compatibleHooks "pre-remove.cmd"),
      (Join-Path $compatibleHooks "pre-remove.bat")
    )
    foreach ($path in $canonicalPaths + $compatiblePaths) {
      if ($path.EndsWith(".ps1")) { "exit 0" | Set-Content -LiteralPath $path }
      else { "@exit /b 0" | Set-Content -Encoding ASCII -LiteralPath $path }
    }

    $ambiguityText = (& $binary remove $ambiguityWorktree --path --keep-branches --force --json | Out-String)
    if ($LASTEXITCODE -eq 0) { throw "Ambiguous native candidates unexpectedly succeeded" }
    $ambiguity = $ambiguityText | ConvertFrom-Json
    if ($ambiguity.error.code -ne "HOOK_CONFIGURATION_INVALID") {
      throw "Unexpected ambiguity code: $($ambiguity.error.code)"
    }
    $outcome = @($ambiguity.error.details.hookOutcomes)[0]
    $expected = @($canonicalPaths + $compatiblePaths | ForEach-Object { (Resolve-Path $_).Path })
    if ($outcome.sourceScriptPath -ne $null) { throw "Ambiguous singular sourceScriptPath was populated" }
    if ((@($outcome.sourceScriptPaths) -join "|") -cne ($expected -join "|")) {
      throw "sourceScriptPaths order mismatch: $(@($outcome.sourceScriptPaths) -join ', ')"
    }
    foreach ($path in $expected) {
      if (-not $outcome.message.Contains($path)) { throw "Ambiguity message omitted native path: $path" }
    }
    if (-not (Test-Path $ambiguityWorktree)) { throw "Ambiguity mutated the target worktree" }
    exit 0
  }
  finally {
    Pop-Location
  }
}
finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
