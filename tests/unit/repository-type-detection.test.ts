/**
 * Unit Tests: Repository Type Detection
 * Feature: 001-nested-worktree-paths
 *
 * Tests the detectRepositoryType() function for classifying repositories
 * as meta-repo, child, or standalone based on configuration and location.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import type { Config as ArashiConfig } from "../../src/lib/config.ts";
import type { Repository } from "../../src/core/repository.ts";
import { detectRepositoryType } from "../../src/core/worktree.ts";
import { join } from "path";

describe("detectRepositoryType", () => {
  const testDir = join(import.meta.dir, "temp-test-workspace");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  describe("US1: Meta-repo Detection", () => {
    test("should detect meta-repo when .arashi/config.json exists", async () => {
      // Setup: Create meta-repo with .arashi/config.json
      const metaRepoPath = join(testDir, "meta-repo");
      const arashiConfigPath = join(metaRepoPath, ".arashi", "config.json");

      await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
      await writeFile(arashiConfigPath, JSON.stringify({ version: "1.0.0" }));

      const repo: Repository = {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "meta-repo",
        path: metaRepoPath,
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
        defaultBranch: "main",
        hasSetupScript: false,
        name: "meta-repo",
        path: metaRepoPath,
      };

      const config: ArashiConfig = {
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
      };

      const result = await detectRepositoryType(repo, config);

      expect(result.type).toBe("meta-repo");
      expect(result.reason).toContain(".arashi/config.json");
    });
  });
});
