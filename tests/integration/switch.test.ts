import {
  createCommand,
  executeSwitch,
  resolveSwitchResolution,
} from "../../src/commands/switch.ts";
import type { SwitchCommandOptions, SwitchExecutionResult } from "../../src/commands/switch.ts";
import { runtime } from "../helpers/node-runtime.ts";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { join, resolve } from "path";
import { mkdtemp, realpath, rm } from "fs/promises";
import type { SwitchCandidate } from "../../src/core/switch.ts";
import type { SwitchProcessRunner } from "../../src/lib/switch-launcher.ts";
import type { WorkspaceRepository } from "../../src/lib/config.ts";
import { tmpdir } from "os";

const candidate: SwitchCandidate = {
  branchName: "feature/switch-command",
  repoName: "workspace",
  worktreePath: "/workspace/feature-switch-command",
};

const resolvedPath = (path: string): string => resolve(path);

describe("unified switch resolution", () => {
  test.each([
    { expected: "launch", managedActive: false, mode: undefined, shellActive: false },
    { expected: "launch", managedActive: false, mode: "launch", shellActive: true },
    { expected: "cd", managedActive: false, mode: "auto", shellActive: true },
    { expected: "launch", managedActive: true, mode: "auto", shellActive: true },
    { expected: "launch", managedActive: false, mode: "auto", shellActive: false },
    { expected: "cd", managedActive: true, mode: "cd", shellActive: true },
    { expected: "cd", managedActive: true, mode: "cd", shellActive: false },
    { expected: "launch", managedActive: true, mode: "sesh", shellActive: true },
    { expected: "launch", managedActive: true, mode: "herdr", shellActive: true },
  ] as const)(
    "resolves configured mode $mode with shell=$shellActive managed=$managedActive to $expected",
    ({ expected, managedActive, mode, shellActive }) => {
      expect(
        resolveSwitchResolution({
          configMode: mode,
          managedContextActive: managedActive,
          options: {},
          shellIntegrationActive: shellActive,
        }).behavior.mode,
      ).toBe(expected);
    },
  );

  test.each(["tmux", "sesh", "herdr", "vscode", "cursor", "kiro"] as const)(
    "rejects --cd with explicit --%s",
    (launcher) => {
      expect(() =>
        resolveSwitchResolution({
          configMode: "auto",
          managedContextActive: true,
          options: { cd: true, [launcher]: true },
          shellIntegrationActive: true,
        }),
      ).toThrowError(/Conflicting switch behavior overrides/);
    },
  );

  test.each(["sesh", "herdr", "vscode", "cursor", "kiro"] as const)(
    "rejects --tmux with explicit --%s and reports both launchers",
    (launcher) => {
      expect(() =>
        resolveSwitchResolution({
          configMode: "auto",
          managedContextActive: true,
          options: { tmux: true, [launcher]: true },
          shellIntegrationActive: true,
        }),
      ).toThrowError(new RegExp(`--tmux, --${launcher}`));
    },
  );

  test.each([{ cd: false }, { defaultLaunch: false }])(
    "keeps explicit tmux authoritative with compatible opt-out %#",
    (compatibleOption) => {
      expect(
        resolveSwitchResolution({
          configMode: "herdr",
          managedContextActive: true,
          options: { ...compatibleOption, tmux: true },
          shellIntegrationActive: true,
        }),
      ).toMatchObject({ behavior: { mode: "launch" }, launch: { tmux: true } });
    },
  );

  test("--no-cd retains a configured explicit launcher", () => {
    expect(
      resolveSwitchResolution({
        configMode: "herdr",
        managedContextActive: true,
        options: { cd: false },
        shellIntegrationActive: true,
      }),
    ).toMatchObject({
      behavior: { mode: "launch" },
      launch: { herdr: true, sesh: false },
    });
  });

  test.each(["sesh", "herdr"] as const)(
    "--cd remains authoritative over configured %s launch behavior",
    (configMode) => {
      expect(
        resolveSwitchResolution({
          configMode,
          managedContextActive: true,
          options: { cd: true },
          shellIntegrationActive: true,
        }).behavior.mode,
      ).toBe("cd");
    },
  );

  test("--no-default-launch opts out only a configured explicit launcher", () => {
    expect(
      resolveSwitchResolution({
        configMode: "herdr",
        managedContextActive: true,
        options: { defaultLaunch: false },
        shellIntegrationActive: true,
      }),
    ).toMatchObject({
      behavior: { mode: "launch" },
      launch: { sesh: false },
    });
    expect(
      resolveSwitchResolution({
        configMode: "auto",
        managedContextActive: false,
        options: { defaultLaunch: false },
        shellIntegrationActive: true,
      }).behavior.mode,
    ).toBe("cd");
  });

  test.each(["sesh", "herdr"] as const)(
    "--tab bypasses a configured %s launcher without a redundant opt-out",
    (configMode) => {
      expect(
        resolveSwitchResolution({
          configMode,
          managedContextActive: true,
          options: { tab: true },
          shellIntegrationActive: true,
        }),
      ).toEqual({
        behavior: {
          mode: "launch",
          skipLaunchWhenUnavailable: false,
          warnOnMissingIntegration: false,
        },
        launch: { disposition: "tab", sesh: false },
      });
    },
  );

  test("--tab preserves an explicit launcher over a different configured launcher", () => {
    expect(
      resolveSwitchResolution({
        configMode: "sesh",
        managedContextActive: true,
        options: { herdr: true, tab: true },
        shellIntegrationActive: true,
      }),
    ).toMatchObject({
      behavior: { mode: "launch" },
      launch: { disposition: "tab", herdr: true, sesh: false },
    });
  });
});

