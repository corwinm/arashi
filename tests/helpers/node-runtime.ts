import { glob } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  file,
  spawn as baseSpawn,
  spawnSync as baseSpawnSync,
  runtime as baseRuntime,
} from "../../src/lib/runtime.ts";

const tsxImport = createRequire(import.meta.url).resolve("tsx");

const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/;

export const resolveTestCommand = (command: string[], platform = process.platform): string[] => {
  const resolved = command.map((argument, index) => {
    if (argument === "tsx" && command[index - 1] === "--import") {
      return tsxImport;
    }
    if (
      platform === "win32" &&
      windowsAbsolutePathPattern.test(argument) &&
      argument.endsWith(".ts")
    ) {
      return new URL(`file:///${argument.replaceAll("\\", "/")}`).href;
    }
    return argument;
  });
  return resolved[0] === "git" && resolved[1] === "commit"
    ? ["git", "-c", "commit.gpgsign=false", ...resolved.slice(1)]
    : resolved;
};

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
