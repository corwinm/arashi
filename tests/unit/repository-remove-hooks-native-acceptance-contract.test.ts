import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const root = join(import.meta.dirname, "../..");

describe("native repository remove-hook acceptance contract", () => {
  test("Windows built CLI covers canonical onboarding, discovery, execution, and ambiguity", async () => {
    const fixture = await readFile(
      join(root, "tests/windows/repository-remove-hooks-native.ps1"),
      "utf8",
    );
    const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");

    for (const marker of [
      "pre-remove.REPO.ps1.example",
      "post-remove.REPO.cmd.example",
      "pre-remove.repo-a.ps1",
      "ARASHI_HOOK_TARGET_REPOSITORY",
      "HOOK_CONFIGURATION_INVALID",
      "sourceScriptPaths",
      "pre-remove.repo-a.cmd",
      "pre-remove.repo-a.bat",
    ]) {
      expect(fixture).toContain(marker);
    }
    expect(workflow).toContain("./tests/windows/repository-remove-hooks-native.ps1");
  });
});
