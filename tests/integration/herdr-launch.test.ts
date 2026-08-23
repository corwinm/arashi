import { describe, expect, test } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "../helpers/node-runtime.ts";
import type { CreateCommandDependencies } from "../../src/commands/create.ts";
import {
  createCommand as createCreateCommand,
  executeCreate,
  resolveCreateDefaults,
} from "../../src/commands/create.ts";
import { createCommand as createSwitchCommand, executeSwitch } from "../../src/commands/switch.ts";
import type { SwitchCandidate } from "../../src/core/switch.ts";
import type { Config, LoadedConfig } from "../../src/lib/config.ts";
import { normalizeConfig } from "../../src/lib/config.ts";
import { isHerdrSession, launchSwitchTarget } from "../../src/lib/switch-launcher.ts";
import { SwitchCommandErrorCode } from "../../src/types/switch.ts";
import type { OperationSummary } from "../../src/core/worktree.ts";

const workspaceRoot = "/workspace";
const branchName = "feature/herdr";
const candidate: SwitchCandidate = {
  branchName,
  herdrSource: { path: workspaceRoot, status: "available" },
  repoName: "workspace",
  worktreePath: "/workspace-herdr",
};

const herdrSuccess = (alreadyOpen = false) => ({
  exitCode: 0,
  stderr: "",
  stdout: JSON.stringify({
    result: {
      already_open: alreadyOpen,
      type: "worktree_opened",
      workspace: { workspace_id: "workspace-123" },
    },
  }),
});

function baseConfig(): Config {
  return { repos: {}, reposDir: "./repos", version: "1.0.0" };
}

function createSummary(worktreePath = "/workspace-herdr"): OperationSummary {
  return {
    errorSummary: null,
    failureCount: 0,
    hookOutcomes: [],
    nextSteps: [],
    repositoryResults: [
      {
        branchName,
        duration: 1,
        error: null,
        hookOutcomes: [],
        repository: {
          defaultBranch: "main",
          hasSetupScript: false,
          name: "workspace",
          path: workspaceRoot,
        },
        status: "success",
        targetAction: "created",
        warnings: [],
        worktreePath,
      },
    ],
    targetActionByRepositoryPath: new Map([[workspaceRoot, "created"]]),
    rolledBack: false,
    skippedCount: 0,
    successCount: 1,
    totalDuration: 1,
    totalRepositories: 1,
  };
}

function loadedConfig(overrides: Partial<Config> = {}): LoadedConfig {
  return {
    config: { ...baseConfig(), ...overrides },
    configPath: "/workspace/.arashi/config.json",
    source: "local-file",
  };
}

function createDeps(overrides: Record<string, unknown> = {}): CreateCommandDependencies {
  return {
    applyRepositoryFilter: async (_filter: unknown, repositories: unknown[]) => repositories,
    calculateWorktreePathPlan: async (repositories: { name: string }[]) =>
      new Map(
        repositories.map((repository) => [
          repository,
          {
            path: `/worktrees/${repository.name}`,
            repositoryType: "meta-repo" as const,
            strategy: "sibling" as const,
          },
        ]),
      ),
    createCoordinatedWorktrees: async () => createSummary(),
    discoverRepositories: async () => ({
      duration: 1,
      errors: [],
      repositories: [],
      scanDepth: 0,
      scannedDirectories: 0,
      workspacePath: "/workspace/repos",
    }),
    isGitRepository: async () => true,
    listRegisteredWorktreePaths: async () => [],
    loadConfigWithFallback: async () => loadedConfig(),
    pathExists: () => true,
    reconcileManagedIgnore: async () => ({
      appliedRules: [],
      attempted: false,
      changed: false,
      fileChanges: { local: false, preference: false, tracked: false },
      localExcludePath: "/workspace/.git/info/exclude",
      paths: [],
      plannedRules: [],
      restored: false,
      scope: "local" as const,
      staleRules: [],
      storedPreference: null,
      trackedIgnorePath: "/workspace/.gitignore",
      warnings: [],
    }),
    resolveCreateInvocationContext: async () => ({
      executionPath: workspaceRoot,
      invocationPath: workspaceRoot,
      repositoryType: "non-bare" as const,
      workspaceRoot,
    }),
    resolveCurrentBranch: async () => "main",
    resolveGitMainWorktree: async (path: string) => path,
    ...overrides,
  } as unknown as CreateCommandDependencies;
}

