import { readFileSync } from "node:fs";
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
