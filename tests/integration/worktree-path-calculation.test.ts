/**
 * Integration Tests: Worktree Path Calculation
 * Feature: 001-nested-worktree-paths
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import type { Config as ArashiConfig } from "../../src/lib/config.ts";
import type { Repository } from "../../src/core/repository.ts";
import { calculateWorktreePath } from "../../src/core/worktree.ts";
import { join } from "path";
import { spawn } from "child_process";

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

describe("calculateWorktreePath integration", () => {
  const testDir = join(import.meta.dirname, "..", "temp-integration-workspace", "worktree-paths");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("uses the branch-only path for a configured non-bare meta-repo", async () => {
    const metaRepoPath = join(testDir, "my-project");
    await createGitRepo(metaRepoPath, false);
    await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
    await writeFile(
      join(metaRepoPath, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0" }),
    );

    const repo: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "my-project",
      path: metaRepoPath,
    };
    const config: ArashiConfig = { repos: {}, reposDir: "./repos", version: "1.0.0" };

    const result = await calculateWorktreePath(repo, "feature-123", config);

    expect(result.path).toBe(join(metaRepoPath, ".arashi", "worktrees", "feature-123"));
    expect(result.repositoryType).toBe("meta-repo");
    expect(result.strategy).toBe("sibling");
  });

  test("namespaces configured bare worktrees beneath the canonical worktree name", async () => {
    const bareRepoPath = join(testDir, "my-project.git");
    await createGitRepo(bareRepoPath, true);
    await mkdir(join(bareRepoPath, ".arashi"), { recursive: true });
    await writeFile(
      join(bareRepoPath, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0" }),
    );

    const repo: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "configured-project",
      path: bareRepoPath,
      worktreeName: "my-project",
    };
    const config: ArashiConfig = { repos: {}, reposDir: "./repos", version: "1.0.0" };

    const result = await calculateWorktreePath(repo, "feature-123", config);

    expect(result.path).toBe(
      join(bareRepoPath, ".arashi", "worktrees", "my-project", "feature-123"),
    );
    expect(result.strategy).toBe("sibling");
  });

  test("nests child repos inside the branch-only non-bare parent destination", async () => {
    const metaRepoPath = join(testDir, "parent-repo");
    await createGitRepo(metaRepoPath, false);
    await mkdir(join(metaRepoPath, ".arashi"), { recursive: true });
    await writeFile(
      join(metaRepoPath, ".arashi", "config.json"),
      JSON.stringify({ reposDir: "./repos", version: "1.0.0" }),
    );

    const childRepoPath = join(metaRepoPath, "repos", "child-repo");
    await createGitRepo(childRepoPath, false);

    const childRepo: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "child-repo",
      path: childRepoPath,
    };
    const config: ArashiConfig = { repos: {}, reposDir: "./repos", version: "1.0.0" };

    const result = await calculateWorktreePath(childRepo, "feature-123", config);

    expect(result.path).toBe(
      join(metaRepoPath, ".arashi", "worktrees", "feature-123", "repos", "child-repo"),
    );
    expect(result.repositoryType).toBe("child");
    expect(result.strategy).toBe("nested");
  });

  test("nests child repos inside the repository-namespaced bare parent destination", async () => {
    const bareMetaRepoPath = join(testDir, "parent.git");
    await createGitRepo(bareMetaRepoPath, true);
    await mkdir(join(bareMetaRepoPath, ".arashi"), { recursive: true });
    await writeFile(
      join(bareMetaRepoPath, ".arashi", "config.json"),
      JSON.stringify({ reposDir: "./repos", version: "1.0.0" }),
    );

    const childRepoPath = join(bareMetaRepoPath, "repos", "child-repo");
    await createGitRepo(childRepoPath, false);

    const childRepo: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "child-repo",
      path: childRepoPath,
    };
    const config: ArashiConfig = { repos: {}, reposDir: "./repos", version: "1.0.0" };

    const result = await calculateWorktreePath(childRepo, "feature-123", config);

    expect(result.path).toBe(
      join(
        bareMetaRepoPath,
        ".arashi",
        "worktrees",
        "parent",
        "feature-123",
        "repos",
        "child-repo",
      ),
    );
    expect(result.parentWorktreePath).toBe(
      join(bareMetaRepoPath, ".arashi", "worktrees", "parent", "feature-123"),
    );
  });

  test("preserves slash branches beneath a custom configured worktree root", async () => {
    const bareRepoPath = join(testDir, "canonical.git");
    await createGitRepo(bareRepoPath, true);
    const repo: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "configured-name",
      path: bareRepoPath,
      worktreeName: "canonical",
    };
    const config: ArashiConfig = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreesDir: "../custom-worktrees",
    };

    const result = await calculateWorktreePath(repo, "feature/auth", config, {
      reason: "configured parent",
      type: "meta-repo",
    });

    expect(result.path).toBe(join(testDir, "custom-worktrees", "canonical", "feature", "auth"));
  });

  test("keeps adjacent bare repository and branch components in distinct namespaces", async () => {
    const firstPath = join(testDir, "example.git");
    const secondPath = join(testDir, "example-feature.git");
    await createGitRepo(firstPath, true);
    await createGitRepo(secondPath, true);
    const config: ArashiConfig = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreesDir: "../shared-worktrees",
    };

    const first = await calculateWorktreePath(
      {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "example.git",
        path: firstPath,
      },
      "feature/auth",
      config,
    );
    const second = await calculateWorktreePath(
      {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "example-feature.git",
        path: secondPath,
      },
      "auth",
      config,
    );

    expect(first.path).toBe(join(testDir, "shared-worktrees", "example", "feature", "auth"));
    expect(second.path).toBe(join(testDir, "shared-worktrees", "example-feature", "auth"));
    expect(first.path).not.toBe(second.path);
  });

  test("uses the authoritative parent destination instead of deriving a second parent name", async () => {
    const bareMetaRepoPath = join(testDir, "filesystem-name.git");
    await createGitRepo(bareMetaRepoPath, true);
    const childRepoPath = join(bareMetaRepoPath, "repos", "child-checkout");
    await createGitRepo(childRepoPath, false);
    const authoritativeParentWorktreePath = join(
      bareMetaRepoPath,
      ".arashi",
      "worktrees",
      "canonical-parent",
      "feature",
      "auth",
    );

    const result = await calculateWorktreePath({
      authoritativeParentWorktreePath,
      branchName: "feature/auth",
      config: { repos: {}, reposDir: "./repos", version: "1.0.0" },
      knownType: {
        parentName: "filesystem-name.git",
        reason: "configured child",
        reposDir: "repos",
        type: "child",
      },
      repo: {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "configured-child",
        path: childRepoPath,
        worktreeName: "child-checkout",
      },
    });

    expect(result.parentWorktreePath).toBe(authoritativeParentWorktreePath);
    expect(result.path).toBe(join(authoritativeParentWorktreePath, "repos", "child-checkout"));
  });
});
