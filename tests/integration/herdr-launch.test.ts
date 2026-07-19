import { describe, expect, test } from "vitest";
import { resolve } from "node:path";
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
        warnings: [],
        worktreePath,
      },
    ],
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

describe("Herdr launcher", () => {
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
      { herdr: true },
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
      mode: "herdr",
    });
    expect(commands).toEqual([result.command]);
  });

  test.each([false, true])(
    "accepts structured first-open/reuse response (%s)",
    async (alreadyOpen) => {
      const result = await launchSwitchTarget(
        candidate,
        { herdr: true },
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
        { herdr: true },
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
        { herdr: true },
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
      {},
      {
        env: { HERDR_ENV: "1", TMUX: "/tmp/tmux" },
        platform: "darwin",
        runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
      },
    );
    expect(tmux.mode).toBe("tmux");
    const herdr = await launchSwitchTarget(
      candidate,
      {},
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
  test("normalizes Herdr launchMode on switch, create, and editor defaults", () => {
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
    expect(normalized.defaults?.create).toMatchObject({ launch: true, launchMode: "herdr" });
    expect(normalized.defaults?.editors?.vscode?.create).toMatchObject({
      launch: true,
      launchMode: "herdr",
    });
    expect(normalized.defaults?.switch?.launchMode).toBe("herdr");
    const legacy = normalizeConfig({
      defaults: { switch: { launch_mode: "herdr" } },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });
    expect(legacy.defaults?.switch?.launchMode).toBe("herdr");
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
      launchMode: "herdr",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test("configured create Herdr is suppressed by --no-launch", () => {
    const config = baseConfig();
    config.defaults = { create: { launchMode: "herdr" } };
    expect(resolveCreateDefaults({ launch: false }, config)).toEqual({
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
    const calls: Array<{ herdr?: boolean }> = [];
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
          return { command: ["noop"], mode: launchOptions.herdr ? "herdr" : "fallback" };
        },
        loadWorkspaceRepositories: async () => ({
          config: {
            ...baseConfig(),
            defaults: configured ? { switch: { launchMode: "herdr" } } : undefined,
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

describe("Herdr post-create preservation", () => {
  test("passes source provenance and explicit Herdr mode after coordinated creation", async () => {
    const calls: Array<{ candidate: SwitchCandidate; options: { herdr?: boolean } }> = [];
    await executeCreate(
      branchName,
      { herdr: true },
      createDeps({
        launchSwitchTarget: async (selected: SwitchCandidate, options: { herdr?: boolean }) => {
          calls.push({ candidate: selected, options });
          return { command: ["herdr"], mode: "herdr" };
        },
      }),
    );
    expect(calls).toEqual([
      {
        candidate: expect.objectContaining({
          herdrSource: { path: resolve(workspaceRoot), status: "available" },
          worktreePath: "/workspace-herdr",
        }),
        options: expect.objectContaining({ herdr: true }),
      },
    ]);
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
