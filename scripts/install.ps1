#requires -Version 5.1
<##
.SYNOPSIS
Install Arashi for Windows from GitHub Releases.

.EXAMPLE
powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"

.EXAMPLE
.\install.ps1 -Version 1.16.0 -InstallDir C:\Tools\Arashi -NoModifyPath
#>

[CmdletBinding()]
param(
    [string]$Version = $env:ARASHI_VERSION,
    [string]$InstallDir = $env:ARASHI_INSTALL_DIR,
    [switch]$NoModifyPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repository = "corwinm/arashi"
$ProjectName = "arashi"
$WindowsBinaryAsset = "arashi-windows-x64.exe"
$BashWrapperAsset = "arashi"
$PowerShellWrapperAsset = "arashi.ps1"
$CmdWrapperAsset = "arashi.bat"
$AliasBashWrapperAsset = "aw"
$AliasPowerShellWrapperAsset = "aw.ps1"
$AliasCmdWrapperAsset = "aw.bat"
$UninstallHelperAsset = "uninstall.ps1"
$AliasMarker = "arashi-managed-alias:aw:v1"
$OwnershipLedgerName = ".arashi-managed-entrypoints.json"
$OwnershipLedgerSchemaVersion = 2
$ChecksumManifestAsset = "arashi-checksums.txt"
$InstalledBinaryName = "arashi.bin.exe"
$ReleaseFallbackUrl = "https://github.com/$Repository/releases/latest"

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "==> $Message"
}

function Write-WarningMessage {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Warning $Message
}

function Fail-Install {
    param([Parameter(Mandatory = $true)][string]$Message)
    [Console]::Error.WriteLine($Message)
    [Console]::Error.WriteLine("Manual fallback: download $WindowsBinaryAsset, $BashWrapperAsset, $PowerShellWrapperAsset, $CmdWrapperAsset, $AliasBashWrapperAsset, $AliasPowerShellWrapperAsset, and $AliasCmdWrapperAsset from $ReleaseFallbackUrl into one directory on PATH; rename the executable to $InstalledBinaryName.")
    exit 1
}

function Normalize-ArashiVersion {
    param([AllowNull()][string]$InputVersion)

    if ([string]::IsNullOrWhiteSpace($InputVersion) -or $InputVersion -eq "latest" -or $InputVersion -eq "stable") {
        return "latest"
    }

    return $InputVersion.Trim().TrimStart("v")
}

function Get-ArashiReleaseBaseUrl {
    param([Parameter(Mandatory = $true)][string]$InputVersion)

    $normalizedVersion = Normalize-ArashiVersion -InputVersion $InputVersion
    if ($normalizedVersion -eq "latest") {
        return "https://github.com/$Repository/releases/latest/download"
    }

    return "https://github.com/$Repository/releases/download/v$normalizedVersion"
}

function Test-ArashiSupportedWindowsPlatform {
    $isWindowsPlatform = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
    if (-not $isWindowsPlatform) {
        Fail-Install "This installer supports Windows x64 only. Use https://arashi.haphazard.dev/install on macOS/Linux."
    }

    $architecture = $env:PROCESSOR_ARCHITECTURE
    try {
        $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    } catch {
        # Windows PowerShell 5.1 may not expose RuntimeInformation on all systems; fall back to PROCESSOR_ARCHITECTURE.
    }

    if ($architecture -notin @("X64", "x64", "Amd64", "AMD64")) {
        Fail-Install "Unsupported Windows architecture: $architecture. Arashi currently publishes Windows x64 assets only."
    }

    return "windows-x64"
}

function Resolve-ArashiInstallDir {
    param([AllowNull()][string]$InputInstallDir)

    if (-not [string]::IsNullOrWhiteSpace($InputInstallDir)) {
        return [System.IO.Path]::GetFullPath($InputInstallDir)
    }

    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        Fail-Install "USERPROFILE is not set. Provide -InstallDir or ARASHI_INSTALL_DIR."
    }

    return (Join-Path $env:USERPROFILE ".arashi\bin")
}

function Test-ArashiNoModifyPath {
    param([switch]$NoModifyPathFlag)

    if ($NoModifyPathFlag.IsPresent) {
        return $true
    }

    return $env:ARASHI_NO_MODIFY_PATH -in @("1", "true", "TRUE", "yes", "YES")
}

