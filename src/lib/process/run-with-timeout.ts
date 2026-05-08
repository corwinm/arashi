import { normalizeSpawnEnvironment } from "../shell-directives.ts";

export interface RunWithTimeoutResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  signalCode: string | null;
  killed: boolean;
}

export interface RunWithTimeoutOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export async function runWithTimeout(
  command: string[],
  options: RunWithTimeoutOptions,
): Promise<RunWithTimeoutResult> {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("Command must include at least one argument");
  }

  if (!options.cwd || typeof options.cwd !== "string") {
    throw new Error("cwd must be a non-empty string");
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }

  const startTime = Date.now();

  try {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: normalizeSpawnEnvironment(
        (options.env ?? (process.env as Record<string, string>)) as Record<
          string,
          string | undefined
        >,
      ),
      killSignal: "SIGTERM",
      stderr: "pipe",
      stdout: "pipe",
      timeout: options.timeoutMs,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;

    const durationMs = Date.now() - startTime;

    return {
      durationMs,
      exitCode: proc.exitCode ?? -1,
      killed: proc.killed,
      signalCode: proc.signalCode,
      stderr,
      stdout,
      timedOut: proc.killed && proc.signalCode === "SIGTERM",
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    return {
      durationMs,
      exitCode: -1,
      killed: false,
      signalCode: null,
      stderr: message,
      stdout: "",
      timedOut: false,
    };
  }
}
