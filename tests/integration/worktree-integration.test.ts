/**
 * Integration tests for worktree orchestration
 *
 * Feature: 001-worktree-orchestration
 * Tests use real git repositories to verify end-to-end functionality
 */

import { access, mkdir, rm } from "fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { constants } from "fs";
import { createTestWorkspace } from "../helpers/create-test-workspace.ts";
import { runtime } from "../helpers/node-runtime.ts";
type TestWorkspace = Awaited<ReturnType<typeof createTestWorkspace>>;

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
      expect(await revParse(repoResult.repository.path, branchName)).toBe(
        await revParse(repoResult.repository.path, repoResult.repository.defaultBranch),
      );
    }
  });

  test.each(["origin/HEAD", "origin/-feature"])(
    "creates the literal target %s with omitted base semantics",
    async (branchName) => {
      workspace = await createTestWorkspace([{ defaultBranch: "main", name: "repo-1" }]);
      const { createCoordinatedWorktrees } = await import("../../src/core/worktree.ts");

      const result = await createCoordinatedWorktrees(branchName, workspace.repositories, {
        executeHooks: false,
        showProgress: false,
      });

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);
      expect(result.repositoryResults[0]?.branchName).toBe(branchName);
      expect(await verifyBranchExists(workspace.repositories[0]!.path, branchName)).toBe(true);
      expect(await revParse(workspace.repositories[0]!.path, branchName)).toBe(
        await revParse(workspace.repositories[0]!.path, "main"),
      );
    },
  );
});
// ============================================================================

describe("Rollback on Repository Failure (Integration)", () => {
  test("should rollback first 2 worktrees when 3rd repository fails", async () => {
    // Setup: Create 3 test repositories
    workspace = await createTestWorkspace();

    const { createCoordinatedWorktrees } = await import("../../src/core/worktree.ts");

    // First, verify we can successfully create worktrees
    const branchName = "test-rollback";

    // Keep the path canonicalizable while making the 3rd entry a non-repository.
    // This lets action planning complete before repository processing reaches the failure.
    const invalidRepositoryPath = workspace.repositories[2].path;
    await rm(invalidRepositoryPath, { force: true, recursive: true });
    await mkdir(invalidRepositoryPath, { recursive: true });
    const reposWithFailure = [
      workspace.repositories[0],
      workspace.repositories[1],
      workspace.repositories[2],
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
    expect(result.repositoryResults.map(({ status }) => status)).toEqual([
      "success",
      "success",
      "failed",
    ]);
  });
});

// ============================================================================
// T034: Integration test for conflict detection and resolution
// ============================================================================

describe("Conflict Detection and Resolution (Integration)", () => {
  test("should preserve an existing branch OID with REUSE_EXISTING and no base", async () => {
    // Setup: Create workspace with existing branch in one repo
    const existingBranchName = "existing-feature";
    workspace = await createTestWorkspace([
      { createExistingBranch: existingBranchName, defaultBranch: "main", name: "repo-1" },
      { defaultBranch: "main", name: "repo-2" },
      { defaultBranch: "master", name: "repo-3" },
    ]);

    const { createCoordinatedWorktrees, checkBranchConflicts } =
      await import("../../src/core/worktree.ts");
    const [existingRepository] = workspace.repositories;
    expect(existingRepository).toBeDefined();
    await runGit(existingRepository.path, ["switch", existingBranchName]);
    await runGit(existingRepository.path, [
      "commit",
      "--allow-empty",
      "-m",
      "Advance existing feature",
    ]);
    await runGit(existingRepository.path, ["switch", existingRepository.defaultBranch]);
    const originalExistingBranchOid = await revParse(existingRepository.path, existingBranchName);
    expect(originalExistingBranchOid).not.toBe(
      await revParse(existingRepository.path, existingRepository.defaultBranch),
    );

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
    expect(await revParse(existingRepository.path, existingBranchName)).toBe(
      originalExistingBranchOid,
    );
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
  const proc = runtime.spawn(["git", "branch", "--list", branchName], {
    cwd: repoPath,
    stdout: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output.trim().length > 0;
}

async function runGit(repoPath: string, args: string[]): Promise<void> {
  const proc = runtime.spawn(["git", ...args], {
    cwd: repoPath,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(exitCode, stderr).toBe(0);
}

async function revParse(repoPath: string, ref: string): Promise<string> {
  const proc = runtime.spawn(["git", "rev-parse", ref], {
    cwd: repoPath,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  return output.trim();
}
