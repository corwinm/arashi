/**
 * Unit tests for ArashiError class
 */

import { describe, expect, test } from "vitest";
import { ArashiError } from "../../../src/lib/errors";
import { GitErrorCode } from "../../../src/types/git";

interface GitErrorContext {
  stdout: string;
  stderr: string;
  exitCode: number;
  args: string[];
  cwd?: string;
}

describe("ArashiError", () => {
  const baseContext: GitErrorContext = {
    args: ["status"],
    cwd: "/test/repo",
    exitCode: 1,
    stderr: "",
    stdout: "",
  };

  test("creates error with message and context", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "fatal: error message",
    };

    const error = new ArashiError("Test error", context);

    expect(error.message).toBe("Test error");
    expect(error.name).toBe("ArashiError");
    expect(error.context).toEqual(context);
  });

  test("parses NOT_A_REPOSITORY error code", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
    };

    const error = new ArashiError("Not a repository", context);

    expect(error.code).toBe(GitErrorCode.NOT_A_REPOSITORY);
  });

  test("parses ALREADY_EXISTS error code", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "fatal: branch already exists",
    };

    const error = new ArashiError("Already exists", context);

    expect(error.code).toBe(GitErrorCode.ALREADY_EXISTS);
  });

  test("parses PERMISSION_DENIED error code", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "fatal: permission denied while trying to connect",
    };

    const error = new ArashiError("Permission denied", context);

    expect(error.code).toBe(GitErrorCode.PERMISSION_DENIED);
  });

  test("parses NOT_FOUND error code", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "error: branch not found",
    };

    const error = new ArashiError("Not found", context);

    expect(error.code).toBe(GitErrorCode.NOT_FOUND);
  });

  test("parses NETWORK_ERROR error code", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "fatal: could not resolve host: github.com",
    };

    const error = new ArashiError("Network error", context);

    expect(error.code).toBe(GitErrorCode.NETWORK_ERROR);
  });

  test("parses GIT_FATAL error code for generic fatal errors", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "fatal: some other error",
    };

    const error = new ArashiError("Fatal error", context);

    expect(error.code).toBe(GitErrorCode.GIT_FATAL);
  });

  test("defaults to GIT_ERROR for unrecognized errors", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "some unrecognized error message",
    };

    const error = new ArashiError("Unknown error", context);

    expect(error.code).toBe(GitErrorCode.GIT_ERROR);
  });

  test("preserves all context properties", () => {
    const context: GitErrorContext = {
      args: ["worktree", "add", "/path", "branch"],
      cwd: "/repo/path",
      exitCode: 128,
      stderr: "some error",
      stdout: "some output",
    };

    const error = new ArashiError("Test", context);

    expect(error.context.stdout).toBe("some output");
    expect(error.context.stderr).toBe("some error");
    expect(error.context.exitCode).toBe(128);
    expect(error.context.args).toEqual(["worktree", "add", "/path", "branch"]);
    expect(error.context.cwd).toBe("/repo/path");
  });

  test("toJSON() returns serializable object", () => {
    const context: GitErrorContext = {
      args: ["status"],
      cwd: "/repo",
      exitCode: 1,
      stderr: "fatal: error",
      stdout: "output",
    };

    const error = new ArashiError("Test error", context);
    const json = error.toJSON();

    expect(json).toHaveProperty("name", "ArashiError");
    expect(json).toHaveProperty("message", "Test error");
    expect(json).toHaveProperty("code", GitErrorCode.GIT_FATAL);
    expect(json).toHaveProperty("context");
    expect(json).toHaveProperty("stack");
  });

  test("toJSON() includes all context properties", () => {
    const context: GitErrorContext = {
      args: ["test"],
      cwd: "/path",
      exitCode: 1,
      stderr: "error",
      stdout: "output",
    };

    const error = new ArashiError("Test", context);
    const json = error.toJSON() as {
      context: {
        stdout: string;
        stderr: string;
        exitCode: number;
        args: string[];
        cwd?: string;
      };
    };

    expect(json.context.stdout).toBe("output");
    expect(json.context.stderr).toBe("error");
    expect(json.context.exitCode).toBe(1);
    expect(json.context.args).toEqual(["test"]);
    expect(json.context.cwd).toBe("/path");
  });

  test("is instanceof Error", () => {
    const error = new ArashiError("Test", baseContext);

    expect(error instanceof Error).toBe(true);
    expect(error instanceof ArashiError).toBe(true);
  });

  test("has stack trace", () => {
    const error = new ArashiError("Test", baseContext);

    expect(error.stack).toBeDefined();
    expect(typeof error.stack).toBe("string");
    expect(error.stack).toContain("ArashiError");
  });

  test("handles context without cwd", () => {
    const context: GitErrorContext = {
      args: ["test"],
      exitCode: 1,
      stderr: "error",
      stdout: "",
      // Cwd is optional
    };

    const error = new ArashiError("Test", context);

    expect(error.context.cwd).toBeUndefined();
  });

  test("error code parsing is case-insensitive", () => {
    const context: GitErrorContext = {
      ...baseContext,
      stderr: "FATAL: NOT A GIT REPOSITORY",
    };

    const error = new ArashiError("Test", context);

    expect(error.code).toBe(GitErrorCode.NOT_A_REPOSITORY);
  });
});
