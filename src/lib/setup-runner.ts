import { runWithTimeout } from "./process/run-with-timeout.ts";
import type { SetupExecutionResult, SetupTarget } from "./setup-types.ts";

export interface SetupRunnerOptions {
  timeoutMs: number;
}

export async function runSetupTarget(
  target: SetupTarget,
  options: SetupRunnerOptions,
): Promise<SetupExecutionResult> {
  if (!target.setupScriptPath) {
    return {
      repositoryName: target.name,
      status: "skipped",
      durationMs: 0,
      detail: target.skipReason ?? "no setup script found",
    };
  }

  const command = buildScriptCommand(target.setupScriptPath);
  const result = await runWithTimeout(command, {
    cwd: target.path,
    timeoutMs: options.timeoutMs,
  });

  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");

  if (result.timedOut) {
    return {
      repositoryName: target.name,
      status: "timed-out",
      durationMs: result.durationMs,
      detail: `Timed out after ${options.timeoutMs}ms`,
      output,
    };
  }

  if (result.exitCode !== 0) {
    return {
      repositoryName: target.name,
      status: "failed",
      durationMs: result.durationMs,
      detail: output || `Setup exited with code ${result.exitCode}`,
      output,
    };
  }

  return {
    repositoryName: target.name,
    status: "success",
    durationMs: result.durationMs,
    output,
  };
}

function buildScriptCommand(scriptPath: string): string[] {
  if (process.platform === "win32") {
    if (scriptPath.endsWith(".ps1")) {
      return ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
    }
    return ["cmd.exe", "/c", scriptPath];
  }

  return ["sh", scriptPath];
}
