import { runtime } from "#test-runtime";
/**
 * Unit tests for git.ts core functions
 *
 * These tests focus on the exec() function which is the foundation
 * for all git operations.
 */

import {
  GitTestRepo,
  commitChanges,
  createFile,
  createInitialCommit,
  createTempDir,
  initBareGitRepo,
  removeTempDir,
} from "../../helpers/git-test-utils";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  exec,
  getDefaultBranch,
  isBareRepo,
  readTrackedFileFromDefaultBranch,
} from "../../../src/lib/git";
import { ArashiError } from "../../../src/lib/errors";
import { join } from "path";
import { realpathSync } from "fs";

const toComparablePath = (value: string): string =>
  realpathSync.native(value).replaceAll("\\", "/").toLowerCase();

describe("exec()", () => {
  let testRepo: GitTestRepo;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("should execute git command successfully and return CommandResult", async () => {
    const result = await exec(["status", "--porcelain"], testRepo.path);

    expect(result).toBeDefined();
    expect(result.stdout).toBeDefined();
    expect(result.stderr).toBeDefined();
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });

  test("should capture stdout from successful git command", async () => {
    const result = await exec(["rev-parse", "--show-toplevel"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(toComparablePath(result.stdout.trim())).toBe(toComparablePath(testRepo.path));
    expect(result.stderr).toBe("");
  });

  test("should throw ArashiError on git command failure", async () => {
    await expect(exec(["status"], "/nonexistent/directory")).rejects.toThrow(ArashiError);
  });

  test("should capture stderr in ArashiError when command fails", async () => {
    try {
      await exec(["status"], "/nonexistent/directory");
      expect.unreachable("Should have thrown ArashiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ArashiError);
      const arashiError = error as ArashiError;

      // Stderr should contain an error message (either git error or spawn error)
      expect(arashiError.context.stderr).toBeTruthy();
      expect(arashiError.context.exitCode).not.toBe(0);
      expect(arashiError.context.args).toEqual(["status"]);
      expect(arashiError.context.cwd).toBe("/nonexistent/directory");
    }
  });

  test("should include full diagnostic context in ArashiError", async () => {
    try {
      await exec(["worktree", "add", "/nonexistent/path", "nonexistent-branch"], testRepo.path);
      expect.unreachable("Should have thrown ArashiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ArashiError);
      const arashiError = error as ArashiError;

      expect(arashiError.context).toBeDefined();
      expect(arashiError.context.stdout).toBeDefined();
      expect(arashiError.context.stderr).toBeDefined();
      expect(arashiError.context.exitCode).toBeGreaterThan(0);
      expect(arashiError.context.args).toEqual([
        "worktree",
        "add",
        "/nonexistent/path",
        "nonexistent-branch",
      ]);
      expect(arashiError.context.cwd).toBe(testRepo.path);
    }
  });

  test("should handle commands that write to stderr but succeed", async () => {
    // Git sometimes writes warnings to stderr even on success
    // For example, "git init" writes "Initialized empty Git repository..."
    const result = await exec(["rev-parse", "--git-dir"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(".git");
    // Stderr may or may not be empty, but command should succeed
  });

  test("should preserve exact git command arguments order", async () => {
    const args = ["log", "--oneline", "--max-count=1", "--format=%H"];
    const result = await exec(args, testRepo.path);

    expect(result.exitCode).toBe(0);
    // The output should be a commit hash (40 hex characters)
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  test("should handle empty argument array by throwing validation error", async () => {
    await expect(exec([], testRepo.path)).rejects.toThrow();
  });

  test("should validate cwd parameter exists", async () => {
    await expect(exec(["status"], "")).rejects.toThrow();
  });

  test("should handle git commands with no output", async () => {
    // Create a file and commit it
    await createFile(testRepo.path, "test.txt", "content");
    commitChanges(testRepo.path, "Add test file");

    // Try a command that will fail - show-ref with nonexistent ref
    try {
      await exec(["show-ref", "nonexistent-ref"], testRepo.path);
      expect.unreachable("Should have thrown ArashiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ArashiError);
      // Git returns exit code 1 for show-ref when ref is not found
      const arashiError = error as ArashiError;
      expect(arashiError.context.exitCode).toBe(1);
    }
  });

  test("should handle multiline stdout output", async () => {
    // Create multiple commits
    await createFile(testRepo.path, "file1.txt", "content1");
    commitChanges(testRepo.path, "First commit");
    await createFile(testRepo.path, "file2.txt", "content2");
    commitChanges(testRepo.path, "Second commit");

    const result = await exec(["log", "--oneline"], testRepo.path);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3); // Initial + 2 new commits
  });

  test("should handle concurrent exec() calls to same repository", async () => {
    // Test that multiple concurrent git operations work correctly
    const promises = [
      exec(["status", "--porcelain"], testRepo.path),
      exec(["rev-parse", "HEAD"], testRepo.path),
      exec(["branch", "--show-current"], testRepo.path),
    ];

    const results = await Promise.all(promises);

    expect(results).toHaveLength(3);
    results.forEach((result) => {
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("isBareRepo()", () => {
  let testRepo: GitTestRepo;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("should return false for a regular non-bare repository", async () => {
    const result = await isBareRepo(testRepo.path);
    expect(result).toBe(false);
  });

  test("should return true for a bare repository", async () => {
    const bareRepoPath = createTempDir();

    try {
      initBareGitRepo(bareRepoPath);
      const result = await isBareRepo(bareRepoPath);
      expect(result).toBe(true);
    } finally {
      removeTempDir(bareRepoPath);
    }
  });

  test("should return true when checking a worktree of a bare repository", async () => {
    const bareRepoPath = createTempDir();
    const worktreeParent = createTempDir();
    const worktreePath = join(worktreeParent, "worktree");

    try {
      // Create a bare repository
      initBareGitRepo(bareRepoPath);

      // Create an initial commit in a temporary non-bare repo
      const tempRepoPath = createTempDir();
      let branchName = "main";
      try {
        runtime.spawnSync(["git", "init"], { cwd: tempRepoPath });
        runtime.spawnSync(["git", "config", "user.email", "test@example.com"], {
          cwd: tempRepoPath,
        });
        runtime.spawnSync(["git", "config", "user.name", "Test User"], { cwd: tempRepoPath });
        await createInitialCommit(tempRepoPath);

        // Get the actual branch name (might be master or main depending on git config)
        const branchResult = runtime.spawnSync(["git", "branch", "--show-current"], {
          cwd: tempRepoPath,
        });
        branchName = new TextDecoder().decode(branchResult.stdout).trim();

        // Push to bare repo
        runtime.spawnSync(["git", "remote", "add", "origin", bareRepoPath], { cwd: tempRepoPath });
        runtime.spawnSync(["git", "push", "-u", "origin", branchName], { cwd: tempRepoPath });
      } finally {
        removeTempDir(tempRepoPath);
      }

      // Create a worktree from the bare repository using the actual branch name
      // Git worktree add will create the worktreePath directory
      const worktreeResult = runtime.spawnSync(
        ["git", "worktree", "add", worktreePath, branchName],
        {
          cwd: bareRepoPath,
        },
      );

      // Ensure worktree was created successfully
      if (worktreeResult.exitCode !== 0) {
        throw new Error(
          `Failed to create worktree: ${new TextDecoder().decode(worktreeResult.stderr)}`,
        );
      }

      // Check if isBareRepo correctly identifies the worktree's parent as bare
      const result = await isBareRepo(worktreePath);
      expect(result).toBe(true);
    } finally {
      removeTempDir(bareRepoPath);
      removeTempDir(worktreeParent);
    }
  });

  test("should return false when checking a worktree of a non-bare repository", async () => {
    const worktreePath = createTempDir();

    try {
      // Create a worktree from the regular (non-bare) repository
      runtime.spawnSync(["git", "worktree", "add", worktreePath, "-b", "feature-branch"], {
        cwd: testRepo.path,
      });

      // Check if isBareRepo correctly identifies the worktree's parent as non-bare
      const result = await isBareRepo(worktreePath);
      expect(result).toBe(false);
    } finally {
      // Clean up worktree
      runtime.spawnSync(["git", "worktree", "remove", worktreePath, "--force"], {
        cwd: testRepo.path,
      });
      removeTempDir(worktreePath);
    }
  });
});

describe("getDefaultBranch()", () => {
  test("detects local default branch in bare repository without remotes", async () => {
    const bareRepoPath = createTempDir();
    const seedPath = createTempDir();

    try {
      initBareGitRepo(bareRepoPath);

      runtime.spawnSync(["git", "init", "-b", "main"], { cwd: seedPath });
      runtime.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: seedPath });
      runtime.spawnSync(["git", "config", "user.name", "Test User"], { cwd: seedPath });

      await runtime.write(join(seedPath, "README.md"), "# test\n");
      runtime.spawnSync(["git", "add", "README.md"], { cwd: seedPath });
      runtime.spawnSync(["git", "commit", "-m", "seed"], { cwd: seedPath });
      runtime.spawnSync(["git", "remote", "add", "origin", bareRepoPath], { cwd: seedPath });
      runtime.spawnSync(["git", "push", "origin", "main"], { cwd: seedPath });

      const branch = await getDefaultBranch(bareRepoPath);
      expect(branch).toBe("main");
    } finally {
      removeTempDir(seedPath);
      removeTempDir(bareRepoPath);
    }
  });
});

describe("readTrackedFileFromDefaultBranch()", () => {
  test("reads tracked file contents from bare repository default branch", async () => {
    const bareRepoPath = createTempDir();
    const seedPath = createTempDir();

    try {
      initBareGitRepo(bareRepoPath);

      runtime.spawnSync(["git", "init", "-b", "main"], { cwd: seedPath });
      runtime.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: seedPath });
      runtime.spawnSync(["git", "config", "user.name", "Test User"], { cwd: seedPath });

      await runtime.write(join(seedPath, "tracked.txt"), "tracked-value\n");
      runtime.spawnSync(["git", "add", "tracked.txt"], { cwd: seedPath });
      runtime.spawnSync(["git", "commit", "-m", "add tracked file"], { cwd: seedPath });
      runtime.spawnSync(["git", "remote", "add", "origin", bareRepoPath], { cwd: seedPath });
      runtime.spawnSync(["git", "push", "origin", "main"], { cwd: seedPath });

      const content = await readTrackedFileFromDefaultBranch(bareRepoPath, "tracked.txt");
      expect(content).toBe("tracked-value\n");
    } finally {
      removeTempDir(seedPath);
      removeTempDir(bareRepoPath);
    }
  });

  test("falls back when bare HEAD points to missing branch", async () => {
    const bareRepoPath = createTempDir();
    const seedPath = createTempDir();

    try {
      // Bare repo defaults HEAD to master on many CI systems.
      initBareGitRepo(bareRepoPath);

      runtime.spawnSync(["git", "init", "-b", "main"], { cwd: seedPath });
      runtime.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: seedPath });
      runtime.spawnSync(["git", "config", "user.name", "Test User"], { cwd: seedPath });

      await runtime.write(join(seedPath, "tracked.txt"), "from-main-only\n");
      runtime.spawnSync(["git", "add", "tracked.txt"], { cwd: seedPath });
      runtime.spawnSync(["git", "commit", "-m", "add tracked file"], { cwd: seedPath });
      runtime.spawnSync(["git", "remote", "add", "origin", bareRepoPath], { cwd: seedPath });
      runtime.spawnSync(["git", "push", "origin", "main"], { cwd: seedPath });

      const content = await readTrackedFileFromDefaultBranch(bareRepoPath, "tracked.txt");
      expect(content).toBe("from-main-only\n");
    } finally {
      removeTempDir(seedPath);
      removeTempDir(bareRepoPath);
    }
  });
});
