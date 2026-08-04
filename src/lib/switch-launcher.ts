import { runtime } from "./runtime.ts";
import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { normalizeSpawnEnvironment, stripDirectiveEnvironment } from "./shell-directives.ts";
import type { SwitchCandidate } from "../core/switch.ts";
import { resolveGitMainWorktree } from "./workspace-context.ts";
import { launchManagedKitty } from "./kitty-launcher.ts";

type SwitchLaunchMode =
  | "sesh"
  | "tmux"
  | "herdr"
  | "cmux"
  | "kitty"
  | "vscode"
  | "cursor"
  | "kiro"
  | "fallback";
export type SupportedIde = "vscode" | "cursor" | "kiro";
export type ManagedSwitchContext = "tmux" | "herdr" | "cmux" | "kitty" | SupportedIde;
export type LaunchDisposition = "window" | "tab";
export type LaunchFamily =
  | "sesh"
  | "tmux"
  | "herdr"
  | "cmux"
  | "kitty"
  | "ide"
  | "windows-terminal"
  | "git-bash"
  | "wezterm"
  | "kitty-unmanaged"
  | "ghostty"
  | "terminal"
  | "iterm2"
  | "fallback";
export interface LaunchPlan {
  disposition: LaunchDisposition;
  launcher: LaunchFamily;
  supported: boolean;
  reason?: string;
}

interface MacTargetEvidence {
  launcher: "ghostty" | "iterm2" | "terminal";
  profile: string;
  target: string;
  version: string;
}

export interface LaunchPreflight extends LaunchPlan {
  autoIde?: { available: boolean; ide: SupportedIde };
  macTarget?: MacTargetEvidence;
  seshAvailable?: true;
}

const IDE_COMMANDS: Record<SupportedIde, string> = {
  cursor: "cursor",
  kiro: "kiro",
  vscode: "code",
};

const WINDOWS_SHELL = "cmd.exe";
const WINDOWS_SWITCH_WORKTREE_ENV = "ARASHI_SWITCH_WORKTREE";
const WINDOWS_GIT_BASH_LAUNCH =
  "$directory = Split-Path -Parent (Get-Command git.exe -ErrorAction Stop).Source; while ($directory) { $gitBash = Join-Path $directory 'git-bash.exe'; if (Test-Path -LiteralPath $gitBash) { Start-Process -FilePath $gitBash -ArgumentList '--no-cd' -WorkingDirectory $env:ARASHI_SWITCH_WORKTREE -ErrorAction Stop; exit 0 }; $parent = Split-Path -Parent $directory; if ($parent -eq $directory) { break }; $directory = $parent }; exit 1";
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
  disposition: LaunchDisposition;
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
  kittyLockRoot?: string;
  pathExists?: (path: string) => Promise<boolean>;
  preflight?: LaunchPreflight | null;
  runDetachedProcess?: SwitchProcessRunner;
}

export interface LaunchSwitchResult {
  mode: SwitchLaunchMode;
  command: string[];
  disposition: LaunchDisposition;
}

