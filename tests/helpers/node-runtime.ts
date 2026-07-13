import { glob } from "node:fs/promises";
import {
  file,
  spawn as baseSpawn,
  spawnSync as baseSpawnSync,
  runtime as baseRuntime,
} from "../../src/lib/runtime.ts";

export const resolveTestCommand = (command: string[]): string[] =>
  command[0] === "git" && command[1] === "commit"
    ? ["git", "-c", "commit.gpgsign=false", ...command.slice(1)]
    : command;

export const spawn: typeof baseSpawn = (command, options) =>
  baseSpawn(resolveTestCommand(command), options);
export const spawnSync: typeof baseSpawnSync = (command, options) =>
  baseSpawnSync(resolveTestCommand(command), options);

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
