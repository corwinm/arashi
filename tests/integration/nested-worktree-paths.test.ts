/**
 * Integration Tests: Nested Worktree Paths
 * Feature: 001-nested-worktree-paths
 *
 * Integration tests verifying worktree path calculation works correctly
 * within the full worktree creation flow for all repository types.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import type { Repository } from "../../src/core/repository.ts";
import { createCoordinatedWorktrees } from "../../src/core/worktree.ts";
import { join } from "path";
import { spawn } from "bun";

describe("Nested Worktree Paths Integration", () => {
  const testDir = join(import.meta.dir, "../temp-integration-workspace");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  async function initGitRepo(path: string) {
    await spawn(["git", "init", "-b", "main"], { cwd: path }).exited;
    await spawn(["git", "config", "user.name", "Test User"], { cwd: path }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: path }).exited;

    // Create initial commit
    await writeFile(join(path, "README.md"), "# Test Repository");
    await spawn(["git", "add", "."], { cwd: path }).exited;
    await spawn(["git", "commit", "-m", "Initial commit"], { cwd: path }).exited;
  }

  describe("US1: Meta-repo Worktree Creation", () => {
    test("should create meta-repo worktree as sibling", async () => {
      // Setup: Create meta-repo with .arashi config
      const metaRepoPath = join(testDir, "parent-repo");
      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(metaRepoPath, ".arashi", "config.json"),
        JSON.stringify({
          repos: {},
          reposDir: "./repos",
          version: "1.0.0",
          worktree_strategy: "same_branch",
        }),
      );

      await initGitRepo(metaRepoPath);

      const repo: Repository = {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "parent-repo",
        path: metaRepoPath,
      };

      // Create worktree
      const result = await createCoordinatedWorktrees("feature", [repo], {
        executeHooks: false,
        showProgress: false,
      });

      // Verify worktree was created as sibling
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);

      const worktreePath = join(metaRepoPath, ".arashi", "worktrees", "parent-repo-feature");
      const worktreeExists = await Bun.file(join(worktreePath, "README.md")).exists();
      expect(worktreeExists).toBe(true);

      const parentExists = await Bun.file(join(metaRepoPath, "README.md")).exists();
      expect(parentExists).toBe(true);
    });

    test("should maintain existing meta-repo behavior", async () => {
      // Setup: Create meta-repo
      const metaRepoPath = join(testDir, "existing-repo");
      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(metaRepoPath, ".arashi", "config.json"),
        JSON.stringify({
          repos: {},
          reposDir: "./repos",
          version: "1.0.0",
          worktree_strategy: "same_branch",
        }),
      );

      await initGitRepo(metaRepoPath);

      const repo: Repository = {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "existing-repo",
        path: metaRepoPath,
      };

      // Create worktree with different branch name
      const result = await createCoordinatedWorktrees("bugfix-123", [repo], {
        executeHooks: false,
        showProgress: false,
      });

      expect(result.successCount).toBe(1);

      const worktreePath = join(metaRepoPath, ".arashi", "worktrees", "existing-repo-bugfix-123");
      const worktreeExists = await Bun.file(join(worktreePath, "README.md")).exists();
      expect(worktreeExists).toBe(true);
    });
  });
});