export async function launchSwitchTarget(
  candidate: SwitchCandidate,
  options: LaunchSwitchOptions,
  deps: LaunchSwitchDependencies = {},
): Promise<LaunchSwitchResult> {
  const env = deps.env ?? process.env;
  const childEnv = stripDirectiveEnvironment(env);
  const platform = deps.platform ?? process.platform;
  const runProcess = deps.runProcess ?? runSwitchProcess;
  const runDetachedProcess =
    deps.runDetachedProcess ?? (deps.runProcess ? deps.runProcess : runDetachedSwitchProcess);
  const disposition = options.disposition;
  const preflight =
    deps.preflight ??
    (await preflightLaunchSwitchTarget(options, {
      env,
      platform,
      runProcess,
    }));

  if (options.tmux) {
    if (!isTmuxSession(env)) {
      throw new SwitchCommandError(
        "--tmux requires an active tmux client or session (non-empty TMUX environment variable not detected). Run inside tmux or choose a different launcher.",
        SwitchCommandErrorCode.TMUX_CONTEXT_REQUIRED,
      );
    }
    return launchWithTmux(candidate, disposition, { env: childEnv, runProcess });
  }

  if (options.sesh) {
    if (!isTmuxSession(env)) {
      throw new SwitchCommandError(
        "--sesh requires an active tmux session (TMUX environment variable not detected).",
        SwitchCommandErrorCode.SESH_REQUIRES_TMUX,
      );
    }

    const seshAvailable =
      preflight?.seshAvailable === true ||
      (await isCommandAvailable("sesh", {
        env: childEnv,
        platform,
        runProcess,
      }));
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
      disposition,
      mode: "sesh",
    };
  }

  if (options.herdr) {
    ensureLaunchSupported("herdr", disposition, env, platform);
    return launchWithHerdr(
      disposition === "tab" ? candidate : await resolveHerdrCandidate(candidate, deps),
      disposition,
      { env: childEnv, runProcess },
    );
  }

  if (options.preferredIde) {
    const launchResult = await launchWithPreferredIde(candidate, options.preferredIde, {
      env: childEnv,
      platform,
      requireAvailability: options.requirePreferredIde === true,
      runProcess,
      disposition,
      availability:
        preflight?.autoIde?.ide === options.preferredIde ? preflight.autoIde.available : undefined,
    });
    if (launchResult) {
      return launchResult;
    }
  }

  const managedContext = detectManagedSwitchContext(env);
  if (managedContext === "tmux") {
    return launchWithTmux(candidate, disposition, { env: childEnv, runProcess });
  }

  if (managedContext === "herdr") {
    ensureLaunchSupported("herdr", disposition, env, platform);
    return launchWithHerdr(
      disposition === "tab" ? candidate : await resolveHerdrCandidate(candidate, deps),
      disposition,
      { env: childEnv, runProcess },
    );
  }

  if (managedContext === "cmux") {
    return launchWithCmux(candidate, disposition, {
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
      disposition,
      availability:
        preflight?.autoIde?.ide === managedContext ? preflight.autoIde.available : undefined,
    });
    if (launchResult) {
      return launchResult;
    }
  }

  if (managedContext === "kitty" || isKittySession(env)) {
    return launchManagedKitty(candidate, disposition, {
      env: childEnv,
      lockRoot: deps.kittyLockRoot,
      pathExists: deps.pathExists,
      platform,
      runProcess,
    });
  }

  const terminalAppResult = await launchWithDetectedTerminalApp(candidate, {
    env: childEnv,
    platform,
    runProcess,
    runDetachedProcess,
    disposition,
    macTarget: preflight?.macTarget,
  });
  if (terminalAppResult) {
    return terminalAppResult;
  }

  return launchWithFallback(candidate, {
    env: childEnv,
    platform,
    runDetachedProcess,
    runProcess,
    disposition,
  });
}

export function resolveLaunchPlan(
  launcher: LaunchFamily,
  disposition: LaunchDisposition,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): LaunchPlan {
  let supported = true;
  let reason: string | undefined;
  if (disposition === "tab") {
    if (launcher === "terminal") {
      supported = false;
      reason =
        'Terminal.app cannot safely create a true tab through its supported automation. Press Command-T, then run `arashi switch --cd` in the new tab (requires active Arashi shell integration). Without shell integration, run `cd "$(arashi switch --no-cd --no-default-launch)"`. To force normal automatic launch resolution, run `arashi switch --no-cd --no-default-launch`; when automatic launcher resolution selects Terminal.app, it opens a new window.';
    } else if (
      launcher === "ide" ||
      launcher === "git-bash" ||
      launcher === "kitty-unmanaged" ||
      launcher === "fallback" ||
      (launcher === "iterm2" && platform !== "darwin")
    ) {
      supported = false;
    } else if (launcher === "wezterm" && !nonEmpty(env.WEZTERM_PANE)) {
      supported = false;
      reason = "WezTerm requires a non-empty WEZTERM_PANE to target the current GUI window.";
    } else if (launcher === "herdr" && !nonEmpty(env.HERDR_WORKSPACE_ID)) {
      supported = false;
      reason =
        "Herdr requires a non-empty HERDR_WORKSPACE_ID to create a tab in the active workspace.";
    } else if (
      launcher === "ghostty" &&
      (platform !== "darwin" ||
        (nonEmpty(env.TERM_PROGRAM_VERSION) !== null &&
          !versionAtLeast(env.TERM_PROGRAM_VERSION, "1.3.0")))
    ) {
      supported = false;
      reason = "Ghostty tabs require macOS Ghostty 1.3 or newer.";
    }
  }
  return { disposition, launcher, supported, ...(reason ? { reason } : {}) };
}

