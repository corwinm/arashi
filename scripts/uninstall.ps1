#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir = $env:ARASHI_INSTALL_DIR,
    [switch]$DryRun,
    [switch]$Yes,
    [string]$ParentPid,
    [switch]$TemporarySelf
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:USERPROFILE ".arashi\bin" }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$ManifestPath = Join-Path $InstallDir ".arashi-managed-entrypoints.json"

function Get-ProfileEncoding([byte[]]$Bytes) {
    if ($Bytes.Length -ge 4 -and $Bytes[0] -eq 0x00 -and $Bytes[1] -eq 0x00 -and $Bytes[2] -eq 0xFE -and $Bytes[3] -eq 0xFF) { return @((New-Object System.Text.UTF32Encoding($true, $false, $true)), 4) }
    if ($Bytes.Length -ge 4 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE -and $Bytes[2] -eq 0x00 -and $Bytes[3] -eq 0x00) { return @((New-Object System.Text.UTF32Encoding($false, $false, $true)), 4) }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { return @((New-Object System.Text.UTF8Encoding($false, $true)), 3) }
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) { return @((New-Object System.Text.UnicodeEncoding($true, $false, $true)), 2) }
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) { return @((New-Object System.Text.UnicodeEncoding($false, $false, $true)), 2) }
    return @((New-Object System.Text.UTF8Encoding($false, $true)), 0)
}

function Find-ByteSequence([byte[]]$Bytes, [byte[]]$Needle) {
    $matches = New-Object System.Collections.Generic.List[int]
    for ($offset = 0; $offset -le $Bytes.Length - $Needle.Length; $offset++) {
        $matched = $true
        for ($index = 0; $index -lt $Needle.Length; $index++) {
            if ($Bytes[$offset + $index] -ne $Needle[$index]) { $matched = $false; break }
        }
        if ($matched) { $matches.Add($offset) }
    }
    return @($matches)
}

function Test-BytesAt([byte[]]$Bytes, [int]$Offset, [byte[]]$Needle) {
    if ($Offset -lt 0 -or $Offset + $Needle.Length -gt $Bytes.Length) { return $false }
    for ($index = 0; $index -lt $Needle.Length; $index++) {
        if ($Bytes[$Offset + $index] -ne $Needle[$index]) { return $false }
    }
    return $true
}

function Get-CanonicalMarkerPlan([byte[]]$Bytes) {
    $encodingInfo = Get-ProfileEncoding $Bytes
    $encoding = $encodingInfo[0]
    $contentStart = [int]$encodingInfo[1]
    $beginBytes = $encoding.GetBytes("# >>> arashi shell integration >>>")
    $endBytes = $encoding.GetBytes("# <<< arashi shell integration <<<")
    $lfBytes = $encoding.GetBytes("`n")
    $crlfBytes = $encoding.GetBytes("`r`n")
    $rawBegins = @(Find-ByteSequence $Bytes $beginBytes)
    $rawEnds = @(Find-ByteSequence $Bytes $endBytes)
    $canonicalBegins = @($rawBegins | Where-Object {
        ($_ -eq $contentStart -or (Test-BytesAt $Bytes ($_ - $lfBytes.Length) $lfBytes)) -and
        ($_ + $beginBytes.Length -eq $Bytes.Length -or (Test-BytesAt $Bytes ($_ + $beginBytes.Length) $lfBytes) -or (Test-BytesAt $Bytes ($_ + $beginBytes.Length) $crlfBytes))
    })
    $canonicalEnds = @($rawEnds | Where-Object {
        ($_ -eq $contentStart -or (Test-BytesAt $Bytes ($_ - $lfBytes.Length) $lfBytes)) -and
        ($_ + $endBytes.Length -eq $Bytes.Length -or (Test-BytesAt $Bytes ($_ + $endBytes.Length) $lfBytes) -or (Test-BytesAt $Bytes ($_ + $endBytes.Length) $crlfBytes))
    })
    if ($rawBegins.Count -eq 0 -and $rawEnds.Count -eq 0) { return $null }
    if ($rawBegins.Count -ne 1 -or $rawEnds.Count -ne 1 -or $canonicalBegins.Count -ne 1 -or $canonicalEnds.Count -ne 1 -or $canonicalBegins[0] -ge $canonicalEnds[0]) {
        throw "Ambiguous Arashi shell integration markers; only a complete canonical marker line can be removed."
    }
    $blockEnd = $canonicalEnds[0] + $endBytes.Length
    $after = New-Object byte[] ($Bytes.Length - ($blockEnd - $canonicalBegins[0]))
    [System.Array]::Copy($Bytes, 0, $after, 0, $canonicalBegins[0])
    [System.Array]::Copy($Bytes, $blockEnd, $after, $canonicalBegins[0], $Bytes.Length - $blockEnd)
    return [PSCustomObject]@{ Start = $canonicalBegins[0]; End = $blockEnd; After = $after }
}

