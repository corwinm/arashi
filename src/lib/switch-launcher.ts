import { runtime } from "./runtime.ts";
import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { normalizeSpawnEnvironment, stripDirectiveEnvironment } from "./shell-directives.ts";
import type { SwitchCandidate } from "../core/switch.ts";
import { resolveGitMainWorktree } from "./workspace-context.ts";

type SwitchLaunchMode =
  | "sesh"
  | "tmux"
  | "herdr"
  | "cmux"
  | "vscode"
  | "cursor"
  | "kiro"
  | "fallback";
export type SupportedIde = "vscode" | "cursor" | "kiro";
export type ManagedSwitchContext = "tmux" | "herdr" | "cmux" | SupportedIde;

const IDE_COMMANDS: Record<SupportedIde, string> = {
  cursor: "cursor",
  kiro: "kiro",
  vscode: "code",
};

const WINDOWS_SHELL = "cmd.exe";
const CMUX_MINIMUM_VERSION = "0.64.18";

export interface SwitchProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SwitchProcessRunOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export type SwitchProcessRunner = (
  command: string[],
  options: SwitchProcessRunOptions,
) => Promise<SwitchProcessResult>;

export interface LaunchSwitchOptions {
  herdr?: boolean;
  sesh?: boolean;
  tmux?: boolean;
  preferredIde?: SupportedIde;
  requirePreferredIde?: boolean;
}

export interface LaunchSwitchDependencies {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  resolveGitMainWorktree?: (path: string) => Promise<string | null>;
  runProcess?: SwitchProcessRunner;
}

export interface LaunchSwitchResult {
  mode: SwitchLaunchMode;
  command: string[];
}

export async function launchSwitchTarget(
  candidate: SwitchCandidate,
  options: LaunchSwitchOptions = {},
  deps: LaunchSwitchDependencies = {},
): Promise<LaunchSwitchResult> {
  const env = deps.env ?? process.env;
  const childEnv = stripDirectiveEnvironment(env);
  const platform = deps.platform ?? process.platform;
  const runProcess = deps.runProcess ?? runSwitchProcess;

  if (options.tmux) {
    if (!isTmuxSession(env)) {
      throw new SwitchCommandError(
        "--tmux requires an active tmux client or session (non-empty TMUX environment variable not detected). Run inside tmux or choose a different launcher.",
        SwitchCommandErrorCode.TMUX_CONTEXT_REQUIRED,
      );
    }
    return launchWithTmux(candidate, { env: childEnv, runProcess });
  }

  if (options.sesh) {
    if (!isTmuxSession(env)) {
      throw new SwitchCommandError(
        "--sesh requires an active tmux session (TMUX environment variable not detected).",
        SwitchCommandErrorCode.SESH_REQUIRES_TMUX,
      );
    }

    const seshAvailable = await isCommandAvailable("sesh", {
      env: childEnv,
      platform,
      runProcess,
    });
    if (!seshAvailable) {
      throw new SwitchCommandError(
        "The `sesh` binary is required for --sesh mode. Install sesh or run `arashi switch` without --sesh.",
        SwitchCommandErrorCode.SESH_NOT_FOUND,
      );
    }

    const seshCommand = buildSeshTmuxCommand(candidate.worktreePath);
    const seshResult = await runProcess(seshCommand, {
      cwd: candidate.worktreePath,
      env: childEnv,
    });

    if (seshResult.exitCode !== 0) {
      throwLaunchFailure(
        candidate.worktreePath,
        seshCommand,
        seshResult.stderr || seshResult.stdout,
      );
    }

    return {
      command: seshCommand,
      mode: "sesh",
    };
  }

  if (options.herdr) {
    return launchWithHerdr(await resolveHerdrCandidate(candidate, deps), {
      env: childEnv,
      runProcess,
    });
  }

  if (options.preferredIde) {
    const launchResult = await launchWithPreferredIde(candidate, options.preferredIde, {
      env: childEnv,
      platform,
      requireAvailability: options.requirePreferredIde === true,
      runProcess,
    });
    if (launchResult) {
      return launchResult;
    }
  }

  const managedContext = detectManagedSwitchContext(env);
  if (managedContext === "tmux") {
    return launchWithTmux(candidate, { env: childEnv, runProcess });
  }

  if (managedContext === "herdr") {
    return launchWithHerdr(await resolveHerdrCandidate(candidate, deps), {
      env: childEnv,
      runProcess,
    });
  }

  if (managedContext === "cmux") {
    return launchWithCmux(candidate, {
      env: childEnv,
      runProcess,
    });
  }

  if (managedContext === "vscode" || managedContext === "cursor" || managedContext === "kiro") {
    const launchResult = await launchWithPreferredIde(candidate, managedContext, {
      env: childEnv,
      platform,
      requireAvailability: false,
      runProcess,
    });
    if (launchResult) {
      return launchResult;
    }
  }

  const terminalAppResult = await launchWithDetectedTerminalApp(candidate, {
    env: childEnv,
    runProcess,
  });
  if (terminalAppResult) {
    return terminalAppResult;
  }

  return launchWithFallback(candidate, {
    env: childEnv,
    platform,
    runProcess,
  });
}