export function resolveLaunchPlanForOptions(
  options: LaunchSwitchOptions,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): LaunchPlan | null {
  let launcher: LaunchFamily;
  if (options.tmux) launcher = "tmux";
  else if (options.sesh) launcher = "sesh";
  else if (options.herdr) launcher = "herdr";
  else if (options.preferredIde && options.requirePreferredIde) launcher = "ide";
  else {
    const managed = detectManagedSwitchContext(env);
    if (managed === "vscode" || managed === "cursor" || managed === "kiro") {
      // Automatic IDE selection must first check CLI availability at runtime. An unavailable
      // integrated IDE deliberately continues to the containing terminal.
      return null;
    }
    if (managed) launcher = managed;
    else {
      const terminal = detectTerminalApp(env);
      if (terminal) launcher = terminal === "kitty" ? "kitty-unmanaged" : terminal;
      else if (platform === "win32" && nonEmpty(env.WT_SESSION)) launcher = "windows-terminal";
      else if (platform === "win32" && isMsysBashSession(env)) launcher = "git-bash";
      else launcher = "fallback";
    }
  }
  return resolveLaunchPlan(launcher, options.disposition, env, platform);
}

export async function preflightLaunchSwitchTarget(
  options: LaunchSwitchOptions,
  deps: {
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    runProcess?: SwitchProcessRunner;
  },
): Promise<LaunchPreflight | null> {
  const runProcess = deps.runProcess ?? runSwitchProcess;
  let seshAvailable = false;
  if (options.sesh) {
    if (!isTmuxSession(deps.env)) {
      throw new SwitchCommandError(
        "--sesh requires an active tmux session (TMUX environment variable not detected).",
        SwitchCommandErrorCode.SESH_REQUIRES_TMUX,
      );
    }
    seshAvailable = await isCommandAvailable("sesh", {
      env: stripDirectiveEnvironment(deps.env),
      platform: deps.platform,
      runProcess,
    });
    if (!seshAvailable) {
      throw new SwitchCommandError(
        "The `sesh` binary is required for --sesh mode. Install sesh or run `arashi switch` without --sesh.",
        SwitchCommandErrorCode.SESH_NOT_FOUND,
      );
    }
  }
  if (options.preferredIde && options.requirePreferredIde && options.disposition === "tab") {
    ensureLaunchSupported("ide", options.disposition, deps.env, deps.platform);
  }

  const managed = detectManagedSwitchContext(deps.env);
  if (
    !options.tmux &&
    !options.sesh &&
    !options.herdr &&
    !options.preferredIde &&
    (managed === "vscode" || managed === "cursor" || managed === "kiro")
  ) {
    const available = await isCommandAvailable(IDE_COMMANDS[managed], {
      env: stripDirectiveEnvironment(deps.env),
      platform: deps.platform,
      runProcess,
    });
    if (available) {
      ensureLaunchSupported("ide", options.disposition, deps.env, deps.platform);
      return {
        ...resolveLaunchPlan("ide", options.disposition, deps.env, deps.platform),
        autoIde: { available, ide: managed },
      };
    }
  }

  const plan = resolveLaunchPlanAfterAutoIde(options, deps.env, deps.platform, managed);
  if (plan && !plan.supported) {
    ensureLaunchSupported(plan.launcher, plan.disposition, deps.env, deps.platform);
  }
  if (
    plan &&
    options.disposition === "tab" &&
    (plan.launcher === "terminal" || plan.launcher === "iterm2" || plan.launcher === "ghostty") &&
    deps.platform === "darwin"
  ) {
    const macTarget = await preflightMacTarget(
      plan.launcher,
      options.disposition,
      deps.env,
      runProcess,
    );
    return {
      ...plan,
      ...(managed === "vscode" || managed === "cursor" || managed === "kiro"
        ? { autoIde: { available: false, ide: managed } }
        : {}),
      macTarget,
    };
  }
  return plan
    ? {
        ...plan,
        ...(seshAvailable ? { seshAvailable: true as const } : {}),
        ...(managed === "vscode" || managed === "cursor" || managed === "kiro"
          ? { autoIde: { available: false, ide: managed } }
          : {}),
      }
    : null;
}

