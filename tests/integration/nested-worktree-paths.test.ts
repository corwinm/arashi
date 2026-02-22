/**
 * Integration Tests: Nested Worktree Paths
 * Feature: 001-nested-worktree-paths
 *
 * Integration tests verifying worktree path calculation works correctly
 * within the full worktree creation flow for all repository types.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "bun";

// Will test the full flow through createCoordinatedWorktrees
import { createCoordinatedWorktrees } from "../../src/core/worktree.ts";
import type { Repository } from "../../src/core/repository.ts";

describe("Nested Worktree Paths Integration", () => {
  const testDir = join(import.meta.dir, "../temp-integration-workspace");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
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
          version: "1.0.0",
          reposDir: "./repos",
          worktree_strategy: "same_branch",
          repos: {},
        }),
      );

      await initGitRepo(metaRepoPath);

      const repo: Repository = {
        name: "parent-repo",
        path: metaRepoPath,
        defaultBranch: "main",
        hasSetupScript: false,
      };

      // Create worktree
      const result = await createCoordinatedWorktrees("feature", [repo], {
        showProgress: false,
        executeHooks: false,
      });

      // Verify worktree was created as sibling
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);

      const worktreePath = join(testDir, "parent-repo-feature");
      const worktreeExists = await Bun.file(join(worktreePath, "README.md")).exists();
      expect(worktreeExists).toBe(true);

      // Verify directory structure: parent-repo/ and parent-repo-feature/ at same level
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
          version: "1.0.0",
          reposDir: "./repos",
          worktree_strategy: "same_branch",
          repos: {},
        }),
      );

      await initGitRepo(metaRepoPath);

      const repo: Repository = {
        name: "existing-repo",
        path: metaRepoPath,
        defaultBranch: "main",
        hasSetupScript: false,
      };

      // Create worktree with different branch name
      const result = await createCoordinatedWorktrees("bugfix-123", [repo], {
        showProgress: false,
        executeHooks: false,
      });

      expect(result.successCount).toBe(1);

      // Verify sibling creation with correct naming
      const worktreePath = join(testDir, "existing-repo-bugfix-123");
      const worktreeExists = await Bun.file(join(worktreePath, "README.md")).exists();
      expect(worktreeExists).toBe(true);
    });
  });
});