export function isVsCodeTerminal(env: Record<string, string | undefined> = process.env): boolean {
  return (
    env.TERM_PROGRAM === "vscode" ||
    typeof env.VSCODE_PID === "string" ||
    typeof env.VSCODE_GIT_IPC_HANDLE === "string"
  );
}

export function detectIntegratedIde(
  env: Record<string, string | undefined> = process.env,
): SupportedIde | null {
  const ideSignals = [
    env.TERM_PROGRAM,
    env.TERM_PROGRAM_VERSION,
    env.VSCODE_GIT_ASKPASS_NODE,
    env.VSCODE_GIT_ASKPASS_EXTRA_ARGS,
    env.VSCODE_GIT_IPC_HANDLE,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase());

  if (ideSignals.some((value) => value.includes("cursor"))) {
    return "cursor";
  }

  if (ideSignals.some((value) => value.includes("kiro"))) {
    return "kiro";
  }

  if (isVsCodeTerminal(env)) {
    return "vscode";
  }

  return null;
}

export function detectManagedSwitchContext(
  env: Record<string, string | undefined> = process.env,
): ManagedSwitchContext | null {
  if (isTmuxSession(env)) {
    return "tmux";
  }
  if (isHerdrSession(env)) {
    return "herdr";
  }
  if (isCmuxSession(env)) {
    return "cmux";
  }
  return detectIntegratedIde(env);
}

export function isTmuxSession(env: Record<string, string | undefined> = process.env): boolean {
  return typeof env.TMUX === "string" && env.TMUX.trim().length > 0;
}

export function isHerdrSession(env: Record<string, string | undefined> = process.env): boolean {
  return env.HERDR_ENV?.trim() === "1";
}

