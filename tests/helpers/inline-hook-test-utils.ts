import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { runtime } from "./node-runtime.ts";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");

export interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export const readWorkspaceConfig = async (
  workspaceRoot: string,
): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(workspaceRoot, ".arashi", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;

export const writeWorkspaceConfig = async (
  workspaceRoot: string,
  config: Record<string, unknown>,
): Promise<void> => {
  await writeFile(
    join(workspaceRoot, ".arashi", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
};

const runArashiProcess = async (options: {
  args: string[];
  cwd: string;
  extraEnv?: Record<string, string | undefined>;
  home?: string;
}): Promise<CliResult> => {
  const proc = runtime.spawn([process.execPath, CLI_ENTRY, ...options.args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.home ? { HOME: options.home } : {}),
      ...options.extraEnv,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
};

export const runArashi = async (cwd: string, args: string[], home?: string): Promise<CliResult> =>
  runArashiProcess({ args, cwd, home });

export const runArashiWithEnv = async (
  cwd: string,
  args: string[],
  extraEnv: Record<string, string | undefined>,
): Promise<CliResult> => runArashiProcess({ args, cwd, extraEnv });

export const writeNativeHook = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  if (process.platform !== "win32") {
    await chmod(path, 0o755);
  }
};

export const branchExists = async (repositoryPath: string, branch: string): Promise<boolean> => {
  const proc = runtime.spawn(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repositoryPath,
    stderr: "ignore",
    stdout: "ignore",
  });
  return (await proc.exited) === 0;
};

export const runGit = async (repositoryPath: string, args: string[]): Promise<void> => {
  const proc = runtime.spawn(["git", ...args], {
    cwd: repositoryPath,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
};
