import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");

describe("built hook-input acceptance contract", () => {
  test("native Windows acceptance covers timeout, interruption cleanup, and terminal reuse", async () => {
    const fixture = await readFile(join(root, "tests/windows/hook-input-native.ps1"), "utf8");
    const helper = await readFile(join(root, "tests/windows/pty-command.mjs"), "utf8");

    expect(fixture).toContain("windows:timeout:cleanup");
    expect(fixture).toContain("windows:interrupt:cleanup");
    expect(fixture).toContain("windows:terminal:reused");
    expect(fixture).toMatch(/Get-Process[\s\S]*-ErrorAction SilentlyContinue/);
    expect(helper).toContain("reusePrompt");
    expect(helper).toContain("__CTRL_C__");
  });

  test("CI executes both built POSIX and native Windows acceptance fixtures", async () => {
    const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain('ARASHI_BUILT_HOOK_ACCEPTANCE: "1"');
    expect(workflow).toContain("tests/integration/hook-input-built-posix.test.ts");
    expect(workflow).toContain("./tests/windows/hook-input-native.ps1");
  });
});