function resolveLaunchPlanAfterAutoIde(
  options: LaunchSwitchOptions,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  managed: ManagedSwitchContext | null,
): LaunchPlan | null {
  if (options.tmux || options.sesh || options.herdr || options.preferredIde) {
    return resolveLaunchPlanForOptions(options, env, platform);
  }
  if (managed && managed !== "vscode" && managed !== "cursor" && managed !== "kiro") {
    return resolveLaunchPlan(managed, options.disposition, env, platform);
  }
  if (isKittySession(env)) return resolveLaunchPlan("kitty", options.disposition, env, platform);
  const terminal = detectTerminalApp(env);
  if (terminal) {
    return resolveLaunchPlan(
      terminal === "kitty" ? "kitty-unmanaged" : terminal,
      options.disposition,
      env,
      platform,
    );
  }
  const family: LaunchFamily =
    platform === "win32" && nonEmpty(env.WT_SESSION)
      ? "windows-terminal"
      : platform === "win32" && isMsysBashSession(env)
        ? "git-bash"
        : "fallback";
  return resolveLaunchPlan(family, options.disposition, env, platform);
}

function ensureLaunchSupported(
  launcher: LaunchFamily,
  disposition: LaunchDisposition,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  const plan = resolveLaunchPlan(launcher, disposition, env, platform);
  if (plan.supported) return;
  throw new SwitchCommandError(
    plan.reason ??
      `${launcher} does not expose a stable tab target; use the default window disposition or another launcher.`,
    SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED,
    { disposition, launcher },
  );
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function versionAtLeast(value: string | undefined, minimum: string): boolean {
  const match = value?.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index]! > required[index]!;
  }
  return true;
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
  const ide = detectIntegratedIde(env);
  if (ide) {
    return ide;
  }
  if (isKittySession(env)) {
    return "kitty";
  }
  return null;
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

export function isKittySession(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    nonEmpty(env.KITTY_PID) ||
    nonEmpty(env.KITTY_WINDOW_ID) ||
    env.TERM?.trim().toLowerCase() === "xterm-kitty",
  );
}

export type TerminalApp = "kitty" | "ghostty" | "wezterm" | "iterm2" | "terminal";

export function detectTerminalApp(
  env: Record<string, string | undefined> = process.env,
): TerminalApp | null {
  const termProgram = env.TERM_PROGRAM?.toLowerCase();

  if (termProgram === "apple_terminal") return "terminal";

  if (termProgram === "wezterm" || nonEmpty(env.WEZTERM_PANE) || nonEmpty(env.WEZTERM_EXECUTABLE)) {
    return "wezterm";
  }

  if (
    termProgram === "ghostty" ||
    nonEmpty(env.GHOSTTY_BIN_DIR) ||
    nonEmpty(env.GHOSTTY_RESOURCES_DIR)
  ) {
    return "ghostty";
  }

  if (termProgram === "kitty" || env.TERM?.trim().toLowerCase() === "xterm-kitty") {
    return "kitty";
  }

  if (termProgram === "iterm.app" || termProgram === "iterm2" || nonEmpty(env.ITERM_SESSION_ID)) {
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

export async function runDetachedSwitchProcess(
  command: string[],
  options: SwitchProcessRunOptions,
): Promise<SwitchProcessResult> {
  try {
    const proc = runtime.spawn(command, {
      cwd: options.cwd,
      detached: true,
      env: normalizeSpawnEnvironment(options.env),
      stdin: "ignore",
      stderr: "ignore",
      stdout: "ignore",
    });
    if (!(await proc.spawned)) {
      return {
        exitCode: -1,
        stderr: proc.spawnError?.message ?? `Failed to start ${command[0] ?? "process"}`,
        stdout: "",
      };
    }
    const startupExitCode = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 300);
      }),
    ]);
    proc.unref();
    if (startupExitCode !== null && startupExitCode !== 0) {
      return {
        exitCode: startupExitCode,
        stderr: `${command[0] ?? "process"} exited with code ${startupExitCode} during startup`,
        stdout: "",
      };
    }
    return { exitCode: 0, stderr: "", stdout: "" };
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
  disposition: LaunchDisposition,
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
  return { command, disposition, mode: "tmux" };
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
  disposition: LaunchDisposition,
  deps: { env: Record<string, string | undefined>; runProcess: SwitchProcessRunner },
): Promise<LaunchSwitchResult> {
  if (disposition === "tab") {
    const workspaceId = nonEmpty(deps.env.HERDR_WORKSPACE_ID)!;
    const command = [
      "herdr",
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      candidate.worktreePath,
      "--label",
      `${candidate.repoName}: ${candidate.branchName}`,
      "--focus",
      "--json",
    ];
    const result = await deps.runProcess(command, { cwd: candidate.worktreePath, env: deps.env });
    if (result.exitCode !== 0 || !isValidHerdrTabResponse(result.stdout)) {
      throwLaunchFailure(
        candidate.worktreePath,
        command,
        result.stderr || result.stdout || "invalid Herdr tab response",
      );
    }
    return { command, disposition, mode: "herdr" };
  }
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

  return { command, disposition, mode: "herdr" };
}

