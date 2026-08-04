import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const scriptPath = join(import.meta.dirname, "../../scripts/install.ps1");
const script = readFileSync(scriptPath, "utf8");

function functionBody(name: string): string {
  const startMarker = `function ${name} {`;
  const start = script.indexOf(startMarker);
  expect(start, `expected function ${name} to exist`).toBeGreaterThanOrEqual(0);
  const nextFunction = script.indexOf("\nfunction ", start + startMarker.length);
  return nextFunction === -1 ? script.slice(start) : script.slice(start, nextFunction);
}

describe("Windows PowerShell installer", () => {
  test("documents the hosted one-line PowerShell install command", () => {
    expect(script).toContain('powershell -c "irm https://arashi.haphazard.dev/install.ps1 | iex"');
  });

  test("supports environment variables and parameters for version and install directory", () => {
    expect(script).toContain("[string]$Version = $env:ARASHI_VERSION");
    expect(script).toContain("[string]$InstallDir = $env:ARASHI_INSTALL_DIR");
    expect(script).toContain('ARASHI_NO_MODIFY_PATH -in @("1", "true", "TRUE", "yes", "YES")');
    expect(script).toContain("Wait-ArashiParentProcess -ParentProcessId $env:ARASHI_WAIT_FOR_PID");
  });

  test("constructs latest and pinned GitHub release asset URLs", () => {
    const body = functionBody("Get-ArashiReleaseBaseUrl");

    expect(body).toContain("releases/latest/download");
    expect(body).toContain("releases/download/v$normalizedVersion");
  });

  test("limits platform support to Windows x64", () => {
    const body = functionBody("Test-ArashiSupportedWindowsPlatform");

    expect(body).toContain("OSVersion.Platform -eq [System.PlatformID]::Win32NT");
    expect(body).toContain('@("X64", "x64", "Amd64", "AMD64")');
    expect(body).toContain("Windows x64 assets only");
  });

  test("downloads the Windows executable, wrappers, and checksum manifest", () => {
    expect(script).toContain('$WindowsBinaryAsset = "arashi-windows-x64.exe"');
    expect(script).toContain('$BashWrapperAsset = "arashi"');
    expect(script).toContain('$PowerShellWrapperAsset = "arashi.ps1"');
    expect(script).toContain('$CmdWrapperAsset = "arashi.bat"');
    expect(script).toContain('$ChecksumManifestAsset = "arashi-checksums.txt"');
    expect(script).toContain(
      "@($WindowsBinaryAsset, $BashWrapperAsset, $PowerShellWrapperAsset, $CmdWrapperAsset, $ChecksumManifestAsset)",
    );
  });

  test("parses and verifies SHA-256 manifest entries", () => {
    const parser = functionBody("Get-ArashiExpectedChecksum");
    const verifier = functionBody("Assert-ArashiChecksum");

    expect(parser).toContain(String.raw`^([A-Fa-f0-9]{64})\s+\*?(.+)$`);
    expect(parser).toContain("Checksum entry for $AssetName not found");
    expect(verifier).toContain("Get-FileHash -Algorithm SHA256");
    expect(verifier).toContain("Checksum validation failed for $AssetName");
  });

  test("uses the expected default install directory and installed filenames", () => {
    expect(script).toContain(String.raw`Join-Path $env:USERPROFILE ".arashi\bin"`);
    expect(script).toContain('$InstalledBinaryName = "arashi.bin.exe"');
    expect(script).toContain("DestinationPath = Join-Path $targetInstallDir $BashWrapperAsset");
    expect(script).toContain("DestinationPath = Join-Path $targetInstallDir $InstalledBinaryName");
    expect(script).toContain(
      "DestinationPath = Join-Path $targetInstallDir $PowerShellWrapperAsset",
    );
    expect(script).toContain("DestinationPath = Join-Path $targetInstallDir $CmdWrapperAsset");
  });

  test("updates user PATH by default while avoiding duplicates", () => {
    const body = functionBody("Add-ArashiUserPath");

    expect(body).toContain('[Environment]::GetEnvironmentVariable("Path", "User")');
    expect(body).toContain(String.raw`TrimEnd("\") -ieq $Directory.TrimEnd("\")`);
    expect(body).toContain('[Environment]::SetEnvironmentVariable("Path", $updatedPath, "User")');
    expect(body).toContain("new Git Bash window");
  });

  test("runs an installed binary version smoke test and prints fallback guidance on failures", () => {
    const body = functionBody("Invoke-ArashiSmokeTest");

    expect(body).toContain("& $BinaryPath --version");
    expect(script).toContain("Join-Path $targetInstallDir $InstalledBinaryName");
    expect(script).toContain(
      "Install-ArashiPayloadTransaction -Payload $payload -BinaryPath $installedBinary",
    );
    expect(body).toContain("Smoke test failed");
    expect(script).toContain(
      "Manual fallback: download $WindowsBinaryAsset, $PowerShellWrapperAsset, and $CmdWrapperAsset",
    );
  });

  test("backs up and replaces the exact four-file managed payload as one transaction", () => {
    const body = functionBody("Install-ArashiPayloadTransaction");

    expect(body).toContain("arashi-payload-backup-");
    expect(body).toContain("Test-Path -LiteralPath $item.DestinationPath");
    expect(body).toContain("Install-ArashiStagedAsset");
    expect(body).toContain("& $SmokeTest $BinaryPath");
    expect(body).toContain("Remove-Item -LiteralPath $backupDirectory -Recurse -Force");
  });

  test("uses a unique installer-owned staging path and cleans only that path", () => {
    const body = functionBody("Install-ArashiStagedAsset");

    expect(body).toContain("arashi-install-");
    expect(body).toContain("[System.Guid]::NewGuid()");
    expect(body).not.toContain('"$DestinationPath.tmp"');
    expect(body).toContain("Remove-Item -LiteralPath $temporaryPath");
  });

  test("rejects pre-existing non-file and reparse-point destinations before replacement", () => {
    const body = functionBody("Install-ArashiPayloadTransaction");

    expect(body).toContain("Get-Item -LiteralPath $item.DestinationPath -Force");
    expect(body).toContain("[System.IO.FileAttributes]::ReparsePoint");
    expect(body).toContain("is not a regular file");
  });

  test("restores exact prior state and retains backups when rollback fails", () => {
    const body = functionBody("Install-ArashiPayloadTransaction");

    expect(body).toContain("Remove-Item -LiteralPath $record.DestinationPath");
    expect(body).toContain("& $RestoreAsset $record.BackupPath $record.DestinationPath");
    expect(body).toContain("Rollback failed");
    expect(body).toContain("backups retained at:");
  });

  test("preserves no-PATH and deferred-update behavior with four-file replacement", () => {
    expect(script).toContain("Test-ArashiNoModifyPath -NoModifyPathFlag:$NoModifyPath");
    expect(script).toContain("Wait-ArashiParentProcess -ParentProcessId $env:ARASHI_WAIT_FOR_PID");
    expect(script).toContain("new Git Bash window");
  });
});
