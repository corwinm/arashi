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
                launch: true,
                launchMode: "sesh",
                switch: true,
              },
            },
          }),
      }),
    );

    expect(launchCalls).toEqual([{ sesh: true }]);
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
                launch: true,
                switch: true,
              },
              editors: {
                vscode: {
                  create: {
                    launch: true,
                    launchMode: "sesh",
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
                launch: true,
                launchMode: "sesh",
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
                launch: true,
                launchMode: "sesh",
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
});
