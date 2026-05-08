/**
 * Unit tests for list.ts core functions
 *
 * Tests focus on individual helper functions and data transformations
 * without requiring full git repository setup.
 */

import { GitTestRepo, commitChanges, createFile } from "../../helpers/git-test-utils";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  discoverSubRepositories,
  findGitRepositories,
  findParentRepo,
  formatAsJson,
  formatAsTable,
  gatherWorktreeData,
  getShortCommitSha,
  hasUncommittedChanges,
  validateListCommandOutput,
  validateWorktreeListItem,
} from "../../../src/core/list";
import { mkdir, mkdtemp, rename, rm, writeFile } from "fs/promises";
import { ListCommandError } from "../../../src/types/list";
import { join } from "path";
import { realpathSync } from "fs";
import { tmpdir } from "os";

interface SubRepositoryInfo {
  relativePath: string;
  branch: string | null;
  commit: string;
  hasChanges: boolean;
}

const toComparablePath = (value: string): string =>
  realpathSync.native(value).replaceAll("\\", "/").toLowerCase();

interface WorktreeListItem {
  path: string;
  branch: string | null;
  commit: string;
  locked: boolean;
  lockReason?: string;
  hasChanges: boolean;
  isMain: boolean;
  parentPath?: string | null;
  childrenPaths?: string[];
  subRepositories?: SubRepositoryInfo[];
}

interface ListCommandOutput {
  worktrees: WorktreeListItem[];
  totalCount: number;
  repositoryPath: string;
}

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

describe("findParentRepo()", () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "arashi-list-parent-"));
  });

  afterEach(async () => {
    await rm(testRoot, { force: true, recursive: true });
  });

  test("returns null when no Arashi config exists in the ancestor chain", async () => {
    const nestedPath = join(testRoot, "deep", "nested", "repo");
    await mkdir(nestedPath, { recursive: true });

    await expect(findParentRepo(nestedPath)).resolves.toBeNull();
  });

  test("returns the parent repo when current path is inside reposDir", async () => {
    const parentRepoPath = join(testRoot, "workspace");
    const childRepoPath = join(parentRepoPath, "repos", "child-repo");

    await mkdir(join(parentRepoPath, ".arashi"), { recursive: true });
    await mkdir(childRepoPath, { recursive: true });
    await writeFile(
      join(parentRepoPath, ".arashi", "config.json"),
      JSON.stringify(
        {
          repos: {},
          reposDir: "./repos",
          version: "1.0.0",
        },
        null,
        2,
      ),
    );

    await expect(findParentRepo(childRepoPath)).resolves.toBe(parentRepoPath);
  });
});

