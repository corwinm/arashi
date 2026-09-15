import createBenchmarkEnvironment from "./environment.ts";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { waitForProcessClose } from "./process.ts";

export interface Invocation {
  args: string[];
  command: string;
}

export interface ProcessResult {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stdout: string;
}

type InvocationParameters = [
  cli: Invocation,
  args: string[],
  cwd: string,
  extraEnvironment?: NodeJS.ProcessEnv,
];

export async function invoke(
  ...[cli, args, cwd, extraEnvironment = {}]: InvocationParameters
): Promise<ProcessResult> {
  const start = performance.now();
  const child = spawn(cli.command, [...cli.args, ...args], {
    cwd,
    env: createBenchmarkEnvironment(process.env, {
      CI: "1",
      FORCE_COLOR: "0",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      ...extraEnvironment,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await waitForProcessClose(child);
  return { durationMs: performance.now() - start, exitCode, stderr, stdout };
}
