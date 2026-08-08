import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");

describe("built hook-input acceptance contract", () => {
  test("native Windows acceptance covers timeout, interruption cleanup, and terminal reuse", async () => {
    const fixture = await readFile(join(root, "tests/windows/hook-input-native.ps1"), "utf8");
    const helper = await readFile(join(root, "tests/windows/pty-command.mjs"), "utf8");
    const hooks = await readFile(join(root, "src/lib/hooks.ts"), "utf8");

    expect(hooks).toContain("ConsoleCancelEventHandler");
    expect(hooks).toContain("powershell.exe");

    expect(fixture).toContain("windows:timeout:cleanup");
    expect(fixture).toContain("windows:interrupt:cleanup");
    expect(fixture).toContain("windows:interrupt:finally");
    expect(fixture).toContain("windows:refusal:exact-output");
    expect(fixture).toContain("Assert-NoCreateArtifacts");
    expect(fixture).toContain("windows:terminal:reused");
    expect(fixture).toMatch(/Get-Process[\s\S]*-ErrorAction SilentlyContinue/);
    expect(helper).toContain("reusePrompt");
    expect(helper).toContain(["__ARASHI_CONPTY_REUSED__:", "$", "{reuseAnswer}"].join(""));
    expect(helper).toContain("__CTRL_C__");
  });

  test("POSIX PTY EOF waits for child reaping instead of reporting a false timeout", async () => {
    const helper = await readFile(join(root, "tests/helpers/pty-command.py"), "utf8");

    expect(helper).toContain("pty_eof = True");
    expect(helper).toMatch(/if not pty_eof:[\s\S]*os\.waitpid\(pid, os\.WNOHANG\)/);
    expect(helper).not.toMatch(/errno\.EIO:[\s\S]{0,80}break/);
  });

  test("CI executes both built POSIX and native Windows acceptance fixtures", async () => {
    const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain('ARASHI_BUILT_HOOK_ACCEPTANCE: "1"');
    expect(workflow).toContain("tests/integration/hook-input-built-posix.test.ts");
    expect(workflow).toContain("./tests/windows/hook-input-native.ps1");
  });
});
