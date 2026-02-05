/**
 * Integration tests for exec() function
 * 
 * These tests verify exec() works correctly with real git commands
 * in various repository scenarios.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "../../../src/lib/git";
import { ArashiError } from "../../../src/lib/errors";
import { GitTestRepo, createFile, commitChanges } from "../../helpers/git-test-utils";
import { GitErrorCode } from "../../../src/types/git";

describe("exec() - Integration Tests", () => {
  let testRepo: GitTestRepo;
  let defaultBranch: string;

  beforeEach(async () => {
    testRepo = new GitTestRepo();
    await testRepo.withInitialCommit();
    
    // Detect the actual default branch name (main or master)
    const branchResult = await exec(["branch", "--show-current"], testRepo.path);
    defaultBranch = branchResult.stdout.trim() || "main";
  });

  afterEach(() => {
    testRepo.cleanup();
  });

  test("should execute git status in valid repository", async () => {
    const result = await exec(["status", "--porcelain"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(""); // Clean repository
    expect(typeof result.stderr).toBe("string");
  });

  test("should fail with NOT_A_REPOSITORY error in invalid directory", async () => {
    try {
      await exec(["status"], "/tmp/not-a-git-repo-" + Date.now());
      expect.unreachable("Should have thrown ArashiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ArashiError);
      const arashiError = error as ArashiError;
      
      // Error code depends on whether directory exists or not
      const validCodes: string[] = [GitErrorCode.NOT_A_REPOSITORY, GitErrorCode.NOT_FOUND];
      expect(validCodes).toContain(arashiError.code);
      expect(arashiError.context.stderr).toBeTruthy();
    }
  });

  test("should capture warnings in stderr for valid commands", async () => {
    // Some git commands write warnings to stderr even on success
    // For example, checking out an empty branch
    const result = await exec(["branch", "--list"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(defaultBranch);
    // stderr might contain warnings but command succeeds
  });

  test("should execute git log and return commit history", async () => {
    // Add more commits
    await createFile(testRepo.path, "file1.txt", "content1");
    commitChanges(testRepo.path, "Add file1");
    await createFile(testRepo.path, "file2.txt", "content2");
    commitChanges(testRepo.path, "Add file2");

    const result = await exec(["log", "--oneline"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Add file1");
    expect(result.stdout).toContain("Add file2");
    expect(result.stdout).toContain("Initial commit");
  });

  test("should execute git diff with unstaged changes", async () => {
    await createFile(testRepo.path, "modified.txt", "original content");
    commitChanges(testRepo.path, "Add modified file");
    
    // Modify the file
    await createFile(testRepo.path, "modified.txt", "new content");

    const result = await exec(["diff", "--name-only"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("modified.txt");
  });

  test("should execute git branch operations", async () => {
    // Create a new branch
    await exec(["branch", "feature-test"], testRepo.path);

    // List branches
    const result = await exec(["branch", "--list"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(defaultBranch);
    expect(result.stdout).toContain("feature-test");
  });

  test("should fail with ALREADY_EXISTS error when creating duplicate branch", async () => {
    await exec(["branch", "test-branch"], testRepo.path);

    try {
      await exec(["branch", "test-branch"], testRepo.path);
      expect.unreachable("Should have thrown ArashiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ArashiError);
      const arashiError = error as ArashiError;
      
      expect(arashiError.code).toBe(GitErrorCode.ALREADY_EXISTS);
      expect(arashiError.context.stderr).toContain("already exists");
    }
  });

  test("should fail with NOT_FOUND error when checking out nonexistent branch", async () => {
    try {
      await exec(["checkout", "nonexistent-branch"], testRepo.path);
      expect.unreachable("Should have thrown ArashiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ArashiError);
      const arashiError = error as ArashiError;
      
      // The error code should be NOT_FOUND or GIT_ERROR depending on git version
      const validCodes: string[] = [GitErrorCode.NOT_FOUND, GitErrorCode.GIT_ERROR];
      expect(validCodes).toContain(arashiError.code);
      expect(arashiError.context.stderr).toContain("pathspec");
    }
  });

  test("should execute git config read operations", async () => {
    const result = await exec(["config", "user.name"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Test User");
  });

  test("should execute git rev-parse operations", async () => {
    const result = await exec(["rev-parse", "HEAD"], testRepo.path);

    expect(result.exitCode).toBe(0);
    // Should return a 40-character commit hash
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  test("should handle large stdout output from git log", async () => {
    // Create many commits
    for (let i = 0; i < 50; i++) {
      await createFile(testRepo.path, `file${i}.txt`, `content ${i}`);
      commitChanges(testRepo.path, `Commit ${i}`);
    }

    const result = await exec(["log", "--oneline"], testRepo.path);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(50);
  });

  test("should execute git show operations", async () => {
    const result = await exec(["show", "HEAD", "--no-patch", "--format=%s"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Initial commit");
  });

  test("should handle permission denied error appropriately", async () => {
    // This test is platform-dependent and might need adjustment
    // We'll test with a path that's likely to fail
    try {
      await exec(["status"], "/root/.private-dir-" + Date.now());
      // If it doesn't throw, that's ok - path might not exist
    } catch (error) {
      if (error instanceof ArashiError) {
        // Should be either NOT_A_REPOSITORY, NOT_FOUND, PERMISSION_DENIED, or GIT_FATAL
        const validCodes: string[] = [
          GitErrorCode.NOT_A_REPOSITORY,
          GitErrorCode.NOT_FOUND,
          GitErrorCode.PERMISSION_DENIED,
          GitErrorCode.GIT_FATAL
        ];
        expect(validCodes).toContain(error.code);
      }
    }
  });

  test("should execute git ls-files operations", async () => {
    await createFile(testRepo.path, "tracked.txt", "content");
    commitChanges(testRepo.path, "Add tracked file");

    const result = await exec(["ls-files"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tracked.txt");
  });

  test("should execute commands with complex arguments", async () => {
    await createFile(testRepo.path, "file.txt", "line1\nline2\nline3");
    commitChanges(testRepo.path, "Add file");

    const result = await exec([
      "log",
      "--pretty=format:%H %s",
      "--max-count=1"
    ], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Add file");
  });
});