function isValidHerdrTabResponse(stdout: string): boolean {
  try {
    const payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const result = payload.result as Record<string, unknown> | undefined;
    const tab = result?.tab as Record<string, unknown> | undefined;
    return Boolean(
      nonEmpty(tab?.tab_id as string | undefined) &&
      nonEmpty(tab?.root_pane_id as string | undefined),
    );
  } catch {
    return false;
  }
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
  disposition: LaunchDisposition,
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
    disposition,
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
    disposition: LaunchDisposition;
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    runDetachedProcess: SwitchProcessRunner;
    runProcess: SwitchProcessRunner;
  },
): Promise<LaunchSwitchResult> {
  const family: LaunchFamily =
    deps.platform === "win32" && nonEmpty(deps.env.WT_SESSION)
      ? "windows-terminal"
      : deps.platform === "win32" && isMsysBashSession(deps.env)
        ? "git-bash"
        : "fallback";
  ensureLaunchSupported(family, deps.disposition, deps.env, deps.platform);
  const commands =
    family === "windows-terminal" && deps.disposition === "tab"
      ? [buildWindowsTerminalCommand(candidate.worktreePath, deps.env, "tab")]
      : buildFallbackCommands(candidate.worktreePath, deps.platform, deps.env);
  const attempts: string[] = [];

  for (const command of commands) {
    const attemptEnv = buildFallbackAttemptEnvironment(command, candidate.worktreePath, deps.env);
    const runner = command[0] === "wt.exe" ? deps.runDetachedProcess : deps.runProcess;
    const result = await runner(command, {
      cwd: candidate.worktreePath,
      env: attemptEnv,
    });

    if (result.exitCode === 0) {
      return {
        command,
        disposition: deps.disposition,
        mode: "fallback",
      };
    }

    const detail = (result.stderr || result.stdout || "unknown failure").trim();
    attempts.push(`${command.join(" ")}: ${detail}`);
    if (deps.disposition === "tab") {
      throwLaunchFailure(candidate.worktreePath, command, detail);
    }
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
    disposition: LaunchDisposition;
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    requireAvailability: boolean;
    runProcess: SwitchProcessRunner;
    availability?: boolean;
  },
): Promise<LaunchSwitchResult | null> {
  const commandName = IDE_COMMANDS[ide];
  if (deps.disposition === "tab") {
    ensureLaunchSupported("ide", deps.disposition, deps.env, deps.platform);
  }
  const ideAvailable =
    deps.availability ??
    (await isCommandAvailable(commandName, {
      env: deps.env,
      platform: deps.platform,
      runProcess: deps.runProcess,
    }));

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

  ensureLaunchSupported("ide", deps.disposition, deps.env, deps.platform);

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
    disposition: deps.disposition,
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
    disposition: LaunchDisposition;
    env: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    runDetachedProcess: SwitchProcessRunner;
    runProcess: SwitchProcessRunner;
    macTarget?: MacTargetEvidence;
  },
): Promise<LaunchSwitchResult | null> {
  const terminalApp = detectTerminalApp(deps.env);
  if (!terminalApp) return null;

  const family: LaunchFamily = terminalApp === "kitty" ? "kitty-unmanaged" : terminalApp;
  ensureLaunchSupported(family, deps.disposition, deps.env, deps.platform);
  const commands = buildTerminalAppCommands(
    candidate.worktreePath,
    terminalApp,
    deps.disposition,
    deps.env,
    deps.platform,
    deps.macTarget,
  );

  for (const command of commands) {
    const runner = isIndependentWezTermStart(command) ? deps.runDetachedProcess : deps.runProcess;
    const result = await runner(command, {
      cwd: candidate.worktreePath,
      env: deps.env,
    });

    if (result.exitCode === 0) {
      return {
        command,
        disposition: deps.disposition,
        mode: "fallback",
      };
    }
    if (deps.disposition === "tab") {
      const detail = result.stderr || result.stdout;
      if (result.exitCode === 42 || detail.includes("ARASHI_TAB_TARGET_UNAVAILABLE")) {
        throw new SwitchCommandError(
          `${terminalApp} does not have an exact active tab target.`,
          SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED,
          { disposition: deps.disposition, launcher: family },
        );
      }
      throwLaunchFailure(candidate.worktreePath, command, detail);
    }
  }

  return null;
}

