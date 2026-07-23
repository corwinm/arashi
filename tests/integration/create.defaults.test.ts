import type { Config, LoadedConfig } from "../../src/lib/config.ts";
import { describe, expect, test } from "vitest";
import type { OperationSummary } from "../../src/core/worktree.ts";
import { executeCreate } from "../../src/commands/create.ts";
type CreateCommandDependencies = NonNullable<Parameters<typeof executeCreate>[2]>;

const workspaceRoot = "/workspace";
const branchName = "feature/defaults";

function createLaunchCalls(): { sesh?: boolean }[] {
  return [];
}

function createLoadedConfig(configOverrides: Partial<Config> = {}): LoadedConfig {
  return {
    config: {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      ...configOverrides,
    },
    configPath: "/workspace/.arashi/config.json",
    source: "local-file",
  };
}

function createSummary(worktreePath = `${workspaceRoot}/${branchName}`): OperationSummary {
  return {
    errorSummary: null,
    failureCount: 0,
    hookOutcomes: [],
    nextSteps: [],
    repositoryResults: [
      {
        branchName,
        duration: 10,
        error: null,
        hookOutcomes: [],
        repository: {
          defaultBranch: "main",
          hasSetupScript: false,
          name: "workspace",
          path: workspaceRoot,
        },
        status: "success",
        warnings: [],
        worktreePath,
      },
    ],
    rolledBack: false,
    skippedCount: 0,
    successCount: 1,
    totalDuration: 20,
    totalRepositories: 1,
  };
}

function baseDeps(overrides: Partial<CreateCommandDependencies> = {}): CreateCommandDependencies {
  return {
    applyRepositoryFilter: async (_filter, repositories) => repositories,
    createCoordinatedWorktrees: async () => createSummary(),
    discoverRepositories: async () => ({
      duration: 1,
      errors: [],
      repositories: [],
      scanDepth: 0,
      scannedDirectories: 0,
      workspacePath: `${workspaceRoot}/repos`,
    }),
    isGitRepository: async () => true,
    loadConfigWithFallback: async () => createLoadedConfig(),
    reconcileManagedIgnore: async () => ({
      appliedRules: [],
      attempted: false,
      changed: false,
      fileChanges: { local: false, preference: false, tracked: false },
      localExcludePath: "/workspace/.git/info/exclude",
      paths: [],
      plannedRules: [],
      restored: false,
      scope: "local",
      staleRules: [],
      storedPreference: null,
      trackedIgnorePath: "/workspace/.gitignore",
      warnings: [],
    }),
    resolveCreateInvocationContext: async () => ({
      executionPath: workspaceRoot,
      invocationPath: workspaceRoot,
      repositoryType: "non-bare",
      workspaceRoot,
    }),
    resolveCurrentBranch: async () => "main",
    ...overrides,
  };
}

