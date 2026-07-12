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

export function spawn(command: string[], options: SpawnOptions = {}) {
  if (options.cwd && !existsSync(options.cwd)) {
    throw new Error(`Working directory not found: ${options.cwd}`);
  }
  const child = nodeSpawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    killSignal: options.killSignal,
    timeout: options.timeout,
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
  const result = nodeSpawnSync(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
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
