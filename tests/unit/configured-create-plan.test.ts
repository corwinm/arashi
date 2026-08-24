import { describe, expect, test } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";

describe("configured create immutable destination plan", () => {
  test("hook preflight consumes the caller-owned plan instead of recalculating destinations", async () => {
    const source = (
      await readFile(join(import.meta.dirname, "..", "..", "src", "core", "worktree.ts"), "utf8")
    ).replaceAll("\r\n", "\n");
    const preflight = source.slice(
      source.indexOf("const preflightConfiguredCreateHooks"),
      source.indexOf(
        "// ============================================================================\n// Repository Type Detection",
      ),
    );

    expect(preflight).toContain(
      "worktreePathPlan: ReadonlyMap<Repository, CalculatedWorktreePath>",
    );
    expect(preflight).toContain("worktreePathPlan.get(repository)");
    expect(preflight).not.toContain("calculateWorktreePath(repository");
    expect(source).toContain(
      "preflightConfiguredCreateHooks(\n        mainRepoPath,\n        repositories,\n        config,\n        branchName,\n        worktreePathPlan,\n      )",
    );
  });
});