describe("switch command integration", () => {
  test("types direct JSON, human, and widened switch execution results accurately", () => {
    const assertTypes = () => {
      expectTypeOf(executeSwitch(undefined, { json: true })).toEqualTypeOf<Promise<number>>();
      expectTypeOf(executeSwitch(undefined, { json: false })).toEqualTypeOf<
        Promise<SwitchExecutionResult>
      >();
      const widened: SwitchCommandOptions = {};
      expectTypeOf(executeSwitch(undefined, widened)).toEqualTypeOf<
        Promise<SwitchExecutionResult | number>
      >();
    };
    expectTypeOf(assertTypes).toBeFunction();
  });

  test("registers switch command with explicit plain tmux option", () => {
    const command = createCommand();
    expect(command.name()).toBe("switch");
    expect(command.options.some((option) => option.long === "--path")).toBe(true);
    expect(command.options.some((option) => option.long === "--sesh")).toBe(true);
    expect(command.options.find((option) => option.long === "--tmux")?.description).toContain(
      "plain tmux",
    );
    expect(command.options.some((option) => option.long === "--cd")).toBe(true);
    expect(command.options.some((option) => option.long === "--vscode")).toBe(true);
    expect(command.options.some((option) => option.long === "--cursor")).toBe(true);
    expect(command.options.some((option) => option.long === "--kiro")).toBe(true);
    expect(command.options.some((option) => option.long === "--no-default-launch")).toBe(true);
    expect(command.options.find((option) => option.long === "--tab")?.description).toContain(
      "bypasses configured launch defaults",
    );
    expect(command.options.some((option) => option.long === "--repos")).toBe(true);
    expect(command.options.some((option) => option.long === "--all")).toBe(true);
  });

  test("renders the default-window and fail-closed tab disposition contract", () => {
    let help = "";
    createCommand()
      .configureOutput({ writeOut: (value) => (help += value) })
      .outputHelp();
    expect(help).toContain(
      "By default, launch opens a new OS window or managed independent-session equivalent.",
    );
    expect(help).toContain(
      "--tab requests a true tab or equivalent; unsupported mappings fail without opening a window.",
    );
  });

  test("passes forced tmux through ahead of configured cd behavior", async () => {
    const launchOptions: unknown[] = [];
    const result = await executeSwitch(
      undefined,
      { tmux: true },
      {
        discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
        env: { TMUX: "/tmp/tmux/default" },
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async (_candidate, options) => {
          launchOptions.push(options);
          return { command: ["tmux"], disposition: "window", mode: "tmux" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: { switch: { mode: "cd" } },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("tmux");
    expect(launchOptions).toEqual([{ disposition: "window", tmux: true }]);
  });

  test("direct JSON tmux rejection precedes conflicts, blank context, and discovery", async () => {
    let discoveryCalled = false;
    const stdout: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    const result = await executeSwitch(
      undefined,
      { json: true, sesh: true, tmux: true },
      {
        discoverSwitchCandidates: async () => {
          discoveryCalled = true;
          return { candidates: [candidate], skippedCount: 0 };
        },
        env: { TMUX: "   " },
      },
    );

    expect(result).toBe(2);
    expect(discoveryCalled).toBe(false);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      command: "switch",
      error: { code: "JSON_UNSUPPORTED_FOR_MODE", details: { mode: "launch" } },
      ok: false,
    });
    write.mockRestore();
  });

  test("direct JSON tab rejection precedes conflicts and discovery", async () => {
    let discoveryCalled = false;
    const stdout: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    const result = await executeSwitch(
      undefined,
      { cd: true, json: true, tab: true },
      {
        discoverSwitchCandidates: async () => {
          discoveryCalled = true;
          return { candidates: [candidate], skippedCount: 0 };
        },
      },
    );

    expect(result).toBe(2);
    expect(discoveryCalled).toBe(false);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      command: "switch",
      error: { code: "JSON_UNSUPPORTED_FOR_MODE", details: { mode: "launch" } },
      ok: false,
    });
    write.mockRestore();
  });

  test("tab overrides contextual cd, composes with no-default-launch, and reaches the launcher", async () => {
    const launchOptions: unknown[] = [];
    const result = await executeSwitch(
      undefined,
      { defaultLaunch: false, tab: true },
      {
        discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
        env: { ARASHI_CD_FILE: "/tmp/directive", TMUX: "/tmp/tmux/default" },
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async (_candidate, options) => {
          launchOptions.push(options);
          return { command: ["tmux"], disposition: "tab", mode: "tmux" };
        },
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("tmux");
    expect(launchOptions).toEqual([{ disposition: "tab", sesh: false }]);
  });

  test("tab conflicts only with explicit cd", () => {
    expect(() =>
      resolveSwitchResolution({
        managedContextActive: false,
        options: { cd: true, tab: true },
        shellIntegrationActive: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFLICTING_SWITCH_OPTIONS" }));
    expect(() =>
      resolveSwitchResolution({
        managedContextActive: false,
        options: { cd: false, tab: true, vscode: true },
        shellIntegrationActive: true,
      }),
    ).not.toThrow();
  });

  test("rejects conflicting explicit launch overrides", async () => {
    await expect(
      executeSwitch(
        undefined,
        { cursor: true, vscode: true },
        {
          discoverSwitchCandidates: async () => ({
            candidates: [candidate],
            skippedCount: 0,
          }),
          findWorkspaceRoot: async () => "/workspace",
          loadWorkspaceRepositories: async () => ({ repositories: [] }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICTING_LAUNCH_OPTIONS",
    });
  });

  test("defaults to parent repository targets", async () => {
    const discoveredRepoSets: string[][] = [];
    const repositories: WorkspaceRepository[] = [
      { name: "workspace", path: "/workspace" },
      { name: "repo-a", path: "/workspace/repos/repo-a" },
      { name: "repo-b", path: "/workspace/repos/repo-b" },
    ];

    await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async (targets) => {
          discoveredRepoSets.push(targets.map((target) => target.name));
          return { candidates: [candidate], skippedCount: 0 };
        },
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({ repositories }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(discoveredRepoSets).toEqual([["workspace"]]);
  });

  test("reports cmux launch mode from the shared launcher", async () => {
    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["cmux", "workspace", "create"],
          disposition: "window",
          mode: "cmux",
        }),
        loadWorkspaceRepositories: async () => ({
          repositories: [{ name: "workspace", path: "/workspace" }],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("cmux");
  });

  test("uses child repositories only with --repos", async () => {
    const discoveredRepoSets: string[][] = [];
    const repositories: WorkspaceRepository[] = [
      { name: "workspace", path: "/workspace" },
      { name: "repo-a", path: "/workspace/repos/repo-a" },
      { name: "repo-b", path: "/workspace/repos/repo-b" },
    ];

    await executeSwitch(
      undefined,
      { repos: true },
      {
        discoverSwitchCandidates: async (targets) => {
          discoveredRepoSets.push(targets.map((target) => target.name));
          return { candidates: [candidate], skippedCount: 0 };
        },
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({ repositories }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(discoveredRepoSets).toEqual([["repo-a", "repo-b"]]);
  });

  test("selects a worktree by exact path when --path is enabled", async () => {
    const result = await executeSwitch(
      "/workspace/main",
      { path: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [
            {
              branchName: "main",
              repoName: "workspace",
              worktreePath: "/workspace/main",
            },
            {
              branchName: "main",
              repoName: "workspace",
              worktreePath: "/workspace/main-copy",
            },
          ],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({
          repositories: [{ name: "workspace", path: "/workspace" }],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.matchedCandidates).toBe(1);
    expect(result.selected.worktreePath).toBe("/workspace/main");
  });

  test("reports a clear error when --path does not match a worktree", async () => {
    await expect(
      executeSwitch(
        "/workspace/missing",
        { path: true },
        {
          discoverSwitchCandidates: async () => ({
            candidates: [
              {
                branchName: "main",
                repoName: "workspace",
                worktreePath: "/workspace/main",
              },
            ],
            skippedCount: 0,
          }),
          findWorkspaceRoot: async () => "/workspace",
          loadWorkspaceRepositories: async () => ({
            repositories: [{ name: "workspace", path: "/workspace" }],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "NO_MATCHES",
      message: `No worktree exists at exact path \`${resolvedPath("/workspace/missing")}\`. Run \`arashi list\` to see available worktree paths.`,
    });
  });

  test("keeps ambiguous fuzzy matching behavior when --path is not enabled", async () => {
    await expect(
      executeSwitch(
        "main",
        {},
        {
          discoverSwitchCandidates: async () => ({
            candidates: [
              {
                branchName: "main",
                repoName: "workspace",
                worktreePath: "/workspace/main",
              },
              {
                branchName: "feature/main-fix",
                repoName: "workspace",
                worktreePath: "/workspace/feature-main-fix",
              },
            ],
            skippedCount: 0,
          }),
          findWorkspaceRoot: async () => "/workspace",
          loadWorkspaceRepositories: async () => ({
            repositories: [{ name: "workspace", path: "/workspace" }],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      ),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_NON_INTERACTIVE",
    });
  });

  test("limits --repos candidates to the current workspace path", async () => {
    const result = await executeSwitch(
      undefined,
      { repos: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [
            {
              branchName: "feature/current",
              repoName: "repo-a",
              worktreePath: "/workspace/current/repos/repo-a",
            },
            {
              branchName: "feature/other",
              repoName: "repo-a",
              worktreePath: "/workspace/other/repos/repo-a",
            },
          ],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace/current",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({
          repositories: [
            { name: "workspace", path: "/workspace/current" },
            { name: "repo-a", path: "/workspace/current/repos/repo-a" },
          ],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.totalCandidates).toBe(1);
    expect(result.selected.worktreePath).toBe("/workspace/current/repos/repo-a");
  });

  test("matches exact repo name first in --repos mode", async () => {
    const result = await executeSwitch(
      "docs",
      { repos: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [
            {
              branchName: "feature/site",
              repoName: "docs",
              worktreePath: "/workspace/repos/docs",
            },
            {
              branchName: "docs",
              repoName: "api",
              worktreePath: "/workspace/repos/api",
            },
          ],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({
          repositories: [
            { name: "workspace", path: "/workspace" },
            { name: "docs", path: "/workspace/repos/docs" },
            { name: "api", path: "/workspace/repos/api" },
          ],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.totalCandidates).toBe(2);
    expect(result.matchedCandidates).toBe(1);
    expect(result.selected.repoName).toBe("docs");
  });

  test("matches a unique partial repo name in --repos mode", async () => {
    const result = await executeSwitch(
      "doc",
      { repos: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [
            {
              branchName: "feature/docs",
              repoName: "docs-site",
              worktreePath: "/workspace/repos/docs-site",
            },
            {
              branchName: "feature/api",
              repoName: "api",
              worktreePath: "/workspace/repos/api",
            },
          ],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({
          repositories: [
            { name: "workspace", path: "/workspace" },
            { name: "docs-site", path: "/workspace/repos/docs-site" },
            { name: "api", path: "/workspace/repos/api" },
          ],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.matchedCandidates).toBe(1);
    expect(result.selected.repoName).toBe("docs-site");
  });

  test("shows available repos when --repos filter has no matches", async () => {
    await expect(
      executeSwitch(
        "docs",
        { repos: true },
        {
          discoverSwitchCandidates: async () => ({
            candidates: [
              {
                branchName: "feature/api",
                repoName: "api",
                worktreePath: "/workspace/repos/api",
              },
              {
                branchName: "feature/web",
                repoName: "web",
                worktreePath: "/workspace/repos/web",
              },
            ],
            skippedCount: 0,
          }),
          findWorkspaceRoot: async () => "/workspace",
          launchSwitchTarget: async () => ({
            command: ["noop"],
            disposition: "window",
            mode: "fallback",
          }),
          loadWorkspaceRepositories: async () => ({
            repositories: [
              { name: "workspace", path: "/workspace" },
              { name: "api", path: "/workspace/repos/api" },
              { name: "web", path: "/workspace/repos/web" },
            ],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      ),
    ).rejects.toMatchObject({
      message: "No child repository matched `docs`. Available repositories: api, web",
    });
  });

  test("uses parent and child repositories with --all", async () => {
    const discoveredRepoSets: string[][] = [];
    const repositories: WorkspaceRepository[] = [
      { name: "workspace", path: "/workspace" },
      { name: "repo-a", path: "/workspace/repos/repo-a" },
      { name: "repo-b", path: "/workspace/repos/repo-b" },
    ];

    await executeSwitch(
      undefined,
      { all: true },
      {
        discoverSwitchCandidates: async (targets) => {
          discoveredRepoSets.push(targets.map((target) => target.name));
          return { candidates: [candidate], skippedCount: 0 };
        },
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({ repositories }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(discoveredRepoSets).toEqual([["workspace", "repo-a", "repo-b"]]);
  });

  test("includes child repo worktrees for each parent workspace in --all mode", async () => {
    const selectedCandidates: SwitchCandidate[][] = [];

    await executeSwitch(
      undefined,
      { all: true },
      {
        augmentAllScopeCandidates: async (candidates) => [
          ...candidates,
          {
            branchName: "main",
            repoName: "docs",
            worktreePath: "/workspace/repos/docs",
          },
          {
            branchName: "feature/a",
            repoName: "docs",
            worktreePath: "/workspace-feature-a/repos/docs",
          },
        ],
        discoverSwitchCandidates: async () => ({
          candidates: [
            {
              branchName: "main",
              repoName: "workspace",
              worktreePath: "/workspace",
            },
            {
              branchName: "feature/a",
              repoName: "workspace",
              worktreePath: "/workspace-feature-a",
            },
          ],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => ({
          command: ["noop"],
          disposition: "window",
          mode: "fallback",
        }),
        loadWorkspaceRepositories: async () => ({
          repositories: [
            { name: "workspace", path: "/workspace" },
            { name: "docs", path: "/workspace/repos/docs" },
          ],
        }),
        selectSwitchCandidate: async (candidates) => {
          selectedCandidates.push(candidates);
          return candidates[3];
        },
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
    );

    expect(selectedCandidates).toHaveLength(1);
    expect(selectedCandidates[0].map((candidate) => candidate.worktreePath)).toEqual([
      "/workspace",
      "/workspace-feature-a",
      "/workspace/repos/docs",
      "/workspace-feature-a/repos/docs",
    ]);
  });

  test("invokes tmux+sesh runner path when --sesh is requested", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "which" && command[1] === "sesh") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/sesh\n" };
      }

      if (command[0] === "tmux") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      { sesh: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: { TMUX: "/tmp/tmux-1000/default" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "darwin",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("sesh");
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toEqual(["which", "sesh"]);
    expect(invocations[1][0]).toBe("tmux");
  });

  test("applies configured switch launch mode defaults", async () => {
    const launchOptions: { sesh?: boolean }[] = [];

    await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async (_candidate, options) => {
          launchOptions.push(options);
          return { command: ["tmux"], disposition: "window", mode: "sesh" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: {
              switch: {
                mode: "sesh",
              },
            },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(launchOptions).toEqual([{ disposition: "window", sesh: true }]);
  });

  test("writes a cd directive when --cd is requested through shell integration", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "arashi-switch-directive-"));
    const directivePath = join(tempDir, "directive.sh");
    let launchCalled = false;

    try {
      const result = await executeSwitch(
        undefined,
        { cd: true },
        {
          discoverSwitchCandidates: async () => ({
            candidates: [candidate],
            skippedCount: 0,
          }),
          env: {
            ARASHI_DIRECTIVE_FILE: directivePath,
            ARASHI_SHELL: "bash",
          },
          findWorkspaceRoot: async () => "/workspace",
          launchSwitchTarget: async () => {
            launchCalled = true;
            return { command: ["open"], disposition: "window", mode: "fallback" };
          },
          loadWorkspaceRepositories: async () => ({ repositories: [] }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );

      expect(result.launchMode).toBe("cd");
      expect(await runtime.file(directivePath).text()).toBe(
        "cd -- '/workspace/feature-switch-command'\n",
      );
      expect(launchCalled).toBe(false);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test("auto mode prefers cd when shell integration is active", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "arashi-switch-auto-"));
    const directivePath = join(tempDir, "directive.sh");

    try {
      const result = await executeSwitch(
        undefined,
        {},
        {
          discoverSwitchCandidates: async () => ({
            candidates: [candidate],
            skippedCount: 0,
          }),
          env: {
            ARASHI_DIRECTIVE_FILE: directivePath,
            ARASHI_SHELL: "bash",
          },
          findWorkspaceRoot: async () => "/workspace",
          loadWorkspaceRepositories: async () => ({
            config: {
              defaults: {
                switch: {
                  mode: "auto",
                },
              },
              repos: {},
              reposDir: "./repos",
              version: "1.0.0",
            },
            repositories: [],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );

      expect(result.launchMode).toBe("cd");
      expect(await runtime.file(directivePath).text()).toBe(
        "cd -- '/workspace/feature-switch-command'\n",
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test.each([
    [{ TMUX: "/tmp/tmux/default" }, "tmux"],
    [{ HERDR_ENV: " 1 " }, "herdr"],
    [{ CMUX_SURFACE_ID: "surface:1" }, "cmux"],
    [
      {
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/cursor",
      },
      "cursor",
    ],
    [{ TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_EXTRA_ARGS: "--host=kiro" }, "kiro"],
    [{ TERM_PROGRAM: "vscode" }, "vscode"],
  ] as const)("configured auto launches strict managed context %#", async (signal, mode) => {
    const tempDir = await mkdtemp(join(tmpdir(), "arashi-switch-managed-auto-"));
    const directivePath = join(tempDir, "directive.sh");
    let launched = false;
    try {
      const result = await executeSwitch(
        undefined,
        {},
        {
          discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
          env: {
            ...signal,
            ARASHI_DIRECTIVE_FILE: directivePath,
            ARASHI_SHELL: "bash",
          },
          findWorkspaceRoot: async () => "/workspace",
          launchSwitchTarget: async () => {
            launched = true;
            return { command: [mode], disposition: "window", mode };
          },
          loadWorkspaceRepositories: async () => ({
            config: {
              defaults: { switch: { mode: "auto" } },
              repos: {},
              reposDir: "./repos",
              version: "1.0.0",
            },
            repositories: [],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );

      expect(result.launchMode).toBe(mode);
      expect(launched).toBe(true);
      expect(await runtime.file(directivePath).exists()).toBe(false);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test.each([
    { CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
    { HERDR_ENV: "true" },
    { TERM_PROGRAM: "ghostty" },
    { TERM_PROGRAM: "unsupported-ide" },
  ])("configured auto uses cd for weak context %#", async (signal) => {
    const tempDir = await mkdtemp(join(tmpdir(), "arashi-switch-weak-auto-"));
    const directivePath = join(tempDir, "directive.sh");
    try {
      const result = await executeSwitch(
        undefined,
        {},
        {
          discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
          env: {
            ...signal,
            ARASHI_DIRECTIVE_FILE: directivePath,
            ARASHI_SHELL: "bash",
          },
          findWorkspaceRoot: async () => "/workspace",
          launchSwitchTarget: async () => {
            throw new Error("weak context must not launch");
          },
          loadWorkspaceRepositories: async () => ({
            config: {
              defaults: { switch: { mode: "auto" } },
              repos: {},
              reposDir: "./repos",
              version: "1.0.0",
            },
            repositories: [],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );
      expect(result.launchMode).toBe("cd");
      expect(await runtime.file(directivePath).text()).toContain(candidate.worktreePath);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  test.each([undefined, "launch"] as const)(
    "%s mode launches even when shell integration is active",
    async (mode) => {
      let launched = false;
      const result = await executeSwitch(
        undefined,
        {},
        {
          discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
          env: { ARASHI_DIRECTIVE_FILE: "/tmp/unused", ARASHI_SHELL: "bash" },
          findWorkspaceRoot: async () => "/workspace",
          launchSwitchTarget: async () => {
            launched = true;
            return { command: ["open"], disposition: "window", mode: "fallback" };
          },
          loadWorkspaceRepositories: async () => ({
            config: {
              defaults: mode ? { switch: { mode } } : undefined,
              repos: {},
              reposDir: "./repos",
              version: "1.0.0",
            },
            repositories: [],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );
      expect(result.launchMode).toBe("fallback");
      expect(launched).toBe(true);
    },
  );

  test("configured cd falls back to automatic launch when shell integration is unavailable", async () => {
    let launched = false;
    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
        env: {},
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => {
          launched = true;
          return { command: ["open"], disposition: "window", mode: "fallback" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: { switch: { mode: "cd" } },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );
    expect(result.launchMode).toBe("fallback");
    expect(launched).toBe(true);
  });

  test("--no-cd retains configured Herdr unless default launch is opted out", async () => {
    const launchOptions: unknown[] = [];
    for (const defaultLaunch of [undefined, false]) {
      await executeSwitch(
        undefined,
        { cd: false, defaultLaunch },
        {
          discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
          findWorkspaceRoot: async () => "/workspace",
          launchSwitchTarget: async (_candidate, launch) => {
            launchOptions.push(launch);
            return { command: ["open"], disposition: "window", mode: "fallback" };
          },
          loadWorkspaceRepositories: async () => ({
            config: {
              defaults: { switch: { mode: "herdr" } },
              repos: {},
              reposDir: "./repos",
              version: "1.0.0",
            },
            repositories: [],
          }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );
    }
    expect(launchOptions).toEqual([
      { disposition: "window", herdr: true, sesh: false },
      { disposition: "window", sesh: false },
    ]);
  });

  test("auto mode falls back to launch behavior when shell integration is inactive", async () => {
    let launchCalled = false;

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => {
          launchCalled = true;
          return { command: ["open"], disposition: "window", mode: "fallback" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: {
              switch: {
                mode: "auto",
              },
            },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("fallback");
    expect(launchCalled).toBe(true);
  });

  test("managed Kitty wins before contextual shell cd and reports kitty mode", async () => {
    let launchCalled = false;
    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
        env: {
          ARASHI_DIRECTIVE_FILE: "/tmp/must-not-write-kitty-directive",
          ARASHI_SHELL: "bash",
          KITTY_PID: " 100 ",
          KITTY_WINDOW_ID: " 73 ",
        },
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async () => {
          launchCalled = true;
          return { command: ["kitten", "@", "focus-window"], disposition: "window", mode: "kitty" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: { switch: { mode: "auto" } },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );
    expect(launchCalled).toBe(true);
    expect(result.launchMode).toBe("kitty");
  });

  test("does not launch when --cd is requested without shell integration", async () => {
    const originalError = console.error;
    const warnings: string[] = [];
    let launchCalled = false;
    console.error = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const result = await executeSwitch(
        undefined,
        { cd: true },
        {
          discoverSwitchCandidates: async () => ({
            candidates: [candidate],
            skippedCount: 0,
          }),
          findWorkspaceRoot: async () => "/workspace",
          launchSwitchTarget: async () => {
            launchCalled = true;
            return { command: ["open"], disposition: "window", mode: "fallback" };
          },
          loadWorkspaceRepositories: async () => ({ repositories: [] }),
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );

      expect(result.launchMode).toBe("cd");
      expect(launchCalled).toBe(false);
      expect(warnings.join("\n")).toContain("Shell integration is not active");
    } finally {
      console.error = originalError;
    }
  });

  test("keeps explicit sesh behavior ahead of cd mode defaults", async () => {
    const launchOptions: { sesh?: boolean }[] = [];

    await executeSwitch(
      undefined,
      { sesh: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: {
          ARASHI_DIRECTIVE_FILE: "/tmp/arashi-directive",
          ARASHI_SHELL: "bash",
        },
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async (_candidate, options) => {
          launchOptions.push(options);
          return { command: ["tmux"], disposition: "window", mode: "sesh" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: {
              switch: {
                mode: "cd",
              },
            },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(launchOptions).toEqual([{ disposition: "window", sesh: true }]);
  });

  test("allows opt-out from configured switch launch mode", async () => {
    const launchOptions: { sesh?: boolean }[] = [];

    await executeSwitch(
      undefined,
      { defaultLaunch: false },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async (_candidate, options) => {
          launchOptions.push(options);
          return { command: ["open"], disposition: "window", mode: "fallback" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: {
              switch: {
                mode: "sesh",
              },
            },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(launchOptions).toEqual([{ disposition: "window", sesh: false }]);
  });

  test("uses explicit IDE overrides ahead of configured launch defaults", async () => {
    const launchOptions: {
      preferredIde?: "vscode" | "cursor" | "kiro";
      requirePreferredIde?: boolean;
      sesh?: boolean;
    }[] = [];

    await executeSwitch(
      undefined,
      { cursor: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => "/workspace",
        launchSwitchTarget: async (_candidate, options) => {
          launchOptions.push(options);
          return { command: ["cursor"], disposition: "window", mode: "cursor" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            defaults: {
              switch: {
                mode: "sesh",
              },
            },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(launchOptions).toEqual([
      {
        disposition: "window",
        preferredIde: "cursor",
        requirePreferredIde: true,
        sesh: false,
      },
    ]);
  });

  test("invokes VS Code runner path in VS Code terminals", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "which" && command[1] === "code") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/code\n" };
      }

      if (command[0] === "code") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: { TERM_PROGRAM: "vscode" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "darwin",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("vscode");
    expect(invocations[0]).toEqual(["which", "code"]);
    expect(invocations[1]).toEqual(["code", "--new-window", "/workspace/feature-switch-command"]);
  });

  test("uses cmd.exe to launch VS Code in Windows terminals", async () => {
    const windowsCandidate: SwitchCandidate = {
      branchName: "feature/switch-command",
      repoName: "workspace",
      worktreePath: "C:\\workspace\\feature-switch-command",
    };
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "where" && command[1] === "code") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n",
        };
      }

      if (command[0] === "cmd.exe") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [windowsCandidate],
          skippedCount: 0,
        }),
        env: { TERM_PROGRAM: "vscode" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "win32",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("vscode");
    expect(invocations[0]).toEqual(["where", "code"]);
    expect(invocations[1]).toEqual([
      "cmd.exe",
      "/d",
      "/c",
      "code",
      "--new-window",
      String.raw`C:\workspace\feature-switch-command`,
    ]);
  });

  test("preserves nested worktree paths for Windows VS Code launches", async () => {
    const windowsCandidate: SwitchCandidate = {
      branchName: "test/new",
      repoName: "workspace",
      worktreePath: "C:\\workspace\\.arashi\\worktrees\\workspace-test\\new",
    };
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "where" && command[1] === "code") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n",
        };
      }

      if (command[0] === "cmd.exe") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [windowsCandidate],
          skippedCount: 0,
        }),
        env: { TERM_PROGRAM: "vscode" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "win32",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("vscode");
    expect(invocations[1]).toEqual([
      "cmd.exe",
      "/d",
      "/c",
      "code",
      "--new-window",
      String.raw`C:\workspace\.arashi\worktrees\workspace-test\new`,
    ]);
  });

  test("falls back to platform launcher when VS Code CLI is unavailable", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "which" && command[1] === "code") {
        return { exitCode: 1, stderr: "not found", stdout: "" };
      }

      if (command[0] === "open") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: { TERM_PROGRAM: "vscode" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "darwin",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("fallback");
    expect(invocations[1]).toEqual(["open", "-a", "Terminal", "/workspace/feature-switch-command"]);
  });

  test("invokes Cursor runner path in Cursor terminals", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "which" && command[1] === "cursor") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/cursor\n" };
      }

      if (command[0] === "cursor") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: {
          TERM_PROGRAM: "vscode",
          VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "darwin",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("cursor");
    expect(invocations[0]).toEqual(["which", "cursor"]);
    expect(invocations[1]).toEqual(["cursor", "--new-window", "/workspace/feature-switch-command"]);
  });

  test("invokes tmux new-window automatically when inside tmux", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "tmux") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: { TERM_PROGRAM: "vscode", TMUX: "/tmp/tmux-1000/default" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "darwin",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("tmux");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual([
      "tmux",
      "new-window",
      "-c",
      "/workspace/feature-switch-command",
    ]);
  });

  test("invokes managed Kitty session launch when running in Kitty", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "arashi-switch-kitty-"));
    const canonicalWorktreePath = await realpath(worktreePath);
    const invocations: string[][] = [];
    let identity = "";
    let launched = false;
    const kittyCandidate = { ...candidate, worktreePath };
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "which") {
        return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
      }
      if (command[1] === "--version") {
        return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
      }
      if (command.includes("launch")) {
        const markerIndex = command.indexOf("--var");
        identity = command[markerIndex + 1]?.split("=")[1] ?? "";
        launched = true;
        return { exitCode: 0, stderr: "", stdout: "73\n" };
      }
      if (command.includes("focus-window")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command.at(-1) === "ls") {
        if (!launched) return { exitCode: 0, stderr: "", stdout: "[]" };
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify([
            {
              id: 1,
              tabs: [
                {
                  id: 2,
                  windows: [
                    {
                      cwd: canonicalWorktreePath,
                      id: 73,
                      is_focused: true,
                      last_focused_at: 1,
                      session_name: "workspace: feature/switch-command",
                      title: "workspace: feature/switch-command",
                      user_vars: { arashi_worktree_id: identity },
                    },
                  ],
                },
              ],
            },
          ]),
        };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    try {
      const result = await executeSwitch(
        undefined,
        {},
        {
          discoverSwitchCandidates: async () => ({
            candidates: [kittyCandidate],
            skippedCount: 0,
          }),
          env: { KITTY_PID: "100", KITTY_WINDOW_ID: "73", TERM: "xterm-kitty" },
          findWorkspaceRoot: async () => worktreePath,
          loadWorkspaceRepositories: async () => ({ repositories: [] }),
          platform: "linux",
          runProcess,
          stdinIsTTY: false,
          stdoutIsTTY: false,
        },
      );

      expect(result.launchMode).toBe("kitty");
      expect(invocations).toContainEqual([
        "/usr/bin/kitten",
        "@",
        "focus-window",
        "--match",
        "id:73",
      ]);
      expect(invocations.filter((command) => command.includes("launch"))).toHaveLength(1);
    } finally {
      await rm(worktreePath, { force: true, recursive: true });
    }
  });

  test("invokes wezterm launch path when running in WezTerm", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "wezterm") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: { TERM_PROGRAM: "WezTerm" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "linux",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("fallback");
    expect(invocations[0]).toEqual([
      "wezterm",
      "cli",
      "spawn",
      "--new-window",
      "--cwd",
      "/workspace/feature-switch-command",
    ]);
  });

  test("invokes iTerm launch path when running in iTerm2", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "osascript") {
        return invocations.length === 1
          ? { exitCode: 0, stderr: "", stdout: "3.5.0\n17\nDefault" }
          : { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected command", stdout: "" };
    };

    const result = await executeSwitch(
      undefined,
      {},
      {
        discoverSwitchCandidates: async () => ({
          candidates: [candidate],
          skippedCount: 0,
        }),
        env: { TERM_PROGRAM: "iTerm.app" },
        findWorkspaceRoot: async () => "/workspace",
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        platform: "darwin",
        runProcess,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(result.launchMode).toBe("fallback");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.slice(-5)).toEqual([
      "/workspace/feature-switch-command",
      "/bin/zsh",
      "",
      "",
      "",
    ]);
  });
});
