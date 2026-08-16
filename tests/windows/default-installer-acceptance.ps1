#requires -Version 5.1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$InstallerPath = Join-Path $Root "scripts\install.ps1"
$FixtureDirectory = Join-Path $env:RUNNER_TEMP "arashi-same-release-fixture"
$temporaryUserProfile = Join-Path $env:RUNNER_TEMP "arashi-user-$([Guid]::NewGuid().ToString('N'))"
$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$originalUserProfile = $env:USERPROFILE
$originalProcessPath = $env:Path
$testFailure = $null

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function global:Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    $assetName = [System.IO.Path]::GetFileName(([Uri]$Uri).AbsolutePath)
    $source = Join-Path $FixtureDirectory $assetName
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Fixture asset missing for $Uri"
    }
    Copy-Item -LiteralPath $source -Destination $OutFile -Force
}

function Invoke-FreshShell {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$ExpectedOutput,
        [Parameter(Mandatory = $true)][string]$FreshPath,
        [Parameter(Mandatory = $true)][string]$FreshUserProfile,
        [Parameter(Mandatory = $true)][hashtable]$AdditionalEnvironment
    )

    $previousPath = $env:Path
    $previousUserProfile = $env:USERPROFILE
    $previousValues = @{}
    foreach ($name in $AdditionalEnvironment.Keys) {
        $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    try {
        $env:Path = $FreshPath
        $env:USERPROFILE = $FreshUserProfile
        foreach ($name in $AdditionalEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $AdditionalEnvironment[$name], "Process")
        }

        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { $_.ToString() })
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        Assert-True ($exitCode -eq 0) "$Label failed with exit code $exitCode`: $($output -join [Environment]::NewLine)"
        Assert-True ($output.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace(($output -join ""))) "$Label produced no version output"
        $actualOutput = ($output -join [Environment]::NewLine).Trim()
        Assert-True ($actualOutput -ceq $ExpectedOutput.Trim()) "$Label did not execute the fixture binary. Expected $ExpectedOutput but received $actualOutput"
    } finally {
        $env:Path = $previousPath
        $env:USERPROFILE = $previousUserProfile
        foreach ($name in $AdditionalEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $previousValues[$name], "Process")
        }
    }
}

try {
    New-Item -ItemType Directory -Path $FixtureDirectory, $temporaryUserProfile -Force | Out-Null
    Copy-Item (Join-Path $Root "bin\arashi-windows-x64.exe") (Join-Path $FixtureDirectory "arashi-windows-x64.exe")
    foreach ($asset in @("arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat")) {
        Copy-Item (Join-Path $Root "bin\$asset") (Join-Path $FixtureDirectory $asset)
    }
    $checksumLines = foreach ($asset in @("arashi-windows-x64.exe", "arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat")) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $FixtureDirectory $asset)).Hash.ToLowerInvariant()
        "$hash  $asset"
    }
    Set-Content -LiteralPath (Join-Path $FixtureDirectory "arashi-checksums.txt") -Value $checksumLines -Encoding Ascii

    $fixtureBinary = Join-Path $FixtureDirectory "arashi-windows-x64.exe"
    $expectedVersionLines = @(& $fixtureBinary --version 2>&1 | ForEach-Object { $_.ToString() })
    Assert-True ($LASTEXITCODE -eq 0) "Fixture binary failed before installation"
    $expectedVersionOutput = ($expectedVersionLines -join [Environment]::NewLine).Trim()
    Assert-True (-not [string]::IsNullOrWhiteSpace($expectedVersionOutput)) "Fixture binary produced no expected version output"

    $gitBashCheckPath = Join-Path $FixtureDirectory "verify-git-bash.sh"
    $gitBashCheck = @'
set -euo pipefail
resolved="$(command -v arashi)"
test -n "$resolved"
test "$(cygpath -am "$resolved")" = "$(cygpath -am "$ARASHI_EXPECTED_WRAPPER")"
alias_resolved="$(command -v aw)"
test -n "$alias_resolved"
test "$(cygpath -am "$alias_resolved")" = "$(cygpath -am "$ARASHI_EXPECTED_ALIAS_WRAPPER")"
canonical="$(arashi --version)"
alias_output="$(aw --version)"
test "$canonical" = "$alias_output"
printf '%s\n' "$canonical"
'@
    [System.IO.File]::WriteAllText($gitBashCheckPath, (($gitBashCheck -replace "`r`n", "`n") + "`n"), [System.Text.Encoding]::ASCII)

    $powerShellCheckPath = Join-Path $FixtureDirectory "verify-powershell.ps1"
    @'
$resolved = (Get-Command arashi.ps1 -ErrorAction Stop).Source
if ([IO.Path]::GetFullPath($resolved) -ine [IO.Path]::GetFullPath($env:ARASHI_EXPECTED_POWERSHELL)) { throw "Unexpected arashi.ps1: $resolved" }
$aliasResolved = (Get-Command aw.ps1 -ErrorAction Stop).Source
if ([IO.Path]::GetFullPath($aliasResolved) -ine [IO.Path]::GetFullPath($env:ARASHI_EXPECTED_ALIAS_POWERSHELL)) { throw "Unexpected aw.ps1: $aliasResolved" }
$canonical = (& $resolved --version | Out-String).Trim()
$aliasOutput = (& $aliasResolved --version | Out-String).Trim()
if ($canonical -cne $aliasOutput) { throw "PowerShell entrypoint versions differ" }
Write-Output $canonical
exit 0
'@ | Set-Content -LiteralPath $powerShellCheckPath -Encoding Ascii

    $cmdCheckPath = Join-Path $FixtureDirectory "verify-cmd.cmd"
    @'
