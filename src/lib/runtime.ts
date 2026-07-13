import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";

type IoMode = "pipe" | "inherit" | "ignore";
type SpawnOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: IoMode;
  stdout?: IoMode;
  stderr?: IoMode;
  timeout?: number;
  killSignal?: NodeJS.Signals;
};

const WINDOWS_BATCH_FILE = /\.(?:cmd|bat)$/i;

const CMD_META_CHARACTER = /([()\][!^"`<>&|;, *?])/g;
const CMD_LITERAL_PERCENT_VARIABLE = "ARASHI_CMD_LITERAL_PERCENT";

// Cmd expands variables once, so this controlled expansion yields an unscanned literal percent.
const escapeCmdPercent = (value: string): string =>
  value.replaceAll("%", `%${CMD_LITERAL_PERCENT_VARIABLE}%`);

const escapeCmdToken = (token: string): string =>
  escapeCmdPercent(token.replace(CMD_META_CHARACTER, "^$1"));

// Quote for both cmd.exe and the batch file's C-runtime-style argument parser.
// Backslashes before quotes (and at the end) must first be doubled.
// Carets protect every character that cmd.exe could interpret before the batch file runs.
// Cmd consumes one backslash from a non-empty run before a caret-protected quote.
// Add one more for that layer before the C-runtime-style parser sees it.
const escapeCmdArgument = (argument: string): string => {
  const quoted = argument
    .replaceAll(
      /(\\*)"/g,
      (_match, backslashes: string) => `${backslashes}${backslashes}${backslashes ? "\\" : ""}\\"`,
    )
    .replace(/(?=(\\+?)?)\1$/, "$1$1");
  return escapeCmdPercent(`"${quoted}"`.replace(CMD_META_CHARACTER, "^$1"));
};

export function prepareSpawnCommand(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  env?: Record<string, string | undefined>;
} {
  const executable = command[0]!;
  if (platform !== "win32" || !WINDOWS_BATCH_FILE.test(executable)) {
    return { args: command.slice(1), command: executable, windowsVerbatimArguments: false };
  }

  return {
    args: [
      "/d",
      "/v:off",
      "/s",
      "/c",
      `"${[escapeCmdToken(executable), ...command.slice(1).map((argument) => escapeCmdArgument(argument))].join(" ")}"`,
    ],
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter(([name]) => name.toUpperCase() !== CMD_LITERAL_PERCENT_VARIABLE),
      ),
      [CMD_LITERAL_PERCENT_VARIABLE]: "%",
    },
    windowsVerbatimArguments: true,
  };
}

export function spawn(command: string[], options: SpawnOptions = {}) {
  if (options.cwd && !existsSync(options.cwd)) {
    throw new Error(`Working directory not found: ${options.cwd}`);
  }
  const invocation = prepareSpawnCommand(command, process.platform, options.env ?? process.env);
  const child = nodeSpawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: invocation.env ?? options.env,
    killSignal: options.killSignal,
    timeout: options.timeout,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    stdio: [options.stdin ?? "pipe", options.stdout ?? "pipe", options.stderr ?? "pipe"],
  });
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let spawnError: Error | null = null;
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      exitCode = 1;
      spawnError = error;
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      signalCode = signal;
      resolve(code ?? (signal ? 128 : 1));
    });
  });
  return {
    exited,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get spawnError() {
      return spawnError;
    },
    get killed() {
      return child.killed;
    },
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    stdin: child.stdin,
    stdout: child.stdout ? Readable.toWeb(child.stdout) : new ReadableStream(),
    stderr: child.stderr ? Readable.toWeb(child.stderr) : new ReadableStream(),
  };
}

export function spawnSync(command: string[], options: SpawnOptions = {}) {
  const invocation = prepareSpawnCommand(command, process.platform, options.env ?? process.env);
  const result = nodeSpawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: invocation.env ?? options.env,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export type RuntimeFile = ReturnType<typeof file>;
export function file(path: string) {
  return {
    async exists() {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    text: () => readFile(path, "utf8"),
  };
}

export const runtime = { file, spawn, spawnSync, write: writeFile };
