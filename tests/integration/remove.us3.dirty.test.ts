/**
 * Integration test: User Story 3 - dirty warning confirmation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { executeRemove } from "../../src/commands/remove.ts";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
  markWorktreeDirty,
} from "../helpers/remove-test-workspace.ts";

describe("remove command - US3 dirty warning", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test("prompts for confirmation when dirty worktree detected", async () => {
    const branchName = "feature-dirty";
    const worktrees = await createWorktreesForBranch(workspace, branchName, true);
    await markWorktreeDirty(worktrees["main"]);

    let confirmCalls = 0;
    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(
        branchName,
        { force: false },
        {
          multiSelect: async () => ({ status: "ok", value: [branchName] }),
          confirm: async () => {
            confirmCalls += 1;
            return { status: "ok", value: true };
          },
        },
      );
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    expect(confirmCalls).toBeGreaterThan(0);
    expect(existsSync(worktrees["main"])).toBe(false);
  });
});
