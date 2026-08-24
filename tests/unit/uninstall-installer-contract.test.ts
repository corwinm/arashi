import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dirname, "../..", path), "utf8");

describe("schema-v2 direct installer and release contracts", () => {
  test("POSIX installer downloads, verifies, installs, and records the bundled helper", () => {
    const installer = read("scripts/install.sh");
    expect(installer).toMatch(/LEDGER_SCHEMA_VERSION=2/);
    expect(installer).toContain('UNINSTALL_HELPER_ASSET="uninstall.sh"');
    expect(installer).toMatch(/installationChannel/);
    expect(installer).toMatch(/"platform": "posix"/);
    expect(installer).toMatch(/"role": "uninstall-helper"/);
    expect(installer).toMatch(/pathMutation/);
  });

  test("PowerShell installer records exact helper and user-PATH created provenance", () => {
    const installer = read("scripts/install.ps1");
    expect(installer).toMatch(/OwnershipLedgerSchemaVersion = 2/);
    expect(installer).toMatch(/UninstallHelperAsset = "uninstall\.ps1"/);
    expect(installer).toMatch(/installationChannel/);
    expect(installer).toMatch(/created/);
    expect(installer).toMatch(/uninstall-helper/);
  });

  test("distribution producer, archives, checksums, and npm package include helpers", () => {
    const policy = read("src/contracts/executable-distribution.ts");
    expect(policy).toMatch(/uninstall\.sh/);
    expect(policy).toMatch(/uninstall\.ps1/);
    const packager = read("scripts/package-releases.sh");
    expect(packager).toMatch(/scripts\/uninstall\.sh/);
    expect(packager).toMatch(/scripts\/uninstall\.ps1/);
    const checksums = read("scripts/generate-checksums.sh");
    expect(checksums).toMatch(/uninstall\.sh/);
    expect(checksums).toMatch(/uninstall\.ps1/);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.files).toEqual(
      expect.arrayContaining(["scripts/uninstall.sh", "scripts/uninstall.ps1"]),
    );
  });
});
