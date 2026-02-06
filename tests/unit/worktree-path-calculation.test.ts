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
import { spawn } from "child_process";

// Import functions we're testing (will be implemented in T010, T020)
import { calculateWorktreePath, calculateChildWorktreePath } from "../../src/core/worktree.ts";
import type { Repository } from "../../src/core/repository.ts";
import type { ArashiConfig } from "../../src/types.ts";

/**
 * Helper to execute git commands
 */
async function exec(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "ignore",
    });
    
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command}`));
      }
    });
    
    child.on("error", reject);
  });
}

/**
 * Helper to create a test git repository
 */
async function createGitRepo(path: string, bare = false): Promise<void> {
  await mkdir(path, { recursive: true });
  if (bare) {
    await exec("git init --bare", path);
  } else {
    await exec("git init -b main", path);
    await exec('git config user.name "Test"', path);
    await exec('git config user.email "test@test.com"', path);
    await exec("git commit --allow-empty -m 'Initial'", path);
  }
}

describe("calculateWorktreePath", () => {
  const testDir = join(import.meta.dir, "temp-test-workspace");
  
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("US1: Meta-repo Sibling Strategy - Non-bare", () => {
    test("should calculate sibling path with repo name prefix for non-bare meta-repo", async () => {
      // Setup: Create non-bare meta-repo
      const metaRepoPath = join(testDir, "my-project");
      await createGitRepo(metaRepoPath, false);
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

      // Non-bare repo should use: repo-name-branch-name
      expect(result.path).toBe(join(testDir, "my-project-feature-123"));
      expect(result.repositoryType).toBe("meta-repo");
      expect(result.strategy).toBe("sibling");
      expect(result.parentWorktreePath).toBeUndefined();
    });

    test("should handle different branch names for non-bare meta-repo", async () => {
      // Setup: Create non-bare meta-repo
      const metaRepoPath = join(testDir, "project");
      await createGitRepo(metaRepoPath, false);
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
        // Non-bare: repo-name-branch-name
        expect(result.path).toBe(join(testDir, `project-${branchName}`));
        expect(result.strategy).toBe("sibling");
      }
    });
  });

  describe("Bare Repository Support", () => {
    test("should calculate sibling path with branch name only for bare repo", async () => {
      // Setup: Create bare meta-repo
      const bareRepoPath = join(testDir, "my-project.git");
      await createGitRepo(bareRepoPath, true);
      await mkdir(join(bareRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(bareRepoPath, ".arashi", "config.json"),
        JSON.stringify({ version: "1.0.0" })
      );

      const repo: Repository = {
        name: "my-project.git",
        path: bareRepoPath,
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

      // Bare repo should use: branch-name only
      expect(result.path).toBe(join(testDir, "feature-123"));
      expect(result.repositoryType).toBe("meta-repo");
      expect(result.strategy).toBe("sibling");
    });

    test("should handle standalone bare repositories", async () => {
      // Setup: Create bare standalone repo (no .arashi config)
      const bareRepoPath = join(testDir, "standalone.git");
      await createGitRepo(bareRepoPath, true);

      const repo: Repository = {
        name: "standalone.git",
        path: bareRepoPath,
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

      const result = await calculateWorktreePath(repo, "bugfix-789", config);

      // Bare repo should use: branch-name only
      expect(result.path).toBe(join(testDir, "bugfix-789"));
      expect(result.repositoryType).toBe("standalone");
      expect(result.strategy).toBe("sibling");
    });
  });

  describe("US2: Child Repository Nested Strategy", () => {
    test("should nest child repo inside non-bare parent worktree", async () => {
      // Setup: Create non-bare meta-repo with child
      const metaRepoPath = join(testDir, "parent-repo");
      await createGitRepo(metaRepoPath, false);
      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(metaRepoPath, ".arashi", "config.json"),
        JSON.stringify({ version: "1.0.0", repos_dir: "./repos" })
      );

      // Create child repo
      const childRepoPath = join(metaRepoPath, "repos", "child-repo");
      await createGitRepo(childRepoPath, false);

      const childRepo: Repository = {
        name: "child-repo",
        path: childRepoPath,
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

      const result = await calculateWorktreePath(childRepo, "feature-123", config);

      // Non-bare parent: parent-repo-feature-123/repos/child-repo
      expect(result.path).toBe(join(testDir, "parent-repo-feature-123", "repos", "child-repo"));
      expect(result.repositoryType).toBe("child");
      expect(result.strategy).toBe("nested");
      expect(result.parentWorktreePath).toBe(join(testDir, "parent-repo-feature-123"));
    });

    test("should nest child repo with branch name only when parent is bare", async () => {
      // Setup: Create bare meta-repo with child
      const bareMetaRepoPath = join(testDir, "parent.git");
      await createGitRepo(bareMetaRepoPath, true);
      await mkdir(join(bareMetaRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(bareMetaRepoPath, ".arashi", "config.json"),
        JSON.stringify({ version: "1.0.0", repos_dir: "./repos" })
      );

      // Create child repo inside bare parent
      const childRepoPath = join(bareMetaRepoPath, "repos", "child-repo");
      await createGitRepo(childRepoPath, false);

      const childRepo: Repository = {
        name: "child-repo",
        path: childRepoPath,
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

      const result = await calculateWorktreePath(childRepo, "feature-123", config);

      // Bare parent: feature-123/repos/child-repo (branch name only!)
      expect(result.path).toBe(join(testDir, "feature-123", "repos", "child-repo"));
      expect(result.repositoryType).toBe("child");
      expect(result.strategy).toBe("nested");
      expect(result.parentWorktreePath).toBe(join(testDir, "feature-123"));
    });

    test("should handle multiple child repos of bare parent consistently", async () => {
      // Setup: Create bare meta-repo
      const bareMetaRepoPath = join(testDir, "monorepo.git");
      await createGitRepo(bareMetaRepoPath, true);
      await mkdir(join(bareMetaRepoPath, ".arashi"), { recursive: true });
      await writeFile(
        join(bareMetaRepoPath, ".arashi", "config.json"),
        JSON.stringify({ version: "1.0.0", repos_dir: "./repos" })
      );

      // Create multiple child repos
      const childNames = ["frontend", "backend", "shared"];
      const childRepos: Repository[] = [];

      for (const name of childNames) {
        const childPath = join(bareMetaRepoPath, "repos", name);
        await createGitRepo(childPath, false);
        childRepos.push({
          name,
          path: childPath,
          defaultBranch: "main",
          hasSetupScript: false,
        });
      }

      const config: ArashiConfig = {
        version: "1.0.0",
        repos_dir: "./repos",
        auto_setup: true,
        worktree_strategy: "same_branch",
        discovered_repos: {},
      };

      // All children should nest inside branch-name-only parent worktree
      for (const childRepo of childRepos) {
        const result = await calculateWorktreePath(childRepo, "dev", config);
        
        expect(result.path).toBe(join(testDir, "dev", "repos", childRepo.name));
        expect(result.strategy).toBe("nested");
        expect(result.parentWorktreePath).toBe(join(testDir, "dev"));
      }
    });
  });
});
