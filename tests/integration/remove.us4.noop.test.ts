/**
 * Integration test: User Story 4 - no-op when both keep flags set
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";
import { executeRemove } from "../../src/commands/remove.ts";
import { existsSync } from "fs";

describe("remove command - US4 no-op keep flags", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test("does not remove worktrees or branches when both keep flags set", async () => {
    const branchName = "feature-noop";
    const worktrees = await createWorktreesForBranch(workspace, branchName, true);

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(branchName, {
        force: true,
        keepBranches: true,
        keepWorktrees: true,
      });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    for (const path of Object.values(worktrees)) {
      expect(existsSync(path)).toBe(true);
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
import { spawn } from "../helpers/node-runtime.ts";
