import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const root = join(import.meta.dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const acceptance = readFileSync(
  join(root, "tests/windows/default-installer-acceptance.ps1"),
  "utf8",
);
const transaction = readFileSync(join(root, "tests/windows/install-transaction.ps1"), "utf8");

describe("Windows installer acceptance wiring", () => {
  test("runs transaction and canonical default-installer fixtures on windows-latest", () => {
    expect(workflow).toContain("windows-installer-acceptance:");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("tests/windows/install-transaction.ps1");
    expect(workflow).toContain("tests/windows/default-installer-acceptance.ps1");
    expect(workflow.match(/shell: powershell/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("intercepts only Invoke-WebRequest while invoking canonical install.ps1 with defaults", () => {
    expect(acceptance).toContain("function global:Invoke-WebRequest");
    expect(acceptance).toContain("& $InstallerPath");
    expect(acceptance).not.toContain("-InstallDir");
    expect(acceptance).not.toContain("-NoModifyPath");
    expect(acceptance).not.toContain("ARASHI_INSTALL_DIR");
    expect(acceptance).not.toContain("ARASHI_NO_MODIFY_PATH");
  });

  test("isolates USERPROFILE and unconditionally restores persistent PATH", () => {
    expect(acceptance).toContain(
      '$originalUserPath = [Environment]::GetEnvironmentVariable("Path", "User")',
    );
    expect(acceptance).toContain("$env:USERPROFILE = $temporaryUserProfile");
    expect(acceptance).toContain("finally {");
    expect(acceptance).toContain(
      '[Environment]::SetEnvironmentVariable("Path", $originalUserPath, "User")',
    );
    expect(acceptance).toContain("Remove-Item -LiteralPath $temporaryUserProfile");
    expect(acceptance).toContain("$cleanupErrors");
    expect(acceptance).toContain("Failed to remove temporary user profile");
    expect(acceptance).toContain("Failed to remove release fixture directory");
  });

  test("reconstructs persisted PATH and launches fresh Git Bash, PowerShell, and Cmd processes", () => {
    expect(acceptance).toContain('[Environment]::GetEnvironmentVariable("Path", "Machine")');
    expect(acceptance).toContain('[Environment]::GetEnvironmentVariable("Path", "User")');
    expect(acceptance).toContain("bash.exe");
    expect(acceptance).toContain("powershell.exe");
    expect(acceptance).toContain("cmd.exe");
    expect(acceptance).toContain("arashi --version");
    expect(acceptance).toContain("arashi.ps1");
    expect(acceptance).toContain("arashi.bat");
    expect(acceptance).toContain("command -v arashi");
    expect(acceptance).toContain("Get-Command arashi.ps1");
    expect(acceptance).toContain("where arashi.bat");
    expect(acceptance).toContain("ExpectedOutput");
    expect(acceptance).toContain("did not execute the fixture binary");
    expect(acceptance).not.toContain("ProcessStartInfo");
  });

  test("covers fresh, partial, replacement, smoke, and rollback failure transaction states", () => {
    for (const scenario of [
      "fresh installation",
      "partial pre-existing payload",
      "non-file destination",
      "pre-existing temporary neighbor",
      "replacement failure",
      "smoke-test failure",
      "rollback failure",
    ]) {
      expect(transaction).toContain(scenario);
    }
  });
});
