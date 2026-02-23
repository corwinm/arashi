import { describe, expect, test } from "bun:test";
import { executeCreate } from "../../src/commands/create.ts";
import type { CreateCommandDependencies } from "../../src/commands/create.ts";
import type { Config, LoadedConfig } from "../../src/lib/config.ts";
import type { OperationSummary } from "../../src/core/worktree.ts";

const workspaceRoot = "/workspace";
const branchName = "feature/defaults";

function createLoadedConfig(configOverrides: Partial<Config> = {}): LoadedConfig {
  return {
    source: "local-file",
    configPath: "/workspace/.arashi/config.json",
    config: {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {},
      ...configOverrides,
    },
  };
}

function createSummary(worktreePath: string = `${workspaceRoot}/${branchName}`): OperationSummary {
  return {
    totalRepositories: 1,
    successCount: 1,
    failureCount: 0,
    skippedCount: 0,
    repositoryResults: [
      {
        repository: {
          name: "workspace",
          path: workspaceRoot,
          defaultBranch: "main",
          hasSetupScript: false,
        },
        status: "success",
        worktreePath,
        branchName,
        error: null,
        warnings: [],
        duration: 10,
        hookOutcomes: [],
      },
    ],
    rolledBack: false,
    totalDuration: 20,
    errorSummary: null,
    hookOutcomes: [],
    nextSteps: [],
  };
}

function baseDeps(overrides: Partial<CreateCommandDependencies> = {}): CreateCommandDependencies {
  return {
    resolveCreateInvocationContext: async () => ({
      invocationPath: workspaceRoot,
      workspaceRoot,
      executionPath: workspaceRoot,
      repositoryType: "non-bare",
    }),
    loadConfigWithFallback: async () => createLoadedConfig(),
    discoverRepositories: async () => ({
      repositories: [],
      workspacePath: `${workspaceRoot}/repos`,
      scanDepth: 0,
      scannedDirectories: 0,
      errors: [],
      duration: 1,
    }),
    isGitRepository: async () => true,
    resolveCurrentBranch: async () => "main",
    applyRepositoryFilter: async (_filter, repositories) => repositories,
    createCoordinatedWorktrees: async () => createSummary(),
    ...overrides,
  };
}

describe("create defaults integration", () => {
  test("applies configured create launch defaults", async () => {
    const launchCalls: Array<{ sesh?: boolean }> = [];

    await executeCreate(
      branchName,
      {},
      baseDeps({
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: {
              create: {
                switch: true,
                launch: true,
                launchMode: "sesh",
              },
            },
          }),
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { mode: "sesh", command: ["tmux"] };
        },
      }),
    );

    expect(launchCalls).toEqual([{ sesh: true }]);
  });

  test("allows one-off opt-out from configured create launch defaults", async () => {
    const launchCalls: Array<{ sesh?: boolean }> = [];

    await executeCreate(
      branchName,
      { launch: false },
      baseDeps({
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: {
              create: {
                switch: true,
                launch: true,
                launchMode: "sesh",
              },
            },
          }),
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { mode: "sesh", command: ["tmux"] };
        },
      }),
    );

    expect(launchCalls).toHaveLength(0);
  });

  test("preserves backward compatibility when create defaults are absent", async () => {
    const launchCalls: Array<{ sesh?: boolean }> = [];

    await executeCreate(
      branchName,
      {},
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { mode: "fallback", command: ["open"] };
        },
      }),
    );

    expect(launchCalls).toHaveLength(0);
  });

  test("allows explicit create launch override without config defaults", async () => {
    const launchCalls: Array<{ sesh?: boolean }> = [];

    await executeCreate(
      branchName,
      { launch: true },
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { mode: "fallback", command: ["open"] };
        },
      }),
    );

    expect(launchCalls).toEqual([{ sesh: false }]);
  });
});
