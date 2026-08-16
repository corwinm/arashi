import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const installer = readFileSync(join(root, "scripts/install.ps1"), "utf8");
const transaction = readFileSync(join(root, "tests/windows/install-transaction.ps1"), "utf8");
const acceptance = readFileSync(
  join(root, "tests/windows/default-installer-acceptance.ps1"),
  "utf8",
);

describe("Windows seven-file alias transaction", () => {
  test("downloads, verifies, and maps the exact canonical-plus-alias payload", () => {
    for (const declaration of [
      '$AliasBashWrapperAsset = "aw"',
      '$AliasPowerShellWrapperAsset = "aw.ps1"',
      '$AliasCmdWrapperAsset = "aw.bat"',
      '$OwnershipLedgerName = ".arashi-managed-entrypoints.json"',
    ]) {
      expect(installer).toContain(declaration);
    }
    for (const installed of [
      "arashi.bin.exe",
      "arashi",
      "arashi.ps1",
      "arashi.bat",
      "aw",
      "aw.ps1",
      "aw.bat",
    ]) {
      expect(installer).toContain(installed);
    }
    expect(installer).toContain("Assert-ArashiAliasOwnership");
    expect(installer).toContain("Write-ArashiOwnershipLedger");
  });

  test("preflights marker-plus-ledger ownership and all ambiguous collision classes before download", () => {
    const preflight = installer.indexOf("Assert-ArashiAliasOwnership");
    const download = installer.indexOf(
      "Invoke-ArashiDownload",
      installer.indexOf("function Install-Arashi"),
    );
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(download);
    for (const evidence of [
      "schemaVersion",
      "installDirectory",
      "Get-FileHash",
      "arashi-managed-alias",
      "ReparsePoint",
      "Get-Command aw",
      "'aw.com', 'aw.exe', 'aw.bat', 'aw.cmd'",
      "Test-Path -LiteralPath $candidate -PathType Leaf",
      "bash.exe",
      "move or remove",
    ]) {
      expect(installer).toContain(evidence);
    }
  });

  test("transaction covers ledger backup, dual smoke equality, commit rollback, and retained recovery", () => {
    for (const evidence of [
      "ledger commit",
      "OwnershipLedgerItem",
      "AliasPath",
      "Rollback failed",
      "backups retained",
      "arashi-payload-backup-",
    ]) {
      expect(installer).toContain(evidence);
    }
    expect(installer).toMatch(/CanonicalPath[\s\S]*AliasPath/);
    expect(installer).toMatch(/canonicalVersion[\s\S]*aliasVersion/);
    expect(installer).toContain("-cne");
  });

  test("native PowerShell 5.1 fixture enumerates ownership and failure scenarios", () => {
    for (const scenario of [
      "fresh installation",
      "pre-alias upgrade",
      "managed alias upgrade",
      "manual marked alias collision",
      "unmarked alias collision",
      "malformed ledger collision",
      "directory alias collision",
      "reparse-point alias collision",
      "PATH-resolved PowerShell collision",
      "PATH-resolved CMD collision",
      "PATH-resolved Git Bash collision",
      "replacement failure",
      "canonical smoke-test failure",
      "alias smoke-test failure",
      "ledger-commit failure",
      "rollback failure",
      "deferred update",
      "complete cleanup",
    ]) {
      expect(transaction).toContain(scenario);
    }
  });

  test("default installer fixture validates both exact commands in three fresh shells and restores all state", () => {
    for (const evidence of [
      "arashi --version",
      "aw --version",
      "Get-Command arashi.ps1",
      "Get-Command aw.ps1",
      "where arashi.bat",
      "where aw.bat",
      "command -v arashi",
      "command -v aw",
      ".arashi-managed-entrypoints.json",
      ".bashrc",
      ".bash_profile",
      ".profile",
      "finally {",
      "originalUserPath",
    ]) {
      expect(acceptance).toContain(evidence);
    }
  });
});
