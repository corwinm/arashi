/**
 * Unit tests for git.ts core functions
 * 
 * These tests focus on the exec() function which is the foundation
 * for all git operations.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { exec } from "../../../src/lib/git";
import { ArashiError } from "../../../src/lib/errors";
import { GitTestRepo, createFile, commitChanges } from "../../helpers/git-test-utils";

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
    // Git may return canonical path (e.g., /private/var vs /var on macOS)
    // So we compare the realpath-resolved values
    const { realpathSync } = await import("fs");
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(testRepo.path));
    expect(result.stderr).toBe("");
  });

  test("should throw ArashiError on git command failure", async () => {
    expect(async () => {
      await exec(["status"], "/nonexistent/directory");
    }).toThrow(ArashiError);
  });

  test("should capture stderr in ArashiError when command fails", async () => {
    try {
      await exec(["status"], "/nonexistent/directory");
      expect.unreachable("Should have thrown ArashiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ArashiError);
      const arashiError = error as ArashiError;
      
      // stderr should contain an error message (either git error or spawn error)
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
      expect(arashiError.context.args).toEqual(["worktree", "add", "/nonexistent/path", "nonexistent-branch"]);
      expect(arashiError.context.cwd).toBe(testRepo.path);
    }
  });

  test("should handle commands that write to stderr but succeed", async () => {
    // Git sometimes writes warnings to stderr even on success
    // For example, "git init" writes "Initialized empty Git repository..."
    const result = await exec(["rev-parse", "--git-dir"], testRepo.path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(".git");
    // stderr may or may not be empty, but command should succeed
  });

  test("should preserve exact git command arguments order", async () => {
    const args = ["log", "--oneline", "--max-count=1", "--format=%H"];
    const result = await exec(args, testRepo.path);

    expect(result.exitCode).toBe(0);
    // The output should be a commit hash (40 hex characters)
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  test("should handle empty argument array by throwing validation error", async () => {
    expect(async () => {
      await exec([], testRepo.path);
    }).toThrow();
  });

  test("should validate cwd parameter exists", async () => {
    expect(async () => {
      await exec(["status"], "");
    }).toThrow();
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
    results.forEach(result => {
      expect(result.exitCode).toBe(0);
    });
  });
});