describe("validateWorktreeListItem()", () => {
  test("validates a valid worktree item", () => {
    const validItem: WorktreeListItem = {
      branch: "main",
      commit: "abc1234",
      hasChanges: false,
      isMain: true,
      locked: false,
      path: "/absolute/path/to/worktree",
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("validates worktree with null branch (detached HEAD)", () => {
    const validItem: WorktreeListItem = {
      branch: null,
      commit: "abc1234",
      hasChanges: false,
      isMain: false,
      locked: false,
      path: "/absolute/path/to/worktree",
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("validates locked worktree with lock reason", () => {
    const validItem: WorktreeListItem = {
      branch: "feature",
      commit: "def5678",
      hasChanges: true,
      isMain: false,
      lockReason: "Working on critical fix",
      locked: true,
      path: "/absolute/path/to/worktree",
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("validates worktree with sub-repositories", () => {
    const validItem: WorktreeListItem = {
      branch: "main",
      commit: "abc1234",
      hasChanges: false,
      isMain: true,
      locked: false,
      path: "/absolute/path/to/worktree",
      subRepositories: [
        {
          branch: "main",
          commit: "xyz9876",
          hasChanges: false,
          relativePath: "repos/sub-repo",
        },
      ],
    };

    expect(() => {
      validateWorktreeListItem(validItem);
    }).not.toThrow();
  });

  test("throws for relative path", () => {
    const invalidItem = {
      branch: "main",
      commit: "abc1234",
      hasChanges: false,
      isMain: true,
      locked: false,
      path: "relative/path",
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for invalid commit format (not 7 hex characters)", () => {
    const invalidItem = {
      branch: "main",
      commit: "invalid",
      hasChanges: false,
      isMain: true,
      locked: false,
      path: "/absolute/path",
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for non-boolean locked field", () => {
    const invalidItem = {
      branch: "main",
      commit: "abc1234",
      hasChanges: false,
      isMain: true,
      locked: "yes" as unknown as boolean,
      path: "/absolute/path",
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for non-string branch when not null", () => {
    const invalidItem = {
      branch: 123 as unknown as string,
      commit: "abc1234",
      hasChanges: false,
      isMain: true,
      locked: false,
      path: "/absolute/path",
    };

    expect(() => {
      validateWorktreeListItem(invalidItem);
    }).toThrow(ListCommandError);
  });

  test("throws for non-array subRepositories", () => {
    const invalidItem = {
      branch: "main",
      commit: "abc1234",
      hasChanges: false,
      isMain: true,
      locked: false,
      path: "/absolute/path",
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
      repositoryPath: "/repo/main",
      totalCount: 2,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
        {
          branch: "feature",
          commit: "def5678",
          hasChanges: true,
          isMain: false,
          locked: false,
          path: "/repo/feature",
        },
      ],
    };

    expect(() => {
      validateListCommandOutput(validOutput);
    }).not.toThrow();
  });

  test("throws when worktrees is empty", () => {
    const invalidOutput = {
      repositoryPath: "/repo",
      totalCount: 0,
      worktrees: [],
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when totalCount does not match array length", () => {
    const invalidOutput = {
      repositoryPath: "/repo",
      totalCount: 5,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
      ],
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when no main worktree exists", () => {
    const invalidOutput = {
      repositoryPath: "/repo",
      totalCount: 2,
      worktrees: [
        {
          branch: "feature1",
          commit: "abc1234",
          hasChanges: false,
          isMain: false,
          locked: false,
          path: "/repo/feature1",
        },
        {
          branch: "feature2",
          commit: "def5678",
          hasChanges: false,
          isMain: false,
          locked: false,
          path: "/repo/feature2",
        },
      ],
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when multiple main worktrees exist", () => {
    const invalidOutput = {
      repositoryPath: "/repo",
      totalCount: 2,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main1",
        },
        {
          branch: "main",
          commit: "def5678",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main2",
        },
      ],
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });

  test("throws when repositoryPath is relative", () => {
    const invalidOutput = {
      repositoryPath: "relative/path",
      totalCount: 1,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
      ],
    };

    expect(() => {
      validateListCommandOutput(invalidOutput);
    }).toThrow(ListCommandError);
  });
});

describe("formatAsJson()", () => {
  test("formats output as valid JSON", () => {
    const output: ListCommandOutput = {
      repositoryPath: "/repo/main",
      totalCount: 1,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
      ],
    };

    const json = formatAsJson(output);

    expect(json).toBeDefined();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("JSON output contains all worktree fields", () => {
    const output: ListCommandOutput = {
      repositoryPath: "/repo/main",
      totalCount: 1,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
      ],
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
      repositoryPath: "/repo/main",
      totalCount: 1,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
          subRepositories: [
            {
              branch: "develop",
              commit: "xyz9876",
              hasChanges: true,
              relativePath: "repos/sub",
            },
          ],
        },
      ],
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
      repositoryPath: "/repo/main",
      totalCount: 1,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
      ],
    };

    const table = formatAsTable(output, false);

    expect(table).toContain("No additional worktrees found");
    expect(table).toContain("arashi create");
    expect(table).toContain("/repo/main");
  });

  test("formats multiple worktrees in table format", () => {
    const output: ListCommandOutput = {
      repositoryPath: "/repo/main",
      totalCount: 2,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
        {
          branch: "feature",
          commit: "def5678",
          hasChanges: true,
          isMain: false,
          locked: false,
          path: "/repo/feature",
        },
      ],
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
      repositoryPath: "/repo/main",
      totalCount: 2,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
          subRepositories: [
            {
              branch: "develop",
              commit: "xyz9876",
              hasChanges: true,
              relativePath: "repos/sub",
            },
          ],
        },
        {
          branch: "feature",
          commit: "def5678",
          hasChanges: true,
          isMain: false,
          locked: false,
          path: "/repo/feature",
        },
      ],
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
      repositoryPath: "/repo/main",
      totalCount: 2,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
        {
          branch: "feature",
          commit: "def5678",
          hasChanges: false,
          isMain: false,
          lockReason: "Critical work in progress",
          locked: true,
          path: "/repo/locked",
        },
      ],
    };

    const table = formatAsTable(output, false);

    expect(table).toContain("locked");
  });

  test("shows detached HEAD correctly", () => {
    const output: ListCommandOutput = {
      repositoryPath: "/repo/main",
      totalCount: 2,
      worktrees: [
        {
          branch: "main",
          commit: "abc1234",
          hasChanges: false,
          isMain: true,
          locked: false,
          path: "/repo/main",
        },
        {
          branch: null,
          commit: "def5678",
          hasChanges: false,
          isMain: false,
          locked: false,
          path: "/repo/detached",
        },
      ],
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

  test("finds repository when nested git metadata uses a .git file", async () => {
    const nestedRepoPath = join(testRepo.path, "linked-repo");
    await mkdir(nestedRepoPath, { recursive: true });

    const { spawn } = await import("bun");
    await spawn(["git", "init"], { cwd: nestedRepoPath }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: nestedRepoPath })
      .exited;
    await spawn(["git", "config", "user.name", "Test User"], { cwd: nestedRepoPath }).exited;
    await rename(join(nestedRepoPath, ".git"), join(nestedRepoPath, ".gitdir"));
    await writeFile(join(nestedRepoPath, ".git"), "gitdir: ./.gitdir\n");

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
    expect(toComparablePath(worktrees[0].path)).toBe(toComparablePath(testRepo.path));
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

  test("discovers nested repository when git metadata uses a .git file", async () => {
    const nestedPath = join(testRepo.path, "repos", "linked-nested");
    await mkdir(nestedPath, { recursive: true });

    const { spawn } = await import("bun");
    await spawn(["git", "init"], { cwd: nestedPath }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: nestedPath }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: nestedPath }).exited;
    await createFile(nestedPath, "README.md", "# Linked Nested");
    await commitChanges(nestedPath, "Initial commit");
    await rename(join(nestedPath, ".git"), join(nestedPath, ".gitdir"));
    await writeFile(join(nestedPath, ".git"), "gitdir: ./.gitdir\n");

    const subRepos = await discoverSubRepositories(testRepo.path, 3);

    expect(subRepos).toHaveLength(1);
    expect(subRepos[0].relativePath).toBe("repos/linked-nested");
  });

  test("returns empty array when no sub-repositories exist", async () => {
    const subRepos = await discoverSubRepositories(testRepo.path, 3);

    expect(subRepos).toEqual([]);
  });
});
