/**
 * Unit Tests: Worktree Path Calculation
 * Feature: 001-nested-worktree-paths
 * 
 * Tests the calculateWorktreePath() function for calculating correct
 * worktree destination paths based on repository type.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

// Import functions we're testing (will be implemented in T010, T020)
import { calculateWorktreePath, calculateChildWorktreePath } from "../../src/core/worktree.ts";
import type { Repository } from "../../src/core/repository.ts";
import type { ArashiConfig } from "../../src/types.ts";

describe("calculateWorktreePath", () => {
  const testDir = join(import.meta.dir, "temp-test-workspace");
  
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("US1: Meta-repo Sibling Strategy", () => {
    test("should calculate sibling path for meta-repo", async () => {
      // Setup: Create meta-repo
      const metaRepoPath = join(testDir, "my-project");
      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(metaRepoPath, ".arashi", "config.json"),
        JSON.stringify({ version: "1.0.0" })
      );

      const repo: Repository = {
        name: "my-project",
        path: metaRepoPath,
        defaultBranch: "main",
        hasSetupScript: false,
      };

      const config: ArashiConfig = {
        version: "1.0.0",
        repos_dir: "./repos",
        auto_setup: true,
        worktree_strategy: "same_branch",
        discovered_repos: {},
      };

      const result = await calculateWorktreePath(repo, "feature-123", config);

      expect(result.path).toBe(join(testDir, "my-project-feature-123"));
      expect(result.repositoryType).toBe("meta-repo");
      expect(result.strategy).toBe("sibling");
      expect(result.parentWorktreePath).toBeUndefined();
    });

    test("should handle different branch names for meta-repo", async () => {
      // Setup: Create meta-repo
      const metaRepoPath = join(testDir, "project");
      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(metaRepoPath, ".arashi", "config.json"),
        JSON.stringify({ version: "1.0.0" })
      );

      const repo: Repository = {
        name: "project",
        path: metaRepoPath,
        defaultBranch: "main",
        hasSetupScript: false,
      };

      const config: ArashiConfig = {
        version: "1.0.0",
        repos_dir: "./repos",
        auto_setup: true,
        worktree_strategy: "same_branch",
        discovered_repos: {},
      };

      // Test various branch names
      const branchNames = ["bugfix-456", "feature/new-ui", "hotfix/critical"];
      
      for (const branchName of branchNames) {
        const result = await calculateWorktreePath(repo, branchName, config);
        expect(result.path).toBe(join(testDir, `project-${branchName}`));
        expect(result.strategy).toBe("sibling");
      }
    });
  });
});
