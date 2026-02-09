/**
 * Unit tests for list.ts core functions
 *
 * Tests focus on individual helper functions and data transformations
 * without requiring full git repository setup.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getShortCommitSha,
  hasUncommittedChanges,
  validateWorktreeListItem,
  validateListCommandOutput,
  formatAsTable,
  formatAsJson,
  gatherWorktreeData,
  discoverSubRepositories,
  findGitRepositories,
} from "../../../src/core/list";
import type {
  WorktreeListItem,
  ListCommandOutput,
  SubRepositoryInfo,
} from "../../../src/types/list";
import { ListCommandError } from "../../../src/types/list";
import { GitTestRepo, createFile, commitChanges } from "../../helpers/git-test-utils";
import { mkdir } from "fs/promises";
import { join } from "path";

describe("getShortCommitSha()", () => {
  let testRepo: GitTestRepo;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("returns 7-character commit SHA", async () => {
    const sha = await getShortCommitSha(testRepo.path);

    expect(sha).toBeDefined();
    expect(sha).toMatch(/^[0-9a-f]{7}$/);
    expect(sha.length).toBe(7);
  });

  test("throws ListCommandError for invalid repository path", async () => {
    await expect(async () => {
      await getShortCommitSha("/nonexistent/path");
    }).toThrow(ListCommandError);
  });

  test("returns consistent SHA for same commit", async () => {
    const sha1 = await getShortCommitSha(testRepo.path);
    const sha2 = await getShortCommitSha(testRepo.path);

    expect(sha1).toBe(sha2);
  });

  test("returns different SHA after new commit", async () => {
    const sha1 = await getShortCommitSha(testRepo.path);

    // Create a new commit
    await createFile(testRepo.path, "test.txt", "content");
    await commitChanges(testRepo.path, "Add test file");

    const sha2 = await getShortCommitSha(testRepo.path);

    expect(sha1).not.toBe(sha2);
  });
});

describe("hasUncommittedChanges()", () => {
  let testRepo: GitTestRepo;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("returns false when repository is clean", async () => {
    const hasChanges = await hasUncommittedChanges(testRepo.path);

    expect(hasChanges).toBe(false);
  });

  test("returns true when untracked files exist", async () => {
    await createFile(testRepo.path, "untracked.txt", "content");

    const hasChanges = await hasUncommittedChanges(testRepo.path);

    expect(hasChanges).toBe(true);
  });

  test("returns true when tracked files are modified", async () => {
    // Create and commit a file
    await createFile(testRepo.path, "tracked.txt", "original");
    await commitChanges(testRepo.path, "Add tracked file");

    // Modify it
    await createFile(testRepo.path, "tracked.txt", "modified");

    const hasChanges = await hasUncommittedChanges(testRepo.path);

    expect(hasChanges).toBe(true);
  });

  test("throws ListCommandError for invalid repository path", async () => {
    await expect(async () => {
      await hasUncommittedChanges("/nonexistent/path");
    }).toThrow(ListCommandError);
  });
});

describe("validateWorktreeListItem()", () => {
  test("validates a valid worktree item", () => {
    const validItem: WorktreeListItem = {
      path: "/absolute/path/to/worktree",
      branch: "main",
      commit: "abc1234",
      locked: false,
      hasChanges: false,
      isMain: true,
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("validates worktree with null branch (detached HEAD)", () => {
    const validItem: WorktreeListItem = {
      path: "/absolute/path/to/worktree",
      branch: null,
      commit: "abc1234",
      locked: false,
      hasChanges: false,
      isMain: false,
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("validates locked worktree with lock reason", () => {
    const validItem: WorktreeListItem = {
      path: "/absolute/path/to/worktree",
      branch: "feature",
      commit: "def5678",
      locked: true,
      lockReason: "Working on critical fix",
      hasChanges: true,
      isMain: false,
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("validates worktree with sub-repositories", () => {
    const validItem: WorktreeListItem = {
      path: "/absolute/path/to/worktree",
      branch: "main",
      commit: "abc1234",
      locked: false,
      hasChanges: false,
      isMain: true,
      subRepositories: [
        {
          relativePath: "repos/sub-repo",
          branch: "main",
          commit: "xyz9876",
          hasChanges: false,
        },
      ],
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("throws for relative path", () => {
    const invalidItem = {
      path: "relative/path",
      branch: "main",
      commit: "abc1234",
      locked: false,
      hasChanges: false,
      isMain: true,
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for invalid commit format (not 7 hex characters)", () => {
    const invalidItem = {
      path: "/absolute/path",
      branch: "main",
      commit: "invalid",
      locked: false,
      hasChanges: false,
      isMain: true,
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for non-boolean locked field", () => {
    const invalidItem = {
      path: "/absolute/path",
      branch: "main",
      commit: "abc1234",
      locked: "yes" as unknown as boolean,
      hasChanges: false,
      isMain: true,
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for non-string branch when not null", () => {
      const invalidItem = {
      path: "/absolute/path",
      branch: 123 as unknown as string,
      commit: "abc1234",
      locked: false,
      hasChanges: false,
      isMain: true,
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for non-array subRepositories", () => {
    const invalidItem = {
      path: "/absolute/path",
      branch: "main",
      commit: "abc1234",
      locked: false,
      hasChanges: false,
      isMain: true,
      subRepositories: "not an array" as unknown as SubRepositoryInfo[],
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });
});

describe("validateListCommandOutput()", () => {
  test("validates valid output structure", () => {
    const validOutput: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
        {
          path: "/repo/feature",
          branch: "feature",
          commit: "def5678",
          locked: false,
          hasChanges: true,
          isMain: false,
        },
      ],
      totalCount: 2,
      repositoryPath: "/repo/main",
    };

    expect(() => {
      validateListCommandOutput(validOutput);
    }).not.toThrow();
  });

  test("throws when worktrees is empty", () => {
    const invalidOutput = {
      worktrees: [],
      totalCount: 0,
      repositoryPath: "/repo",
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when totalCount does not match array length", () => {
    const invalidOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
      ],
      totalCount: 5,
      repositoryPath: "/repo",
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when no main worktree exists", () => {
    const invalidOutput = {
      worktrees: [
        {
          path: "/repo/feature1",
          branch: "feature1",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: false,
        },
        {
          path: "/repo/feature2",
          branch: "feature2",
          commit: "def5678",
          locked: false,
          hasChanges: false,
          isMain: false,
        },
      ],
      totalCount: 2,
      repositoryPath: "/repo",
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when multiple main worktrees exist", () => {
    const invalidOutput = {
      worktrees: [
        {
          path: "/repo/main1",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
        {
          path: "/repo/main2",
          branch: "main",
          commit: "def5678",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
      ],
      totalCount: 2,
      repositoryPath: "/repo",
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when repositoryPath is relative", () => {
    const invalidOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
      ],
      totalCount: 1,
      repositoryPath: "relative/path",
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });
});

describe("formatAsJson()", () => {
  test("formats output as valid JSON", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
      ],
      totalCount: 1,
      repositoryPath: "/repo/main",
    };

    const json = formatAsJson(output);

    expect(json).toBeDefined();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("JSON output contains all worktree fields", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
      ],
      totalCount: 1,
      repositoryPath: "/repo/main",
    };

    const json = formatAsJson(output);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe("/repo/main");
    expect(parsed[0].branch).toBe("main");
    expect(parsed[0].commit).toBe("abc1234");
    expect(parsed[0].locked).toBe(false);
    expect(parsed[0].hasChanges).toBe(false);
    expect(parsed[0].isMain).toBe(true);
  });

  test("JSON output includes sub-repositories when present", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
          subRepositories: [
            {
              relativePath: "repos/sub",
              branch: "develop",
              commit: "xyz9876",
              hasChanges: true,
            },
          ],
        },
      ],
      totalCount: 1,
      repositoryPath: "/repo/main",
    };

    const json = formatAsJson(output);
    const parsed = JSON.parse(json);

    expect(parsed[0].subRepositories).toBeDefined();
    expect(parsed[0].subRepositories).toHaveLength(1);
    expect(parsed[0].subRepositories[0].relativePath).toBe("repos/sub");
  });
});

describe("formatAsTable()", () => {
  test("formats single main worktree with helpful message", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
      ],
      totalCount: 1,
      repositoryPath: "/repo/main",
    };

    const table = formatAsTable(output, false);

    expect(table).toContain("No additional worktrees found");
    expect(table).toContain("arashi create");
    expect(table).toContain("/repo/main");
  });

  test("formats multiple worktrees in table format", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
        {
          path: "/repo/feature",
          branch: "feature",
          commit: "def5678",
          locked: false,
          hasChanges: true,
          isMain: false,
        },
      ],
      totalCount: 2,
      repositoryPath: "/repo/main",
    };

    const table = formatAsTable(output, false);

    expect(table).toContain("Worktrees (2 total)");
    expect(table).toContain("PATH");
    expect(table).toContain("BRANCH");
    expect(table).toContain("STATUS");
    expect(table).toContain("/repo/main");
    expect(table).toContain("/repo/feature");
    expect(table).toContain("Legend");
  });

  test("verbose mode shows detailed information", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
          subRepositories: [
            {
              relativePath: "repos/sub",
              branch: "develop",
              commit: "xyz9876",
              hasChanges: true,
            },
          ],
        },
        {
          path: "/repo/feature",
          branch: "feature",
          commit: "def5678",
          locked: false,
          hasChanges: true,
          isMain: false,
        },
      ],
      totalCount: 2,
      repositoryPath: "/repo/main",
    };

    const table = formatAsTable(output, true);

    expect(table).toContain("PATH:");
    expect(table).toContain("BRANCH:");
    expect(table).toContain("STATUS:");
    expect(table).toContain("TYPE:");
    expect(table).toContain("SUB-REPOSITORIES:");
    expect(table).toContain("repos/sub");
    expect(table).toContain("develop");
  });

  test("shows locked status for locked worktrees", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
        {
          path: "/repo/locked",
          branch: "feature",
          commit: "def5678",
          locked: true,
          lockReason: "Critical work in progress",
          hasChanges: false,
          isMain: false,
        },
      ],
      totalCount: 2,
      repositoryPath: "/repo/main",
    };

    const table = formatAsTable(output, false);

    expect(table).toContain("locked");
  });

  test("shows detached HEAD correctly", () => {
    const output: ListCommandOutput = {
      worktrees: [
        {
          path: "/repo/main",
          branch: "main",
          commit: "abc1234",
          locked: false,
          hasChanges: false,
          isMain: true,
        },
        {
          path: "/repo/detached",
          branch: null,
          commit: "def5678",
          locked: false,
          hasChanges: false,
          isMain: false,
        },
      ],
      totalCount: 2,
      repositoryPath: "/repo/main",
    };

    const table = formatAsTable(output, false);

    expect(table).toContain("detached");
  });
});

describe("findGitRepositories()", () => {
  let testRepo: GitTestRepo;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("finds git repository in direct subdirectory", async () => {
    // Create a nested git repository
    const nestedRepoPath = join(testRepo.path, "nested-repo");
    await mkdir(nestedRepoPath, { recursive: true });

    const { spawn } = await import("bun");
    await spawn(["git", "init"], { cwd: nestedRepoPath }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: nestedRepoPath })
      .exited;
    await spawn(["git", "config", "user.name", "Test User"], { cwd: nestedRepoPath }).exited;

    const repos = await findGitRepositories(testRepo.path, 3, true);

    expect(repos).toContain(nestedRepoPath);
  });

  test("respects maxDepth parameter", async () => {
    // Create nested repositories at different depths
    const depth1 = join(testRepo.path, "level1");
    const depth2 = join(depth1, "level2");
    const depth3 = join(depth2, "level3");

    await mkdir(depth3, { recursive: true });

    const { spawn } = await import("bun");

    // Initialize git repos at each level
    for (const path of [depth1, depth2, depth3]) {
      await spawn(["git", "init"], { cwd: path }).exited;
      await spawn(["git", "config", "user.email", "test@example.com"], { cwd: path }).exited;
      await spawn(["git", "config", "user.name", "Test"], { cwd: path }).exited;
    }

    // Search with maxDepth = 1 (should only find level1)
    const reposDepth1 = await findGitRepositories(testRepo.path, 1, true);
    expect(reposDepth1).toContain(depth1);
    expect(reposDepth1).not.toContain(depth2);
    expect(reposDepth1).not.toContain(depth3);

    // Search with maxDepth = 2 (should find level1 and level2)
    const reposDepth2 = await findGitRepositories(testRepo.path, 2, true);
    expect(reposDepth2).toContain(depth1);
    expect(reposDepth2).toContain(depth2);
    expect(reposDepth2).not.toContain(depth3);
  });

  test("excludes root repository when excludeRoot is true", async () => {
    const repos = await findGitRepositories(testRepo.path, 3, true);

    expect(repos).not.toContain(testRepo.path);
  });

  test("includes root repository when excludeRoot is false", async () => {
    const repos = await findGitRepositories(testRepo.path, 3, false);

    expect(repos).toContain(testRepo.path);
  });

  test("skips node_modules directories", async () => {
    // Create a git repo inside node_modules
    const nodeModulesRepo = join(testRepo.path, "node_modules", "some-package");
    await mkdir(nodeModulesRepo, { recursive: true });

    const { spawn } = await import("bun");
    await spawn(["git", "init"], { cwd: nodeModulesRepo }).exited;

    const repos = await findGitRepositories(testRepo.path, 5, true);

    expect(repos).not.toContain(nodeModulesRepo);
  });

  test("skips .arashi directories", async () => {
    // Create a git repo inside .arashi
    const arashiRepo = join(testRepo.path, ".arashi", "some-repo");
    await mkdir(arashiRepo, { recursive: true });

    const { spawn } = await import("bun");
    await spawn(["git", "init"], { cwd: arashiRepo }).exited;

    const repos = await findGitRepositories(testRepo.path, 5, true);

    expect(repos).not.toContain(arashiRepo);
  });

  test("returns empty array when no repositories found", async () => {
    // Create directory with no git repos
    const emptyDir = join(testRepo.path, "empty");
    await mkdir(emptyDir);

    const repos = await findGitRepositories(emptyDir, 3, false);

    expect(repos).toEqual([]);
  });
});

describe("gatherWorktreeData()", () => {
  let testRepo: GitTestRepo;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("returns main worktree data", async () => {
    const worktrees = await gatherWorktreeData(testRepo.path);

    expect(worktrees).toHaveLength(1);
    // Use realpath to handle /private/var vs /var on macOS
    const { realpathSync } = await import("fs");
    expect(realpathSync(worktrees[0].path)).toBe(realpathSync(testRepo.path));
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[0].hasChanges).toBe(false);
  });

  test("detects uncommitted changes in main worktree", async () => {
    await createFile(testRepo.path, "test.txt", "content");

    const worktrees = await gatherWorktreeData(testRepo.path);

    expect(worktrees[0].hasChanges).toBe(true);
  });

  test("includes branch name for main worktree", async () => {
    const worktrees = await gatherWorktreeData(testRepo.path);

    // Default branch is usually 'main' or 'master'
    expect(worktrees[0].branch).toBeDefined();
    expect(typeof worktrees[0].branch).toBe("string");
  });

  test("includes valid commit SHA", async () => {
    const worktrees = await gatherWorktreeData(testRepo.path);

    expect(worktrees[0].commit).toMatch(/^[0-9a-f]{7}$/);
  });
});

describe("discoverSubRepositories()", () => {
  let testRepo: GitTestRepo;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("discovers nested git repository", async () => {
    // Create nested repo
    const nestedPath = join(testRepo.path, "repos", "nested");
    await mkdir(nestedPath, { recursive: true });

    const { spawn } = await import("bun");
    await spawn(["git", "init"], { cwd: nestedPath }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: nestedPath }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: nestedPath }).exited;

    // Create initial commit
    await createFile(nestedPath, "README.md", "# Nested");
    await commitChanges(nestedPath, "Initial commit");

    const subRepos = await discoverSubRepositories(testRepo.path, 3);

    expect(subRepos).toHaveLength(1);
    expect(subRepos[0].relativePath).toBe("repos/nested");
  });

  test("detects uncommitted changes in sub-repository", async () => {
    // Create nested repo with changes
    const nestedPath = join(testRepo.path, "repos", "nested");
    await mkdir(nestedPath, { recursive: true });

    const { spawn } = await import("bun");
    await spawn(["git", "init"], { cwd: nestedPath }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: nestedPath }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: nestedPath }).exited;

    // Create initial commit
    await createFile(nestedPath, "README.md", "# Nested");
    await commitChanges(nestedPath, "Initial commit");

    // Add uncommitted changes
    await createFile(nestedPath, "changes.txt", "uncommitted");

    const subRepos = await discoverSubRepositories(testRepo.path, 3);

    expect(subRepos[0].hasChanges).toBe(true);
  });

  test("returns empty array when no sub-repositories exist", async () => {
    const subRepos = await discoverSubRepositories(testRepo.path, 3);

    expect(subRepos).toEqual([]);
  });
});
