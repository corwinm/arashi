/**
 * Unit tests for remove core helpers
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "bun";
import {
  parseWorktreeList,
  createRemovalSummary,
  formatRemovalSummaryHuman,
} from "../../src/core/remove.ts";
import { getWorktreeDirtyStatus } from "../../src/core/worktree.ts";

describe("remove core helpers", () => {
  test("parseWorktreeList parses porcelain output", () => {
    const repoPath = "/repo/main";
    const output = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/feature",
      "HEAD def456",
      "branch refs/heads/feature-x",
      "",
    ].join("\n");

    const worktrees = parseWorktreeList(output, "main-repo", repoPath);
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].branch).toBe("main");
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[1].branch).toBe("feature-x");
    expect(worktrees[1].isMain).toBe(false);
  });

  test("getWorktreeDirtyStatus detects untracked files", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "arashi-remove-dirty-"));
    await spawn(["git", "init", "-b", "main"], { cwd: repoPath }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: repoPath }).exited;
    await spawn(["git", "config", "user.name", "Test User"], { cwd: repoPath }).exited;
    await spawn(["git", "commit", "--allow-empty", "-m", "Initial"], { cwd: repoPath }).exited;

    await Bun.write(join(repoPath, "dirty.txt"), "dirty");

    const status = await getWorktreeDirtyStatus(repoPath);
    expect(status.isDirty).toBe(true);
    expect(status.untrackedFiles).toBeGreaterThan(0);

    await rm(repoPath, { recursive: true, force: true });
  });

  test("formatRemovalSummaryHuman includes success message", () => {
    const summary = createRemovalSummary(1, 1);
    summary.successfulWorktrees = 1;
    summary.successfulBranches = 1;
    summary.operations.push({
      type: "worktree_remove",
      repository: "main",
      branchName: "feature",
      worktreePath: "/repo/feature",
      status: "success",
    });
    summary.operations.push({
      type: "branch_delete",
      repository: "main",
      branchName: "feature",
      status: "success",
    });

    const output = formatRemovalSummaryHuman(summary);
    expect(output).toContain("Successfully removed 1 worktrees");
    expect(output).toContain("Removed worktrees:");
    expect(output).toContain("Deleted branches:");
  });
});