export function isCmuxSession(env: Record<string, string | undefined> = process.env): boolean {
  return [env.CMUX_WORKSPACE_ID, env.CMUX_SURFACE_ID].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

export type TerminalApp = "kitty" | "ghostty" | "wezterm" | "iterm2";

export function detectTerminalApp(
  env: Record<string, string | undefined> = process.env,
): TerminalApp | null {
  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  const term = env.TERM?.toLowerCase();

  if (
    termProgram === "wezterm" ||
    typeof env.WEZTERM_PANE === "string" ||
    typeof env.WEZTERM_EXECUTABLE === "string"
  ) {
    return "wezterm";
  }

  if (
    termProgram === "ghostty" ||
    typeof env.GHOSTTY_BIN_DIR === "string" ||
    typeof env.GHOSTTY_RESOURCES_DIR === "string"
  ) {
    return "ghostty";
  }

  if (
    typeof env.KITTY_PID === "string" ||
    typeof env.KITTY_WINDOW_ID === "string" ||
    (typeof term === "string" && term.includes("kitty"))
  ) {
    return "kitty";
  }

  if (
    termProgram === "iterm.app" ||
    termProgram === "iterm2" ||
    typeof env.ITERM_SESSION_ID === "string"
  ) {
    return "iterm2";
  }

  return null;
}

export async function isCommandAvailable(
  commandName: string,
  deps: {
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    runProcess?: SwitchProcessRunner;
  } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const runProcess = deps.runProcess ?? runSwitchProcess;
  const lookupCommand = platform === "win32" ? ["where", commandName] : ["which", commandName];

  const result = await runProcess(lookupCommand, {
    cwd: process.cwd(),
    env,
  });
  return result.exitCode === 0;
}

export async function runSwitchProcess(
  command: string[],
  options: SwitchProcessRunOptions,
): Promise<SwitchProcessResult> {
  try {
    const proc = runtime.spawn(command, {
      cwd: options.cwd,
      env: normalizeSpawnEnvironment(options.env),
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return {
      exitCode,
      stderr,
      stdout,
    };
  } catch (error) {
    return {
      exitCode: -1,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
}

function buildSeshTmuxCommand(worktreePath: string): string[] {
  return ["tmux", "new-window", "-c", worktreePath, `sesh connect ${shellQuote(worktreePath)}`];
}

async function launchWithTmux(
  candidate: SwitchCandidate,
  deps: { env: Record<string, string | undefined>; runProcess: SwitchProcessRunner },
): Promise<LaunchSwitchResult> {
  const command = ["tmux", "new-window", "-c", candidate.worktreePath];
  const result = await deps.runProcess(command, {
    cwd: candidate.worktreePath,
    env: deps.env,
  });
  if (result.exitCode !== 0) {
    throwLaunchFailure(candidate.worktreePath, command, result.stderr || result.stdout);
  }
  return { command, mode: "tmux" };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function resolveHerdrCandidate(
  candidate: SwitchCandidate,
  deps: LaunchSwitchDependencies,
): Promise<SwitchCandidate> {
  if (candidate.herdrSource) {
    return candidate;
  }

  const resolveMainWorktree = deps.resolveGitMainWorktree ?? resolveGitMainWorktree;
  const mainWorktree = await resolveMainWorktree(candidate.worktreePath);
  return {
    ...candidate,
    herdrSource: mainWorktree
      ? { path: mainWorktree, status: "available" }
      : { status: "unavailable" },
  };
}

async function launchWithHerdr(
  candidate: SwitchCandidate,
  deps: { env: Record<string, string | undefined>; runProcess: SwitchProcessRunner },
): Promise<LaunchSwitchResult> {
  if (candidate.herdrSource?.status !== "available") {
    throw new SwitchCommandError(
      `Herdr requires a non-bare source checkout for ${candidate.repoName}, but Git could not resolve one for ${candidate.worktreePath}.`,
      SwitchCommandErrorCode.LAUNCH_FAILED,
      { path: candidate.worktreePath, reason: "non-bare source checkout unavailable" },
    );
  }

  const command = [
    "herdr",
    "worktree",
    "open",
    "--cwd",
    candidate.herdrSource.path,
    "--path",
    candidate.worktreePath,
    "--label",
    `${candidate.repoName}: ${candidate.branchName}`,
    "--focus",
    "--json",
  ];
  const result = await deps.runProcess(command, {
    cwd: candidate.worktreePath,
    env: deps.env,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "unknown failure").trim();
    throwLaunchFailure(
      candidate.worktreePath,
      command,
      `Herdr launch failed. Ensure the Herdr CLI is installed and its default server/socket is running. ${detail}`,
    );
  }

  if (!isValidHerdrResponse(result.stdout)) {
    const detail = (result.stderr || result.stdout || "empty response").trim();
    throwLaunchFailure(
      candidate.worktreePath,
      command,
      `Herdr response could not be validated. Expected worktree_opened JSON with boolean already_open and a non-empty workspace_id. ${detail}`,
    );
  }

  return { command, mode: "herdr" };
}

function isValidHerdrResponse(stdout: string): boolean {
  try {
    const payload: unknown = JSON.parse(stdout.trim());
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
    const result = (payload as Record<string, unknown>).result;
    if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
    const record = result as Record<string, unknown>;
    if (record.type !== "worktree_opened" || typeof record.already_open !== "boolean") return false;
    const workspace = record.workspace;
    if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace))
      return false;
    const workspaceId = (workspace as Record<string, unknown>).workspace_id;
    return typeof workspaceId === "string" && workspaceId.trim().length > 0;
  } catch {
    return false;
  }
}

async function launchWithCmux(
  candidate: SwitchCandidate,
  deps: {
    env: Record<string, string | undefined>;
    runProcess: SwitchProcessRunner;
  },
): Promise<LaunchSwitchResult> {
  const command = [
    "cmux",
    "workspace",
    "create",
    "--cwd",
    candidate.worktreePath,
    "--focus",
    "true",
    "--json",
  ];
  const result = await deps.runProcess(command, {
    cwd: candidate.worktreePath,
    env: deps.env,
  });

  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || "unknown failure").trim();
    throwLaunchFailure(
      candidate.worktreePath,
      command,
      `cmux workspace creation failed. Ensure cmux v${CMUX_MINIMUM_VERSION} or newer is installed and local socket access is enabled. ${detail}`,
    );
  }

  const workspaceId = parseCmuxWorkspaceIdentifier(result.stdout);
  if (!workspaceId) {
    throwLaunchFailure(
      candidate.worktreePath,
      command,
      `cmux returned invalid JSON or omitted workspace_ref/workspace_id. Ensure cmux v${CMUX_MINIMUM_VERSION} or newer is installed.`,
    );
  }

  return {
    command,
    mode: "cmux",
  };
}

function parseCmuxWorkspaceIdentifier(stdout: string): string | null {
  try {
    const payload: unknown = JSON.parse(stdout.trim());
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    for (const key of ["workspace_ref", "workspace_id"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function launchWithFallback(
  candidate: SwitchCandidate,
  deps: {
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    runProcess: SwitchProcessRunner;
  },
): Promise<LaunchSwitchResult> {
  const fallbackCommands = buildFallbackCommands(candidate.worktreePath, deps.platform);
  const attempts: string[] = [];

  for (const command of fallbackCommands) {
    const result = await deps.runProcess(command, {
      cwd: candidate.worktreePath,
      env: deps.env,
    });

    if (result.exitCode === 0) {
      return {
        command,
        mode: "fallback",
      };
    }

    const detail = (result.stderr || result.stdout || "unknown failure").trim();
    attempts.push(`${command.join(" ")}: ${detail}`);
  }

  throw new SwitchCommandError(
    `Failed to open a terminal at ${candidate.worktreePath}. Attempted commands: ${attempts.join(
      " | ",
    )}`,
    SwitchCommandErrorCode.LAUNCH_FAILED,
    {
      attempts,
      path: candidate.worktreePath,
    },
  );
}

async function launchWithPreferredIde(
  candidate: SwitchCandidate,
  ide: SupportedIde,
  deps: {
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    requireAvailability: boolean;
    runProcess: SwitchProcessRunner;
  },
): Promise<LaunchSwitchResult | null> {
  const commandName = IDE_COMMANDS[ide];
  const ideAvailable = await isCommandAvailable(commandName, {
    env: deps.env,
    platform: deps.platform,
    runProcess: deps.runProcess,
  });

  if (!ideAvailable) {
    if (!deps.requireAvailability) {
      return null;
    }

    throw new SwitchCommandError(
      `The \`${commandName}\` launcher is required for --${ide}. Install ${commandName} or choose a different switch mode.`,
      SwitchCommandErrorCode.IDE_NOT_FOUND,
      {
        ide,
        launcher: commandName,
      },
    );
  }

  const ideCommand = buildIdeCommand(commandName, candidate.worktreePath, deps.platform);
  const ideResult = await deps.runProcess(ideCommand, {
    cwd: candidate.worktreePath,
    env: deps.env,
  });

  if (ideResult.exitCode !== 0) {
    throwLaunchFailure(candidate.worktreePath, ideCommand, ideResult.stderr || ideResult.stdout);
  }

  return {
    command: ideCommand,
    mode: ide,
  };
}

function buildIdeCommand(
  commandName: string,
  worktreePath: string,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") {
    return [commandName, "--new-window", worktreePath];
  }

  return [WINDOWS_SHELL, "/d", "/c", commandName, "--new-window", worktreePath];
}

async function launchWithDetectedTerminalApp(
  candidate: SwitchCandidate,
  deps: {
    env: Record<string, string | undefined>;
    runProcess: SwitchProcessRunner;
  },
): Promise<LaunchSwitchResult | null> {
  const terminalApp = detectTerminalApp(deps.env);
  if (!terminalApp) {
    return null;
  }

  const commands = buildTerminalAppCommands(candidate.worktreePath, terminalApp);

  for (const command of commands) {
    const result = await deps.runProcess(command, {
      cwd: candidate.worktreePath,
      env: deps.env,
    });

    if (result.exitCode === 0) {
      return {
        command,
        mode: "fallback",
      };
    }
  }

  return null;
}

function buildTerminalAppCommands(worktreePath: string, terminalApp: TerminalApp): string[][] {
  if (terminalApp === "wezterm") {
    return [
      ["wezterm", "cli", "spawn", "--cwd", worktreePath],
      ["wezterm", "start", "--cwd", worktreePath],
    ];
  }

  if (terminalApp === "kitty") {
    return [
      ["kitty", "@", "launch", "--type=tab", "--cwd", worktreePath],
      ["kitty", "@", "launch", "--cwd", worktreePath],
      ["kitty", "--directory", worktreePath],
    ];
  }

  if (terminalApp === "iterm2") {
    return [
      ["open", "-a", "iTerm", worktreePath],
      ["open", "-a", "iTerm2", worktreePath],
    ];
  }

  return [["ghostty", "--working-directory", worktreePath]];
}

function buildFallbackCommands(worktreePath: string, platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") {
    return [["open", "-a", "Terminal", worktreePath]];
  }

  if (platform === "win32") {
    return [["cmd.exe", "/c", "start", "", "/D", worktreePath, "cmd.exe"]];
  }

  return [
    ["x-terminal-emulator", "--working-directory", worktreePath],
    ["gnome-terminal", "--working-directory", worktreePath],
    ["konsole", "--workdir", worktreePath],
  ];
}

function throwLaunchFailure(worktreePath: string, command: string[], reason: string): never {
  throw new SwitchCommandError(
    `Failed to open a terminal context for ${worktreePath} using \`${command.join(
      " ",
    )}\`: ${reason.trim() || "unknown failure"}`,
    SwitchCommandErrorCode.LAUNCH_FAILED,
    {
      command,
      path: worktreePath,
      reason,
    },
  );
}
