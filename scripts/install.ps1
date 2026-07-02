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
$PowerShellWrapperAsset = "arashi.ps1"
$CmdWrapperAsset = "arashi.bat"
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
    Write-Error $Message
    Write-Error "Manual fallback: download $WindowsBinaryAsset, $PowerShellWrapperAsset, and $CmdWrapperAsset from $ReleaseFallbackUrl into one directory on PATH."
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

function Install-ArashiStagedAsset {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $temporaryPath = "$DestinationPath.tmp"
    Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath -Force
    Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
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
        return
    }

    $updatedPath = (@($entries) + $Directory) -join ";"
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

    Write-Host "Open a new terminal for the updated PATH to take effect."
}

function Invoke-ArashiSmokeTest {
    param([Parameter(Mandatory = $true)][string]$BinaryPath)

    Write-Step "Running post-install smoke test"
    $output = & $BinaryPath --version 2>&1
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        $exitCode = 0
    }
    if ($exitCode -ne 0) {
        Fail-Install "Smoke test failed: $BinaryPath --version exited with $exitCode. Output: $output"
    }
    if ([string]::IsNullOrWhiteSpace(($output | Out-String))) {
        Fail-Install "Smoke test succeeded but did not print an Arashi version."
    }

    Write-Step "Verified arashi executable ($($output | Select-Object -First 1))"
}

function Install-Arashi {
    $null = Test-ArashiSupportedWindowsPlatform
    $selectedVersion = Normalize-ArashiVersion -InputVersion $Version
    $releaseBaseUrl = Get-ArashiReleaseBaseUrl -InputVersion $selectedVersion
    $targetInstallDir = Resolve-ArashiInstallDir -InputInstallDir $InstallDir
    $skipPathModification = Test-ArashiNoModifyPath -NoModifyPathFlag:$NoModifyPath

    Write-Step "Installing Arashi for Windows x64"
    Write-Step "Release: $selectedVersion"
    Write-Step "Install directory: $targetInstallDir"

    $stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "arashi-install-$([System.Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

    try {
        $assets = @($WindowsBinaryAsset, $PowerShellWrapperAsset, $CmdWrapperAsset, $ChecksumManifestAsset)
        foreach ($asset in $assets) {
            Invoke-ArashiDownload -Url "$releaseBaseUrl/$asset" -Destination (Join-Path $stagingDir $asset) -Label $asset
        }

        $manifestPath = Join-Path $stagingDir $ChecksumManifestAsset
        foreach ($asset in @($WindowsBinaryAsset, $PowerShellWrapperAsset, $CmdWrapperAsset)) {
            Assert-ArashiChecksum -ManifestPath $manifestPath -AssetPath (Join-Path $stagingDir $asset) -AssetName $asset
        }
        Write-Step "Verified SHA-256 checksums"

        New-Item -ItemType Directory -Path $targetInstallDir -Force | Out-Null
        Install-ArashiStagedAsset -SourcePath (Join-Path $stagingDir $WindowsBinaryAsset) -DestinationPath (Join-Path $targetInstallDir $InstalledBinaryName)
        Install-ArashiStagedAsset -SourcePath (Join-Path $stagingDir $PowerShellWrapperAsset) -DestinationPath (Join-Path $targetInstallDir $PowerShellWrapperAsset)
        Install-ArashiStagedAsset -SourcePath (Join-Path $stagingDir $CmdWrapperAsset) -DestinationPath (Join-Path $targetInstallDir $CmdWrapperAsset)
        Write-Step "Installed Arashi files"

        $installedBinary = Join-Path $targetInstallDir $InstalledBinaryName
        Invoke-ArashiSmokeTest -BinaryPath $installedBinary

        if ($skipPathModification) {
            Write-WarningMessage "PATH modification disabled. Add this directory to your user PATH: $targetInstallDir"
        } else {
            Add-ArashiUserPath -Directory $targetInstallDir
        }

        Write-Host ""
        Write-Host "Arashi installed successfully."
        Write-Host "Install directory: $targetInstallDir"
        Write-Host "Run 'arashi --version' from a new terminal to verify PATH setup."
    } finally {
        Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Arashi
