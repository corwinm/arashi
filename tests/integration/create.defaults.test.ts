import type { Config, LoadedConfig } from "../../src/lib/config.ts";
import { describe, expect, test, vi } from "vitest";
import type { OperationSummary } from "../../src/core/worktree.ts";
import { executeCreate, resolveCreateDefaults } from "../../src/commands/create.ts";
type CreateCommandDependencies = NonNullable<Parameters<typeof executeCreate>[2]>;

const workspaceRoot = "/workspace";
const branchName = "feature/defaults";

function createLaunchCalls(): { sesh?: boolean; tmux?: boolean }[] {
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
  test.each([
    { interactive: true },
    { launch: true },
    { tmux: true },
    { sesh: true },
    { herdr: true },
    { switch: true },
    { tab: true },
    { sesh: true, tmux: true },
  ])("direct JSON rejection precedes validation and creation for %#", async (launchOptions) => {
    let creationCalled = false;
    const stdout: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    const result = await executeCreate(
      branchName,
      { json: true, ...launchOptions },
      baseDeps({
        createCoordinatedWorktrees: async () => {
          creationCalled = true;
          return createSummary();
        },
        env: { TMUX: "  " },
      }),
    );

    expect(result).toBe(1);
    expect(creationCalled).toBe(false);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      command: "create",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "interactive-or-launch" },
      },
      ok: false,
    });
    write.mockRestore();
  });

  test("tab implies launch and switch and wins over negative flags", () => {
    expect(
      resolveCreateDefaults(
        { launch: false, switch: false, tab: true },
        createLoadedConfig().config,
      ),
    ).toEqual({
      disposition: "tab",
      launchMode: "auto",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test("dry-run previews tab without requiring runtime target evidence", async () => {
    let reconciled = false;
    let created = false;
    await expect(
      executeCreate(
        branchName,
        { dryRun: true, tab: true },
        baseDeps({
          env: {},
          reconcileManagedIgnore: async (options) => {
            reconciled = true;
            return baseDeps().reconcileManagedIgnore!(options);
          },
          createCoordinatedWorktrees: async (...args) => {
            created = true;
            const summary = await baseDeps().createCoordinatedWorktrees!(...args);
            return {
              ...summary,
              dryRunOutcome: {
                conflicts: [],
                overallStatus: "actionable" as const,
                plannedWorktrees: [],
                summaryCounts: { blockingTotal: 0, conflictTotal: 0, plannedTotal: 0 },
              },
              isDryRun: true,
            };
          },
        }),
      ),
    ).resolves.toBe(0);
    expect(reconciled).toBe(true);
    expect(created).toBe(true);
  });

  test("preflights a knowably unsupported tab before managed ignore or creation", async () => {
    let reconciled = false;
    let created = false;
    await expect(
      executeCreate(
        branchName,
        { tab: true },
        baseDeps({
          env: {},
          platform: "linux",
          reconcileManagedIgnore: async (...args) => {
            reconciled = true;
            return baseDeps().reconcileManagedIgnore!(...args);
          },
          createCoordinatedWorktrees: async (...args) => {
            created = true;
            return baseDeps().createCoordinatedWorktrees!(...args);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "TAB_DISPOSITION_UNSUPPORTED" });
    expect(reconciled).toBe(false);
    expect(created).toBe(false);
  });

  test("rejects an available auto IDE tab before managed ignore, hooks, branches, or worktrees", async () => {
    const events: string[] = [];
    await expect(
      executeCreate(
        branchName,
        { tab: true },
        baseDeps({
          env: { TERM_PROGRAM: "vscode" },
          platform: "darwin",
          runProcess: async (command) => {
            events.push(command.join(" "));
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/code\n" };
          },
          reconcileManagedIgnore: async (...args) => {
            events.push("MUTATION managed-ignore");
            return baseDeps().reconcileManagedIgnore!(...args);
          },
          createCoordinatedWorktrees: async (...args) => {
            events.push("MUTATION create");
            return baseDeps().createCoordinatedWorktrees!(...args);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "TAB_DISPOSITION_UNSUPPORTED" });
    expect(events).toEqual(["which code"]);
  });

  test("lets an unavailable auto IDE fall through to the canonical platform tab mapping", async () => {
    const events: string[] = [];
    await expect(
      executeCreate(
        branchName,
        { tab: true },
        baseDeps({
          env: { TERM_PROGRAM: "vscode", WT_SESSION: "session" },
          platform: "win32",
          runProcess: async (command) => {
            events.push(command.join(" "));
            return { exitCode: 1, stderr: "missing", stdout: "" };
          },
          reconcileManagedIgnore: async (...args) => {
            events.push("MUTATION managed-ignore");
            return baseDeps().reconcileManagedIgnore!(...args);
          },
          createCoordinatedWorktrees: async (...args) => {
            events.push("MUTATION create");
            return baseDeps().createCoordinatedWorktrees!(...args);
          },
          launchSwitchTarget: async (_candidate, options) => ({
            command: ["wt.exe"],
            disposition: options.disposition,
            mode: "fallback",
          }),
        }),
      ),
    ).resolves.toBe(0);
    expect(events[0]).toBe("where code");
    expect(events).toContain("MUTATION managed-ignore");
    expect(events).toContain("MUTATION create");
  });

  test("keeps configured create mutation-free when Terminal.app tabs are unsupported", async () => {
    const events: string[] = [];
    await expect(
      executeCreate(
        branchName,
        { tab: true },
        baseDeps({
          env: { SHELL: "/bin/zsh", TERM_PROGRAM: "Apple_Terminal" },
          platform: "darwin",
          runProcess: async (command) => {
            events.push(command[0] ?? "unknown");
            return { exitCode: 0, stderr: "", stdout: "" };
          },
          reconcileManagedIgnore: async (...args) => {
            events.push("MUTATION managed-ignore");
            return baseDeps().reconcileManagedIgnore!(...args);
          },
          createCoordinatedWorktrees: async (...args) => {
            events.push("MUTATION create");
            return baseDeps().createCoordinatedWorktrees!(...args);
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "TAB_DISPOSITION_UNSUPPORTED",
      context: { disposition: "tab", launcher: "terminal" },
      message: expect.stringContaining("Command-T"),
    });
    expect(events).toEqual([]);
  });

  test.each([undefined, "", "   "])(
    "rejects explicit tmux context %s before configured creation",
    async (tmuxValue) => {
      let creationCalled = false;
      await expect(
        executeCreate(
          branchName,
          { tmux: true },
          baseDeps({
            createCoordinatedWorktrees: async () => {
              creationCalled = true;
              return createSummary();
            },
            env: { TMUX: tmuxValue },
          }),
        ),
      ).rejects.toMatchObject({ code: "TMUX_CONTEXT_REQUIRED" });
      expect(creationCalled).toBe(false);
    },
  );

  test.each([
    {
      code: "SESH_REQUIRES_TMUX",
      env: { TMUX: "   " },
      expectedEvents: [],
      lookupExitCode: 0,
    },
    {
      code: "SESH_NOT_FOUND",
      env: { TMUX: "/tmp/tmux" },
      expectedEvents: [`${process.platform === "win32" ? "where" : "which"} sesh`],
      lookupExitCode: 1,
    },
  ])("rejects sesh $code before managed-ignore, hooks, branches, or worktrees", async (fixture) => {
    const events: string[] = [];
    await expect(
      executeCreate(
        branchName,
        { sesh: true },
        baseDeps({
          env: fixture.env,
          runProcess: async (command) => {
            events.push(command.join(" "));
            return { exitCode: fixture.lookupExitCode, stderr: "missing", stdout: "" };
          },
          reconcileManagedIgnore: async (...args) => {
            events.push("MUTATION managed-ignore");
            return baseDeps().reconcileManagedIgnore!(...args);
          },
          createCoordinatedWorktrees: async (...args) => {
            events.push("MUTATION branch-worktree-hooks");
            return baseDeps().createCoordinatedWorktrees!(...args);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: fixture.code });
    expect(events).toEqual(fixture.expectedEvents);
  });

  test("dry-run sesh skips runtime prerequisite execution", async () => {
    const commands: string[][] = [];
    await expect(
      executeCreate(
        branchName,
        { dryRun: true, sesh: true },
        baseDeps({
          env: {},
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: 1, stderr: "missing", stdout: "" };
          },
          createCoordinatedWorktrees: async () => ({
            ...createSummary(),
            dryRunOutcome: {
              conflicts: [],
              overallStatus: "actionable",
              plannedWorktrees: [],
              summaryCounts: { blockingTotal: 0, conflictTotal: 0, plannedTotal: 0 },
            },
            isDryRun: true,
          }),
        }),
      ),
    ).resolves.toBe(0);
    expect(commands).toEqual([]);
  });

  test("explicit tmux overrides configured create mode", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      { tmux: true },
      baseDeps({
        env: { TMUX: "/tmp/tmux/default" },
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], disposition: "window", mode: "tmux" };
        },
        loadConfigWithFallback: async () =>
          createLoadedConfig({
            defaults: { create: { launch: "sesh", switch: true } },
          }),
      }),
    );

    expect(launchCalls).toEqual([{ disposition: "window", sesh: false, tmux: true }]);
  });

  test("preserves configured worktrees when explicit tmux process launch fails", async () => {
    let creationCompleted = false;
    const commands: string[][] = [];

    await expect(
      executeCreate(
        branchName,
        { tmux: true },
        baseDeps({
          createCoordinatedWorktrees: async () => {
            creationCompleted = true;
            return createSummary();
          },
          env: { TMUX: "/tmp/tmux/default" },
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: 23, stderr: "tmux failed after create", stdout: "" };
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    expect(creationCompleted).toBe(true);
    expect(commands).toEqual([["tmux", "new-window", "-c", `${workspaceRoot}/${branchName}`]]);
  });

  test("applies configured create launch defaults", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      {},
      baseDeps({
        env: { TMUX: "/tmp/tmux/default" },
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], disposition: "window", mode: "sesh" };
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
        runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "/usr/bin/sesh\n" }),
      }),
    );

    expect(launchCalls).toEqual([{ disposition: "window", sesh: true }]);
  });

  test("preserves cmux launch mode for configured post-create launch", async () => {
    const launchCandidates: string[] = [];

    await executeCreate(
      branchName,
      {},
      baseDeps({
        launchSwitchTarget: async (candidate) => {
          launchCandidates.push(candidate.worktreePath);
          return { command: ["cmux", "workspace", "create"], disposition: "window", mode: "cmux" };
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
        env: { TMUX: "/tmp/tmux/default" },
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], disposition: "window", mode: "sesh" };
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
        runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "/usr/bin/sesh\n" }),
      }),
    );

    expect(launchCalls).toEqual([{ disposition: "window", sesh: true }]);
  });

  test("allows one-off opt-out from configured create launch defaults", async () => {
    const launchCalls = createLaunchCalls();

    await executeCreate(
      branchName,
      { launch: false },
      baseDeps({
        launchSwitchTarget: async (_candidate, options) => {
          launchCalls.push(options);
          return { command: ["tmux"], disposition: "window", mode: "sesh" };
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
          return { command: ["open"], disposition: "window", mode: "fallback" };
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
          return { command: ["tmux"], disposition: "window", mode: "sesh" };
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
          return { command: ["open"], disposition: "window", mode: "fallback" };
        },
      }),
    );

    expect(launchCalls).toEqual([{ disposition: "window", sesh: false }]);
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
