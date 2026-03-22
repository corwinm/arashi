import type { SwitchCandidate } from "../core/switch.ts";
import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import type { SwitchLaunchMode } from "../types/switch.ts";

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
  sesh?: boolean;
}

export interface LaunchSwitchDependencies {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
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
  const platform = deps.platform ?? process.platform;
  const runProcess = deps.runProcess ?? runSwitchProcess;

  if (options.sesh) {
    if (!isTmuxSession(env)) {
      throw new SwitchCommandError(
        "--sesh requires an active tmux session (TMUX environment variable not detected).",
        SwitchCommandErrorCode.SESH_REQUIRES_TMUX,
      );
    }

    const seshAvailable = await isCommandAvailable("sesh", {
      env,
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
      env,
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

  if (isTmuxSession(env)) {
    const tmuxCommand = ["tmux", "new-window", "-c", candidate.worktreePath];
    const tmuxResult = await runProcess(tmuxCommand, {
      cwd: candidate.worktreePath,
      env,
    });

    if (tmuxResult.exitCode !== 0) {
      throwLaunchFailure(
        candidate.worktreePath,
        tmuxCommand,
        tmuxResult.stderr || tmuxResult.stdout,
      );
    }

    return {
      command: tmuxCommand,
      mode: "tmux",
    };
  }

  if (isVsCodeTerminal(env)) {
    const codeAvailable = await isCommandAvailable("code", {
      env,
      platform,
      runProcess,
    });

    if (codeAvailable) {
      const codeCommand = ["code", "--new-window", candidate.worktreePath];
      const codeResult = await runProcess(codeCommand, {
        cwd: candidate.worktreePath,
        env,
      });

      if (codeResult.exitCode !== 0) {
        throwLaunchFailure(
          candidate.worktreePath,
          codeCommand,
          codeResult.stderr || codeResult.stdout,
        );
      }

      return {
        command: codeCommand,
        mode: "vscode",
      };
    }
  }

  const terminalAppResult = await launchWithDetectedTerminalApp(candidate, {
    env,
    runProcess,
  });
  if (terminalAppResult) {
    return terminalAppResult;
  }

  return launchWithFallback(candidate, {
    env,
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

export function isTmuxSession(env: Record<string, string | undefined> = process.env): boolean {
  return typeof env.TMUX === "string" && env.TMUX.trim().length > 0;
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
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: normalizeEnv(options.env),
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

function normalizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }

  return normalized;
}

function buildSeshTmuxCommand(worktreePath: string): string[] {
  return ["tmux", "new-window", "-c", worktreePath, `sesh connect ${shellQuote(worktreePath)}`];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll(/'/g, `'\\''`)}'`;
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