async function runTestCommand(command: string[], cwd: string): Promise<void> {
  const child = spawn(command, { cwd, stderr: "ignore", stdout: "ignore" });
  expect(await child.exited).toBe(0);
}

describe("Herdr launcher", () => {
  test("resolves source provenance only when Herdr is selected", async () => {
    let resolutionCalls = 0;
    const commands: string[][] = [];
    const result = await launchSwitchTarget(
      { ...candidate, herdrSource: undefined },
      { disposition: "window", herdr: true },
      {
        env: {},
        platform: "darwin",
        resolveGitMainWorktree: async (path) => {
          resolutionCalls += 1;
          expect(path).toBe(candidate.worktreePath);
          return workspaceRoot;
        },
        runProcess: async (command) => {
          commands.push(command);
          return herdrSuccess();
        },
      },
    );

    expect(resolutionCalls).toBe(1);
    expect(commands[0]).toContain(workspaceRoot);
    expect(result.mode).toBe("herdr");
  });

  test("uses argv-safe existing-worktree contract", async () => {
    const special: SwitchCandidate = {
      branchName: "feature/auth '$review",
      herdrSource: { path: "/source repo's $main", status: "available" },
      repoName: "repo '$name",
      worktreePath: "/target repo's $worktree",
    };
    const commands: string[][] = [];
    const result = await launchSwitchTarget(
      special,
      { disposition: "window", herdr: true },
      {
        env: {},
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return herdrSuccess();
        },
      },
    );
    expect(result).toEqual({
      command: [
        "herdr",
        "worktree",
        "open",
        "--cwd",
        "/source repo's $main",
        "--path",
        "/target repo's $worktree",
        "--label",
        "repo '$name: feature/auth '$review",
        "--focus",
        "--json",
      ],
      disposition: "window",
      mode: "herdr",
    });
    expect(commands).toEqual([result.command]);
  });

  test.each([false, true])(
    "accepts structured first-open/reuse response (%s)",
    async (alreadyOpen) => {
      const result = await launchSwitchTarget(
        candidate,
        { disposition: "window", herdr: true },
        { env: {}, platform: "darwin", runProcess: async () => herdrSuccess(alreadyOpen) },
      );
      expect(result.mode).toBe("herdr");
    },
  );

  test.each([
    ["missing binary", { exitCode: -1, stderr: "spawn herdr ENOENT", stdout: "" }],
    ["server socket", { exitCode: 1, stderr: "connection refused", stdout: "" }],
    ["malformed JSON", { exitCode: 0, stderr: "", stdout: "not json" }],
    ["structured error", { exitCode: 0, stderr: "", stdout: '{"error":{"message":"no server"}}' }],
    [
      "wrong type",
      {
        exitCode: 0,
        stderr: "",
        stdout:
          '{"result":{"type":"workspace_opened","already_open":false,"workspace":{"workspace_id":"id"}}}',
      },
    ],
    [
      "missing boolean",
      {
        exitCode: 0,
        stderr: "",
        stdout: '{"result":{"type":"worktree_opened","workspace":{"workspace_id":"id"}}}',
      },
    ],
    [
      "empty id",
      {
        exitCode: 0,
        stderr: "",
        stdout:
          '{"result":{"type":"worktree_opened","already_open":false,"workspace":{"workspace_id":" "}}}',
      },
    ],
  ])("fails without fallback for %s", async (_name, processResult) => {
    const commands: string[][] = [];
    await expect(
      launchSwitchTarget(
        candidate,
        { disposition: "window", herdr: true },
        {
          env: { TERM_PROGRAM: "vscode" },
          platform: "darwin",
          runProcess: async (command) => {
            commands.push(command);
            return processResult;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { path: candidate.worktreePath },
      message: expect.stringContaining("Herdr"),
    });
    expect(commands).toHaveLength(1);
  });

  test("fails before process invocation for unavailable source", async () => {
    const commands: string[][] = [];
    await expect(
      launchSwitchTarget(
        { ...candidate, herdrSource: { status: "unavailable" } },
        { disposition: "window", herdr: true },
        {
          env: {},
          platform: "darwin",
          runProcess: async (command) => {
            commands.push(command);
            return herdrSuccess();
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining("non-bare source checkout"),
    });
    expect(commands).toEqual([]);
  });

  test.each([undefined, "", "0", "true", "2"])(
    "rejects HERDR_ENV=%s and unrelated variables",
    (value) => {
      expect(isHerdrSession({ HERDR_ENV: value, HERDR_WORKSPACE_ID: "id" })).toBe(false);
    },
  );

  test("detects only exact normalized HERDR_ENV=1", () => {
    expect(isHerdrSession({ HERDR_ENV: " 1 " })).toBe(true);
  });

  test("automatic tmux precedes Herdr, while Herdr precedes IDE", async () => {
    const tmux = await launchSwitchTarget(
      candidate,
      { disposition: "window" },
      {
        env: { HERDR_ENV: "1", TMUX: "/tmp/tmux" },
        platform: "darwin",
        runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      },
    );
    expect(tmux.mode).toBe("tmux");
    const herdr = await launchSwitchTarget(
      candidate,
      { disposition: "window" },
      {
        env: { HERDR_ENV: "1", TERM_PROGRAM: "vscode" },
        platform: "darwin",
        runProcess: async () => herdrSuccess(),
      },
    );
    expect(herdr.mode).toBe("herdr");
  });
});

describe("Herdr configuration and command resolution", () => {
  test("normalizes unified Herdr mode on switch and preserves create defaults", () => {
    const normalized = normalizeConfig({
      defaults: {
        create: { launchMode: "herdr" },
        editors: { vscode: { create: { launchMode: "herdr" } } },
        switch: { launchMode: "herdr" },
      },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });
    expect(normalized.defaults?.create).toEqual({ launch: "herdr" });
    expect(normalized.defaults?.editors?.vscode?.create).toEqual({ launch: "herdr" });
    expect(normalized.defaults?.switch?.mode).toBe("herdr");
    const legacy = normalizeConfig({
      defaults: { switch: { launch_mode: "herdr" } },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });
    expect(legacy.defaults?.switch?.mode).toBe("herdr");
  });

  test("registers --herdr on switch and create help surfaces", () => {
    expect(
      createSwitchCommand().options.some((option: { long?: string }) => option.long === "--herdr"),
    ).toBe(true);
    expect(
      createCreateCommand().options.some((option: { long?: string }) => option.long === "--herdr"),
    ).toBe(true);
  });

  test("explicit create Herdr implies launch and overrides --no-launch", () => {
    expect(resolveCreateDefaults({ herdr: true, launch: false }, baseConfig())).toEqual({
      disposition: "window",
      launchMode: "herdr",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test("configured create Herdr is suppressed by --no-launch", () => {
    const config = baseConfig();
    config.defaults = { create: { launch: "herdr" } };
    expect(resolveCreateDefaults({ launch: false }, config)).toEqual({
      disposition: "window",
      launchMode: "auto",
      shouldLaunch: false,
      shouldSwitch: false,
    });
  });

  test.each([
    { herdr: true, sesh: true },
    { herdr: true, vscode: true },
    { cd: true, herdr: true },
  ])("rejects switch conflict %o", async (options) => {
    await expect(
      executeSwitch(undefined, options, {
        discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
        findWorkspaceRoot: async () => workspaceRoot,
        loadWorkspaceRepositories: async () => ({ repositories: [] }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      }),
    ).rejects.toMatchObject({ code: expect.stringContaining("CONFLICTING") });
  });

  test("rejects create --herdr plus --sesh before creation", async () => {
    let created = false;
    await expect(
      executeCreate(
        branchName,
        { herdr: true, sesh: true },
        createDeps({
          createCoordinatedWorktrees: async () => {
            created = true;
            return createSummary();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.CONFLICTING_LAUNCH_OPTIONS });
    expect(created).toBe(false);
  });

  test("passes explicit/configured Herdr into switch launcher and honors opt-out", async () => {
    const calls: { herdr?: boolean }[] = [];
    for (const [options, configured] of [
      [{ herdr: true }, true],
      [{}, true],
      [{ defaultLaunch: false }, true],
    ] as const) {
      await executeSwitch(undefined, options, {
        discoverSwitchCandidates: async () => ({ candidates: [candidate], skippedCount: 0 }),
        findWorkspaceRoot: async () => workspaceRoot,
        launchSwitchTarget: async (_selected, launchOptions) => {
          calls.push(launchOptions);
          return {
            command: ["noop"],
            disposition: "window",
            mode: launchOptions.herdr ? "herdr" : "fallback",
          };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            ...baseConfig(),
            defaults: configured ? { switch: { mode: "herdr" } } : undefined,
          },
          repositories: [],
        }),
        stdinIsTTY: false,
        stdoutIsTTY: false,
      });
    }
    expect(calls[0]?.herdr).toBe(true);
    expect(calls[1]?.herdr).toBe(true);
    expect(calls[2]?.herdr).toBeUndefined();
  });
});

describe("Herdr create integration", () => {
  test("does not resolve Herdr source when automatic create launch selects tmux", async () => {
    let resolutionCalls = 0;
    const commands: string[][] = [];
    await executeCreate(
      branchName,
      {},
      createDeps({
        env: { TMUX: "/tmp/tmux/default" },
        loadConfigWithFallback: async () =>
          loadedConfig({ defaults: { create: { launch: "auto" } } }),
        resolveGitMainWorktree: async () => {
          resolutionCalls += 1;
          return workspaceRoot;
        },
        runProcess: async (command: string[]) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    );

    expect(resolutionCalls).toBe(0);
    expect(commands[0]?.[0]).toBe("tmux");
  });

  test("rejects conflicting launchers before standalone worktree creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-standalone-launch-conflict-"));
    try {
      await runTestCommand(["git", "init", "-b", "main"], root);
      await runTestCommand(["git", "config", "user.name", "Test"], root);
      await runTestCommand(["git", "config", "user.email", "test@example.com"], root);
      await writeFile(join(root, "fixture.txt"), "fixture\n");
      await runTestCommand(["git", "add", "fixture.txt"], root);
      await runTestCommand(["git", "commit", "-m", "initial"], root);
      await mkdir(join(root, ".worktrees"));
      await writeFile(join(root, ".git", "info", "exclude"), ".worktrees/\n");

      const child = spawn(
        [
          process.execPath,
          join(import.meta.dirname, "../../src/index.ts"),
          "create",
          branchName,
          "--herdr",
          "--sesh",
        ],
        { cwd: root, stderr: "pipe", stdout: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Conflicting launch overrides provided");
      await expect(access(join(root, ".worktrees", "feature", "herdr"))).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports conflicting create launchers as a usage error without a stack trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-create-launch-conflict-"));
    try {
      const gitInit = spawn(["git", "init", "-b", "main"], {
        cwd: root,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(await gitInit.exited).toBe(0);
      await mkdir(join(root, ".arashi"));
      await writeFile(
        join(root, ".arashi", "config.json"),
        JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }),
      );
      const child = spawn(
        [
          process.execPath,
          join(import.meta.dirname, "../../src/index.ts"),
          "create",
          branchName,
          "--herdr",
          "--sesh",
        ],
        { cwd: root, stderr: "pipe", stdout: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Conflicting launch overrides provided");
      expect(stderr).not.toContain("Unexpected error:");
      expect(stderr).not.toContain("SwitchCommandError:");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("passes source provenance and explicit Herdr mode after coordinated creation", async () => {
    const commands: string[][] = [];
    await executeCreate(
      branchName,
      { herdr: true },
      createDeps({
        resolveGitMainWorktree: async () => resolve(workspaceRoot),
        runProcess: async (command: string[]) => {
          commands.push(command);
          return herdrSuccess();
        },
      }),
    );

    expect(commands[0]).toContain(resolve(workspaceRoot));
    expect(commands[0]).toContain("/workspace-herdr");
  });

  test("preserves coordinated worktrees when Herdr launch fails", async () => {
    const paths = ["/workspace-herdr", "/workspace-herdr/repos/child"];
    const summary = createSummary(paths[0]);
    summary.repositoryResults.push({
      ...summary.repositoryResults[0],
      repository: {
        ...summary.repositoryResults[0].repository,
        name: "child",
        path: "/workspace/repos/child",
      },
      worktreePath: paths[1],
    });
    await expect(
      executeCreate(
        branchName,
        { herdr: true },
        createDeps({
          createCoordinatedWorktrees: async () => summary,
          launchSwitchTarget: async () => {
            throw new Error("Herdr server unavailable after creation");
          },
          pathExists: (path: string) => paths.includes(path),
        }),
      ),
    ).rejects.toThrow("Herdr server unavailable after creation");
    expect(paths.every((path) => path.length > 0)).toBe(true);
  });

  test("reports a bare-source limitation after coordinated creation without invoking Herdr", async () => {
    await expect(
      executeCreate(
        branchName,
        { herdr: true },
        createDeps({ resolveGitMainWorktree: async () => null }),
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining("non-bare source checkout"),
    });
  });
});
