#requires -Version 5.1
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installerSource = Get-Content -LiteralPath (Join-Path $Root "scripts\install.ps1") -Raw
$installerSource = $installerSource -replace '(?m)^Install-Arashi\s*\r?\n?$', ''
Invoke-Expression $installerSource

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) { throw "$Message (expected '$Expected', got '$Actual')" }
}

function New-PayloadFixture {
    param([string]$Name, [string[]]$Existing = @())
    $root = Join-Path $env:RUNNER_TEMP "arashi-transaction-$Name-$([Guid]::NewGuid().ToString('N'))"
    $source = Join-Path $root "source"
    $destination = Join-Path $root "destination"
    New-Item -ItemType Directory -Path $source, $destination -Force | Out-Null
    $names = @("arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat")
    $payload = foreach ($name in $names) {
        Set-Content -LiteralPath (Join-Path $source $name) -Value "new-$name" -NoNewline
        if ($Existing -contains $name) { Set-Content -LiteralPath (Join-Path $destination $name) -Value "old-$name" -NoNewline }
        [PSCustomObject]@{ SourcePath = Join-Path $source $name; DestinationPath = Join-Path $destination $name }
    }
    return [PSCustomObject]@{ Root = $root; Destination = $destination; Payload = @($payload); Names = $names }
}

function Assert-State {
    param($Fixture, [string[]]$Existing, [string]$Prefix)
    foreach ($name in $Fixture.Names) {
        $path = Join-Path $Fixture.Destination $name
        if ($Existing -contains $name) {
            Assert-Equal "$Prefix-$name" (Get-Content -LiteralPath $path -Raw) "Unexpected content for $name"
        } elseif (Test-Path -LiteralPath $path) {
            throw "Expected $name to be absent"
        }
    }
}

$fixtures = @()
try {
    Write-Host "fresh installation"
    $fresh = New-PayloadFixture "fresh"
    $fixtures += $fresh
    Install-ArashiPayloadTransaction -Payload $fresh.Payload -BinaryPath (Join-Path $fresh.Destination "arashi.bin.exe") -SmokeTest { param($path) }
    Assert-State $fresh $fresh.Names "new"

    Write-Host "partial pre-existing payload"
    $partialNames = @("arashi.bin.exe", "arashi.ps1")
    $partial = New-PayloadFixture "partial" -Existing $partialNames
    $fixtures += $partial
    Install-ArashiPayloadTransaction -Payload $partial.Payload -BinaryPath (Join-Path $partial.Destination "arashi.bin.exe") -SmokeTest { param($path) }
    Assert-State $partial $partial.Names "new"

    Write-Host "non-file destination"
    $nonFile = New-PayloadFixture "non-file"
    $fixtures += $nonFile
    $nonFilePath = Join-Path $nonFile.Destination "arashi"
    New-Item -ItemType Directory -Path $nonFilePath -Force | Out-Null
    try {
        Install-ArashiPayloadTransaction -Payload $nonFile.Payload -BinaryPath (Join-Path $nonFile.Destination "arashi.bin.exe") -SmokeTest { param($path) }
        throw "Expected non-file destination failure"
    } catch {
        if ($_.Exception.Message -notmatch "not a regular file") { throw }
    }
    if (-not (Test-Path -LiteralPath $nonFilePath -PathType Container)) { throw "Existing directory was mutated" }
    foreach ($name in $nonFile.Names | Where-Object { $_ -ne "arashi" }) {
        if (Test-Path -LiteralPath (Join-Path $nonFile.Destination $name)) { throw "Payload mutated before non-file rejection" }
    }

    Write-Host "pre-existing temporary neighbor"
    $temporaryNeighbor = New-PayloadFixture "temporary-neighbor"
    $fixtures += $temporaryNeighbor
    $neighborPath = Join-Path $temporaryNeighbor.Destination "arashi.tmp"
    Set-Content -LiteralPath $neighborPath -Value "keep-neighbor" -NoNewline
    Install-ArashiPayloadTransaction -Payload $temporaryNeighbor.Payload -BinaryPath (Join-Path $temporaryNeighbor.Destination "arashi.bin.exe") -SmokeTest { param($path) }
    if ((Get-Content -LiteralPath $neighborPath -Raw) -ne "keep-neighbor") { throw "Pre-existing temporary neighbor was mutated" }
    $ownedTemporaryFiles = @(Get-ChildItem -LiteralPath $temporaryNeighbor.Destination -Filter "*.arashi-install-*.tmp" -Force)
    if ($ownedTemporaryFiles.Count -ne 0) { throw "Installer-owned temporary files were not cleaned" }

    Write-Host "replacement failure"
    $replacement = New-PayloadFixture "replacement" -Existing @("arashi.bin.exe", "arashi")
    $fixtures += $replacement
    $replaceCount = 0
    try {
        Install-ArashiPayloadTransaction -Payload $replacement.Payload -BinaryPath (Join-Path $replacement.Destination "arashi.bin.exe") -SmokeTest { param($path) } -ReplaceAsset {
            param($source, $destination)
            $script:replaceCount++
            if ($script:replaceCount -eq 3) { throw "injected replacement failure" }
            Install-ArashiStagedAsset -SourcePath $source -DestinationPath $destination
        }
        throw "Expected replacement failure"
    } catch {
        if ($_.Exception.Message -notmatch "replacement") { throw }
    }
    Assert-State $replacement @("arashi.bin.exe", "arashi") "old"

    Write-Host "smoke-test failure"
    $smoke = New-PayloadFixture "smoke" -Existing @("arashi.bin.exe", "arashi.bat")
    $fixtures += $smoke
    try {
        Install-ArashiPayloadTransaction -Payload $smoke.Payload -BinaryPath (Join-Path $smoke.Destination "arashi.bin.exe") -SmokeTest { param($path) throw "injected smoke failure" }
        throw "Expected smoke-test failure"
    } catch {
        if ($_.Exception.Message -notmatch "smoke") { throw }
    }
    Assert-State $smoke @("arashi.bin.exe", "arashi.bat") "old"

    Write-Host "rollback failure"
    $rollbackNames = @("arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat")
    $rollback = New-PayloadFixture "rollback" -Existing $rollbackNames
    $fixtures += $rollback
    try {
        Install-ArashiPayloadTransaction -Payload $rollback.Payload -BinaryPath (Join-Path $rollback.Destination "arashi.bin.exe") -SmokeTest { param($path) throw "force rollback" } -RestoreAsset {
            param($backup, $destination)
            throw "injected rollback failure"
        }
        throw "Expected rollback failure"
    } catch {
        if ($_.Exception.Message -notmatch "Rollback failed" -or $_.Exception.Message -notmatch "backups retained") { throw }
        $backupMatch = [regex]::Match($_.Exception.Message, 'backups retained at: ([^\r\n]+)')
        if (-not $backupMatch.Success -or -not (Test-Path -LiteralPath $backupMatch.Groups[1].Value)) {
            throw "Rollback failure did not retain recoverable backups"
        }
        Remove-Item -LiteralPath $backupMatch.Groups[1].Value -Recurse -Force
    }
} finally {
    foreach ($fixture in $fixtures) { Remove-Item -LiteralPath $fixture.Root -Recurse -Force -ErrorAction SilentlyContinue }
}
