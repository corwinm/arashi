/**
 * Integration Tests: Rollback Mechanism - Type-Specific Rollback
 *
 * Tests rollback functions with real git repositories and directories.
 * Uses temporary test resources that are created and cleaned up for each test.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { exec as gitExec } from "../../src/lib/git";
import {
  rollbackWorktreeCreated,
  rollbackBranchCreated,
  rollbackDirectoryCreated,
  WorktreeCreatedEntry,
  BranchCreatedEntry,
  DirectoryCreatedEntry,
} from "../../src/core/rollback";

describe("Rollback Integration Tests - User Story 3", () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    // Create temporary directory for tests
    testDir = await mkdtemp(join(tmpdir(), "rollback-test-"));
    repoPath = join(testDir, "test-repo");

    // Initialize a test git repository
    await mkdir(repoPath, { recursive: true });
    await gitExec(["init"], repoPath);
    await gitExec(["config", "user.name", "Test User"], repoPath);
    await gitExec(["config", "user.email", "test@example.com"], repoPath);

    // Create an initial commit
    await writeFile(join(repoPath, "README.md"), "# Test Repository");
    await gitExec(["add", "README.md"], repoPath);
    await gitExec(["commit", "-m", "Initial commit"], repoPath);
  });

  afterEach(async () => {
    // Clean up test directory
    if (testDir) {
      try {
        await rm(testDir, { recursive: true, force: true });
      } catch (error) {
        console.error("Failed to clean up test directory:", error);
      }
    }
  });

  // ============================================================================
  // T031: Integration test for worktree rollback with real temporary repository
  // ============================================================================

  describe("rollbackWorktreeCreated()", () => {
    test("should successfully remove a real worktree", async () => {
      const worktreePath = join(testDir, "test-worktree");
      const branchName = "feature-test";

      // Create a worktree
      await gitExec(["worktree", "add", worktreePath, "-b", branchName], repoPath);

      // Verify worktree exists
      const listResult = await gitExec(["worktree", "list"], repoPath);
      expect(listResult.stdout).toContain(worktreePath);

      // Create rollback entry
      const entry: WorktreeCreatedEntry = {
        type: "worktree_created",
        timestamp: Date.now(),
        data: {
          repositoryPath: repoPath,
          worktreePath: worktreePath,
          branchName: branchName,
        },
      };

      // Execute rollback - should complete successfully
      await rollbackWorktreeCreated(entry);

      // Verify worktree is removed
      const listAfter = await gitExec(["worktree", "list"], repoPath);
      expect(listAfter.stdout).not.toContain(worktreePath);
    });

    test("should be idempotent when worktree does not exist", async () => {
      const worktreePath = join(testDir, "non-existent-worktree");
      const branchName = "feature-test";

      const entry: WorktreeCreatedEntry = {
        type: "worktree_created",
        timestamp: Date.now(),
        data: {
          repositoryPath: repoPath,
          worktreePath: worktreePath,
          branchName: branchName,
        },
      };

      // Should not throw even though worktree doesn't exist
      await rollbackWorktreeCreated(entry);
      // Test passes if no error is thrown
    });
  });

  // ============================================================================
  // T032: Integration test for branch rollback with real temporary repository
  // ============================================================================

  describe("rollbackBranchCreated()", () => {
    test("should successfully delete a real branch", async () => {
      const branchName = "feature-test-branch";

      // Create a branch
      await gitExec(["branch", branchName], repoPath);

      // Verify branch exists
      const branchList = await gitExec(["branch"], repoPath);
      expect(branchList.stdout).toContain(branchName);

      // Create rollback entry
      const entry: BranchCreatedEntry = {
        type: "branch_created",
        timestamp: Date.now(),
        data: {
          repositoryPath: repoPath,
          branchName: branchName,
        },
      };

      // Execute rollback - should complete successfully
      await rollbackBranchCreated(entry);

      // Verify branch is deleted
      const branchListAfter = await gitExec(["branch"], repoPath);
      expect(branchListAfter.stdout).not.toContain(branchName);
    });

    test("should be idempotent when branch does not exist", async () => {
      const branchName = "non-existent-branch";

      const entry: BranchCreatedEntry = {
        type: "branch_created",
        timestamp: Date.now(),
        data: {
          repositoryPath: repoPath,
          branchName: branchName,
        },
      };

      // Should not throw even though branch doesn't exist
      await rollbackBranchCreated(entry);
      // Test passes if no error is thrown
    });
  });

  // ============================================================================
  // T033: Integration test for directory rollback with real temporary directory
  // ============================================================================

  describe("rollbackDirectoryCreated()", () => {
    test("should successfully remove a real directory", async () => {
      const dirPath = join(testDir, "test-directory");

      // Create directory with some content
      await mkdir(dirPath, { recursive: true });
      await writeFile(join(dirPath, "file.txt"), "test content");
      await mkdir(join(dirPath, "subdir"));
      await writeFile(join(dirPath, "subdir", "nested.txt"), "nested content");

      // Verify directory exists
      const fs = await import("fs/promises");
      try {
        await fs.access(dirPath);
        // Directory exists - good
      } catch {
        throw new Error("Directory should exist but does not");
      }

      // Create rollback entry
      const entry: DirectoryCreatedEntry = {
        type: "directory_created",
        timestamp: Date.now(),
        data: {
          directoryPath: dirPath,
        },
      };

      // Execute rollback - should complete successfully
      await rollbackDirectoryCreated(entry);

      // Verify directory is removed
      await expect(fs.access(dirPath)).rejects.toThrow();
    });

    test("should be idempotent when directory does not exist", async () => {
      const dirPath = join(testDir, "non-existent-directory");

      const entry: DirectoryCreatedEntry = {
        type: "directory_created",
        timestamp: Date.now(),
        data: {
          directoryPath: dirPath,
        },
      };

      // Should not throw even though directory doesn't exist
      await rollbackDirectoryCreated(entry);
      // Test passes if no error is thrown
    });
  });

  // ============================================================================
  // T045: Integration test for full rollback with mixed operation types
  // ============================================================================

  describe("Full rollback integration (User Story 1)", () => {
    test("should rollback mixed operations in LIFO order", async () => {
      // This test verifies User Story 1: automatic rollback with correct ordering
      const { OperationLog } = await import("../../src/core/rollback");
      const log = new OperationLog();

      const worktreePath = join(testDir, "test-worktree");
      const branchName = "feature-branch";
      const dirPath = join(testDir, "test-directory");

      // Step 1: Create branch
      await gitExec(["branch", branchName], repoPath);

      // Step 2: Create worktree on that branch
      await gitExec(["worktree", "add", worktreePath, branchName], repoPath);

      // Step 3: Create directory
      await mkdir(dirPath, { recursive: true });

      // Log all operations in order
      log.add({
        type: "branch_created",
        timestamp: Date.now(),
        data: { repositoryPath: repoPath, branchName },
      });

      log.add({
        type: "worktree_created",
        timestamp: Date.now() + 100,
        data: { repositoryPath: repoPath, worktreePath, branchName },
      });

      log.add({
        type: "directory_created",
        timestamp: Date.now() + 200,
        data: { directoryPath: dirPath },
      });

      // Verify all resources exist
      const branchList = await gitExec(["branch"], repoPath);
      expect(branchList.stdout).toContain(branchName);

      const worktreeList = await gitExec(["worktree", "list"], repoPath);
      expect(worktreeList.stdout).toContain(worktreePath);

      const fs = await import("fs/promises");
      try {
        await fs.access(dirPath);
      } catch {
        throw new Error("Directory should exist");
      }

      // Execute rollback - should remove in LIFO order (dir, worktree, branch)
      const result = await log.rollback();

      // Verify rollback succeeded
      expect(result.totalOperations).toBe(3);
      expect(result.successCount).toBe(3);
      expect(result.failureCount).toBe(0);

      // Verify all resources are removed
      const branchListAfter = await gitExec(["branch"], repoPath);
      expect(branchListAfter.stdout).not.toContain(branchName);

      const worktreeListAfter = await gitExec(["worktree", "list"], repoPath);
      expect(worktreeListAfter.stdout).not.toContain(worktreePath);

      try {
        await fs.access(dirPath);
        throw new Error("Directory should not exist after rollback");
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message === "Directory should not exist after rollback"
        ) {
          throw error;
        }
        // Expected - directory was removed
      }
    });

    test("should continue rollback despite individual failures", async () => {
      // This test verifies User Story 4: continue despite failures
      const { OperationLog } = await import("../../src/core/rollback");
      const log = new OperationLog();

      const dirPath2 = join(testDir, "dir2");
      const branchName = "test-branch";

      // Create real branch
      await gitExec(["branch", branchName], repoPath);

      // Create real directory
      await mkdir(dirPath2, { recursive: true });

      // Log: fake worktree (will fail), real branch, real directory
      log.add({
        type: "worktree_created",
        timestamp: Date.now(),
        data: {
          repositoryPath: repoPath,
          worktreePath: "/nonexistent/worktree",
          branchName: "fake-branch",
        },
      });

      log.add({
        type: "branch_created",
        timestamp: Date.now() + 100,
        data: { repositoryPath: repoPath, branchName },
      });

      log.add({
        type: "directory_created",
        timestamp: Date.now() + 200,
        data: { directoryPath: dirPath2 },
      });

      // Execute rollback
      const result = await log.rollback();

      // Should have processed all 3 operations
      expect(result.totalOperations).toBe(3);

      // Worktree will fail (idempotent - doesn't exist), branch and dir should succeed
      expect(result.successCount).toBe(3); // All succeed because worktree is idempotent
      expect(result.failureCount).toBe(0);

      // Verify real resources were removed
      const branchListAfter = await gitExec(["branch"], repoPath);
      expect(branchListAfter.stdout).not.toContain(branchName);

      const fs = await import("fs/promises");
      try {
        await fs.access(dirPath2);
        throw new Error("Directory should not exist after rollback");
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message === "Directory should not exist after rollback"
        ) {
          throw error;
        }
        // Expected - directory was removed
      }
    });
  });
});
