import { runtime } from "../helpers/node-runtime.ts";
import { createCommand, executeSwitch } from "../../src/commands/switch.ts";
import { describe, expect, test } from "vitest";
import { join, resolve } from "path";
import { mkdtemp, rm } from "fs/promises";
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

describe("switch command integration", () => {
  test("registers switch command with --sesh option", () => {
    const command = createCommand();
    expect(command.name()).toBe("switch");
    expect(command.options.some((option) => option.long === "--path")).toBe(true);
    expect(command.options.some((option) => option.long === "--sesh")).toBe(true);
    expect(command.options.some((option) => option.long === "--cd")).toBe(true);
    expect(command.options.some((option) => option.long === "--vscode")).toBe(true);
    expect(command.options.some((option) => option.long === "--cursor")).toBe(true);
    expect(command.options.some((option) => option.long === "--kiro")).toBe(true);
    expect(command.options.some((option) => option.long === "--no-default-launch")).toBe(true);
    expect(command.options.some((option) => option.long === "--repos")).toBe(true);
    expect(command.options.some((option) => option.long === "--all")).toBe(true);
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
          launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
        launchSwitchTarget: async () => ({ command: ["noop"], mode: "fallback" }),
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
          return { command: ["tmux"], mode: "sesh" };
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

    expect(launchOptions).toEqual([{ sesh: true }]);
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
            return { command: ["open"], mode: "fallback" };
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
          return { command: ["open"], mode: "fallback" };
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
            return { command: ["open"], mode: "fallback" };
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
          return { command: ["tmux"], mode: "sesh" };
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

    expect(launchOptions).toEqual([{ sesh: true }]);
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
          return { command: ["open"], mode: "fallback" };
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

    expect(launchOptions).toEqual([{ sesh: false }]);
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
          return { command: ["cursor"], mode: "cursor" };
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

  test("invokes kitty tab launch path when running in kitty", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

      if (command[0] === "kitty") {
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
        env: { KITTY_PID: "100", TERM: "xterm-kitty" },
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
      "kitty",
      "@",
      "launch",
      "--type=tab",
      "--cwd",
      "/workspace/feature-switch-command",
    ]);
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
      "--cwd",
      "/workspace/feature-switch-command",
    ]);
  });

  test("invokes iTerm launch path when running in iTerm2", async () => {
    const invocations: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      invocations.push(command);

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
    expect(invocations[0]).toEqual(["open", "-a", "iTerm", "/workspace/feature-switch-command"]);
  });
});
