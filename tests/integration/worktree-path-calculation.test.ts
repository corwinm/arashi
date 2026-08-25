/**
 * Integration Tests: Worktree Path Calculation
 * Feature: 001-nested-worktree-paths
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "fs/promises";
import type { Config as ArashiConfig } from "../../src/lib/config.ts";
import type { Repository } from "../../src/core/repository.ts";
import { calculateWorktreePath, calculateWorktreePathPlan } from "../../src/core/worktree.ts";
import { join } from "path";
import { createHash } from "node:crypto";
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

  test("keeps the root workspace meta-repo authoritative when a configured child is also a meta-repo", async () => {
    const rootPath = join(testDir, "workspace");
    await createGitRepo(rootPath, false);
    await mkdir(join(rootPath, ".arashi"), { recursive: true });
    await writeFile(
      join(rootPath, ".arashi", "config.json"),
      JSON.stringify({ reposDir: "./repos", version: "1.0.0" }),
    );
    const nestedMetaPath = join(rootPath, "repos", "nested-meta");
    await createGitRepo(nestedMetaPath, false);
    await mkdir(join(nestedMetaPath, ".arashi"), { recursive: true });
    await writeFile(
      join(nestedMetaPath, ".arashi", "config.json"),
      JSON.stringify({ reposDir: "./repos", version: "1.0.0" }),
    );
    const ordinaryChildPath = join(rootPath, "repos", "ordinary-child");
    await createGitRepo(ordinaryChildPath, false);

    const repositories: Repository[] = [
      {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "workspace",
        path: rootPath,
      },
      {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "nested-meta",
        path: nestedMetaPath,
      },
      {
        defaultBranch: "main",
        hasSetupScript: false,
        name: "ordinary-child",
        path: ordinaryChildPath,
      },
    ];
    const plan = await calculateWorktreePathPlan(repositories, "feature/nested-config", {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });
    const rootDestination = join(rootPath, ".arashi", "worktrees", "feature", "nested-config");

    expect(plan.get(repositories[0]!)?.path).toBe(rootDestination);
    expect(plan.get(repositories[1]!)?.repositoryType).toBe("meta-repo");
    expect(plan.get(repositories[2]!)?.path).toBe(join(rootDestination, "repos", "ordinary-child"));
  });

  test("keeps under-budget configured paths byte-for-byte unchanged", async () => {
    const rootPath = join(testDir, "under-budget");
    await createGitRepo(rootPath);
    const repository: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "under-budget",
      path: rootPath,
    };
    const baseConfig: ArashiConfig = { repos: {}, reposDir: "./repos", version: "1.0.0" };
    const ordinary = await calculateWorktreePath(repository, "feature/short", baseConfig, {
      reason: "configured parent",
      type: "meta-repo",
    });
    const budgeted = await calculateWorktreePath(
      repository,
      "feature/short",
      { ...baseConfig, worktreeNaming: { maxPathLength: ordinary.path.length } },
      { reason: "configured parent", type: "meta-repo" },
    );

    expect(budgeted).toEqual(ordinary);
  });

  test("shortens deterministically with the portable ordinary namespace SHA-256 suffix", async () => {
    const rootPath = join(testDir, "stable-hash");
    await createGitRepo(rootPath);
    const branch = "feature/this-is-an-extremely-long-generated-parent-namespace";
    const portableNamespace = branch;
    const suffix = createHash("sha256").update(portableNamespace).digest("hex").slice(0, 8);
    const base = join(rootPath, ".arashi", "worktrees");
    const maxPathLength = base.length + 1 + 24;
    const config: ArashiConfig = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreeNaming: { maxPathLength },
    };
    const repository: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "stable-hash",
      path: rootPath,
    };

    const first = await calculateWorktreePath(repository, branch, config, {
      reason: "configured parent",
      type: "meta-repo",
    });
    const second = await calculateWorktreePath(repository, branch, config, {
      reason: "configured parent",
      type: "meta-repo",
    });

    expect(first.path).toBe(join(base, `feature/this-is-${suffix}`));
    expect(first.path.length).toBe(maxPathLength);
    expect(second.path).toBe(first.path);
  });

  test("counts UTF-16 units without splitting a surrogate pair", async () => {
    const rootPath = join(testDir, "unicode-safe");
    await createGitRepo(rootPath);
    const branch = "abc😀definitely-too-long";
    const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
    const base = join(rootPath, ".arashi", "worktrees");
    const repository: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "unicode-safe",
      path: rootPath,
    };
    const result = await calculateWorktreePath(
      repository,
      branch,
      {
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreeNaming: { maxPathLength: base.length + 1 + 13 },
      },
      { reason: "configured parent", type: "meta-repo" },
    );

    expect(result.path).toBe(join(base, `abc-${hash}`));
    expect(result.path).not.toContain("\uFFFD");
  });

  test("hashes distinct ordinary namespaces while preserving deliberate ordinary aliases", async () => {
    const firstPath = join(testDir, "hash-one.git");
    const secondPath = join(testDir, "hash-two.git");
    await createGitRepo(firstPath, true);
    await createGitRepo(secondPath, true);
    const branch = "feature/shared-readable-prefix-that-needs-shortening";
    const sharedBase = "../shared-fitted";
    const makeConfig = (style: "branch" | "default" | "repo-branch"): ArashiConfig => ({
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreeNaming: { maxPathLength: join(testDir, "shared-fitted").length + 22, style },
      worktreesDir: sharedBase,
    });
    const first: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "hash-one.git",
      path: firstPath,
    };
    const second: Repository = { ...first, name: "hash-two.git", path: secondPath };

    const configuredParent = { reason: "configured parent", type: "meta-repo" as const };
    const distinctFirst = await calculateWorktreePath(
      first,
      branch,
      makeConfig("repo-branch"),
      configuredParent,
    );
    const distinctSecond = await calculateWorktreePath(
      second,
      branch,
      makeConfig("repo-branch"),
      configuredParent,
    );
    const aliasFirst = await calculateWorktreePath(
      first,
      branch,
      makeConfig("branch"),
      configuredParent,
    );
    const aliasSecond = await calculateWorktreePath(
      second,
      branch,
      makeConfig("branch"),
      configuredParent,
    );

    expect(distinctFirst.path).not.toBe(distinctSecond.path);
    expect(distinctFirst.path).toContain(
      createHash("sha256").update(`hash-one-${branch}`).digest("hex").slice(0, 8),
    );
    expect(distinctSecond.path).toContain(
      createHash("sha256").update(`hash-two-${branch}`).digest("hex").slice(0, 8),
    );
    expect(aliasFirst.path).toBe(aliasSecond.path);
  });

  test("sizes one parent against the longest selected child for parent and child-only plans", async () => {
    const rootPath = join(testDir, "coordinated");
    await createGitRepo(rootPath);
    const shortPath = join(rootPath, "repos", "short");
    const longPath = join(rootPath, "packages", "deep", "longest-child-name");
    await createGitRepo(shortPath);
    await createGitRepo(longPath);
    const parent: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "coordinated",
      path: rootPath,
    };
    const short: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "short",
      path: shortPath,
    };
    const longest: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "longest",
      path: longPath,
    };
    const base = join(rootPath, ".arashi", "worktrees");
    const longestSuffix = join("packages", "deep", "longest-child-name");
    const maxPathLength = base.length + 1 + 18 + 1 + longestSuffix.length;
    const config: ArashiConfig = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreeNaming: { maxPathLength },
    };

    const parentSelected = await calculateWorktreePathPlan(
      [parent, short, longest],
      "feature/a-parent-name-that-is-much-too-long",
      config,
      parent,
    );
    const childOnly = await calculateWorktreePathPlan(
      [short, longest],
      "feature/a-parent-name-that-is-much-too-long",
      config,
      parent,
    );
    const parentPath = parentSelected.get(parent)!.path;

    expect([...childOnly.keys()]).toEqual([short, longest]);
    expect(parentSelected.get(short)!.path).toBe(join(parentPath, "repos", "short"));
    expect(parentSelected.get(longest)!.path).toBe(join(parentPath, longestSuffix));
    expect(childOnly.get(short)!.parentWorktreePath).toBe(parentPath);
    expect(childOnly.get(longest)!.parentWorktreePath).toBe(parentPath);
    expect(childOnly.get(longest)!.path.length).toBeLessThanOrEqual(maxPathLength);
  });

  test("reports the first impossible selected destination with exact overflow details", async () => {
    const rootPath = join(testDir, "overflow");
    await createGitRepo(rootPath);
    const childPath = join(rootPath, "repos", "api");
    await createGitRepo(childPath);
    const parent: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "overflow",
      path: rootPath,
    };
    const child: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "api",
      path: childPath,
    };
    const base = join(rootPath, ".arashi", "worktrees");
    const maxPathLength = base.length + 1 + 8 + 1 + join("repos", "api").length;
    const ordinaryPath = join(base, "feature", "far-too-long", "repos", "api");

    await expect(
      calculateWorktreePathPlan(
        [child],
        "feature/far-too-long",
        {
          repos: {},
          reposDir: "./repos",
          version: "1.0.0",
          worktreeNaming: { maxPathLength },
        },
        parent,
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_PATH_LENGTH_EXCEEDED",
      details: {
        maxPathLength,
        minimumPathLength: maxPathLength + 1,
        repositoryName: "api",
        worktreePath: ordinaryPath,
      },
    });
  });
});
