import createBenchmarkEnvironment from "./environment.ts";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { platform } from "node:os";
import { spawn } from "node:child_process";
import { waitForProcessClose } from "./process.ts";

export interface Invocation {
  args: string[];
  command: string;
}

export type CpuUsage =
  | { available: true; method: string; systemMs: number; userMs: number }
  | { available: false; method: string; reason: string };

export interface ProcessResult {
  cpu: CpuUsage;
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
  options?: { measureCpu?: boolean },
];

const TIME_PATH = "/usr/bin/time";
const TIME_OUTPUT = /(?:^|\n)real\s+([0-9.]+)\s*\nuser\s+([0-9.]+)\s*\nsys\s+([0-9.]+)\s*\n?$/;
const BENCHMARK_CONTROLS = {
  CI: "1",
  FORCE_COLOR: "0",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
} as const;

function invocationEnvironment(extraEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inheritedEnvironment = { ...process.env };
  const ownedEnvironment = { ...extraEnvironment };
  const controls = new Set(Object.keys(BENCHMARK_CONTROLS));
  for (const environment of [inheritedEnvironment, ownedEnvironment]) {
    for (const key of Object.keys(environment)) {
      if (controls.has(key.toUpperCase())) {
        delete environment[key];
      }
    }
  }
  return createBenchmarkEnvironment(inheritedEnvironment, {
    ...ownedEnvironment,
    ...BENCHMARK_CONTROLS,
  });
}

export async function invoke(
  ...[cli, args, cwd, extraEnvironment = {}, options = {}]: InvocationParameters
): Promise<ProcessResult> {
  const measureWithTime =
    options.measureCpu === true && platform() !== "win32" && existsSync(TIME_PATH);
  const command = measureWithTime ? TIME_PATH : cli.command;
  const commandArgs = measureWithTime
    ? ["-p", cli.command, ...cli.args, ...args]
    : [...cli.args, ...args];
  const start = performance.now();
  const child = spawn(command, commandArgs, {
    cwd,
    env: invocationEnvironment(extraEnvironment),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await waitForProcessClose(child);
  let cpu: CpuUsage;
  if (measureWithTime) {
    const match = TIME_OUTPUT.exec(stderr);
    if (match) {
      cpu = {
        available: true,
        method: "posix-time-p",
        systemMs: Number(match[3]) * 1000,
        userMs: Number(match[2]) * 1000,
      };
      stderr = stderr.slice(0, match.index);
    } else {
      cpu = {
        available: false,
        method: "posix-time-p",
        reason: "CPU usage was absent from time output.",
      };
    }
  } else if (options.measureCpu === true) {
    cpu = {
      available: false,
      method: "unavailable",
      reason:
        platform() === "win32"
          ? "The benchmark runner has no privilege-free Windows child CPU adapter."
          : "/usr/bin/time is unavailable.",
    };
  } else {
    cpu = { available: false, method: "not-requested", reason: "CPU measurement not requested." };
  }
  return { cpu, durationMs: performance.now() - start, exitCode, stderr, stdout };
}
