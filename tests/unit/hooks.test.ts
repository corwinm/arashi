import {
  GLOBAL_HOOKS,
  buildRemoveHookOperationData,
  executeHook,
  findHook,
  resolveScopedLifecycleHooks,
  runLifecycleHook,
  validateHook,
} from "../../src/lib/hooks";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import {
  cleanupTestRepo,
  createHookInRepo,
  createMockHook,
  createTestContext,
  createTestRepo,
} from "../helpers/hooks";
import { dirname, join } from "path";

// ============================================================================
// FindHook() Tests
// ============================================================================

describe("findHook", () => {
  let testRepo: string;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(testRepo);
  });

  test("returns path when hook exists", async () => {
    createHookInRepo(testRepo, "pre-create", "echo 'test'");

    const hookPath = await findHook("pre-create", testRepo);

    expect(hookPath).toContain(".arashi/hooks/pre-create.sh");
    expect(hookPath).toContain(testRepo);
  });

  test("returns null when hook doesn't exist", async () => {
    const hookPath = await findHook("nonexistent", testRepo);

    expect(hookPath).toBeNull();
  });

  test("returns null when hooks directory doesn't exist", async () => {
    const emptyRepo = `/tmp/empty-repo-${Date.now()}`;

    const hookPath = await findHook("pre-create", emptyRepo);

    expect(hookPath).toBeNull();
  });

  test("handles platform-specific path separators", async () => {
    createHookInRepo(testRepo, "test-hook", "echo 'test'");

    const hookPath = await findHook("test-hook", testRepo);

    expect(hookPath).toBeTruthy();
    expect(hookPath).toContain("test-hook.sh");
  });
});

describe("remove lifecycle helpers", () => {
  test("exposes remove lifecycle names", () => {
    expect(GLOBAL_HOOKS.preRemove).toBe("pre-remove");
    expect(GLOBAL_HOOKS.postRemove).toBe("post-remove");
  });

  test("buildRemoveHookOperationData includes aggregate remove metadata", () => {
    const operationData = buildRemoveHookOperationData({
      branchNames: ["feature-a", "feature-a", "feature-b"],
      mainRepoPath: "/tmp/workspace",
      repositoryNames: ["repo-a", "repo-a", "repo-b"],
      worktreePaths: ["/tmp/wt-a", "/tmp/wt-a", "/tmp/wt-b"],
    });

    expect(operationData.OPERATION).toBe("remove");
    expect(operationData.BRANCH_NAME).toBe("feature-a");
    expect(operationData.WORKTREE_PATH).toBe("/tmp/wt-a");
    expect(operationData.REPO_NAME).toBe("repo-a");
    expect(operationData.MAIN_REPO_PATH).toBe("/tmp/workspace");
    expect(operationData.REMOVE_TARGET_BRANCHES).toBe("feature-a,feature-b");
    expect(operationData.REMOVE_TARGET_WORKTREES).toBe("/tmp/wt-a,/tmp/wt-b");
    expect(operationData.REMOVE_TARGET_REPOSITORIES).toBe("repo-a,repo-b");
    expect(operationData.REMOVE_TOTAL_BRANCHES).toBe("2");
    expect(operationData.REMOVE_TOTAL_WORKTREES).toBe("2");
    expect(operationData.REMOVE_TOTAL_REPOSITORIES).toBe("2");
  });
});

describe("resolveScopedLifecycleHooks", () => {
  let workspaceRoot: string;
  let homeRoot: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    workspaceRoot = createTestRepo();
    homeRoot = createTestRepo();
    originalHome = process.env.HOME;
    process.env.HOME = homeRoot;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    cleanupTestRepo(workspaceRoot);
    cleanupTestRepo(homeRoot);
  });

  test("resolves hooks in repository, workspace, and global order", async () => {
    const targetRepo = join(workspaceRoot, "repos", "repo-a");
    mkdirSync(targetRepo, { recursive: true });

    const repositoryHookPath = createHookInRepo(targetRepo, "pre-remove", "echo repository");
    const workspaceHookPath = createHookInRepo(workspaceRoot, "pre-remove", "echo workspace");
    const globalSharedHookPath = createHookInRepo(homeRoot, "pre-remove", "echo global-shared");

    const globalRepositoryHookPath = join(homeRoot, ".arashi", "hooks", "repo-a", "pre-remove.sh");
    mkdirSync(dirname(globalRepositoryHookPath), { recursive: true });
    writeFileSync(globalRepositoryHookPath, "#!/bin/sh\necho global-repository\n");
    if (process.platform !== "win32") {
      chmodSync(globalRepositoryHookPath, 0o755);
    }

    const resolved = await resolveScopedLifecycleHooks({
      hookName: "pre-remove",
      targetRepositories: [{ name: "repo-a", path: targetRepo }],
      workspaceRoot,
    });

    expect(resolved).toHaveLength(4);
    expect(resolved.map((hook) => hook.scope)).toEqual([
      "repository",
      "workspace",
      "global-repository",
      "global-shared",
    ]);
    expect(resolved.map((hook) => hook.scriptPath)).toEqual([
      repositoryHookPath,
      workspaceHookPath,
      globalRepositoryHookPath,
      globalSharedHookPath,
    ]);
    expect(resolved.map((hook) => hook.executionPath)).toEqual([
      targetRepo,
      workspaceRoot,
      targetRepo,
      targetRepo,
    ]);
  });

  test("returns empty list when scoped hooks are missing", async () => {
    const targetRepo = join(workspaceRoot, "repos", "repo-a");
    mkdirSync(targetRepo, { recursive: true });

    const resolved = await resolveScopedLifecycleHooks({
      hookName: "pre-remove",
      targetRepositories: [{ name: "repo-a", path: targetRepo }],
      workspaceRoot,
    });

    expect(resolved).toEqual([]);
  });
});

