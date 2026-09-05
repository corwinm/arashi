import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "node:fs/promises";
import {
  file,
  spawn as baseSpawn,
  spawnSync as baseSpawnSync,
  runtime as baseRuntime,
} from "../../src/lib/runtime.ts";

const cliEntry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

// Only the direct, unflagged source CLI invocation is eligible. In particular,
// PTY scripts and Node -e/--import wrappers must keep their own runtime.
export const resolveTestCommand = (command: string[], cwd = process.cwd()): string[] => {
  const binary = process.env.ARASHI_TEST_BINARY;
  if (
    binary !== undefined &&
    (command[0] === process.execPath || command[0] === "node") &&
    command[1] !== undefined &&
    !command[1].startsWith("-") &&
    resolve(cwd, command[1]) === cliEntry
  ) {
    if (!isAbsolute(binary)) {
      throw new Error("ARASHI_TEST_BINARY must be an explicit absolute executable path");
    }
    return [binary, ...command.slice(2)];
  }
  return command[0] === "git" && command[1] === "commit"
    ? ["git", "-c", "commit.gpgsign=false", ...command.slice(1)]
    : command;
};

export const spawn: typeof baseSpawn = (command, options) =>
  baseSpawn(resolveTestCommand(command, options?.cwd), options);
export const spawnSync: typeof baseSpawnSync = (command, options) =>
  baseSpawnSync(resolveTestCommand(command, options?.cwd), options);

export const runtime = {
  ...baseRuntime,
  file,
  spawn,
  spawnSync,
  Glob: class {
    constructor(private readonly pattern: string) {}
    scan(options: { cwd: string }) {
      return glob(this.pattern, { cwd: options.cwd });
    }
  },
};
