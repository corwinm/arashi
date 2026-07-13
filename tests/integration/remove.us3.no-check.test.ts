/**
 * Integration test: User Story 3 - --no-check-dirty bypass
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
  markWorktreeDirty,
} from "../helpers/remove-test-workspace.ts";
import { executeRemove } from "../../src/commands/remove.ts";
import { existsSync } from "fs";

describe("remove command - US3 no-check-dirty", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test("removes dirty worktrees when --no-check-dirty is set", async () => {
    const branchName = "feature-no-check";
    const worktrees = await createWorktreesForBranch(workspace, branchName, true);
    await markWorktreeDirty(worktrees["main"]);

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(
        branchName,
        { checkDirty: false, force: false },
        {
          confirm: async () => ({ status: "ok", value: true }),
          multiSelect: async () => ({ status: "ok", value: [branchName] }),
        },
      );
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    expect(existsSync(worktrees["main"])).toBe(false);
  });
});
