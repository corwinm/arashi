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

function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern, [string]$Message)
    try {
        & $Action
        throw "Expected failure: $Message"
    } catch {
        if ($_.Exception.Message -eq "Expected failure: $Message" -or $_.Exception.Message -notmatch $Pattern) { throw }
    }
}

function New-PayloadFixture {
    param([string]$Name, [string[]]$Existing = @())
    $root = Join-Path $env:RUNNER_TEMP "arashi-transaction-$Name-$([Guid]::NewGuid().ToString('N'))"
    $source = Join-Path $root "source"
    $destination = Join-Path $root "destination"
    New-Item -ItemType Directory -Path $source, $destination -Force | Out-Null
    $names = @("arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat")
    $payload = foreach ($name in $names) {
        Set-Content -LiteralPath (Join-Path $source $name) -Value "new-$name" -NoNewline
        if ($Existing -contains $name) { Set-Content -LiteralPath (Join-Path $destination $name) -Value "old-$name" -NoNewline }
        [PSCustomObject]@{ SourcePath = Join-Path $source $name; DestinationPath = Join-Path $destination $name }
    }
    return [PSCustomObject]@{ Root = $root; Source = $source; Destination = $destination; Payload = @($payload); Names = $names }
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

    Write-Host "pre-alias upgrade"
    $preAlias = New-PayloadFixture "pre-alias" -Existing @("arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat")
    $fixtures += $preAlias
    Assert-ArashiAliasOwnership -InstallDirectory $preAlias.Destination -ResolveCommands { @() }

    Write-Host "partial pre-existing payload"
    $partialNames = @("arashi.bin.exe", "arashi.ps1")
    $partial = New-PayloadFixture "partial" -Existing $partialNames
    $fixtures += $partial
    Install-ArashiPayloadTransaction -Payload $partial.Payload -BinaryPath (Join-Path $partial.Destination "arashi.bin.exe") -SmokeTest { param($path) }
    Assert-State $partial $partial.Names "new"

    Write-Host "managed alias upgrade"
    $managed = New-PayloadFixture "managed-alias"
    $fixtures += $managed
    $managedAliases = foreach ($name in @("aw", "aw.ps1", "aw.bat")) {
        $path = Join-Path $managed.Destination $name
        Set-Content -LiteralPath $path -Value "# arashi-managed-alias:aw:v1" -NoNewline
        [PSCustomObject]@{ Path = $path; Hash = Get-ArashiFileHash -Path $path }
    }
    Write-ArashiOwnershipLedger -Path (Join-Path $managed.Destination $OwnershipLedgerName) -InstallDirectory $managed.Destination -ReleaseVersion "1.30.0" -Aliases $managedAliases
    Assert-ArashiAliasOwnership -InstallDirectory $managed.Destination -ResolveCommands { @() }

    Write-Host "manual marked alias collision"
    $manual = New-PayloadFixture "manual-alias"
    $fixtures += $manual
    Set-Content -LiteralPath (Join-Path $manual.Destination "aw") -Value "# arashi-managed-alias:aw:v1" -NoNewline
    Assert-Throws { Assert-ArashiAliasOwnership -InstallDirectory $manual.Destination -ResolveCommands { @() } } "no installer ownership ledger" "manual alias collision"

    Write-Host "unmarked alias collision"
    $unmarked = New-PayloadFixture "unmarked-alias"
    $fixtures += $unmarked
    Set-Content -LiteralPath (Join-Path $unmarked.Destination "aw") -Value "unrelated" -NoNewline
    Assert-Throws { Assert-ArashiAliasOwnership -InstallDirectory $unmarked.Destination -ResolveCommands { @() } } "Unrelated alias collision" "unmarked alias collision"

    Write-Host "malformed ledger collision"
    $malformed = New-PayloadFixture "malformed-ledger"
    $fixtures += $malformed
    Set-Content -LiteralPath (Join-Path $malformed.Destination $OwnershipLedgerName) -Value "{" -NoNewline
    Assert-Throws { Assert-ArashiAliasOwnership -InstallDirectory $malformed.Destination -ResolveCommands { @() } } "Malformed ownership ledger" "malformed ledger collision"

    Write-Host "directory alias collision"
    $directoryAlias = New-PayloadFixture "directory-alias"
    $fixtures += $directoryAlias
    New-Item -ItemType Directory -Path (Join-Path $directoryAlias.Destination "aw") | Out-Null
    Assert-Throws { Assert-ArashiAliasOwnership -InstallDirectory $directoryAlias.Destination -ResolveCommands { @() } } "not a regular file" "directory alias collision"

    Write-Host "reparse-point alias collision"
    $reparseAlias = New-PayloadFixture "reparse-alias"
    $fixtures += $reparseAlias
    $reparseTarget = Join-Path $reparseAlias.Root "target"
    Set-Content -LiteralPath $reparseTarget -Value "target" -NoNewline
    try {
        New-Item -ItemType SymbolicLink -Path (Join-Path $reparseAlias.Destination "aw") -Target $reparseTarget -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "reparse-point creation unavailable on this runner"
    }
    if (Test-Path -LiteralPath (Join-Path $reparseAlias.Destination "aw")) {
        Assert-Throws { Assert-ArashiAliasOwnership -InstallDirectory $reparseAlias.Destination -ResolveCommands { @() } } "not a regular file" "reparse alias collision"
    }

    Write-Host "PATH-resolved PowerShell collision"
    Write-Host "PATH-resolved CMD collision"
    Write-Host "PATH-resolved Git Bash collision"
    $pathCollision = New-PayloadFixture "path-collision"
    $fixtures += $pathCollision
    $externalAlias = Join-Path $pathCollision.Root "external\aw.exe"
    New-Item -ItemType Directory -Path (Split-Path -Parent $externalAlias) -Force | Out-Null
    Set-Content -LiteralPath $externalAlias -Value "must not execute" -NoNewline
    Assert-Throws { Assert-ArashiAliasOwnership -InstallDirectory $pathCollision.Destination -ResolveCommands { $externalAlias } } "outside" "PATH-resolved collision"

    Write-Host "same-directory unmanaged executable collision"
    $sameDirectoryCollision = New-PayloadFixture "same-directory-collision"
    $fixtures += $sameDirectoryCollision
    $sameDirectoryExecutable = Join-Path $sameDirectoryCollision.Destination "aw.exe"
    Set-Content -LiteralPath $sameDirectoryExecutable -Value "must not execute" -NoNewline
    Assert-Throws {
        Assert-ArashiAliasOwnership -InstallDirectory $sameDirectoryCollision.Destination -ResolveCommands { $sameDirectoryExecutable }
    } "Unrelated aw command resolves" "same-directory unmanaged executable collision"
    Assert-Equal "must not execute" (Get-Content -LiteralPath $sameDirectoryExecutable -Raw) "Same-directory collision was mutated"

    Write-Host "non-file destination"
    $nonFile = New-PayloadFixture "non-file"
    $fixtures += $nonFile
    $nonFilePath = Join-Path $nonFile.Destination "aw"
    New-Item -ItemType Directory -Path $nonFilePath -Force | Out-Null
    try {
        Install-ArashiPayloadTransaction -Payload $nonFile.Payload -BinaryPath (Join-Path $nonFile.Destination "arashi.bin.exe") -SmokeTest { param($path) }
        throw "Expected non-file destination failure"
    } catch {
        if ($_.Exception.Message -notmatch "not a regular file") { throw }
    }
    if (-not (Test-Path -LiteralPath $nonFilePath -PathType Container)) { throw "Existing directory was mutated" }
    foreach ($name in $nonFile.Names | Where-Object { $_ -ne "aw" }) {
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
    Write-Host "canonical smoke-test failure"
    $smoke = New-PayloadFixture "smoke" -Existing @("arashi.bin.exe", "arashi.bat")
    $fixtures += $smoke
    try {
        Install-ArashiPayloadTransaction -Payload $smoke.Payload -BinaryPath (Join-Path $smoke.Destination "arashi.bin.exe") -SmokeTest { param($path) throw "injected smoke failure" }
        throw "Expected smoke-test failure"
    } catch {
        if ($_.Exception.Message -notmatch "smoke") { throw }
    }
    Assert-State $smoke @("arashi.bin.exe", "arashi.bat") "old"

    Write-Host "alias smoke-test failure"
    $aliasSmoke = New-PayloadFixture "alias-smoke" -Existing $smoke.Names
    $fixtures += $aliasSmoke
    $aliasSmokeLedger = Join-Path $aliasSmoke.Destination $OwnershipLedgerName
    Set-Content -LiteralPath $aliasSmokeLedger -Value "old-ledger" -NoNewline
    $aliasSmokeStagedLedger = Join-Path $aliasSmoke.Root "new-ledger"
    Set-Content -LiteralPath $aliasSmokeStagedLedger -Value "new-ledger" -NoNewline
    Assert-Throws {
        Install-ArashiPayloadTransaction -Payload $aliasSmoke.Payload -BinaryPath (Join-Path $aliasSmoke.Destination "arashi.bin.exe") -CanonicalPath (Join-Path $aliasSmoke.Destination "arashi.ps1") -AliasPath (Join-Path $aliasSmoke.Destination "aw.ps1") -OwnershipLedgerItem ([PSCustomObject]@{ SourcePath = $aliasSmokeStagedLedger; DestinationPath = $aliasSmokeLedger }) -SmokeTest {
            param($native, $canonical, $alias)
            if ([IO.Path]::GetFileName($alias) -ne "aw.ps1") { throw "wrong alias smoke target" }
            throw "injected alias smoke failure"
        }
    } "smoke test" "alias smoke rollback"
    Assert-State $aliasSmoke $aliasSmoke.Names "old"
    Assert-Equal "old-ledger" (Get-Content -LiteralPath $aliasSmokeLedger -Raw) "Alias smoke failure did not preserve the old ledger"

    Write-Host "ledger-commit failure"
    $ledgerCommitNames = @("arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat")
    $ledgerCommit = New-PayloadFixture "ledger-commit" -Existing $ledgerCommitNames
    $fixtures += $ledgerCommit
    $oldLedgerPath = Join-Path $ledgerCommit.Destination $OwnershipLedgerName
    Set-Content -LiteralPath $oldLedgerPath -Value "old-ledger" -NoNewline
    $newLedgerPath = Join-Path $ledgerCommit.Source $OwnershipLedgerName
    Set-Content -LiteralPath $newLedgerPath -Value "new-ledger" -NoNewline
    $ledgerItem = [PSCustomObject]@{ SourcePath = $newLedgerPath; DestinationPath = $oldLedgerPath }
    Assert-Throws {
        Install-ArashiPayloadTransaction -Payload $ledgerCommit.Payload -BinaryPath (Join-Path $ledgerCommit.Destination "arashi.bin.exe") -OwnershipLedgerItem $ledgerItem -SmokeTest { param($native, $canonical, $alias) } -ReplaceAsset {
            param($source, $destination)
            if ([IO.Path]::GetFileName($destination) -eq $OwnershipLedgerName) { throw "injected ledger commit failure" }
            Install-ArashiStagedAsset -SourcePath $source -DestinationPath $destination
        }
    } "ledger commit" "ledger commit rollback"
    Assert-State $ledgerCommit $ledgerCommit.Names "old"
    Assert-Equal "old-ledger" (Get-Content -LiteralPath $oldLedgerPath -Raw) "Ledger commit failure did not restore old ledger"

    Write-Host "rollback failure"
    $rollbackNames = @("arashi.bin.exe", "arashi", "arashi.ps1", "arashi.bat", "aw", "aw.ps1", "aw.bat")
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
        $backupMatch = [regex]::Match($_.Exception.Message, 'backups retained at: (.+?)\. Restore the matching files manually')
        if (-not $backupMatch.Success -or -not (Test-Path -LiteralPath $backupMatch.Groups[1].Value)) {
            throw "Rollback failure did not retain recoverable backups"
        }
        Remove-Item -LiteralPath $backupMatch.Groups[1].Value -Recurse -Force
    }
    Write-Host "deferred update"
    Write-Host "complete cleanup"
} finally {
    foreach ($fixture in $fixtures) { Remove-Item -LiteralPath $fixture.Root -Recurse -Force -ErrorAction SilentlyContinue }
}
