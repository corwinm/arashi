import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const helper = readFileSync(join(import.meta.dirname, "../../scripts/uninstall.ps1"), "utf8");

describe("bundled PowerShell uninstall helper contract", () => {
  test("supports explicit/default directory, dry-run, consent, parent wait, and temporary self cleanup", () => {
    expect(helper).toMatch(/\[string\]\$InstallDir/);
    expect(helper).toMatch(/\[switch\]\$DryRun/);
    expect(helper).toMatch(/\[switch\]\$Yes/);
    expect(helper).toMatch(/\$ParentPid/);
    expect(helper).toMatch(/Wait-Process/);
    expect(helper).toMatch(
      /Get-Process[^\n]+\$parsed[^\n]+throw "Timed out waiting for parent process/,
    );
    expect(helper).toMatch(/\$TemporarySelf/);
    expect(helper).toMatch(/arashi-uninstall-/);
    expect(helper).toMatch(/GetFileName\(\$selfDirectory\)/);
  });

  test("locally validates v2 ownership, digests and reparse points and preserves created:false PATH", () => {
    expect(helper).toContain(".arashi-managed-entrypoints.json");
    expect(helper).toMatch(/schemaVersion/);
    expect(helper).toContain("files,installationChannel,installDirectory,platform,schemaVersion");
    expect(helper).toContain("$manifestProperties -contains 'pathMutation'");
    expect(helper).toMatch(/official-direct/);
    expect(helper).toMatch(/Get-FileHash/);
    expect(helper).toMatch(/ReparsePoint/);
    expect(helper).toMatch(/created/);
    expect(helper).toMatch(/User/);
    expect(helper).toMatch(/pathMutation\.entry -isnot \[string\]/);
    expect(helper).toMatch(/IsNullOrEmpty\(\$manifest\.pathMutation\.entry\)/);
  });

  test("revalidates payload ownership after consent immediately before deletion", () => {
    const consentOffset = helper.indexOf(
      'Read-Host "Remove this proven Arashi installation? [y/N]"',
    );
    const deletionOffset = helper.indexOf(
      "foreach ($path in $removable) { Remove-Item",
      consentOffset,
    );
    const postConsent = helper.slice(consentOffset, deletionOffset);

    expect(consentOffset).toBeGreaterThan(-1);
    expect(deletionOffset).toBeGreaterThan(consentOffset);
    expect(postConsent).toMatch(/Get-Item -LiteralPath \$InstallDir/);
    expect(postConsent).toMatch(/ReadAllBytes\(\$ManifestPath\)/);
    expect(postConsent).toMatch(/Get-FileHash -Algorithm SHA256/);
  });

  test("matches only canonical marker lines and preserves shell-profile bytes and encoding", () => {
    expect(helper).toMatch(/ReadAllBytes/);
    expect(helper).toMatch(/WriteAllBytes/);
    expect(helper).toMatch(/ToBase64String/);
    expect(helper).toMatch(/UnicodeEncoding/);
    expect(helper).toMatch(/0xFF/);
    expect(helper).not.toMatch(/ReadAllText\(\$shellTarget\)/);
    expect(helper).not.toMatch(/WriteAllText\(\$shellTemporary/);
    expect(helper).toMatch(/canonical marker line/i);
  });

  test("preserves and reports unsafe shell startup candidates instead of blocking payload removal", () => {
    expect(helper).toContain(
      'Write-Warning "Preserving unsafe shell startup target: $shellTarget"',
    );
    expect(helper).not.toContain(
      'throw "Shell startup target is not a regular non-reparse file: $shellTarget"',
    );
  });
});
