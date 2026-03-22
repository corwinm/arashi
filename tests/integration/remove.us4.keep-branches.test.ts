/**
 * Integration test: User Story 4 - keep branches
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { spawn } from "bun";
import { executeRemove } from "../../src/commands/remove.ts";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";

describe("remove command - US4 keep branches", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test("removes worktrees while keeping branches", async () => {
    const branchName = "feature-keep-branch";
    const worktrees = await createWorktreesForBranch(workspace, branchName, true);

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(branchName, { force: true, keepBranches: true });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    for (const path of Object.values(worktrees)) {
      expect(existsSync(path)).toBe(false);
    }

    const reposToCheck = [workspace.rootPath, ...workspace.repos.map((r) => r.path)];
    for (const repoPath of reposToCheck) {
      const proc = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
        cwd: repoPath,
        stderr: "ignore",
        stdout: "ignore",
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    }
  });
});