function Wait-ArashiParentProcess {
    param([AllowNull()][string]$ParentProcessId)

    if ([string]::IsNullOrWhiteSpace($ParentProcessId)) {
        return
    }

    $parsedProcessId = 0
    if (-not [int]::TryParse($ParentProcessId, [ref]$parsedProcessId) -or $parsedProcessId -le 0) {
        return
    }

    Write-Step "Waiting for current Arashi process to exit before replacing files"
    try {
        Wait-Process -Id $parsedProcessId -Timeout 120 -ErrorAction Stop
    } catch [System.TimeoutException] {
        Fail-Install "Timed out waiting for Arashi process $parsedProcessId to exit. Close running Arashi processes and rerun the installer."
    } catch {
        # The parent process may already be gone by the time the deferred installer starts.
    }
}

function Invoke-ArashiDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Label
    )

    Write-Step "Downloading $Label"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    } catch {
        Fail-Install "Unable to download $Label from $Url. $($_.Exception.Message)"
    }
}

function Get-ArashiExpectedChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$AssetName
    )

    foreach ($line in Get-Content -LiteralPath $ManifestPath) {
        if ($line -match '^([A-Fa-f0-9]{64})\s+\*?(.+)$') {
            $hash = $Matches[1].ToLowerInvariant()
            $name = $Matches[2].Trim()
            if ($name -eq $AssetName) {
                return $hash
            }
        }
    }

    Fail-Install "Checksum entry for $AssetName not found in $ChecksumManifestAsset."
}

function Assert-ArashiChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$AssetPath,
        [Parameter(Mandatory = $true)][string]$AssetName
    )

    $expected = Get-ArashiExpectedChecksum -ManifestPath $ManifestPath -AssetName $AssetName
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $AssetPath).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        Fail-Install "Checksum validation failed for $AssetName."
    }
}

function Get-ArashiFileHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Test-ArashiGitForWindowsRoot {
    param([Parameter(Mandatory = $true)][string]$Root)

    try {
        $fullRoot = [System.IO.Path]::GetFullPath($Root)
    } catch {
        return $false
    }
    return (
        (Test-Path -LiteralPath (Join-Path $fullRoot "cmd\git.exe") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $fullRoot "bin\bash.exe") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $fullRoot "usr\bin\cygpath.exe") -PathType Leaf)
    )
}

function Get-ArashiGitForWindowsBash {
    $candidateRoots = New-Object System.Collections.Generic.List[string]
    foreach ($registryPath in @(
        "HKCU:\Software\GitForWindows",
        "HKLM:\Software\GitForWindows",
        "HKLM:\Software\WOW6432Node\GitForWindows"
    )) {
        try {
            $installPath = (Get-ItemProperty -LiteralPath $registryPath -Name InstallPath -ErrorAction Stop).InstallPath
            if (-not [string]::IsNullOrWhiteSpace($installPath)) { $candidateRoots.Add($installPath) }
        } catch {
            # Registry discovery is optional; verified filesystem layouts below remain authoritative.
        }
    }
    foreach ($programFilesRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LocalAppData)) {
        if (-not [string]::IsNullOrWhiteSpace($programFilesRoot)) {
            $candidateRoots.Add((Join-Path $programFilesRoot "Git"))
            if ($programFilesRoot -eq $env:LocalAppData) {
                $candidateRoots.Add((Join-Path $programFilesRoot "Programs\Git"))
            }
        }
    }
    foreach ($gitCommand in @(Get-Command git.exe -All -ErrorAction SilentlyContinue)) {
        if ([string]::IsNullOrWhiteSpace($gitCommand.Path)) { continue }
        $gitDirectory = Split-Path -Parent $gitCommand.Path
        $candidateRoots.Add((Split-Path -Parent $gitDirectory))
        if ((Split-Path -Leaf $gitDirectory) -ieq "bin") {
            $candidateRoots.Add((Split-Path -Parent (Split-Path -Parent $gitDirectory)))
        }
    }

    $seen = @{}
    foreach ($root in $candidateRoots) {
        try { $fullRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\') } catch { continue }
        if ($seen.ContainsKey($fullRoot)) { continue }
        $seen[$fullRoot] = $true
        if (Test-ArashiGitForWindowsRoot -Root $fullRoot) {
            return (Join-Path $fullRoot "bin\bash.exe")
        }
    }
    return $null
}

