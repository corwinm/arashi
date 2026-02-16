import { access, stat } from "fs/promises";
import { join } from "path";
import { constants } from "fs";

// ============================================================================
// Type Definitions
// ============================================================================

export interface Hook {
  name: string;
  scriptPath: string;
  lifecycle: LifecyclePoint;
}

export interface HookContext {
  hookName: string;
  repoPath: string;
  operationData: Record<string, string>;
}

export interface LifecyclePoint {
  name: string;
  timing: "pre" | "post" | "during";
  operation: string;
}

export interface HookResult {
  exitCode: number;
  signalCode: string | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  success: boolean;
  timedOut: boolean;
  duration: number;
}

export type HookOutcomeStatus = "success" | "failure" | "skipped";

export type HookOutcomeReasonCode =
  | "none"
  | "not_found"
  | "disabled"
  | "timeout"
  | "exit_non_zero"
  | "not_applicable";

export interface HookOutcomeMapping {
  hookStatus: HookOutcomeStatus;
  reasonCode: HookOutcomeReasonCode;
  message: string;
  durationMs?: number;
}

export interface HookConfig {
  timeout: number;
  enabled: boolean;
  allowedHooks: string[] | null;
  blockedHooks: string[];
}

export interface HookExecutionOptions {
  hookName: string;
  scriptPath: string;
  context: HookContext;
  timeout?: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export const GLOBAL_HOOKS = {
  preCreate: "pre-create",
  postCreate: "post-create",
} as const;

export const REPO_SPECIFIC_LIFECYCLES = ["pre-create", "post-create"] as const;

export type RepoSpecificLifecycle = (typeof REPO_SPECIFIC_LIFECYCLES)[number];

export function getRepoSpecificHookName(
  lifecycle: RepoSpecificLifecycle,
  repoName: string,
): string {
  return `${lifecycle}.${repoName}`;
}

export function parseRepoSpecificHookName(
  hookName: string,
): { lifecycle: RepoSpecificLifecycle; repoName: string } | null {
  for (const lifecycle of REPO_SPECIFIC_LIFECYCLES) {
    const prefix = `${lifecycle}.`;
    if (hookName.startsWith(prefix)) {
      const repoName = hookName.slice(prefix.length);
      if (repoName.length === 0) {
        return null;
      }
      return { lifecycle, repoName };
    }
  }

  return null;
}

export function buildHookOperationData(options: {
  branchName?: string;
  repoName?: string;
  worktreePath?: string;
  mainRepoPath?: string;
  parentRepoPath?: string;
}): Record<string, string> {
  const data: Record<string, string> = {};

  if (options.branchName) {
    data.BRANCH_NAME = options.branchName;
  }

  if (options.repoName) {
    data.REPO_NAME = options.repoName;
  }

  if (options.worktreePath) {
    data.WORKTREE_PATH = options.worktreePath;
  }

  if (options.mainRepoPath) {
    data.MAIN_REPO_PATH = options.mainRepoPath;
  }

  if (options.parentRepoPath) {
    data.PARENT_REPO_PATH = options.parentRepoPath;
  }

  return data;
}

export function isHookSkipped(result: HookResult | null): boolean {
  return result === null;
}

export function isHookFailure(result: HookResult | null): boolean {
  return result !== null && !result.success;
}

export function mapHookSkippedOutcome(
  reasonCode: Exclude<HookOutcomeReasonCode, "none" | "timeout" | "exit_non_zero">,
  message: string,
): HookOutcomeMapping {
  return {
    hookStatus: "skipped",
    reasonCode,
    message,
  };
}

export function mapHookExecutionResult(result: HookResult): HookOutcomeMapping {
  if (result.success) {
    return {
      hookStatus: "success",
      reasonCode: "none",
      message: "Hook completed",
      durationMs: result.duration,
    };
  }

  if (result.timedOut) {
    return {
      hookStatus: "failure",
      reasonCode: "timeout",
      message: "Hook timed out after configured limit",
      durationMs: result.duration,
    };
  }

  return {
    hookStatus: "failure",
    reasonCode: "exit_non_zero",
    message: `Hook exited with code ${result.exitCode}`,
    durationMs: result.duration,
  };
}

// ============================================================================
// Helper Functions (Internal)
// ============================================================================

/**
 * Returns platform-appropriate shell command for executing scripts.
 */
function getShellCommand(scriptPath: string): string[] {
  if (process.platform === "win32") {
    return scriptPath.endsWith(".ps1")
      ? ["powershell.exe", "-File", scriptPath]
      : ["cmd.exe", "/c", scriptPath];
  }
  // Execute script directly (it has shebang #!/bin/sh)
  return [scriptPath];
}

/**
 * Constructs environment variables from hook context.
 */
function buildEnvironment(context: HookContext): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    ARASHI_HOOK_NAME: context.hookName,
    ARASHI_REPO_PATH: context.repoPath,
  };

  // Add operation-specific data with ARASHI_ prefix
  for (const [key, value] of Object.entries(context.operationData)) {
    env[`ARASHI_${key}`] = value;
  }

  return env;
}

