/**
 * Unit Tests: Repository Type Detection
 * Feature: 001-nested-worktree-paths
 * 
 * Tests the detectRepositoryType() function for classifying repositories
 * as meta-repo, child, or standalone based on configuration and location.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

// Import the function we're testing (will be implemented in T009)
import { detectRepositoryType } from "../../src/core/worktree.ts";
import type { Repository } from "../../src/core/repository.ts";
import type { ArashiConfig } from "../../src/types.ts";

describe("detectRepositoryType", () => {
  const testDir = join(import.meta.dir, "temp-test-workspace");
  
  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("US1: Meta-repo Detection", () => {
    test("should detect meta-repo when .arashi/config.json exists", async () => {
      // Setup: Create meta-repo with .arashi/config.json
      const metaRepoPath = join(testDir, "meta-repo");
      const arashiConfigPath = join(metaRepoPath, ".arashi", "config.json");
      
      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(arashiConfigPath, JSON.stringify({ version: "1.0.0" }));

      const repo: Repository = {
        name: "meta-repo",
        path: metaRepoPath,
        defaultBranch: "main",
        hasSetupScript: false,
      };

      const result = await detectRepositoryType(repo, null);

      expect(result.type).toBe("meta-repo");
      expect(result.reason).toContain(".arashi/config.json");
      expect(result.parentName).toBeUndefined();
      expect(result.reposDir).toBeUndefined();
    });

    test("should detect meta-repo even when config provided", async () => {
      // Setup: Create meta-repo with .arashi/config.json
      const metaRepoPath = join(testDir, "meta-repo");
      const arashiConfigPath = join(metaRepoPath, ".arashi", "config.json");
      
      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(arashiConfigPath, JSON.stringify({ version: "1.0.0" }));

      const repo: Repository = {
        name: "meta-repo",
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

      const result = await detectRepositoryType(repo, config);

      expect(result.type).toBe("meta-repo");
      expect(result.reason).toContain(".arashi/config.json");
    });
  });
});