function buildTerminalAppCommands(
  worktreePath: string,
  terminalApp: TerminalApp,
  disposition: LaunchDisposition,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  macTarget?: MacTargetEvidence,
): string[][] {
  if (terminalApp === "wezterm") {
    return disposition === "tab"
      ? [
          [
            "wezterm",
            "cli",
            "spawn",
            "--pane-id",
            nonEmpty(env.WEZTERM_PANE)!,
            "--cwd",
            worktreePath,
          ],
        ]
      : [
          ["wezterm", "cli", "spawn", "--new-window", "--cwd", worktreePath],
          ["wezterm", "start", "--always-new-process", "--cwd", worktreePath],
        ];
  }

  if (terminalApp === "kitty") {
    return platform === "darwin"
      ? [["open", "-na", "kitty.app", "--args", "--directory", worktreePath]]
      : [["kitty", "--detach", "--directory", worktreePath]];
  }

  const shell = nonEmpty(env.SHELL) ?? "/bin/zsh";
  if (terminalApp === "terminal" && platform === "darwin") {
    const appleScriptCommand = [
      "osascript",
      "-e",
      terminalAppleScript(disposition),
      "--",
      worktreePath,
      shell,
      macTarget?.target ?? "",
      macTarget?.profile ?? "",
      macTarget?.version ?? "",
    ];
    return disposition === "tab"
      ? [appleScriptCommand]
      : [appleScriptCommand, ["open", "-a", "Terminal", worktreePath]];
  }
  if (terminalApp === "iterm2" && platform === "darwin") {
    const appleScriptCommand = [
      "osascript",
      "-e",
      iTermAppleScript(disposition),
      "--",
      worktreePath,
      shell,
      macTarget?.target ?? "",
      macTarget?.profile ?? "",
      macTarget?.version ?? "",
    ];
    return disposition === "tab"
      ? [appleScriptCommand]
      : [
          appleScriptCommand,
          ["open", "-a", "iTerm", worktreePath],
          ["open", "-a", "iTerm2", worktreePath],
        ];
  }
  if (
    terminalApp === "ghostty" &&
    platform === "darwin" &&
    ((macTarget && versionAtLeast(macTarget.version, "1.3.0")) ||
      (disposition === "window" && versionAtLeast(env.TERM_PROGRAM_VERSION, "1.3.0")))
  ) {
    const appleScriptCommand = [
      "osascript",
      "-e",
      ghosttyAppleScript(disposition),
      "--",
      worktreePath,
      shell,
      macTarget?.target ?? "",
      macTarget?.profile ?? "",
      macTarget?.version ?? env.TERM_PROGRAM_VERSION ?? "",
    ];
    return disposition === "tab"
      ? [appleScriptCommand]
      : [
          appleScriptCommand,
          [
            "open",
            "-na",
            "Ghostty.app",
            "--args",
            "--working-directory",
            worktreePath,
            "-e",
            shell,
          ],
        ];
  }
  if (platform === "linux") {
    return [["ghostty", "+new-window", "--working-directory", worktreePath, "-e", shell]];
  }
  if (platform === "darwin") {
    return [
      ["open", "-na", "Ghostty.app", "--args", "--working-directory", worktreePath, "-e", shell],
    ];
  }
  return [["ghostty", "--working-directory", worktreePath, "-e", shell]];
}