// ============================================================================
// ValidateHook() Tests
// ============================================================================

describe("validateHook", () => {
  let testRepo: string;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(testRepo);
  });

  test("passes for executable file on Unix", async () => {
    if (process.platform === "win32") {
      return; // Skip on Windows
    }

    const hookPath = createHookInRepo(testRepo, "test-hook", "echo 'test'", true);

    const result = await validateHook(hookPath);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("fails for non-executable file on Unix", async () => {
    if (process.platform === "win32") {
      return; // Skip on Windows
    }

    const hookPath = createHookInRepo(testRepo, "test-hook", "echo 'test'", false);

    const result = await validateHook(hookPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("not executable");
    expect(result.error).toContain("chmod +x");
  });

  test("passes for .sh file on Windows", async () => {
    if (process.platform !== "win32") {
      return; // Skip on non-Windows
    }

    const hookPath = createHookInRepo(testRepo, "test-hook", "echo test", true);

    const result = await validateHook(hookPath);

    expect(result.valid).toBe(true);
  });

  test("returns clear error messages", async () => {
    const nonexistentPath = "/nonexistent/hook.sh";

    const result = await validateHook(nonexistentPath);

    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Failed to validate hook");
  });
});

// ============================================================================
// ExecuteHook() Tests
// ============================================================================

describe("executeHook", () => {
  test("successfully executes hook with exit code 0", async () => {
    const hookPath = createMockHook("echo 'test output'");

    const result = await executeHook({
      context: createTestContext(),
      hookName: "test-hook",
      scriptPath: hookPath,
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test output");
    // Note: Bun sets killed=true even for successful exits
    expect(result.timedOut).toBe(false);
    expect(result.duration).toBeGreaterThan(0);

    rmSync(hookPath);
  });

  test("captures stdout and stderr correctly", async () => {
    const hookPath = createMockHook("echo 'stdout message' && echo 'stderr message' >&2");

    const result = await executeHook({
      context: createTestContext(),
      hookName: "test-hook",
      scriptPath: hookPath,
    });

    expect(result.stdout).toContain("stdout message");
    expect(result.stderr).toContain("stderr message");

    rmSync(hookPath);
  });

  test("handles non-zero exit codes", async () => {
    const hookPath = createMockHook("exit 1");

    const result = await executeHook({
      context: createTestContext(),
      hookName: "test-hook",
      scriptPath: hookPath,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    // Note: Bun sets killed=true even for failed exits

    rmSync(hookPath);
  });

  // Note: Timeout enforcement tests are not included due to Bun test framework limitations
  // With streaming + timeout. The timeout feature works correctly in production (verified manually).

  test("passes environment variables correctly", async () => {
    const testRepo = createTestRepo();
    const hookPath = createMockHook(`
			echo "Hook: $ARASHI_HOOK_NAME"
			echo "Repo: $ARASHI_REPO_PATH"
			echo "Branch: $ARASHI_BRANCH"
		`);

    const result = await executeHook({
      context: {
        hookName: "test-hook",
        operationData: { BRANCH: "main" },
        repoPath: testRepo,
      },
      hookName: "test-hook",
      scriptPath: hookPath,
    });

    expect(result.stdout).toContain("Hook: test-hook");
    expect(result.stdout).toContain(`Repo: ${testRepo}`);
    expect(result.stdout).toContain("Branch: main");

    rmSync(hookPath);
    cleanupTestRepo(testRepo);
  });

  test("passes scope metadata environment variables", async () => {
    const testRepo = createTestRepo();
    const hookPath = createMockHook(`
      echo "Scope: $ARASHI_HOOK_SCOPE"
      echo "Source: $ARASHI_HOOK_SOURCE_PATH"
      echo "TargetRepo: $ARASHI_HOOK_TARGET_REPOSITORY"
      echo "TargetRepoPath: $ARASHI_HOOK_TARGET_REPO_PATH"
    `);

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

    rmSync(hookPath);
    cleanupTestRepo(testRepo);
  });
});

// ============================================================================
// RunLifecycleHook() Tests
// ============================================================================

describe("runLifecycleHook", () => {
  let testRepo: string;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(testRepo);
  });

  test("returns null when hook doesn't exist", async () => {
    const result = await runLifecycleHook("pre-create", testRepo, {});

    expect(result).toBeNull();
  });

  test("returns null when skipHooks is true", async () => {
    createHookInRepo(testRepo, "pre-create", "echo 'test'");

    const result = await runLifecycleHook(
      "pre-create",
      testRepo,
      {},
      {
        skipHooks: true,
      },
    );

    expect(result).toBeNull();
  });

  test("returns null when validation fails", async () => {
    if (process.platform === "win32") {
      return; // Skip on Windows
    }

    createHookInRepo(testRepo, "pre-create", "echo 'test'", false);

    const result = await runLifecycleHook("pre-create", testRepo, {});

    expect(result).toBeNull();
  });

  test("returns HookResult when hook executes successfully", async () => {
    createHookInRepo(testRepo, "pre-create", "echo 'success'");

    const result = await runLifecycleHook("pre-create", testRepo, {});

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.stdout).toContain("success");
  });

  test("returns HookResult when hook fails", async () => {
    createHookInRepo(testRepo, "pre-create", "exit 1");

    const result = await runLifecycleHook("pre-create", testRepo, {});

    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
  });

  test("passes operation data to hook", async () => {
    createHookInRepo(testRepo, "pre-create", 'echo "Branch: $ARASHI_BRANCH"');

    const result = await runLifecycleHook("pre-create", testRepo, {
      BRANCH: "feature-123",
    });

    expect(result?.stdout).toContain("Branch: feature-123");
  });
});