/**
 * Streams and prefixes output from a ReadableStream.
 */
async function streamOutput(stream: ReadableStream, prefix: string): Promise<string> {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";

    for (const line of parts) {
      console.log(`${prefix} ${line}`);
      lines.push(line);
    }
  }

  if (buffer) {
    console.log(`${prefix} ${buffer}`);
    lines.push(buffer);
  }

  return lines.join("\n");
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Discovers a hook script for a given lifecycle point.
 *
 * @param hookName - Name of the lifecycle point (e.g., "pre-create", "pre-create.<repo>")
 * @param repoPath - Absolute path to the repository
 * @returns Absolute path to hook script if found, null if not found
 */
export async function findHook(hookName: string, repoPath: string): Promise<string | null> {
  const hookPath = join(repoPath, ".arashi", "hooks", `${hookName}.sh`);

  try {
    await access(hookPath, constants.F_OK);
    return hookPath;
  } catch {
    return null; // Not found is not an error
  }
}

/**
 * Validates that a hook script is executable and properly configured.
 *
 * @param hookPath - Absolute path to the hook script
 * @returns Validation result with status and error message if invalid
 */
export async function validateHook(hookPath: string): Promise<ValidationResult> {
  try {
    const stats = await stat(hookPath);

    if (!stats.isFile()) {
      return { valid: false, error: `Hook is not a file: ${hookPath}` };
    }

    // Check execute permissions on Unix
    if (process.platform !== "win32") {
      try {
        await access(hookPath, constants.X_OK);
      } catch {
        return {
          valid: false,
          error: `Hook is not executable: ${hookPath}. Run: chmod +x ${hookPath}`,
        };
      }
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Failed to validate hook: ${error}` };
  }
}

/**
 * Executes a hook script with provided context and returns the result.
 *
 * @param options - Hook execution options
 * @returns Complete execution result including exit code and output
 */
export async function executeHook(options: HookExecutionOptions): Promise<HookResult> {
  const startTime = Date.now();
  const timeout = options.timeout ?? 300000;

  console.log(`🪝 Executing hook: ${options.hookName}`);

  try {
    const proc = Bun.spawn(getShellCommand(options.scriptPath), {
      cwd: options.context.repoPath,
      env: buildEnvironment(options.context),
      stdout: "pipe",
      stderr: "pipe",
      timeout,
      killSignal: "SIGTERM",
    });

    // Stream output in parallel
    const [stdout, stderr] = await Promise.all([
      streamOutput(proc.stdout, `[${options.hookName}:OUT]`),
      streamOutput(proc.stderr, `[${options.hookName}:ERR]`),
    ]);

    await proc.exited;

    const duration = Date.now() - startTime;
    const exitCode = proc.exitCode ?? -1;

    return {
      exitCode,
      signalCode: proc.signalCode,
      killed: proc.killed,
      stdout,
      stderr,
      success: exitCode === 0,
      timedOut: proc.killed && proc.signalCode === "SIGTERM",
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      exitCode: -1,
      signalCode: null,
      killed: false,
      stdout: "",
      stderr: `Failed to execute hook: ${errorMessage}`,
      success: false,
      timedOut: false,
      duration,
    };
  }
}

/**
 * High-level function to discover, validate, and execute a hook for a lifecycle point.
 *
 * @param lifecyclePoint - Name of the lifecycle point (e.g., "pre-create")
 * @param repoPath - Absolute path to the repository
 * @param operationData - Context-specific data for the hook
 * @param options - Optional settings (skipHooks, timeout)
 * @returns Execution result if hook ran, null if skipped or not found
 */
export async function runLifecycleHook(
  lifecyclePoint: string,
  repoPath: string,
  operationData: Record<string, string>,
  options?: { skipHooks?: boolean; timeout?: number },
): Promise<HookResult | null> {
  // Check skip flag
  if (options?.skipHooks) {
    console.log(`⏭️  Skipping hooks (--no-hooks flag)`);
    return null;
  }

  // Discover hook
  const hookPath = await findHook(lifecyclePoint, repoPath);
  if (!hookPath) {
    return null; // No hook found, not an error
  }

  // Validate hook
  const validation = await validateHook(hookPath);
  if (!validation.valid) {
    console.error(`❌ Hook validation failed: ${validation.error}`);
    return null;
  }

  // Execute hook
  const result = await executeHook({
    hookName: lifecyclePoint,
    scriptPath: hookPath,
    context: {
      hookName: lifecyclePoint,
      repoPath,
      operationData,
    },
    timeout: options?.timeout,
  });

  // Log result
  if (result.success) {
    console.log(`✅ Hook "${lifecyclePoint}" succeeded (${result.duration}ms)`);
  } else if (result.timedOut) {
    console.warn(`⏱️  Hook "${lifecyclePoint}" timed out after ${result.duration}ms`);
  } else {
    console.warn(`⚠️  Hook "${lifecyclePoint}" failed with exit code ${result.exitCode}`);
  }

  return result;
}
