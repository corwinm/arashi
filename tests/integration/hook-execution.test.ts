import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  cleanupTestRepo,
  createHookInRepo,
  createMockHook,
  createTestContext,
  createTestRepo,
} from "../helpers/hooks";
import { executeHook, runLifecycleHook, validateHook } from "../../src/lib/hooks";

describe("hook execution integration", () => {
  let testRepo: string;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(testRepo);
  });

  test("validates executable hooks on Unix", async () => {
    if (process.platform === "win32") {
      return;
    }

    const hookPath = createHookInRepo(testRepo, "test-hook", "echo 'test'", true);
    const result = await validateHook(hookPath);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("rejects non-executable hooks on Unix", async () => {
    if (process.platform === "win32") {
      return;
    }

    const hookPath = createHookInRepo(testRepo, "test-hook", "echo 'test'", false);
    const result = await validateHook(hookPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("not executable");
    expect(result.error).toContain("chmod +x");
  });

  test("returns clear validation errors for missing hooks", async () => {
    const result = await validateHook("/nonexistent/hook.sh");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Failed to validate hook");
  });

  test("executes hooks and captures stdout and stderr", async () => {
    const hookPath = createMockHook("echo 'stdout message' && echo 'stderr message' >&2");

    try {
      const result = await executeHook({
        context: createTestContext({ repoPath: testRepo }),
        hookName: "test-hook",
        scriptPath: hookPath,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("stdout message");
      expect(result.stderr).toContain("stderr message");
      expect(result.timedOut).toBe(false);
    } finally {
      cleanupTestRepo(hookPath);
    }
  });

  test("passes scope metadata environment variables", async () => {
    const hookPath = createMockHook(`
      echo "Scope: $ARASHI_HOOK_SCOPE"
      echo "Source: $ARASHI_HOOK_SOURCE_PATH"
      echo "TargetRepo: $ARASHI_HOOK_TARGET_REPOSITORY"
      echo "TargetRepoPath: $ARASHI_HOOK_TARGET_REPO_PATH"
    `);

    try {
      const result = await executeHook({
        context: {
          hookName: "test-hook",
          hookScope: "global-shared",
          operationData: {},
          repoPath: testRepo,
          sourceScriptPath: "/tmp/source-hook.sh",
          targetRepoName: "repo-a",
          targetRepoPath: "/tmp/repo-a",
        },
        hookName: "test-hook",
        scriptPath: hookPath,
      });

      expect(result.stdout).toContain("Scope: global-shared");
      expect(result.stdout).toContain("Source: /tmp/source-hook.sh");
      expect(result.stdout).toContain("TargetRepo: repo-a");
      expect(result.stdout).toContain("TargetRepoPath: /tmp/repo-a");
    } finally {
      cleanupTestRepo(hookPath);
    }
  });

  test("does not leak directive environment variables to hooks", async () => {
    const originalDirectiveFile = process.env.ARASHI_DIRECTIVE_FILE;
    const originalDirectiveShell = process.env.ARASHI_SHELL;
    process.env.ARASHI_DIRECTIVE_FILE = "/tmp/arashi-directive";
    process.env.ARASHI_SHELL = "bash";

    const hookPath = createMockHook(`
      if [ -n "$ARASHI_DIRECTIVE_FILE" ]; then
        echo "directive leaked"
        exit 1
      fi
      if [ -n "$ARASHI_SHELL" ]; then
        echo "shell leaked"
        exit 1
      fi
      echo "clean"
    `);

    try {
      const result = await executeHook({
        context: createTestContext({ repoPath: testRepo }),
        hookName: "test-hook",
        scriptPath: hookPath,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain("clean");
    } finally {
      cleanupTestRepo(hookPath);

      if (originalDirectiveFile === undefined) {
        delete process.env.ARASHI_DIRECTIVE_FILE;
      } else {
        process.env.ARASHI_DIRECTIVE_FILE = originalDirectiveFile;
      }

      if (originalDirectiveShell === undefined) {
        delete process.env.ARASHI_SHELL;
      } else {
        process.env.ARASHI_SHELL = originalDirectiveShell;
      }
    }
  });

  test("runLifecycleHook returns null when validation fails", async () => {
    if (process.platform === "win32") {
      return;
    }

    createHookInRepo(testRepo, "pre-create", "echo 'test'", false);
    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(result).toBeNull();
  });

  test("runLifecycleHook executes hooks with operation data", async () => {
    createHookInRepo(testRepo, "pre-create", 'echo "Branch: $ARASHI_BRANCH_NAME"');

    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {
        BRANCH_NAME: "feature-123",
      },
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.stdout).toContain("Branch: feature-123");
  });
});
