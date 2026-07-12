import { runtime } from "#test-runtime";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildShellInitScript,
  buildShellInstallBlock,
  detectSupportedShell,
  installShellIntegration,
  resolveStartupFilePath,
} from "../../../src/lib/shell-integration.ts";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

describe("shell integration", () => {
  test("detects supported shells from SHELL", () => {
    expect(detectSupportedShell({ SHELL: "/bin/bash" })).toBe("bash");
    expect(detectSupportedShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("fish");
    expect(detectSupportedShell({ SHELL: "/bin/nu" })).toBeNull();
  });

  test("builds bash and fish init wrappers", () => {
    expect(buildShellInitScript("bash")).toContain("ARASHI_DIRECTIVE_FILE");
    expect(buildShellInitScript("bash")).toContain("ARASHI_SHELL=bash");
    expect(buildShellInitScript("fish")).toContain("ARASHI_SHELL=fish");
    expect(buildShellInitScript("fish")).toContain('source "$directive_file"');
  });

  test("resolves startup files for known shells", async () => {
    const home = await mkdtemp(join(tmpdir(), "arashi-shell-home-"));
    tempPaths.push(home);

    await writeFile(join(home, ".zshrc"), "# existing\n");

    expect(await resolveStartupFilePath("zsh", { HOME: home })).toBe(join(home, ".zshrc"));
    expect(await resolveStartupFilePath("fish", { HOME: home })).toBe(
      join(home, ".config", "fish", "config.fish"),
    );
  });

  test("builds install blocks for bash and fish", () => {
    expect(buildShellInstallBlock("bash")).toContain('eval "$(command arashi shell init bash)"');
    expect(buildShellInstallBlock("fish")).toContain("command arashi shell init fish | source");
  });

  test("installs managed shell integration idempotently", async () => {
    const home = await mkdtemp(join(tmpdir(), "arashi-shell-install-"));
    tempPaths.push(home);

    const bashrcPath = join(home, ".bashrc");
    await writeFile(bashrcPath, "# existing\n");

    const firstInstall = await installShellIntegration({
      env: { HOME: home, SHELL: "/bin/bash" },
    });
    const once = await runtime.file(bashrcPath).text();

    const secondInstall = await installShellIntegration({
      env: { HOME: home, SHELL: "/bin/bash" },
    });
    const twice = await runtime.file(bashrcPath).text();

    expect(firstInstall.shell).toBe("bash");
    expect(firstInstall.startupFilePath).toBe(bashrcPath);
    expect(once).toContain("# >>> arashi shell integration >>>");
    expect(twice).toBe(once);
    expect(secondInstall.updated).toBe(false);
  });

  test("returns actionable error when install cannot detect a supported shell", async () => {
    await expect(
      installShellIntegration({ env: { HOME: "/tmp", SHELL: "/bin/nu" } }),
    ).rejects.toThrow("Use `arashi shell init <bash|zsh|fish>` for manual setup");
  });
});