try {
    if (-not [string]::IsNullOrWhiteSpace($ParentPid)) {
        $parsed = 0
        if (-not [int]::TryParse($ParentPid, [ref]$parsed) -or $parsed -le 0) { throw "Invalid parent PID." }
        try {
            Wait-Process -Id $parsed -Timeout 120 -ErrorAction Stop
        } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
            if (Get-Process -Id $parsed -ErrorAction SilentlyContinue) { throw "Timed out waiting for parent process $parsed." }
        }
    }
    $installItem = Get-Item -LiteralPath $InstallDir -Force -ErrorAction Stop
    if (-not $installItem.PSIsContainer -or ($installItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Install directory is not a non-reparse directory." }
    $manifestItem = Get-Item -LiteralPath $ManifestPath -Force -ErrorAction Stop
    if ($manifestItem.PSIsContainer -or ($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Ownership manifest is not a regular non-reparse file." }
    $manifestBytes = [System.IO.File]::ReadAllBytes($ManifestPath)
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $manifestProperties = @($manifest.PSObject.Properties.Name | Sort-Object)
    if (($manifestProperties -join ',') -cnotin @('files,installationChannel,installDirectory,platform,schemaVersion', 'files,installationChannel,installDirectory,pathMutation,platform,schemaVersion')) { throw "Manifest property set is not closed." }
    if ($manifest.schemaVersion -isnot [int] -or $manifest.schemaVersion -ne 2 -or $manifest.installationChannel -isnot [string] -or $manifest.installationChannel -cne "official-direct" -or $manifest.platform -isnot [string] -or $manifest.platform -cne "windows" -or $manifest.installDirectory -isnot [string]) { throw "Unsupported manifest; refresh this direct install first." }
    if ([System.IO.Path]::GetFullPath($manifest.installDirectory) -cne $InstallDir) { throw "Manifest installDirectory mismatch." }
    $expected = @(
        @("arashi.bin.exe", "native-executable"), @("arashi", "canonical-wrapper"),
        @("arashi.ps1", "canonical-powershell-wrapper"), @("arashi.bat", "canonical-cmd-wrapper"),
        @("aw", "alias-wrapper"), @("aw.ps1", "alias-powershell-wrapper"),
        @("aw.bat", "alias-cmd-wrapper"), @("uninstall.ps1", "uninstall-helper")
    )
    if (@($manifest.files).Count -ne $expected.Count) { throw "Manifest payload mismatch." }
    $removable = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $expected.Count; $index++) {
        $record = @($manifest.files)[$index]
        $properties = @($record.PSObject.Properties.Name | Sort-Object)
        if (($properties -join ',') -cne 'digest,relativePath,role' -or $record.relativePath -isnot [string] -or $record.role -isnot [string] -or $record.digest -isnot [string] -or $record.relativePath -cne $expected[$index][0] -or $record.role -cne $expected[$index][1] -or $record.digest -cnotmatch '^[a-f0-9]{64}$') { throw "Invalid payload record $index." }
        $path = [System.IO.Path]::GetFullPath((Join-Path $InstallDir $record.relativePath))
        if ((Split-Path -Parent $path) -cne $InstallDir) { throw "Escaping payload path." }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($null -eq $item) { continue }
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "$($record.relativePath) is not a regular non-reparse file." }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -cne $record.digest) { throw "$($record.relativePath) digest mismatch." }
        $removable.Add($path)
    }
    $pathEntryToRemove = $null
    if ($manifestProperties -contains 'pathMutation') {
        $pathProperties = @($manifest.pathMutation.PSObject.Properties.Name | Sort-Object)
        if (($pathProperties -join ',') -cne 'created,entry' -or $manifest.pathMutation.created -isnot [bool] -or $manifest.pathMutation.entry -isnot [string] -or [string]::IsNullOrEmpty($manifest.pathMutation.entry)) { throw "Invalid user PATH provenance." }
        if ($manifest.pathMutation.created) {
            $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
            $userPathEntries = if ([string]::IsNullOrEmpty($userPath)) { @() } else { @($userPath -split ';') }
            $matches = @($userPathEntries | Where-Object { $_ -ceq $manifest.pathMutation.entry })
            if ($matches.Count -eq 1) { $pathEntryToRemove = $manifest.pathMutation.entry }
            elseif ($matches.Count -gt 1) { Write-Warning "Created user PATH entry is ambiguous and will be preserved." }
        }
        # created: false is deliberately preserved.
    }
    $shellPlans = @()
    $shellHome = if (-not [string]::IsNullOrWhiteSpace($env:HOME)) { $env:HOME } else { $env:USERPROFILE }
    if (-not [string]::IsNullOrWhiteSpace($shellHome)) {
        $shellCandidates = @(
            (Join-Path $shellHome ".zshrc"),
            (Join-Path $shellHome ".config\fish\config.fish"),
            (Join-Path $shellHome ".bashrc"),
            (Join-Path $shellHome ".bash_profile"),
            (Join-Path $shellHome ".profile")
        ) | Select-Object -Unique
        foreach ($shellTarget in $shellCandidates) {
            $shellItem = Get-Item -LiteralPath $shellTarget -Force -ErrorAction SilentlyContinue
            if ($null -eq $shellItem) { continue }
            if ($shellItem.PSIsContainer -or ($shellItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                Write-Warning "Preserving unsafe shell startup target: $shellTarget"
                continue
            }
            $shellBytes = [System.IO.File]::ReadAllBytes($shellTarget)
            try { $markerPlan = Get-CanonicalMarkerPlan $shellBytes } catch { throw "$($_.Exception.Message) Target: $shellTarget" }
            if ($null -ne $markerPlan) { $shellPlans += [PSCustomObject]@{ Path = $shellTarget; Before = $shellBytes; After = $markerPlan.After } }
        }
    }
    Write-Host "Installation channel: official-direct"
    foreach ($path in $removable) { Write-Host "- remove: $path" }
    foreach ($shellPlan in $shellPlans) { Write-Host "- remove exact managed shell block: $($shellPlan.Path)" }
    Write-Host "Preserved: projects, Git data, unrelated user state, and install-directory neighbors."
    if ($DryRun) { exit 0 }
    if (-not $Yes) {
        if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw "Non-interactive uninstall requires -Yes." }
        if ((Read-Host "Remove this proven Arashi installation? [y/N]") -notmatch '^(?i:y|yes)$') { Write-Host "Uninstall declined."; exit 0 }
    }
    $currentInstallItem = Get-Item -LiteralPath $InstallDir -Force -ErrorAction Stop
    if (-not $currentInstallItem.PSIsContainer -or ($currentInstallItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Install directory changed after preflight." }
    $currentManifestItem = Get-Item -LiteralPath $ManifestPath -Force -ErrorAction Stop
    if ($currentManifestItem.PSIsContainer -or ($currentManifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "Ownership manifest changed after preflight." }
    $currentManifestBytes = [System.IO.File]::ReadAllBytes($ManifestPath)
    if ([Convert]::ToBase64String($currentManifestBytes) -cne [Convert]::ToBase64String($manifestBytes)) { throw "Ownership manifest changed after preflight." }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        $record = @($manifest.files)[$index]
        $path = [System.IO.Path]::GetFullPath((Join-Path $InstallDir $record.relativePath))
        if ($removable -notcontains $path) { continue }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw "$($record.relativePath) changed after preflight." }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -cne $record.digest) { throw "$($record.relativePath) changed after preflight." }
    }
    foreach ($shellPlan in $shellPlans) {
        $currentShellBytes = [System.IO.File]::ReadAllBytes($shellPlan.Path)
        if ([Convert]::ToBase64String($currentShellBytes) -cne [Convert]::ToBase64String($shellPlan.Before)) { throw "Shell startup file changed after preflight." }
        $shellTemporary = "$($shellPlan.Path).arashi-uninstall-$([System.Guid]::NewGuid().ToString('N')).tmp"
        try {
            [System.IO.File]::WriteAllBytes($shellTemporary, $shellPlan.After)
            Move-Item -LiteralPath $shellTemporary -Destination $shellPlan.Path -Force
        } finally { Remove-Item -LiteralPath $shellTemporary -Force -ErrorAction SilentlyContinue }
    }
    if ($null -ne $pathEntryToRemove) {
        $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $entriesBeforeRemoval = if ([string]::IsNullOrEmpty($currentUserPath)) { @() } else { @($currentUserPath -split ';') }
        $currentMatches = @($entriesBeforeRemoval | Where-Object { $_ -ceq $pathEntryToRemove })
        if ($currentMatches.Count -ne 1) { throw "Created user PATH entry changed after preflight." }
        $removed = $false
        $entries = @($entriesBeforeRemoval | Where-Object {
            if (-not $removed -and $_ -ceq $pathEntryToRemove) { $removed = $true; return $false }
            return $true
        })
        [Environment]::SetEnvironmentVariable("Path", ($entries -join ';'), "User")
    }
    foreach ($path in $removable) { Remove-Item -LiteralPath $path -Force }
    Remove-Item -LiteralPath $ManifestPath -Force
} catch {
    [Console]::Error.WriteLine("error: $($_.Exception.Message)")
    exit 1
} finally {
    if ($TemporarySelf) {
        $self = $MyInvocation.MyCommand.Path
        $selfDirectory = Split-Path -Parent $self
        if ([System.IO.Path]::GetFileName($selfDirectory) -like "arashi-uninstall-*" -and [System.IO.Path]::GetFileName($self) -ceq "uninstall.ps1") {
            Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command',"Start-Sleep -Milliseconds 100; Remove-Item -LiteralPath '$($self.Replace("'", "''"))' -Force; Remove-Item -LiteralPath '$($selfDirectory.Replace("'", "''"))' -Force -ErrorAction SilentlyContinue")
        }
    }
}
