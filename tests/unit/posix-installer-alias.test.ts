import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const script = readFileSync(join(root, "scripts/install.sh"), "utf8");
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

function source(command: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    ["-c", `ARASHI_INSTALLER_SOURCE_ONLY=1 source scripts/install.sh; ${command}`],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

describe("POSIX alias installer contract", () => {
  test("declares marked alias, ledger, checksum, and three-file transaction", () => {
    expect(script).toContain('ALIAS_ASSET="aw"');
    expect(script).toContain('LEDGER_NAME=".arashi-managed-entrypoints.json"');
    expect(script).toContain("arashi-managed-alias");
    expect(script).toContain('expected_checksum_for_asset "$downloaded_manifest" "$ALIAS_ASSET"');
    expect(script).toContain("install_posix_payload_transaction");
    expect(script).toContain("write_ownership_ledger");
    expect(script).toContain("verify_installed_entrypoints");
  });

  test.each(["regular", "directory", "symlink", "manual", "malformed-ledger", "mismatched-ledger"])(
    "fails closed for %s alias ownership before downloads or target-directory creation",
    (kind) => {
      const fixture = mkdtempSync(join(tmpdir(), `arashi-aw-${kind}-`));
      fixtures.push(fixture);
      const target = join(fixture, "missing", "aw");
      if (kind !== "malformed-ledger" && kind !== "mismatched-ledger") {
        mkdirSync(join(fixture, "missing"));
      }
      if (kind === "directory") {
        mkdirSync(target);
      } else if (kind === "symlink") {
        symlinkSync(join(fixture, "elsewhere"), target);
      } else if (kind === "regular") {
        writeFileSync(target, "unrelated\n");
      } else if (kind === "manual") {
        writeFileSync(target, "# arashi-managed-alias\n");
      } else {
        mkdirSync(join(fixture, "missing"));
        writeFileSync(
          join(fixture, "missing", ".arashi-managed-entrypoints.json"),
          kind === "malformed-ledger"
            ? "{"
            : JSON.stringify({ aliases: [], installDirectory: "/wrong", schemaVersion: 1 }),
        );
      }
      const result = source(
        `preflight_alias_ownership ${JSON.stringify(join(fixture, "missing"))}`,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/collision|ledger|move|remove/i);
    },
  );

  test("detects PATH-resolved aw outside the target without executing it", () => {
    const fixture = mkdtempSync(join(tmpdir(), "arashi-aw-path-"));
    fixtures.push(fixture);
    const pathBin = join(fixture, "path");
    mkdirSync(pathBin);
    const sentinel = join(fixture, "executed");
    writeFileSync(join(pathBin, "aw"), `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`);
    chmodSync(join(pathBin, "aw"), 0o755);
    const result = source(`preflight_alias_ownership ${JSON.stringify(join(fixture, "target"))}`, {
      PATH: `${pathBin}:${process.env.PATH ?? ""}`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(join(pathBin, "aw"));
    expect(() => readFileSync(sentinel)).toThrow();
  });

  test.each(["extra top-level property", "extra alias property", "extra alias entry"])(
    "rejects a structurally valid ledger with %s",
    (kind) => {
      const fixture = mkdtempSync(join(tmpdir(), "arashi-aw-ledger-shape-"));
      fixtures.push(fixture);
      const aliasPath = join(fixture, "aw");
      const aliasContents = "# arashi-managed-alias:aw:v1\n";
      writeFileSync(aliasPath, aliasContents);
      const hash = spawnSync("shasum", ["-a", "256", aliasPath], { encoding: "utf8" })
        .stdout.split(" ")[0]
        ?.trim();
      const alias: Record<string, string | undefined> = { path: aliasPath, sha256: hash };
      const ledger: Record<string, unknown> = {
        aliases: [alias],
        installDirectory: fixture,
        releaseVersion: "1.31.0",
        schemaVersion: 1,
      };
      if (kind === "extra top-level property") ledger.owner = "arashi";
      if (kind === "extra alias property") alias.owner = "arashi";
      if (kind === "extra alias entry") {
        ledger.aliases = [alias, { path: join(fixture, "other"), sha256: "0".repeat(64) }];
      }
      writeFileSync(
        join(fixture, ".arashi-managed-entrypoints.json"),
        `${JSON.stringify(ledger, null, 2)}\n`,
      );

      const result = source(`preflight_alias_ownership ${JSON.stringify(fixture)}`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/ledger|alias-set|move|remove/i);
    },
  );

  test("transaction source encodes backup, replacement, dual smoke, ledger commit, and complete rollback phases", () => {
    for (const evidence of [
      "arashi-payload-backup.",
      "replacement",
      "smoke test",
      "ledger commit",
      "Rollback failed",
      "backups retained",
      ".arashi-install.XXXXXX",
    ]) {
      expect(script).toContain(evidence);
    }
    expect(script).toContain('capture_entrypoint_version "$canonical_path" canonical_version');
    expect(script).toContain('capture_entrypoint_version "$alias_path" alias_version');
    expect(script).toContain("ACTIVE_TRANSACTION_CHILD=$!");
    expect(script).toContain("trap 'interrupt_transaction INT 130' INT");
    expect(script).toContain('kill -TERM "$ACTIVE_TRANSACTION_CHILD"');
    expect(script).toContain('kill -KILL "$ACTIVE_TRANSACTION_CHILD"');
    expect(script).toContain('"$canonical_version" != "$alias_version"');
    const stagedCleanup = script.lastIndexOf('rm -f "$staged_ledger"');
    const backupCleanup = script.indexOf('rm -rf "$backup_directory"', stagedCleanup);
    const committed = script.indexOf("transaction_committed=1", backupCleanup);
    const disarmed = script.indexOf("trap - EXIT ERR HUP INT TERM", committed);
    expect(stagedCleanup).toBeGreaterThan(-1);
    expect(backupCleanup).toBeGreaterThan(stagedCleanup);
    expect(committed).toBeGreaterThan(backupCleanup);
    expect(disarmed).toBeGreaterThan(committed);
  });

  test("commits a three-file payload and versioned path/hash ownership ledger", () => {
    const fixture = mkdtempSync(join(tmpdir(), "arashi-aw-transaction-"));
    fixtures.push(fixture);
    const staging = join(fixture, "staging");
    const install = join(fixture, "install");
    mkdirSync(staging);
    writeFileSync(join(staging, "arashi.bin"), "#!/bin/sh\necho 1.31.0\n");
    writeFileSync(join(staging, "arashi"), '#!/bin/sh\nexec "$(dirname "$0")/arashi.bin" "$@"\n');
    writeFileSync(
      join(staging, "aw"),
      '#!/bin/sh\n# arashi-managed-alias:aw:v1\nexec "$(dirname "$0")/arashi.bin" "$@"\n',
    );
    for (const name of ["arashi.bin", "arashi", "aw"]) {
      chmodSync(join(staging, name), 0o755);
    }
    const result = source(
      `install_posix_payload_transaction ${JSON.stringify(install)} ${JSON.stringify(join(staging, "arashi.bin"))} ${JSON.stringify(join(staging, "arashi"))} ${JSON.stringify(join(staging, "aw"))} 1.31.0`,
      { PATH: process.env.PATH },
    );
    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(
      readFileSync(join(install, ".arashi-managed-entrypoints.json"), "utf8"),
    );
    expect(ledger).toMatchObject({
      aliases: [{ path: join(install, "aw"), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      installDirectory: install,
      releaseVersion: "1.31.0",
      schemaVersion: 1,
    });
    expect(statSync(join(install, ".arashi-managed-entrypoints.json")).mode & 0o111).toBe(0);
  });

  test("restores the complete previous payload and ledger after alias smoke failure", () => {
    const fixture = mkdtempSync(join(tmpdir(), "arashi-aw-rollback-"));
    fixtures.push(fixture);
    const staging = join(fixture, "staging");
    const install = join(fixture, "install");
    mkdirSync(staging);
    mkdirSync(install);
    for (const name of ["arashi.bin", "arashi", "aw"]) {
      writeFileSync(join(staging, name), `new-${name}\n`);
      writeFileSync(join(install, name), `old-${name}\n`);
    }
    chmodSync(join(install, "arashi.bin"), 0o700);
    chmodSync(join(install, "arashi"), 0o740);
    chmodSync(join(install, "aw"), 0o744);
    writeFileSync(join(install, ".arashi-managed-entrypoints.json"), "old-ledger\n");
    chmodSync(join(install, ".arashi-managed-entrypoints.json"), 0o640);
    const result = source(
      `verify_installed_entrypoints(){ return 1; }; install_posix_payload_transaction ${JSON.stringify(install)} ${JSON.stringify(join(staging, "arashi.bin"))} ${JSON.stringify(join(staging, "arashi"))} ${JSON.stringify(join(staging, "aw"))} 1.31.0`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Rollback completed");
    for (const name of ["arashi.bin", "arashi", "aw"]) {
      expect(readFileSync(join(install, name), "utf8")).toBe(`old-${name}\n`);
    }
    expect(statSync(join(install, "arashi.bin")).mode & 0o777).toBe(0o700);
    expect(statSync(join(install, "arashi")).mode & 0o777).toBe(0o740);
    expect(statSync(join(install, "aw")).mode & 0o777).toBe(0o744);
    expect(readFileSync(join(install, ".arashi-managed-entrypoints.json"), "utf8")).toBe(
      "old-ledger\n",
    );
    expect(statSync(join(install, ".arashi-managed-entrypoints.json")).mode & 0o777).toBe(0o640);
  });
});
