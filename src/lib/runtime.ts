import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { prepareSpawnCommand } from "../../bin/prepare-spawn-command.js";

export { prepareSpawnCommand };

type IoMode = "pipe" | "inherit" | "ignore";
type SpawnOptions = {
  cwd?: string;
  detached?: boolean;
  env?: Record<string, string | undefined>;
  extraStdio?: number[];
  stdin?: IoMode;
  stdout?: IoMode;
  stderr?: IoMode;
  timeout?: number;
  killSignal?: NodeJS.Signals;
  callBatchFile?: boolean;
};

export function spawn(command: string[], options: SpawnOptions = {}) {
  if (options.cwd && !existsSync(options.cwd)) {
    throw new Error(`Working directory not found: ${options.cwd}`);
  }
  const invocation = prepareSpawnCommand(
    command,
    process.platform,
    options.env ?? process.env,
    false,
    options.callBatchFile,
  );
  const child = nodeSpawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    detached: options.detached,
    env: invocation.env ?? options.env,
    killSignal: options.killSignal,
    timeout: options.timeout,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    stdio: [
      options.stdin ?? "pipe",
      options.stdout ?? "pipe",
      options.stderr ?? "pipe",
      ...(options.extraStdio ?? []),
    ],
  });
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let spawnError: Error | null = null;
  const spawned = new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
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
    spawned,
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
    get pid() {
      return child.pid;
    },
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
    unref: () => child.unref(),
    stdin: child.stdin,
    stdout: child.stdout ? Readable.toWeb(child.stdout) : new ReadableStream(),
    stderr: child.stderr ? Readable.toWeb(child.stderr) : new ReadableStream(),
  };
}

export function spawnSync(command: string[], options: SpawnOptions = {}) {
  const invocation = prepareSpawnCommand(
    command,
    process.platform,
    options.env ?? process.env,
    false,
    options.callBatchFile,
  );
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
