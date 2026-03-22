/**
 * Integration tests for worktree orchestration
 *
 * Feature: 001-worktree-orchestration
 * Tests use real git repositories to verify end-to-end functionality
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createTestWorkspace } from "../helpers/create-test-workspace.ts";
import type { TestWorkspace } from "../helpers/create-test-workspace.ts";
import { access } from "fs/promises";
import { constants } from "fs";

// ============================================================================
// Test Setup and Teardown
// ============================================================================

let workspace: TestWorkspace | null = null;

afterEach(async () => {
  if (workspace) {
    await workspace.cleanup();
    workspace = null;
  }
});

// ============================================================================
// T017: Integration test for basic coordinated worktree creation
// ============================================================================

describe("Basic Coordinated Worktree Creation (Integration)", () => {
  test("should create worktrees across 3 real test repositories", async () => {
    // Setup: Create 3 test repositories
    workspace = await createTestWorkspace();
    const branchName = "feature-integration-test";

    const { createCoordinatedWorktrees } = await import("../../src/core/worktree.ts");

    // Call createCoordinatedWorktrees
    const result = await createCoordinatedWorktrees(branchName, workspace.repositories, {
      executeHooks: false,
      showProgress: false,
    });

    // Verify operation summary
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
    expect(result.rolledBack).toBe(false);
    expect(result.repositoryResults).toHaveLength(3);

    // Verify each repository result
    for (const repoResult of result.repositoryResults) {
      expect(repoResult.status).toBe("success");
      expect(repoResult.worktreePath).not.toBeNull();
      expect(repoResult.branchName).toBe(branchName);
      expect(repoResult.error).toBeNull();

      // Verify worktree directory exists
      const worktreeExists = await verifyWorktreeExists(repoResult.worktreePath!);
      expect(worktreeExists).toBe(true);

      // Verify branch exists
      const branchExists = await verifyBranchExists(repoResult.repository.path, branchName);
      expect(branchExists).toBe(true);
    }
  });
});

// ============================================================================
// T026: Integration test for rollback on simulated failure
// ============================================================================

describe("Rollback on Repository Failure (Integration)", () => {
  test("should rollback first 2 worktrees when 3rd repository fails", async () => {
    // Setup: Create 3 test repositories
    workspace = await createTestWorkspace();

    const { createCoordinatedWorktrees } = await import("../../src/core/worktree.ts");

    // First, verify we can successfully create worktrees
    const branchName = "test-rollback";

    // Make the 3rd repository path invalid to trigger a failure
    const reposWithFailure = [
      workspace.repositories[0],
      workspace.repositories[1],
      {
        ...workspace.repositories[2],
        path: "/nonexistent/invalid/path", // This will cause git command to fail
      },
    ];

    const result = await createCoordinatedWorktrees(branchName, reposWithFailure, {
      executeHooks: false,
      showProgress: false,
    });

    // Verify rollback was triggered
    expect(result.rolledBack).toBe(true);
    expect(result.errorSummary).not.toBeNull();

    // Verify the first two repositories had their worktrees cleaned up (rolled back)
    // Since rollback was triggered, the operation log should have reversed the changes
    // We can verify by checking that branches don't exist in the original repos
    const branch1Exists = await verifyBranchExists(workspace.repositories[0].path, branchName);
    const branch2Exists = await verifyBranchExists(workspace.repositories[1].path, branchName);

    // After rollback, branches should be removed
    expect(branch1Exists).toBe(false);
    expect(branch2Exists).toBe(false);
  });
});

// ============================================================================
// T034: Integration test for conflict detection and resolution
// ============================================================================

describe("Conflict Detection and Resolution (Integration)", () => {
  test("should detect and handle branch conflicts with REUSE_EXISTING strategy", async () => {
    // Setup: Create workspace with existing branch in one repo
    const existingBranchName = "existing-feature";
    workspace = await createTestWorkspace([
      { createExistingBranch: existingBranchName, defaultBranch: "main", name: "repo-1" },
      { defaultBranch: "main", name: "repo-2" },
      { defaultBranch: "master", name: "repo-3" },
    ]);

    const { createCoordinatedWorktrees, checkBranchConflicts } =
      await import("../../src/core/worktree.ts");

    // Check for conflicts
    const conflictCheck = await checkBranchConflicts(existingBranchName, workspace.repositories);

    // Verify conflict detected in repo-1
    expect(conflictCheck.hasConflicts).toBe(true);
    expect(conflictCheck.conflicts).toHaveLength(1);
    expect(conflictCheck.conflicts[0].repository.name).toBe("repo-1");
    expect(conflictCheck.conflicts[0].existsLocally).toBe(true);

    // Now create worktrees with REUSE_EXISTING strategy
    const result = await createCoordinatedWorktrees(existingBranchName, workspace.repositories, {
      conflictResolution: "REUSE_EXISTING",
      executeHooks: false,
      showProgress: false,
    });

    // All repos should succeed (repo-1 reuses existing branch)
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
    expect(result.rolledBack).toBe(false);
  });
});

// ============================================================================
// T046: Integration test for explicit repository filtering
// ============================================================================

describe("Repository Filtering (Integration)", () => {
  test("should create worktrees only in explicitly selected repositories", async () => {
    // Setup: Create 5 test repositories
    workspace = await createTestWorkspace([
      { defaultBranch: "main", name: "repo-1" },
      { defaultBranch: "main", name: "repo-2" },
      { defaultBranch: "master", name: "repo-3" },
      { defaultBranch: "develop", name: "repo-4" },
      { defaultBranch: "main", name: "repo-5" },
    ]);

    const { applyRepositoryFilter } = await import("../../src/core/worktree.ts");

    // Filter to only repos 1, 3, and 5
    const filter = {
      explicitList: ["repo-1", "repo-3", "repo-5"],
      mode: "explicit" as const,
      selectedRepositories: null,
    };

    const filteredRepos = await applyRepositoryFilter(filter, workspace.repositories);

    expect(filteredRepos).toHaveLength(3);
    expect(filteredRepos[0].name).toBe("repo-1");
    expect(filteredRepos[1].name).toBe("repo-3");
    expect(filteredRepos[2].name).toBe("repo-5");

    // Now create worktrees with filtered repos
    const { createCoordinatedWorktrees } = await import("../../src/core/worktree.ts");

    const branchName = "test-filtering";
    const result = await createCoordinatedWorktrees(branchName, filteredRepos, {
      executeHooks: false,
      showProgress: false,
    });

    // Only 3 repos should have worktrees
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
    expect(result.repositoryResults).toHaveLength(3);

    // Verify branches exist only in filtered repos
    const branch1Exists = await verifyBranchExists(workspace.repositories[0].path, branchName);
    const branch2Exists = await verifyBranchExists(workspace.repositories[1].path, branchName);
    const branch3Exists = await verifyBranchExists(workspace.repositories[2].path, branchName);
    const branch4Exists = await verifyBranchExists(workspace.repositories[3].path, branchName);
    const branch5Exists = await verifyBranchExists(workspace.repositories[4].path, branchName);

    expect(branch1Exists).toBe(true); // Repo-1: included
    expect(branch2Exists).toBe(false); // Repo-2: excluded
    expect(branch3Exists).toBe(true); // Repo-3: included
    expect(branch4Exists).toBe(false); // Repo-4: excluded
    expect(branch5Exists).toBe(true); // Repo-5: included
  });
});

// ============================================================================
// Helper Functions for Integration Tests
// ============================================================================

/**
 * Verify a worktree exists at the specified path
 */
async function verifyWorktreeExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a branch exists in a repository
 */
async function verifyBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "branch", "--list", branchName], {
    cwd: repoPath,
    stdout: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output.trim().length > 0;
}
