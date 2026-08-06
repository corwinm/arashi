import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import packageJson from "../../package.json";
import { buildShellInstallBlock } from "../../src/lib/shell-integration.ts";

describe("completion distribution and installer wiring", () => {
  test.each(["bash", "zsh", "fish"])(
    "managed %s block owns wrapper and completion once",
    (shell) => {
      const block = buildShellInstallBlock(shell as "bash" | "zsh" | "fish");
      expect(block.match(/shell init/g)).toHaveLength(1);
      expect(block.match(/arashi completion/g)).toHaveLength(1);
      expect(block).toContain("command arashi");
    },
  );

  test("release installer produces the same activation pair", () => {
    const installer = readFileSync("scripts/install.sh", "utf8");
    expect(installer).toContain("command arashi completion fish | source");
    expect(installer).toContain("source <(command arashi completion %s)");
    expect(installer).not.toMatch(/shell_integration_installed\(\)[\s\S]*grep -F[^\n]*START/);
  });

  test("release installer upgrades a managed block without changing outside bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "arashi-release-shell-upgrade-"));
    const rcFile = join(root, ".bashrc");
    const prefix = "# before\n\n\t\n";
    const suffix = "\n  \n# after";
    const oldBlock =
      '# >>> arashi shell integration >>>\neval "$(arashi shell init bash)"\n# <<< arashi shell integration <<<';
    writeFileSync(rcFile, `${prefix}${oldBlock}${suffix}`);

    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          'ARASHI_INSTALLER_SOURCE_ONLY=1 source scripts/install.sh; integration_block="$(build_shell_integration_block bash)"; upsert_shell_integration_block "$RC_FILE" "$integration_block"; upsert_shell_integration_block "$RC_FILE" "$integration_block"',
        ],
        { encoding: "utf8", env: { ...process.env, RC_FILE: rcFile } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(rcFile, "utf8")).toBe(
        `${prefix}${buildShellInstallBlock("bash")}${suffix}`,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "release installer upgrades through a symlink without replacing it",
    () => {
      const root = mkdtempSync(join(tmpdir(), "arashi-release-shell-symlink-"));
      const rcFile = join(root, ".bashrc");
      const targetFile = join(root, "versioned-bashrc");
      const oldBlock =
        '# >>> arashi shell integration >>>\neval "$(arashi shell init bash)"\n# <<< arashi shell integration <<<';
      writeFileSync(targetFile, `${oldBlock}\n`);
      symlinkSync("versioned-bashrc", rcFile);

      try {
        const result = spawnSync(
          "bash",
          [
            "-c",
            'ARASHI_INSTALLER_SOURCE_ONLY=1 source scripts/install.sh; integration_block="$(build_shell_integration_block bash)"; upsert_shell_integration_block "$RC_FILE" "$integration_block"',
          ],
          { encoding: "utf8", env: { ...process.env, RC_FILE: rcFile } },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(lstatSync(rcFile).isSymbolicLink()).toBe(true);
        expect(readFileSync(targetFile, "utf8")).toBe(`${buildShellInstallBlock("bash")}\n`);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  test("build, publish, and contract paths enforce generated freshness", () => {
    expect(packageJson.scripts["completion:generate"]).toBeTruthy();
    expect(packageJson.scripts["completion:check"]).toBeTruthy();
    expect(packageJson.scripts.build).toContain("completion:check");
    expect(packageJson.scripts.buildAll ?? packageJson.scripts["build:all"]).toContain(
      "completion:check",
    );
    expect(packageJson.scripts.prepublishOnly).toContain("completion:check");
    expect(packageJson.files).not.toContain("src");
  });

  test("npm first-use completion suppresses installer progress stdout", async () => {
    const { ensureInstalled } = await import("../../bin/arashi.js");
    const stdout: string[] = [];
    let installLog: ((message: string) => void) | undefined;
    await ensureInstalled({
      argv: ["completion", "bash"],
      binDir: "/missing",
      existsSyncImpl: () => false,
      log: (message: string) => stdout.push(message),
      installBinaryImpl: async (options: { log?: (message: string) => void }) => {
        installLog = options.log;
        options.log?.("download progress");
        return { status: "installed" };
      },
    });
    expect(installLog).toBeTypeOf("function");
    expect(stdout).toEqual([]);
  });
});