function Assert-ArashiAliasOwnership {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDirectory,
        [string[]]$AliasNames = @($AliasBashWrapperAsset, $AliasPowerShellWrapperAsset, $AliasCmdWrapperAsset),
        [scriptblock]$ResolveCommands
    )

    $ledgerPath = Join-Path $InstallDirectory $OwnershipLedgerName
    $ledgerItem = Get-Item -LiteralPath $ledgerPath -Force -ErrorAction SilentlyContinue
    $ledgerExists = $null -ne $ledgerItem
    $ledger = $null
    if (-not $ledgerExists) {
        $legacyPayloadNames = @($InstalledBinaryName, $BashWrapperAsset, $PowerShellWrapperAsset, $CmdWrapperAsset)
        $legacyPayloadComplete = $true
        foreach ($legacyName in $legacyPayloadNames) {
            $legacyItem = Get-Item -LiteralPath (Join-Path $InstallDirectory $legacyName) -Force -ErrorAction SilentlyContinue
            if ($null -eq $legacyItem -or $legacyItem.PSIsContainer -or ($legacyItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                $legacyPayloadComplete = $false
                break
            }
        }
        foreach ($unmanagedName in @($InstalledBinaryName, $BashWrapperAsset, $PowerShellWrapperAsset, $CmdWrapperAsset, $AliasBashWrapperAsset, $AliasPowerShellWrapperAsset, $AliasCmdWrapperAsset, $UninstallHelperAsset)) {
            $unmanagedPath = Join-Path $InstallDirectory $unmanagedName
            if ((Test-Path -LiteralPath $unmanagedPath) -and (-not $legacyPayloadComplete -or $unmanagedName -notin $legacyPayloadNames)) { throw "Unmanifested install collision at $unmanagedPath; move it aside before installing." }
        }
    }
    if ($ledgerExists) {
        $ledgerReparse = ($ledgerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        if ($ledgerItem.PSIsContainer -or $ledgerReparse) { throw "Ownership ledger collision at $ledgerPath is not a regular file; move or remove it deliberately before retrying." }
        try {
            $ledgerBytes = [System.IO.File]::ReadAllBytes($ledgerPath)
            $ledgerEncoding = New-Object System.Text.UTF8Encoding($false, $true)
            $ledgerText = $ledgerEncoding.GetString($ledgerBytes).TrimStart([char]0xFEFF)
            $ledger = $ledgerText | ConvertFrom-Json
        } catch { throw "Malformed ownership ledger at $ledgerPath; move or remove it deliberately before retrying." }
        if ($ledger.schemaVersion -eq 2) {
            $currentProperties = @($ledger.PSObject.Properties.Name | Sort-Object)
            if (($currentProperties -join ',') -cnotin @('files,installationChannel,installDirectory,platform,schemaVersion', 'files,installationChannel,installDirectory,pathMutation,platform,schemaVersion')) { throw "Current ownership manifest property-set defect at $ledgerPath; refresh cannot safely replace it." }
            if ($ledger.schemaVersion -isnot [int] -or $ledger.installationChannel -isnot [string] -or $ledger.installationChannel -cne "official-direct" -or $ledger.platform -isnot [string] -or $ledger.platform -cne "windows" -or $ledger.installDirectory -isnot [string] -or [System.IO.Path]::GetFullPath($ledger.installDirectory) -ine [System.IO.Path]::GetFullPath($InstallDirectory)) {
                throw "Current ownership manifest identity mismatch at $ledgerPath; refresh cannot safely replace it."
            }
            if ($currentProperties -contains 'pathMutation') {
                $pathProperties = @($ledger.pathMutation.PSObject.Properties.Name | Sort-Object)
                if (($pathProperties -join ',') -cne 'created,entry' -or $ledger.pathMutation.created -isnot [bool] -or $ledger.pathMutation.entry -isnot [string] -or [string]::IsNullOrEmpty($ledger.pathMutation.entry)) {
                    throw "Current ownership manifest PATH provenance defect at $ledgerPath; refresh cannot safely replace it."
                }
            }
            $currentExpected = @(
                @($InstalledBinaryName, "native-executable"),
                @($BashWrapperAsset, "canonical-wrapper"),
                @($PowerShellWrapperAsset, "canonical-powershell-wrapper"),
                @($CmdWrapperAsset, "canonical-cmd-wrapper"),
                @($AliasBashWrapperAsset, "alias-wrapper"),
                @($AliasPowerShellWrapperAsset, "alias-powershell-wrapper"),
                @($AliasCmdWrapperAsset, "alias-cmd-wrapper"),
                @($UninstallHelperAsset, "uninstall-helper")
            )
            if (@($ledger.files).Count -ne $currentExpected.Count) { throw "Current ownership manifest payload mismatch at $ledgerPath; refresh cannot safely replace it." }
            for ($currentIndex = 0; $currentIndex -lt $currentExpected.Count; $currentIndex++) {
                $currentRecord = @($ledger.files)[$currentIndex]
                $currentRecordProperties = @($currentRecord.PSObject.Properties.Name | Sort-Object)
                if (($currentRecordProperties -join ',') -cne 'digest,relativePath,role' -or $currentRecord.relativePath -isnot [string] -or $currentRecord.role -isnot [string] -or $currentRecord.digest -isnot [string] -or $currentRecord.relativePath -cne $currentExpected[$currentIndex][0] -or $currentRecord.role -cne $currentExpected[$currentIndex][1] -or $currentRecord.digest -cnotmatch '^[a-f0-9]{64}$') {
                    throw "Current ownership manifest payload mismatch at $ledgerPath; refresh cannot safely replace it."
                }
                $currentPath = [System.IO.Path]::GetFullPath((Join-Path $InstallDirectory $currentRecord.relativePath))
                if ((Split-Path -Parent $currentPath) -ine [System.IO.Path]::GetFullPath($InstallDirectory)) { throw "Current ownership manifest payload mismatch at $ledgerPath; refresh cannot safely replace it." }
                $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
                if ($null -eq $currentItem -or $currentItem.PSIsContainer -or ($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or (Get-ArashiFileHash -Path $currentPath) -cne $currentRecord.digest) {
                    throw "Current ownership manifest payload mismatch at $ledgerPath; refresh cannot safely replace it."
                }
            }
            if ($currentProperties -contains 'pathMutation') { return $ledger.pathMutation }
            return $null
        }
        $ledgerProperties = @($ledger.PSObject.Properties.Name | Sort-Object)
        if (($ledgerProperties -join ',') -cne 'aliases,installDirectory,releaseVersion,schemaVersion') { throw "Ownership ledger property-set defect at $ledgerPath; move or remove it deliberately before retrying." }
        if ($ledger.schemaVersion -ne 1) { throw "Unsupported ownership ledger schemaVersion at $ledgerPath; move or remove it deliberately before retrying." }
        if (Test-Path -LiteralPath (Join-Path $InstallDirectory $UninstallHelperAsset)) { throw "Legacy ownership metadata does not own $UninstallHelperAsset; move it aside before refreshing." }
        if ($ledger.releaseVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw "Ownership ledger releaseVersion defect at $ledgerPath; move or remove it deliberately before retrying." }
        if ([System.IO.Path]::GetFullPath($ledger.installDirectory) -ine [System.IO.Path]::GetFullPath($InstallDirectory)) { throw "Ownership ledger installDirectory mismatch at $ledgerPath; move or remove it deliberately before retrying." }
        if (@($ledger.aliases).Count -ne $AliasNames.Count) { throw "Ownership ledger alias set mismatch at $ledgerPath; move or remove it deliberately before retrying." }
        foreach ($entry in @($ledger.aliases)) {
            $entryProperties = @($entry.PSObject.Properties.Name | Sort-Object)
            if (($entryProperties -join ',') -cne 'path,sha256' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Ownership ledger alias-entry defect at $ledgerPath; move or remove it deliberately before retrying." }
        }
    }

    foreach ($aliasName in $AliasNames) {
        $aliasPath = Join-Path $InstallDirectory $aliasName
        $item = Get-Item -LiteralPath $aliasPath -Force -ErrorAction SilentlyContinue
        $exists = $null -ne $item
        if ($exists) {
            $isReparsePoint = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
            if ($item.PSIsContainer -or $isReparsePoint) { throw "Alias collision at $aliasPath is not a regular file; move or remove it deliberately before retrying." }
            try { $contents = Get-Content -LiteralPath $aliasPath -Raw -ErrorAction Stop } catch { throw "Alias collision at $aliasPath is unreadable; move or remove it deliberately before retrying." }
            if ($contents -notmatch [regex]::Escape($AliasMarker)) { throw "Unrelated alias collision at $aliasPath; move or remove it deliberately before retrying." }
            if ($null -eq $ledger) { throw "Marked manual alias $aliasPath has no installer ownership ledger; move or remove it deliberately before retrying." }
            $entry = @($ledger.aliases | Where-Object { [System.IO.Path]::GetFullPath($_.path) -ieq [System.IO.Path]::GetFullPath($aliasPath) })
            if ($entry.Count -ne 1) { throw "Ownership ledger path mismatch for $aliasPath; move or remove it deliberately before retrying." }
            if ($entry[0].sha256 -cne (Get-ArashiFileHash -Path $aliasPath)) { throw "Ownership ledger hash mismatch for $aliasPath; move or remove it deliberately before retrying." }
        } elseif ($null -ne $ledger) {
            throw "Ownership ledger $ledgerPath claims a missing alias $aliasPath; move or remove it deliberately before retrying."
        }
    }

    $resolvedCommands = @()
    if ($null -ne $ResolveCommands) {
        $resolvedCommands = @(& $ResolveCommands)
    } else {
        $powerShell = Get-Command aw -All -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandType -in @("Application", "ExternalScript") -and -not [string]::IsNullOrWhiteSpace($_.Path) } |
            ForEach-Object { $_.Path }
        $cmd = @(
            foreach ($directory in @($env:Path -split ';')) {
                $expandedDirectory = [Environment]::ExpandEnvironmentVariables($directory.Trim().Trim('"'))
                if ([string]::IsNullOrWhiteSpace($expandedDirectory)) { continue }
                foreach ($name in @('aw.com', 'aw.exe', 'aw.bat', 'aw.cmd')) {
                    $candidate = Join-Path $expandedDirectory $name
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                        [System.IO.Path]::GetFullPath($candidate)
                    }
                }
            }
        )
        $bashPath = Get-ArashiGitForWindowsBash
        $gitBash = if ($bashPath) {
            & $bashPath --noprofile --norc -c 'candidate=$(type -P aw) || exit 0; cygpath -w -- "$candidate"' 2>$null
        } else { @() }
        $resolvedCommands = @($powerShell) + @($cmd) + @($gitBash)
    }
    $managedAliasPaths = @(
        $AliasNames | ForEach-Object { [System.IO.Path]::GetFullPath((Join-Path $InstallDirectory $_)) }
    )
    foreach ($resolved in $resolvedCommands | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) {
        $candidate = $resolved.ToString().Trim()
        if ($candidate -match '^/[a-zA-Z]/') { $candidate = $candidate.Substring(1, 1) + ":" + $candidate.Substring(2).Replace('/', '\') }
        $candidatePath = [System.IO.Path]::GetFullPath($candidate)
        $candidateDirectory = Split-Path -Parent $candidatePath
        if ($candidateDirectory.TrimEnd('\') -ine ([System.IO.Path]::GetFullPath($InstallDirectory)).TrimEnd('\')) {
            throw "Unrelated aw command resolves to $resolved outside $InstallDirectory; move or remove it deliberately before retrying."
        }
        if ($managedAliasPaths -notcontains $candidatePath) {
            throw "Unrelated aw command resolves to $resolved but is not an installer-managed alias destination; move or remove it deliberately before retrying."
        }
    }
}

function Write-ArashiOwnershipLedger {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$InstallDirectory,
        [Parameter(Mandatory = $true)][array]$Payload,
        [AllowNull()]$PathMutation = $null
    )
    $ledger = [ordered]@{
        schemaVersion = $OwnershipLedgerSchemaVersion
        installationChannel = "official-direct"
        platform = "windows"
        installDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
        files = @($Payload | ForEach-Object { [ordered]@{ relativePath = $_.RelativePath; role = $_.Role; digest = Get-ArashiFileHash -Path $_.SourcePath } })
    }
    if ($null -ne $PathMutation) { $ledger.pathMutation = $PathMutation }
    $temporaryPath = "$Path.arashi-install-$([System.Guid]::NewGuid().ToString('N')).tmp"
    try {
        $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($temporaryPath, (($ledger | ConvertTo-Json -Depth 5) + [Environment]::NewLine), $utf8WithoutBom)
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } finally { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
}

function Install-ArashiStagedAsset {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $destinationDirectory = Split-Path -Parent $DestinationPath
    $destinationName = [System.IO.Path]::GetFileName($DestinationPath)
    $temporaryPath = Join-Path $destinationDirectory ".$destinationName.arashi-install-$([System.Guid]::NewGuid().ToString('N')).tmp"
    try {
        Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath
        Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Install-ArashiPayloadTransaction {
    param(
        [Parameter(Mandatory = $true)][array]$Payload,
        [Parameter(Mandatory = $true)][string]$BinaryPath,
        [string]$CanonicalPath = $BinaryPath,
        [string]$AliasPath = $BinaryPath,
        [AllowNull()]$OwnershipLedgerItem = $null,
        [scriptblock]$SmokeTest = { param($native, $canonical, $alias) Invoke-ArashiSmokeTest -BinaryPath $native -CanonicalPath $canonical -AliasPath $alias },
        [scriptblock]$ReplaceAsset = { param($source, $destination) Install-ArashiStagedAsset -SourcePath $source -DestinationPath $destination },
        [scriptblock]$RestoreAsset = { param($backup, $destination) Install-ArashiStagedAsset -SourcePath $backup -DestinationPath $destination }
    )

    $backupDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "arashi-payload-backup-$([System.Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $records = @()

    try {
        $index = 0
        foreach ($item in @($Payload) + @($OwnershipLedgerItem | Where-Object { $null -ne $_ })) {
            $existed = Test-Path -LiteralPath $item.DestinationPath
            if ($existed) {
                $destinationItem = Get-Item -LiteralPath $item.DestinationPath -Force
                $isReparsePoint = ($destinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
                if ($destinationItem.PSIsContainer -or $isReparsePoint) {
                    throw "Managed destination $($item.DestinationPath) exists but is not a regular file. Move it aside and rerun the installer."
                }
            }
            $backupPath = Join-Path $backupDirectory "$index-$([System.IO.Path]::GetFileName($item.DestinationPath))"
            if ($existed) {
                Copy-Item -LiteralPath $item.DestinationPath -Destination $backupPath -Force
            }
            $records += [PSCustomObject]@{
                BackupPath = $backupPath
                DestinationPath = $item.DestinationPath
                Existed = $existed
            }
            $index++
        }
    } catch {
        Remove-Item -LiteralPath $backupDirectory -Recurse -Force -ErrorAction SilentlyContinue
        throw "Installation failed during backup before replacement began: $($_.Exception.Message)"
    }

    $phase = "replacement"
    try {
        foreach ($item in $Payload) {
            & $ReplaceAsset $item.SourcePath $item.DestinationPath
        }

        $phase = "smoke test"
        & $SmokeTest $BinaryPath $CanonicalPath $AliasPath
        if ($null -ne $OwnershipLedgerItem) {
            $phase = "ledger commit"
            & $ReplaceAsset $OwnershipLedgerItem.SourcePath $OwnershipLedgerItem.DestinationPath
        }
        Remove-Item -LiteralPath $backupDirectory -Recurse -Force
    } catch {
        $originalFailure = $_.Exception.Message
        $rollbackErrors = @()

        foreach ($record in $records) {
            try {
                if ($record.Existed) {
                    & $RestoreAsset $record.BackupPath $record.DestinationPath
                } elseif (Test-Path -LiteralPath $record.DestinationPath) {
                    Remove-Item -LiteralPath $record.DestinationPath -Force
                }
            } catch {
                $rollbackErrors += "$($record.DestinationPath): $($_.Exception.Message)"
            }
        }

        if ($rollbackErrors.Count -gt 0) {
            throw "Installation failed during $phase ($originalFailure). Rollback failed: $($rollbackErrors -join '; '). Recoverable backups retained at: $backupDirectory. Restore the matching files manually, remove managed files that were previously absent, then rerun the installer."
        }

        Remove-Item -LiteralPath $backupDirectory -Recurse -Force
        throw "Installation failed during $phase ($originalFailure). Rollback completed and restored the previous managed payload."
    }
}

function Add-ArashiUserPath {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrEmpty($currentUserPath)) {
        $entries = @()
    } else {
        $entries = $currentUserPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    $alreadyPresent = $entries | Where-Object { $_.TrimEnd("\") -ieq $Directory.TrimEnd("\") } | Select-Object -First 1
    if ($alreadyPresent) {
        Write-Step "$Directory is already on the user PATH"
        return [PSCustomObject]@{ Created = $false; Entry = $alreadyPresent.ToString(); Before = $currentUserPath; After = $currentUserPath }
    }

    $updatedPath = if ([string]::IsNullOrEmpty($currentUserPath)) { $Directory } else { "$currentUserPath;$Directory" }
    [Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")
    Write-Step "Added $Directory to the user PATH"

    try {
        $signature = @"
using System;
using System.Runtime.InteropServices;
public static class NativeMethods {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
"@
        Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue | Out-Null
        $result = [UIntPtr]::Zero
        [NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 0x2, 5000, [ref]$result) | Out-Null
    } catch {
        Write-WarningMessage "Could not broadcast the PATH update to running applications."
    }

    Write-Host "Open a new terminal, including a new Git Bash window, for the updated PATH to take effect."
    return [PSCustomObject]@{ Created = $true; Entry = $Directory; Before = $currentUserPath; After = $updatedPath }
}

function Resolve-ArashiPathMutation {
    param(
        [AllowNull()]$Existing,
        [Parameter(Mandatory = $true)]$Result
    )

    if ($null -eq $Existing -or (-not [bool]$Existing.created -and [bool]$Result.Created)) {
        return [ordered]@{ entry = $Result.Entry; created = [bool]$Result.Created }
    }
    return $Existing
}

function Test-ArashiExactUserPathEntry {
    param([Parameter(Mandatory = $true)][string]$Entry)

    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrEmpty($currentUserPath)) { return $false }
    return @($currentUserPath -split ';' | Where-Object { $_ -ceq $Entry }).Count -eq 1
}

function Invoke-ArashiSmokeTest {
    param(
        [Parameter(Mandatory = $true)][string]$BinaryPath,
        [string]$CanonicalPath = $BinaryPath,
        [string]$AliasPath = $BinaryPath
    )

    Write-Step "Running post-install smoke test"
    $outputs = @()
    foreach ($path in @($BinaryPath, $CanonicalPath, $AliasPath)) {
        $output = & $path --version 2>&1
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        if ($exitCode -ne 0) { throw "Smoke test failed: $path --version exited with $exitCode. Output: $output" }
        $version = ($output | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($version)) { throw "Smoke test succeeded but did not print an Arashi version: $path" }
        $outputs += $version
    }
    $canonicalVersion = $outputs[1]
    $aliasVersion = $outputs[2]
    if ($outputs[0] -cne $canonicalVersion -or $canonicalVersion -cne $aliasVersion) { throw "Smoke test failed: native, canonical, and alias version outputs differ." }
    Write-Step "Verified arashi and aw executables ($canonicalVersion)"
}

function Install-Arashi {
    $null = Test-ArashiSupportedWindowsPlatform
    Wait-ArashiParentProcess -ParentProcessId $env:ARASHI_WAIT_FOR_PID
    $selectedVersion = Normalize-ArashiVersion -InputVersion $Version
    $releaseBaseUrl = Get-ArashiReleaseBaseUrl -InputVersion $selectedVersion
    $targetInstallDir = Resolve-ArashiInstallDir -InputInstallDir $InstallDir
    $skipPathModification = Test-ArashiNoModifyPath -NoModifyPathFlag:$NoModifyPath
    $existingPathMutation = Assert-ArashiAliasOwnership -InstallDirectory $targetInstallDir
    if ($null -ne $existingPathMutation -and [bool]$existingPathMutation.created -and -not (Test-ArashiExactUserPathEntry -Entry $existingPathMutation.entry)) {
        $existingPathMutation = $null
    }

    Write-Step "Installing Arashi for Windows x64"
    Write-Step "Release: $selectedVersion"
    Write-Step "Install directory: $targetInstallDir"

    $stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "arashi-install-$([System.Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    $pathResult = $null
    $payloadCommitted = $false

    try {
        $assets = @($WindowsBinaryAsset, $BashWrapperAsset, $PowerShellWrapperAsset, $CmdWrapperAsset, $AliasBashWrapperAsset, $AliasPowerShellWrapperAsset, $AliasCmdWrapperAsset, $UninstallHelperAsset, $ChecksumManifestAsset)
        foreach ($asset in $assets) {
            Invoke-ArashiDownload -Url "$releaseBaseUrl/$asset" -Destination (Join-Path $stagingDir $asset) -Label $asset
        }

        $manifestPath = Join-Path $stagingDir $ChecksumManifestAsset
        foreach ($asset in @($WindowsBinaryAsset, $BashWrapperAsset, $PowerShellWrapperAsset, $CmdWrapperAsset, $AliasBashWrapperAsset, $AliasPowerShellWrapperAsset, $AliasCmdWrapperAsset, $UninstallHelperAsset)) {
            Assert-ArashiChecksum -ManifestPath $manifestPath -AssetPath (Join-Path $stagingDir $asset) -AssetName $asset
        }
        Write-Step "Verified SHA-256 checksums"

        New-Item -ItemType Directory -Path $targetInstallDir -Force | Out-Null
        $payload = @(
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $WindowsBinaryAsset; DestinationPath = Join-Path $targetInstallDir $InstalledBinaryName; RelativePath = $InstalledBinaryName; Role = "native-executable" },
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $BashWrapperAsset; DestinationPath = Join-Path $targetInstallDir $BashWrapperAsset; RelativePath = $BashWrapperAsset; Role = "canonical-wrapper" },
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $PowerShellWrapperAsset; DestinationPath = Join-Path $targetInstallDir $PowerShellWrapperAsset; RelativePath = $PowerShellWrapperAsset; Role = "canonical-powershell-wrapper" },
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $CmdWrapperAsset; DestinationPath = Join-Path $targetInstallDir $CmdWrapperAsset; RelativePath = $CmdWrapperAsset; Role = "canonical-cmd-wrapper" },
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $AliasBashWrapperAsset; DestinationPath = Join-Path $targetInstallDir $AliasBashWrapperAsset; RelativePath = $AliasBashWrapperAsset; Role = "alias-wrapper" },
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $AliasPowerShellWrapperAsset; DestinationPath = Join-Path $targetInstallDir $AliasPowerShellWrapperAsset; RelativePath = $AliasPowerShellWrapperAsset; Role = "alias-powershell-wrapper" },
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $AliasCmdWrapperAsset; DestinationPath = Join-Path $targetInstallDir $AliasCmdWrapperAsset; RelativePath = $AliasCmdWrapperAsset; Role = "alias-cmd-wrapper" },
            [PSCustomObject]@{ SourcePath = Join-Path $stagingDir $UninstallHelperAsset; DestinationPath = Join-Path $targetInstallDir $UninstallHelperAsset; RelativePath = $UninstallHelperAsset; Role = "uninstall-helper" }
        )
        $installedBinary = Join-Path $targetInstallDir $InstalledBinaryName
        $installedCanonical = Join-Path $targetInstallDir $CmdWrapperAsset
        $installedAlias = Join-Path $targetInstallDir $AliasCmdWrapperAsset
        $stagedVersionOutput = & (Join-Path $stagingDir $WindowsBinaryAsset) --version 2>&1
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($stagedVersionOutput | Out-String))) { throw "Staged Windows binary failed version verification." }
        $versionText = ($stagedVersionOutput | Out-String).Trim()
        $versionMatch = [regex]::Match($versionText, '(?<![0-9A-Za-z.-])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-])')
        if (-not $versionMatch.Success) { throw "Unable to determine the release version from: $versionText" }
        $releaseVersion = $versionMatch.Groups[1].Value
        if ($selectedVersion -ne "latest" -and $releaseVersion -cne $selectedVersion) { throw "Downloaded release version $releaseVersion does not match requested version $selectedVersion." }
        $stagedLedger = Join-Path $stagingDir $OwnershipLedgerName
        $pathMutation = $existingPathMutation
        if (-not $skipPathModification) {
            $pathResult = Add-ArashiUserPath -Directory $targetInstallDir
            $pathMutation = Resolve-ArashiPathMutation -Existing $existingPathMutation -Result $pathResult
        }
        Write-ArashiOwnershipLedger -Path $stagedLedger -InstallDirectory $targetInstallDir -Payload $payload -PathMutation $pathMutation
        $ledgerItem = [PSCustomObject]@{ SourcePath = $stagedLedger; DestinationPath = Join-Path $targetInstallDir $OwnershipLedgerName }
        Install-ArashiPayloadTransaction -Payload $payload -BinaryPath $installedBinary -CanonicalPath $installedCanonical -AliasPath $installedAlias -OwnershipLedgerItem $ledgerItem
        $payloadCommitted = $true
        Write-Step "Installed and verified Arashi files"

        if ($skipPathModification) {
            Write-WarningMessage "PATH modification disabled. Add this directory to your persistent user PATH, then open a new Git Bash window or other terminal: $targetInstallDir"
        }

        Write-Host ""
        Write-Host "Arashi installed successfully."
        Write-Host "Install directory: $targetInstallDir"
        Write-Host "Run 'aw --version' from a new terminal to verify PATH setup. The legacy-compatible 'arashi --version' command remains available."
    } catch {
        if (-not $payloadCommitted -and $null -ne $pathResult -and $pathResult.Created) {
            $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
            if ($currentUserPath -ceq $pathResult.After) {
                [Environment]::SetEnvironmentVariable("Path", $pathResult.Before, "User")
            } else {
                Write-WarningMessage "User PATH changed during failed installation; preserving it for manual inspection."
            }
        }
        Fail-Install $_.Exception.Message
    } finally {
        Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Arashi