describe("create defaults integration", () => {
  test("applies configured create launch defaults", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      {},
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], mode: "sesh" };
        },
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: {
              create: {
                launch: "sesh",
                switch: true,
              },
            },
          }),
      }),
    );

    expect(launchCalls).toEqual([{ sesh: true }]);
  });

  test("preserves cmux launch mode for configured post-create launch", async () => {
    const launchCandidates: string[] = [];

    await executeCreate(
      branchName,
      {},
      baseDeps({
        launchSwitchTarget: async (candidate) => {
          launchCandidates.push(candidate.worktreePath);
          return { command: ["cmux", "workspace", "create"], mode: "cmux" };
        },
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: {
              create: {
                launch: "auto",
                switch: true,
              },
            },
          }),
      }),
    );

    expect(launchCandidates).toEqual([`${workspaceRoot}/${branchName}`]);
  });

  test("reports cmux launch failure after preserving created worktrees", async () => {
    let creationCompleted = false;

    await expect(
      executeCreate(
        branchName,
        { launch: true },
        baseDeps({
          createCoordinatedWorktrees: async () => {
            creationCompleted = true;
            return createSummary();
          },
          launchSwitchTarget: async () => {
            throw new Error("cmux socket access denied");
          },
        }),
      ),
    ).rejects.toThrow("cmux socket access denied");

    expect(creationCompleted).toBe(true);
  });

  test("applies editor-scoped create defaults for editor-hosted invocations", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      { editorHost: "vscode" },
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], mode: "sesh" };
        },
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: {
              create: {
                launch: "auto",
                switch: true,
              },
              editors: {
                vscode: {
                  create: {
                    launch: "sesh",
                  },
                },
              },
            },
          }),
      }),
    );

    expect(launchCalls).toEqual([{ sesh: true }]);
  });

  test("allows one-off opt-out from configured create launch defaults", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      { launch: false },
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], mode: "sesh" };
        },
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: {
              create: {
                launch: "sesh",
                switch: true,
              },
            },
          }),
      }),
    );

    expect(launchCalls).toHaveLength(0);
  });

  test("preserves backward compatibility when create defaults are absent", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      {},
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["open"], mode: "fallback" };
        },
      }),
    );

    expect(launchCalls).toHaveLength(0);
  });

  test("does not apply terminal defaults to editor-hosted create without editor overrides", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      { editorHost: "cursor" },
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], mode: "sesh" };
        },
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: {
              create: {
                launch: "sesh",
                switch: true,
              },
            },
          }),
      }),
    );

    expect(launchCalls).toHaveLength(0);
  });

  test("allows explicit create launch override without config defaults", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      { launch: true },
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["open"], mode: "fallback" };
        },
      }),
    );

    expect(launchCalls).toEqual([{ sesh: false }]);
  });

  test("rejects configured launch in JSON mode before repository discovery", async () => {
    let discoveryCalls = 0;
    const originalWrite = process.stdout.write;
    let stdout = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      const exitCode = await executeCreate(
        branchName,
        { json: true },
        baseDeps({
          discoverRepositories: async () => {
            discoveryCalls += 1;
            throw new Error("repository discovery must not run");
          },
          loadConfigWithFallback: async () =>
            createLoadedConfig({ defaults: { create: { launch: "auto" } } }),
        }),
      );
      expect(exitCode).toBe(1);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(discoveryCalls).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "create",
      error: { code: "JSON_UNSUPPORTED_FOR_MODE", details: { mode: "interactive-or-launch" } },
      ok: false,
    });
  });

  test("retains managed ignore state when rollback leaves a residual worktree", async () => {
    let restoreCalls = 0;
    const managedIgnore = {
      appliedRules: ["repos/"],
      attempted: true,
      changed: true,
      fileChanges: { local: true, preference: false, tracked: false },
      localExcludePath: "/workspace/.git/info/exclude",
      paths: [],
      plannedRules: ["repos/"],
      restored: false,
      scope: "local" as const,
      staleRules: [],
      storedPreference: null,
      trackedIgnorePath: "/workspace/.gitignore",
      warnings: [],
    };
    const failedSummary = {
      ...createSummary(),
      rolledBack: true,
    };

    await expect(
      executeCreate(
        branchName,
        {},
        baseDeps({
          createCoordinatedWorktrees: async () => failedSummary,
          pathExists: () => true,
          reconcileManagedIgnore: async () => managedIgnore,
          restoreManagedIgnore: async () => {
            restoreCalls += 1;
          },
        }),
      ),
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    expect(restoreCalls).toBe(0);
    expect(managedIgnore.changed).toBe(true);
  });

  test("restores managed ignore state after a complete worktree rollback", async () => {
    let restoreCalls = 0;
    const managedIgnore = {
      appliedRules: ["repos/"],
      attempted: true,
      changed: true,
      fileChanges: { local: true, preference: false, tracked: false },
      localExcludePath: "/workspace/.git/info/exclude",
      paths: [],
      plannedRules: ["repos/"],
      restored: false,
      scope: "local" as const,
      staleRules: [],
      storedPreference: null,
      trackedIgnorePath: "/workspace/.gitignore",
      warnings: [],
    };
    const failedSummary = {
      ...createSummary(),
      rolledBack: true,
    };

    await expect(
      executeCreate(
        branchName,
        {},
        baseDeps({
          createCoordinatedWorktrees: async () => failedSummary,
          pathExists: () => false,
          reconcileManagedIgnore: async () => managedIgnore,
          restoreManagedIgnore: async (result) => {
            restoreCalls += 1;
            result.changed = false;
            result.restored = true;
          },
        }),
      ),
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    expect(restoreCalls).toBe(1);
    expect(managedIgnore).toMatchObject({ changed: false, restored: true });
  });
});
