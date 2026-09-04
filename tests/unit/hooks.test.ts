import {
  GLOBAL_HOOKS,
  LifecycleHookAmbiguityError,
  LifecycleHookDiscoveryError,
  buildHookOperationData,
  buildRemoveHookOperationData,
  findHook,
  getRepoSpecificHookName,
  isHookFailure,
  isHookSkipped,
  mapHookExecutionResult,
  mapHookSkippedOutcome,
  parseRepoSpecificHookName,
  resolveScopedLifecycleHooks,
  runLifecycleHook,
} from "../../src/lib/hooks";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { cleanupTestRepo, createHookInRepo, createTestRepo } from "../helpers/hooks";
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

    expect(hookPath?.replaceAll("\\", "/")).toContain(".arashi/hooks/pre-create.sh");
    expect(hookPath).toContain(testRepo);
  });

  test("returns null when hook doesn't exist", async () => {
    const hookPath = await findHook("nonexistent", testRepo);

    expect(hookPath).toBeNull();
  });

  test("returns null when hooks directory doesn't exist", async () => {
    const emptyRepo = join(testRepo, "empty-repo");
    mkdirSync(emptyRepo, { recursive: true });

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

describe("repo-specific hook naming", () => {
  test("builds lifecycle names for a repository", () => {
    expect(getRepoSpecificHookName("pre-create", "repo-a")).toBe("pre-create.repo-a");
    expect(getRepoSpecificHookName("post-create", "repo-b")).toBe("post-create.repo-b");
  });

  test("parses repo-specific lifecycle names", () => {
    expect(parseRepoSpecificHookName("pre-create.repo-a")).toEqual({
      lifecycle: "pre-create",
      repoName: "repo-a",
    });
    expect(parseRepoSpecificHookName("post-create.repo-b")).toEqual({
      lifecycle: "post-create",
      repoName: "repo-b",
    });
    expect(parseRepoSpecificHookName("pre-create.")).toBeNull();
    expect(parseRepoSpecificHookName("pre-remove.repo-a")).toBeNull();
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
    expect(operationData).not.toHaveProperty("BRANCH_NAME");
    expect(operationData).not.toHaveProperty("WORKTREE_PATH");
    expect(operationData).not.toHaveProperty("REPO_NAME");
    expect(operationData.MAIN_REPO_PATH).toBe("/tmp/workspace");
    expect(operationData.REMOVE_TARGET_BRANCHES).toBe("feature-a,feature-b");
    expect(operationData.REMOVE_TARGET_WORKTREES).toBe("/tmp/wt-a,/tmp/wt-b");
    expect(operationData.REMOVE_TARGET_REPOSITORIES).toBe("repo-a,repo-b");
    expect(operationData.REMOVE_TOTAL_BRANCHES).toBe("2");
    expect(operationData.REMOVE_TOTAL_WORKTREES).toBe("2");
    expect(operationData.REMOVE_TOTAL_REPOSITORIES).toBe("2");
    expect(JSON.parse(operationData.REMOVE_TARGETS_JSON)).toEqual([
      { branchName: "feature-a", repository: "repo-a", worktreePath: "/tmp/wt-a" },
      { branchName: "feature-b", repository: "repo-b", worktreePath: "/tmp/wt-b" },
    ]);
  });

  test("buildHookOperationData includes only defined values", () => {
    const operationData = buildHookOperationData({
      branchName: "feature-a",
      mainRepoPath: "/tmp/workspace",
      repoName: "repo-a",
    });

    expect(operationData).toEqual({
      BRANCH_NAME: "feature-a",
      MAIN_REPO_PATH: "/tmp/workspace",
      REPO_NAME: "repo-a",
    });
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

  test("fails closed at the first scoped ambiguity", async () => {
    const targetRepo = join(workspaceRoot, "repos", "repo-a");
    const repositoryHooks = ["ps1", "cmd"].map((extension) =>
      join(workspaceRoot, ".arashi", "hooks", `pre-remove.repo-a.${extension}`),
    );
    const globalHooks = ["ps1", "cmd"].map((extension) =>
      join(homeRoot, ".arashi", "hooks", `pre-remove.${extension}`),
    );
    for (const path of [...repositoryHooks, ...globalHooks]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "exit 0\r\n");
    }

    let thrown: unknown;
    try {
      await resolveScopedLifecycleHooks({
        hookName: "pre-remove",
        platform: "win32",
        targetRepositories: [{ name: "repo-a", path: targetRepo }],
        workspaceRoot,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LifecycleHookDiscoveryError);
    expect(thrown).toMatchObject({
      scope: "repository",
      targetRepositoryName: "repo-a",
    });
    expect((thrown as Error).cause).toBeInstanceOf(LifecycleHookAmbiguityError);
    expect((thrown as Error).cause).toMatchObject({ candidates: repositoryHooks });
  });
});

describe("hook outcome helpers", () => {
  test("classifies skipped and failed hook results", () => {
    const failedResult = {
      duration: 12,
      exitCode: 1,
      killed: false,
      signalCode: null,
      stderr: "boom",
      stdout: "",
      success: false,
      timedOut: false,
    };

    expect(isHookSkipped(null)).toBe(true);
    expect(isHookFailure(null)).toBe(false);
    expect(isHookFailure(failedResult)).toBe(true);
  });

  test("maps hook execution results to summary outcomes", () => {
    expect(
      mapHookExecutionResult({
        duration: 10,
        exitCode: 0,
        killed: false,
        signalCode: null,
        stderr: "",
        stdout: "ok",
        success: true,
        timedOut: false,
      }),
    ).toEqual({
      durationMs: 10,
      hookStatus: "success",
      message: "Hook completed",
      reasonCode: "none",
    });

    expect(
      mapHookExecutionResult({
        duration: 25,
        exitCode: -1,
        killed: true,
        signalCode: "SIGTERM",
        stderr: "",
        stdout: "",
        success: false,
        timedOut: true,
      }),
    ).toEqual({
      durationMs: 25,
      hookStatus: "failure",
      message: "Hook timed out after configured limit",
      reasonCode: "timeout",
    });

    expect(mapHookSkippedOutcome("not_found", "Hook missing")).toEqual({
      hookStatus: "skipped",
      message: "Hook missing",
      reasonCode: "not_found",
    });
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
    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(result).toBeNull();
  });

  test("returns null when skipHooks is true", async () => {
    createHookInRepo(testRepo, "pre-create", "echo 'test'");

    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      options: {
        skipHooks: true,
      },
      repoPath: testRepo,
    });

    expect(result).toBeNull();
  });
});
