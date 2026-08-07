import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");
const wrapperEntrypoints = ["bin/arashi", "bin/arashi.js", "bin/arashi.ps1", "bin/arashi.bat"];

describe("installed wrapper hook-input acceptance", () => {
  test("all package entrypoints preserve stdin for hook-eligible commands", async () => {
    const sources = new Map(
      await Promise.all(
        wrapperEntrypoints.map(
          async (entrypoint) =>
            [entrypoint, await readFile(join(root, entrypoint), "utf8")] as const,
        ),
      ),
    );

    expect(sources.get("bin/arashi")).toContain('[ "$command" = "list" ]');
    expect(sources.get("bin/arashi")).not.toMatch(/command" = "remove"[\s\S]{0,120}0<&-/);
    expect(sources.get("bin/arashi.js")).toMatch(/stdio:\s*"inherit"/);
    expect(sources.get("bin/arashi.ps1")).not.toMatch(/StandardInput|RedirectStandardInput/);
    expect(sources.get("bin/arashi.bat")).not.toMatch(/<\s*nul/i);
  });

  test("the executable wrapper command-tests forced remove with redirected stdout", async () => {
    const source = await readFile(join(root, "tests/unit/arashi-wrapper.test.ts"), "utf8");
    expect(source).toContain(
      "preserves hook-eligible stdin for forced remove with redirected stdout",
    );
    expect(source).toContain("hook-answer");
  });
});
