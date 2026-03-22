import { describe, expect, test } from "bun:test";
import { executeCreate } from "../../src/commands/create.ts";
import type { CreateCommandDependencies } from "../../src/commands/create.ts";
import type { Config, LoadedConfig } from "../../src/lib/config.ts";
import type { OperationSummary } from "../../src/core/worktree.ts";

const workspaceRoot = "/workspace";
const branchName = "feature/defaults";

function createLoadedConfig(configOverrides: Partial<Config> = {}): LoadedConfig {
  return {
    config: {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {},
      ...configOverrides,
    },
    configPath: "/workspace/.arashi/config.json",
    source: "local-file",
  };
}

function createSummary(worktreePath: string = `${workspaceRoot}/${branchName}`): OperationSummary {
  return {
    errorSummary: null,
    failureCount: 0,
    hookOutcomes: [],
    nextSteps: [],
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
      repositories: [],
      workspacePath: `${workspaceRoot}/repos`,
      scanDepth: 0,
      scannedDirectories: 0,
      errors: [],
      duration: 1,
    }),
    isGitRepository: async () => true,
    loadConfigWithFallback: async () => createLoadedConfig(),
    resolveCreateInvocationContext: async () => ({
      invocationPath: workspaceRoot,
      workspaceRoot,
      executionPath: workspaceRoot,
      repositoryType: "non-bare",
    }),
    resolveCurrentBranch: async () => "main",
    ...overrides,
  };
}

describe("create defaults integration", () => {
  test("applies configured create launch defaults", async () => {
    const launchCalls: { sesh?: boolean }[] = [];

    await executeCreate(
      branchName,
      {},
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { mode: "sesh", command: ["tmux"] };
        },
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
      }),
    );

    expect(launchCalls).toEqual([{ sesh: true }]);
  });

  test("allows one-off opt-out from configured create launch defaults", async () => {
    const launchCalls: { sesh?: boolean }[] = [];

    await executeCreate(
      branchName,
      { launch: false },
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { mode: "sesh", command: ["tmux"] };
        },
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
      }),
    );

    expect(launchCalls).toHaveLength(0);
  });

  test("preserves backward compatibility when create defaults are absent", async () => {
    const launchCalls: { sesh?: boolean }[] = [];

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

  test("allows explicit create launch override without config defaults", async () => {
    const launchCalls: { sesh?: boolean }[] = [];

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
});
