import { glob } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  file,
  spawn as baseSpawn,
  spawnSync as baseSpawnSync,
  runtime as baseRuntime,
} from "../../src/lib/runtime.ts";

const tsxImport = createRequire(import.meta.url).resolve("tsx");

const resolveTestCommand = (command: string[]): string[] => {
  const resolved = command.map((argument, index) =>
    argument === "tsx" && command[index - 1] === "--import" ? tsxImport : argument,
  );
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
