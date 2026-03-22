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
      detail: target.skipReason ?? "no setup script found",
      durationMs: 0,
      repositoryName: target.name,
      status: "skipped",
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
      detail: `Timed out after ${options.timeoutMs}ms`,
      durationMs: result.durationMs,
      output,
      repositoryName: target.name,
      status: "timed-out",
    };
  }

  if (result.exitCode !== 0) {
    return {
      detail: output || `Setup exited with code ${result.exitCode}`,
      durationMs: result.durationMs,
      output,
      repositoryName: target.name,
      status: "failed",
    };
  }

  return {
    durationMs: result.durationMs,
    output,
    repositoryName: target.name,
    status: "success",
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