function isIndependentWezTermStart(command: string[]): boolean {
  return command[0] === "wezterm" && command[1] === "start";
}

async function preflightMacTarget(
  launcher: MacTargetEvidence["launcher"],
  disposition: LaunchDisposition,
  env: Record<string, string | undefined>,
  runProcess: SwitchProcessRunner,
): Promise<MacTargetEvidence> {
  const command = ["osascript", "-e", macTargetPreflightAppleScript(launcher), "--"];
  const result = await runProcess(command, {
    cwd: process.cwd(),
    env: stripDirectiveEnvironment(env),
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout;
    if (detail.includes("ARASHI_TAB_TARGET_UNAVAILABLE")) {
      throwUnsupportedMacTarget(launcher, disposition);
    }
    throwLaunchFailure(process.cwd(), command, detail);
  }

  const evidence = parseMacTargetEvidence(result.stdout, launcher);
  if (!evidence || (launcher === "ghostty" && !versionAtLeast(evidence.version, "1.3.0"))) {
    throwUnsupportedMacTarget(launcher, disposition);
  }
  return evidence;
}

function parseMacTargetEvidence(
  stdout: string,
  launcher: MacTargetEvidence["launcher"],
): MacTargetEvidence | null {
  let target: unknown;
  let profile: unknown;
  let version: unknown;
  try {
    const payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
    ({ profile, target, version } = payload);
  } catch {
    [version, target, profile] = stdout.trim().split("\n");
  }
  if (
    typeof target !== "string" ||
    !nonEmpty(target) ||
    typeof profile !== "string" ||
    !nonEmpty(profile) ||
    typeof version !== "string" ||
    !nonEmpty(version)
  ) {
    return null;
  }
  return {
    launcher,
    profile: profile.trim(),
    target: target.trim(),
    version: version.trim(),
  };
}

function throwUnsupportedMacTarget(
  launcher: MacTargetEvidence["launcher"],
  disposition: LaunchDisposition,
): never {
  throw new SwitchCommandError(
    `${launcher} does not have supported version and exact target evidence for this launch.`,
    SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED,
    { disposition, launcher },
  );
}

function macTargetPreflightAppleScript(launcher: MacTargetEvidence["launcher"]): string {
  if (launcher === "terminal") {
    return `if not (application "Terminal" is running) then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
tell application "Terminal"
if (count of windows) is 0 then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
set targetWindow to front window
set targetProfile to name of current settings of selected tab of targetWindow
return (version as text) & linefeed & (id of targetWindow as text) & linefeed & targetProfile
end tell`;
  }
  if (launcher === "iterm2") {
    return `if not (application "iTerm2" is running) then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
tell application "iTerm2"
if (count of windows) is 0 then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
set targetWindow to current window
set targetProfile to profile name of current session of targetWindow
return (version as text) & linefeed & (id of targetWindow as text) & linefeed & targetProfile
end tell`;
  }
  return `if not (application "Ghostty" is running) then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
tell application "Ghostty"
if (count of windows) is 0 then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42
set targetWindow to front window
return (version as text) & linefeed & (id of targetWindow as text) & linefeed & "Default"
end tell`;
}

function terminalAppleScript(disposition: LaunchDisposition): string {
  const action =
    disposition === "tab"
      ? "set targetWindow to first window whose id as text is targetIdentifier\nset createdTab to do script launchCommand in targetWindow"
      : `if targetProfile is "" and terminalWasRunning and (count of windows) > 0 then
set targetProfile to name of current settings of selected tab of front window
end if
set createdTab to do script launchCommand`;
  return `on run argv
set targetDirectory to item 1 of argv
set targetShell to item 2 of argv
set targetIdentifier to item 3 of argv
set targetProfile to item 4 of argv
set launchCommand to "cd " & quoted form of targetDirectory & "; exec " & quoted form of targetShell & " -l"
set terminalWasRunning to application "Terminal" is running
tell application "Terminal"
${action}
if targetProfile is not "" then set current settings of createdTab to settings set targetProfile
activate
end tell
end run`;
}

function iTermAppleScript(disposition: LaunchDisposition): string {
  const action =
    disposition === "tab"
      ? `${exactMacWindowLookupAppleScript()}\ntell targetWindow to create tab with profile targetProfile command launchCommand`
      : `if targetProfile is "" and iTermWasRunning and (count of windows) > 0 then
set targetProfile to profile name of current session of current window
end if
if targetProfile is "" then
create window with default profile command launchCommand
else
create window with profile targetProfile command launchCommand
end if`;
  return `on run argv
set targetDirectory to item 1 of argv
set targetShell to item 2 of argv
set targetIdentifier to item 3 of argv
set targetProfile to item 4 of argv
set launchCommand to "cd " & quoted form of targetDirectory & "; exec " & quoted form of targetShell & " -l"
set iTermWasRunning to application "iTerm2" is running
tell application "iTerm2"
${action}
activate
end tell
end run`;
}

function ghosttyAppleScript(disposition: LaunchDisposition): string {
  const action =
    disposition === "tab"
      ? `${exactMacWindowLookupAppleScript()}\nnew tab in targetWindow with configuration surfaceConfig`
      : "new window with configuration surfaceConfig";
  return `on run argv
set targetDirectory to item 1 of argv
set targetShell to item 2 of argv
set targetIdentifier to item 3 of argv
tell application "Ghostty"
set surfaceConfig to new surface configuration
set initial working directory of surfaceConfig to targetDirectory
set command of surfaceConfig to targetShell
${action}
activate
end tell
end run`;
}

function exactMacWindowLookupAppleScript(): string {
  return `set targetWindow to missing value
repeat with candidateWindow in windows
if (id of candidateWindow as text) is targetIdentifier then
set targetWindow to contents of candidateWindow
exit repeat
end if
end repeat
if targetWindow is missing value then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42`;
}

function buildFallbackCommands(
  worktreePath: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[][] {
  if (platform === "darwin") {
    return [["open", "-a", "Terminal", worktreePath]];
  }

  if (platform === "win32") {
    const cmdFallback = [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process -FilePath ${WINDOWS_SHELL} -WorkingDirectory $env:${WINDOWS_SWITCH_WORKTREE_ENV}`,
    ];
    const configuredGitBashFallback = [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_GIT_BASH_LAUNCH,
    ];
    const minttyFallback = [
      "mintty.exe",
      "--daemon",
      "--dir",
      worktreePath,
      "/usr/bin/bash",
      "--login",
      "-i",
    ];
    const windowsTerminalSession = env.WT_SESSION?.trim();
    if (windowsTerminalSession) {
      const windowsTerminal = buildWindowsTerminalCommand(worktreePath, env, "window");

      return isMsysBashSession(env)
        ? [windowsTerminal, configuredGitBashFallback, minttyFallback, cmdFallback]
        : [windowsTerminal, cmdFallback];
    }

    if (isMsysBashSession(env)) {
      return [configuredGitBashFallback, minttyFallback, cmdFallback];
    }

    return [cmdFallback];
  }

  return [
    ["x-terminal-emulator", "--working-directory", worktreePath],
    ["gnome-terminal", "--working-directory", worktreePath],
    ["konsole", "--workdir", worktreePath],
  ];
}

function buildWindowsTerminalCommand(
  worktreePath: string,
  env: Record<string, string | undefined>,
  disposition: LaunchDisposition,
): string[] {
  const command = ["wt.exe", "-w", disposition === "tab" ? "0" : "new", "new-tab"];
  const profileId = nonEmpty(env.WT_PROFILE_ID);
  if (profileId) command.push("-p", profileId);
  command.push("-d", worktreePath);
  return command;
}

function isMsysBashSession(env: Record<string, string | undefined>): boolean {
  const msystem = env.MSYSTEM?.trim();
  const shell = env.SHELL?.trim();
  return Boolean(msystem && shell && /(?:^|[\\/])bash(?:\.exe)?$/i.test(shell));
}

function buildFallbackAttemptEnvironment(
  command: string[],
  worktreePath: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (command[4] === WINDOWS_GIT_BASH_LAUNCH) {
    return {
      ...env,
      CHERE_INVOKING: "1",
      [WINDOWS_SWITCH_WORKTREE_ENV]: worktreePath,
    };
  }

  if (command[0] === "mintty.exe") {
    return { ...env, CHERE_INVOKING: "1" };
  }

  if (command[0] === "powershell.exe") {
    return { ...env, [WINDOWS_SWITCH_WORKTREE_ENV]: worktreePath };
  }

  return env;
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