@echo off
setlocal EnableDelayedExpansion
for /f "delims=" %%I in ('where arashi.bat') do if not defined RESOLVED set "RESOLVED=%%~fI"
if /i not "!RESOLVED!"=="%ARASHI_EXPECTED_CMD%" exit /b 41
for /f "delims=" %%I in ('where aw.bat') do if not defined ALIAS_RESOLVED set "ALIAS_RESOLVED=%%~fI"
if /i not "!ALIAS_RESOLVED!"=="%ARASHI_EXPECTED_ALIAS_CMD%" exit /b 42
for /f "delims=" %%I in ('call "!RESOLVED!" --version') do set "CANONICAL=%%I"
for /f "delims=" %%I in ('call "!ALIAS_RESOLVED!" --version') do set "ALIAS_OUTPUT=%%I"
if not "!CANONICAL!"=="!ALIAS_OUTPUT!" exit /b 43
echo !CANONICAL!
'@ | Set-Content -LiteralPath $cmdCheckPath -Encoding Ascii

    [Environment]::SetEnvironmentVariable("Path", "", "User")
    $env:USERPROFILE = $temporaryUserProfile
    & $InstallerPath

    $installDirectory = Join-Path $temporaryUserProfile ".arashi\bin"
    foreach ($file in @("arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat", ".arashi-managed-entrypoints.json")) {
        Assert-True (Test-Path -LiteralPath (Join-Path $installDirectory $file) -PathType Leaf) "Missing installed payload file: $file"
    }

    $persistedUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $matches = @($persistedUserPath -split ";" | Where-Object { $_.TrimEnd("\") -ieq $installDirectory.TrimEnd("\") })
    Assert-True ($matches.Count -eq 1) "Expected install directory exactly once in persistent user PATH"

    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $freshPath = @($machinePath, $persistedUserPath) -join ";"
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    Assert-True (Test-Path -LiteralPath $gitBash) "Git for Windows Bash was not found"

    Invoke-FreshShell -FilePath $gitBash -Arguments @(
        "--noprofile",
        "--norc",
        $gitBashCheckPath
    ) -Label "Git Bash" -ExpectedOutput $expectedVersionOutput -FreshPath $freshPath -FreshUserProfile $temporaryUserProfile -AdditionalEnvironment @{
        ARASHI_EXPECTED_WRAPPER = (Join-Path $installDirectory "arashi")
        ARASHI_EXPECTED_ALIAS_WRAPPER = (Join-Path $installDirectory "aw")
        HOME = $temporaryUserProfile
    }

    Invoke-FreshShell -FilePath "powershell.exe" -Arguments @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $powerShellCheckPath
    ) -Label "PowerShell" -ExpectedOutput $expectedVersionOutput -FreshPath $freshPath -FreshUserProfile $temporaryUserProfile -AdditionalEnvironment @{
        ARASHI_EXPECTED_POWERSHELL = (Join-Path $installDirectory "arashi.ps1")
        ARASHI_EXPECTED_ALIAS_POWERSHELL = (Join-Path $installDirectory "aw.ps1")
    }

    Invoke-FreshShell -FilePath "cmd.exe" -Arguments @(
        "/d",
        "/v:on",
        "/c",
        $cmdCheckPath
    ) -Label "Command Prompt" -ExpectedOutput $expectedVersionOutput -FreshPath $freshPath -FreshUserProfile $temporaryUserProfile -AdditionalEnvironment @{
        ARASHI_EXPECTED_CMD = (Join-Path $installDirectory "arashi.bat")
        ARASHI_EXPECTED_ALIAS_CMD = (Join-Path $installDirectory "aw.bat")
    }

    foreach ($profile in @(".bashrc", ".bash_profile", ".profile")) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $temporaryUserProfile $profile))) "Installer unexpectedly edited $profile"
    }
} catch {
    $testFailure = $_
} finally {
    $cleanupErrors = @()

    try { Remove-Item Function:\Invoke-WebRequest -ErrorAction Stop } catch { $cleanupErrors += "Failed to remove Invoke-WebRequest fixture: $($_.Exception.Message)" }

    try {
        [Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")
        $restoredUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($restoredUserPath -cne $originalUserPath) { throw "persistent user PATH differs from its original value" }
    } catch { $cleanupErrors += "Failed to restore persistent user PATH: $($_.Exception.Message)" }

    try {
        $env:USERPROFILE = $originalUserProfile
        if ($env:USERPROFILE -cne $originalUserProfile) { throw "process USERPROFILE differs from its original value" }
    } catch { $cleanupErrors += "Failed to restore process USERPROFILE: $($_.Exception.Message)" }

    try {
        $env:Path = $originalProcessPath
        if ($env:Path -cne $originalProcessPath) { throw "process PATH differs from its original value" }
    } catch { $cleanupErrors += "Failed to restore process PATH: $($_.Exception.Message)" }

    try {
        if (Test-Path -LiteralPath $temporaryUserProfile) {
            Remove-Item -LiteralPath $temporaryUserProfile -Recurse -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $temporaryUserProfile) { throw "temporary user profile still exists" }
    } catch { $cleanupErrors += "Failed to remove temporary user profile: $($_.Exception.Message)" }

    try {
        if (Test-Path -LiteralPath $FixtureDirectory) {
            Remove-Item -LiteralPath $FixtureDirectory -Recurse -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $FixtureDirectory) { throw "release fixture directory still exists" }
    } catch { $cleanupErrors += "Failed to remove release fixture directory: $($_.Exception.Message)" }

    if ($cleanupErrors.Count -gt 0) {
        $failurePrefix = if ($null -ne $testFailure) { "Acceptance failed: $($testFailure.Exception.Message). " } else { "" }
        throw "$failurePrefix Cleanup failed: $($cleanupErrors -join '; ')"
    }
}

if ($null -ne $testFailure) { throw $testFailure }
