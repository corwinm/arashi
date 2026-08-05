import { runtime } from "./runtime.ts";
import { access, readdir, stat } from "fs/promises";
import { constants } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize, resolve } from "path";
import { normalizeSpawnEnvironment } from "./shell-directives.ts";

const ZERO = 0;
const ONE = 1;
export const DEFAULT_LIFECYCLE_HOOK_TIMEOUT = 300_000;

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
  hookScope?: HookScope;
  sourceScriptPath?: string;
  targetRepoName?: string;
  targetRepoPath?: string;
  targetWorktreePath?: string;
  workspaceMode?: "configured" | "standalone";
  mainRepoPath?: string;
  parentRepoPath?: string;
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

export type HookScope = "repository" | "workspace" | "global-repository" | "global-shared";

export interface HookTargetRepository {
  name: string;
  path: string;
}

export interface ResolvedLifecycleHook {
  hookName: string;
  scope: HookScope;
  scriptPath: string;
  sourceScriptPath: string;
  executionPath: string;
  targetRepositoryName: string;
  targetRepositoryPath: string;
}

export interface LifecycleHookLocation {
  hookName: string;
  scope: HookScope;
  scriptPath: string | null;
  executionPath: string;
  targetRepositoryName: string;
  targetRepositoryPath: string;
}

export class LifecycleHookDiscoveryError extends Error {
  readonly executionPath: string;
  readonly hookName: string;
  readonly scope: HookScope;
  readonly targetRepositoryName: string;
  readonly targetRepositoryPath: string;

  constructor(options: {
    cause: unknown;
    executionPath: string;
    hookName: string;
    scope: HookScope;
    targetRepositoryName: string;
    targetRepositoryPath: string;
  }) {
    super(options.cause instanceof Error ? options.cause.message : String(options.cause), {
      cause: options.cause,
    });
    this.name = "LifecycleHookDiscoveryError";
    this.executionPath = options.executionPath;
    this.hookName = options.hookName;
    this.scope = options.scope;
    this.targetRepositoryName = options.targetRepositoryName;
    this.targetRepositoryPath = options.targetRepositoryPath;
  }
}

export interface LifecycleHookOutcome {
  hookName: string;
  scope: HookScope;
  workspaceMode: "configured" | "standalone";
  hookStatus: HookOutcomeStatus;
  reasonCode: HookOutcomeReasonCode;
  message: string;
  repositoryId: string;
  sourceScriptPath: string | null;
  executionPath: string | null;
  targetRepositoryName: string | null;
  targetRepositoryPath: string | null;
  targetWorktreePath: string | null;
  durationMs?: number;
}

export type HookOutcomeStatus = "success" | "failure" | "skipped";

export type HookOutcomeReasonCode =
  | "none"
  | "not_found"
  | "disabled"
  | "validation_failed"
  | "interpreter_unavailable"
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
  quiet?: boolean;
}

interface RunLifecycleHookOptions {
  lifecyclePoint: string;
  operationData: Record<string, string>;
  options?: { skipHooks?: boolean; timeout?: number };
  repoPath: string;
}

type RunLifecycleHookArgs =
  | [
      lifecyclePoint: string,
      repoPath: string,
      operationData: Record<string, string>,
      options?: { skipHooks?: boolean; timeout?: number },
    ]
  | [options: RunLifecycleHookOptions];

export interface ValidationResult {
  valid: boolean;
  error?: string;
  reasonCode?: "validation_failed" | "interpreter_unavailable";
}

export const GLOBAL_HOOKS = {
  postCreate: "post-create",
  postRemove: "post-remove",
  preCreate: "pre-create",
  preRemove: "pre-remove",
} as const;

export const REPO_SPECIFIC_LIFECYCLES = ["pre-create", "post-create"] as const;

export type RepoSpecificLifecycle = (typeof REPO_SPECIFIC_LIFECYCLES)[number];

export const getRepoSpecificHookName = (
  lifecycle: RepoSpecificLifecycle,
  repoName: string,
): string => `${lifecycle}.${repoName}`;

export const parseRepoSpecificHookName = (
  hookName: string,
): { lifecycle: RepoSpecificLifecycle; repoName: string } | null => {
  for (const lifecycle of REPO_SPECIFIC_LIFECYCLES) {
    const prefix = `${lifecycle}.`;
    if (hookName.startsWith(prefix)) {
      const repoName = hookName.slice(prefix.length);
      if (repoName.length === ZERO) {
        return null;
      }
      return { lifecycle, repoName };
    }
  }

  return null;
};

export const buildHookOperationData = (options: {
  branchName?: string;
  repoName?: string;
  worktreePath?: string;
  mainRepoPath?: string;
  parentRepoPath?: string;
}): Record<string, string> => {
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
};

export interface RemoveHookOperationDataOptions {
  branchNames?: string[];
  worktreePaths?: string[];
  repositoryNames?: string[];
  targets?: RemoveHookTarget[];
  mainRepoPath: string;
}

export interface RemoveHookTarget {
  repository: string;
  branchName: string | null;
  worktreePath: string | null;
}

export const compareUnicodeScalars = (left: string, right: string): number => {
  const leftPoints = [...left].map((value) => value.codePointAt(0) ?? ZERO);
  const rightPoints = [...right].map((value) => value.codePointAt(0) ?? ZERO);
  for (let index = ZERO; index < Math.min(leftPoints.length, rightPoints.length); index += ONE) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
};

export const normalizeLifecyclePath = (value: string): string => {
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  if (windows) {
    const normalized = value.replaceAll("\\", "/");
    const unc = normalized.startsWith("//");
    const prefix = unc ? "//" : `${normalized[0].toUpperCase()}:`;
    const rest = normalized.slice(2);
    const parts: string[] = [];
    for (const part of rest.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        const minimumParts = unc ? 2 : 0;
        if (parts.length > minimumParts) parts.pop();
      } else parts.push(part);
    }
    if (unc) return `//${parts.join("/")}`;
    return `${prefix}/${parts.join("/")}`;
  }
  const absolute = isAbsolute(value) ? value : resolve(value);
  return normalize(absolute)
    .replaceAll("\\", "/")
    .replace(/(?<!^)\/$/, "");
};

export const buildRemoveHookOperationData = (
  options: RemoveHookOperationDataOptions,
): Record<string, string> => {
  const inputTargets =
    options.targets ??
    (options.repositoryNames ?? []).map((repository, index) => ({
      branchName: options.branchNames?.[index] ?? null,
      repository,
      worktreePath: options.worktreePaths?.[index] ?? null,
    }));
  const targetMap = new Map<string, RemoveHookTarget>();
  for (const target of inputTargets) {
    if (!target.repository) continue;
    const canonical = {
      branchName: target.branchName || null,
      repository: target.repository,
      worktreePath: target.worktreePath ? normalizeLifecyclePath(target.worktreePath) : null,
    };
    targetMap.set(JSON.stringify(canonical), canonical);
  }
  const targets = [...targetMap.values()].toSorted((left, right) => {
    const repository = compareUnicodeScalars(left.repository, right.repository);
    if (repository !== ZERO) return repository;
    if (left.worktreePath === null && right.worktreePath !== null) return -ONE;
    if (left.worktreePath !== null && right.worktreePath === null) return ONE;
    const worktree = compareUnicodeScalars(left.worktreePath ?? "", right.worktreePath ?? "");
    if (worktree !== ZERO) return worktree;
    if (left.branchName === null && right.branchName !== null) return -ONE;
    if (left.branchName !== null && right.branchName === null) return ONE;
    return compareUnicodeScalars(left.branchName ?? "", right.branchName ?? "");
  });
  const sortedDistinct = (values: Array<string | null>): string[] =>
    [
      ...new Set(values.filter((value): value is string => value !== null && value.length > ZERO)),
    ].toSorted(compareUnicodeScalars);
  const uniqueBranches = sortedDistinct(targets.map((target) => target.branchName));
  const uniqueWorktreePaths = sortedDistinct(targets.map((target) => target.worktreePath));
  const uniqueRepositories = sortedDistinct(targets.map((target) => target.repository));

  const operationData = buildHookOperationData({
    branchName: uniqueBranches.length === ONE ? uniqueBranches[0] : undefined,
    mainRepoPath: options.mainRepoPath,
    repoName: uniqueRepositories.length === ONE ? uniqueRepositories[0] : undefined,
    worktreePath: uniqueWorktreePaths.length === ONE ? uniqueWorktreePaths[0] : undefined,
  });

  operationData.OPERATION = "remove";
  operationData.REMOVE_TARGETS_JSON = JSON.stringify(targets);
  operationData.REMOVE_TARGET_BRANCHES = uniqueBranches.join(",");
  operationData.REMOVE_TARGET_WORKTREES = uniqueWorktreePaths.join(",");
  operationData.REMOVE_TARGET_REPOSITORIES = uniqueRepositories.join(",");
  operationData.REMOVE_TOTAL_BRANCHES = String(uniqueBranches.length);
  operationData.REMOVE_TOTAL_WORKTREES = String(uniqueWorktreePaths.length);
  operationData.REMOVE_TOTAL_REPOSITORIES = String(uniqueRepositories.length);

  return operationData;
};

export const isHookSkipped = (result: HookResult | null): boolean => result === null;

export const isHookFailure = (result: HookResult | null): boolean =>
  result !== null && !result.success;

export const mapHookSkippedOutcome = (
  reasonCode: Exclude<HookOutcomeReasonCode, "none" | "timeout" | "exit_non_zero">,
  message: string,
): HookOutcomeMapping => ({
  hookStatus: "skipped",
  message,
  reasonCode,
});

export const mapHookExecutionResult = (result: HookResult): HookOutcomeMapping => {
  if (result.success) {
    return {
      durationMs: result.duration,
      hookStatus: "success",
      message: "Hook completed",
      reasonCode: "none",
    };
  }

  if (result.timedOut) {
    return {
      durationMs: result.duration,
      hookStatus: "failure",
      message: "Hook timed out after configured limit",
      reasonCode: "timeout",
    };
  }

  return {
    durationMs: result.duration,
    hookStatus: "failure",
    message: `Hook exited with code ${result.exitCode}`,
    reasonCode: "exit_non_zero",
  };
};

// ============================================================================
// Helper Functions (Internal)
// ============================================================================

/**
 * Returns platform-appropriate shell command for executing scripts.
 */
export const encodeCmdScriptPath = (scriptPath: string): string => {
  if (
    scriptPath.includes("\r") ||
    scriptPath.includes("\n") ||
    scriptPath.includes("\0") ||
    scriptPath.includes('"')
  ) {
    throw new Error(`Unsafe command hook path: ${scriptPath}`);
  }
  return `"${scriptPath.replaceAll("%", "%%")}"`;
};

export const getHookSpawnCommand = (
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  if (platform === "win32") {
    if (scriptPath.toLowerCase().endsWith(".ps1")) {
      return [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ];
    }
    return ["cmd.exe", "/d", "/e:on", "/v:off", "/c", "call", scriptPath];
  }

  return [scriptPath];
};

/**
 * Constructs environment variables from hook context.
 */
export const buildHookEnvironment = (context: HookContext): Record<string, string> => {
  const env: Record<string, string> = {
    ...normalizeSpawnEnvironment(process.env),
  };

  for (const [key, value] of Object.entries(context.operationData)) env[`ARASHI_${key}`] = value;

  env.ARASHI_HOOK_NAME = context.hookName;
  env.ARASHI_HOOK_EXECUTION_PATH = context.repoPath;

  if (context.hookScope) {
    env.ARASHI_HOOK_SCOPE = context.hookScope;
  }

  if (context.sourceScriptPath) {
    env.ARASHI_HOOK_SOURCE_PATH = context.sourceScriptPath;
  }

  if (context.targetRepoName) {
    env.ARASHI_HOOK_TARGET_REPOSITORY = context.targetRepoName;
  }

  if (context.targetRepoPath) {
    env.ARASHI_HOOK_TARGET_REPO_PATH = context.targetRepoPath;
  }
  if (context.targetWorktreePath) env.ARASHI_HOOK_TARGET_WORKTREE_PATH = context.targetWorktreePath;
  if (context.workspaceMode) env.ARASHI_HOOK_WORKSPACE_MODE = context.workspaceMode;
  if (context.mainRepoPath) env.ARASHI_MAIN_REPO_PATH = context.mainRepoPath;
  if (context.parentRepoPath) env.ARASHI_PARENT_REPO_PATH = context.parentRepoPath;

  // Historical aliases are lifecycle-specific. Callers provide REPO_PATH when its
  // compatibility value differs from the process cwd.
  if (!env.ARASHI_REPO_PATH) {
    env.ARASHI_REPO_PATH = context.targetRepoPath ?? context.repoPath;
  }

  return env;
};

/**
 * Streams and prefixes output from a ReadableStream.
 */
const streamOutput = async (
  stream: ReadableStream,
  prefix: string,
  quiet = false,
): Promise<string> => {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";

    for (const line of parts) {
      if (!quiet) {
        console.log(`${prefix} ${line}`);
      }
      lines.push(line);
    }
  }

  if (buffer) {
    if (!quiet) {
      console.log(`${prefix} ${buffer}`);
    }
    lines.push(buffer);
  }

  return lines.join("\n");
};

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
export const findHook = async (hookName: string, repoPath: string): Promise<string | null> => {
  return discoverLifecycleHook(hookName, repoPath);
};

export const lifecycleHookExtensions = (
  platform: NodeJS.Platform = process.platform,
): readonly string[] => (platform === "win32" ? [".ps1", ".cmd", ".bat"] : [".sh"]);

export const discoverLifecycleHookInDirectory = async (
  hookName: string,
  hooksDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> => {
  const extensions = lifecycleHookExtensions(platform);
  let entries: string[];
  try {
    entries = await readdir(hooksDirectory);
  } catch {
    return null;
  }
  const expectedNames = extensions.map((extension) => `${hookName}${extension}`.toLowerCase());
  const candidates = entries
    .filter((entry) =>
      platform === "win32"
        ? expectedNames.includes(entry.toLowerCase())
        : entry === `${hookName}.sh`,
    )
    .map((entry) => resolve(hooksDirectory, entry))
    .toSorted(compareUnicodeScalars);
  if (candidates.length > ONE) {
    throw new Error(`Ambiguous lifecycle hook '${hookName}': ${candidates.join(", ")}`);
  }
  return candidates[ZERO] ?? null;
};

export const discoverLifecycleHook = async (
  hookName: string,
  repoPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> => {
  const hooksDirectory = join(repoPath, ".arashi", "hooks");
  return discoverLifecycleHookInDirectory(hookName, hooksDirectory, platform);
};

export const resolveScopedLifecycleHooks = async (options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
  globalOnly?: boolean;
}): Promise<ResolvedLifecycleHook[]> => {
  const locations = await resolveScopedLifecycleHookLocations(options);
  return locations
    .filter((location): location is LifecycleHookLocation & { scriptPath: string } =>
      Boolean(location.scriptPath),
    )
    .map((location) => ({
      ...location,
      scriptPath: location.scriptPath,
      sourceScriptPath: location.scriptPath,
    }));
};

export const resolveScopedLifecycleHookLocations = async (options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
  globalOnly?: boolean;
}): Promise<LifecycleHookLocation[]> => {
  const resolved: LifecycleHookLocation[] = [];
  const userHome = process.env.HOME ?? homedir();
  const globalHooksDir = join(userHome, ".arashi", "hooks");

  for (const target of options.targetRepositories) {
    const discoverScoped = async (
      scope: HookScope,
      hooksDirectory: string,
      executionPath: string,
    ): Promise<string | null> => {
      try {
        return await discoverLifecycleHookInDirectory(options.hookName, hooksDirectory);
      } catch (cause) {
        throw new LifecycleHookDiscoveryError({
          cause,
          executionPath,
          hookName: options.hookName,
          scope,
          targetRepositoryName: target.name,
          targetRepositoryPath: target.path,
        });
      }
    };
    const repositoryHookPath = options.globalOnly
      ? null
      : await discoverScoped("repository", join(target.path, ".arashi", "hooks"), target.path);
    const workspaceHookPath = options.globalOnly
      ? null
      : await discoverScoped(
          "workspace",
          join(options.workspaceRoot, ".arashi", "hooks"),
          options.workspaceRoot,
        );
    const globalRepositoryHookPath = await discoverScoped(
      "global-repository",
      join(globalHooksDir, target.name),
      target.path,
    );
    const globalSharedHookPath = await discoverScoped("global-shared", globalHooksDir, target.path);

    if (!options.globalOnly && target.path !== options.workspaceRoot) {
      resolved.push({
        executionPath: target.path,
        hookName: options.hookName,
        scope: "repository",
        scriptPath: repositoryHookPath,
        targetRepositoryName: target.name,
        targetRepositoryPath: target.path,
      });
    }

    if (!options.globalOnly) {
      resolved.push({
        executionPath: options.workspaceRoot,
        hookName: options.hookName,
        scope: "workspace",
        scriptPath: workspaceHookPath,
        targetRepositoryName: target.name,
        targetRepositoryPath: target.path,
      });
    }

    resolved.push({
      executionPath: target.path,
      hookName: options.hookName,
      scope: "global-repository",
      scriptPath: globalRepositoryHookPath,
      targetRepositoryName: target.name,
      targetRepositoryPath: target.path,
    });

    resolved.push({
      executionPath: target.path,
      hookName: options.hookName,
      scope: "global-shared",
      scriptPath: globalSharedHookPath,
      targetRepositoryName: target.name,
      targetRepositoryPath: target.path,
    });
  }

  return resolved;
};

/**
 * Validates that a hook script is executable and properly configured.
 *
 * @param hookPath - Absolute path to the hook script
 * @returns Validation result with status and error message if invalid
 */
export const validateHook = async (hookPath: string): Promise<ValidationResult> => {
  try {
    const stats = await stat(hookPath);

    if (!stats.isFile()) {
      return {
        error: `Hook is not a file: ${hookPath}`,
        reasonCode: "validation_failed",
        valid: false,
      };
    }

    // Check execute permissions on Unix
    if (process.platform !== "win32") {
      try {
        await access(hookPath, constants.X_OK);
      } catch {
        return {
          error: `Hook is not executable: ${hookPath}. Run: chmod +x ${hookPath}`,
          reasonCode: "validation_failed",
          valid: false,
        };
      }
    }

    if (process.platform === "win32") {
      let command: string[];
      try {
        command = getHookSpawnCommand(hookPath);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          reasonCode: "interpreter_unavailable",
          valid: false,
        };
      }
      const lookup = runtime.spawnSync(["where.exe", command[ZERO]], {
        stderr: "ignore",
        stdout: "ignore",
      });
      if (lookup.exitCode !== ZERO) {
        return {
          error: `Required hook interpreter is unavailable: ${command[ZERO]}`,
          reasonCode: "interpreter_unavailable",
          valid: false,
        };
      }
    }

    return { valid: true };
  } catch (error) {
    return {
      error: `Failed to validate hook: ${error}`,
      reasonCode: "validation_failed",
      valid: false,
    };
  }
};

/**
 * Executes a hook script with provided context and returns the result.
 *
 * @param options - Hook execution options
 * @returns Complete execution result including exit code and output
 */
export const executeHook = async (options: HookExecutionOptions): Promise<HookResult> => {
  const startTime = Date.now();
  const timeout = options.timeout ?? DEFAULT_LIFECYCLE_HOOK_TIMEOUT;

  if (!options.quiet) {
    console.log(`🪝 Executing hook: ${options.hookName}`);
  }

  try {
    const proc = runtime.spawn(getHookSpawnCommand(options.scriptPath), {
      cwd: options.context.repoPath,
      env: buildHookEnvironment(options.context),
      killSignal: "SIGTERM",
      stderr: "pipe",
      stdout: "pipe",
      timeout,
    });

    const [stdout, stderr] = await Promise.all([
      streamOutput(proc.stdout, `[${options.hookName}:OUT]`, options.quiet),
      streamOutput(proc.stderr, `[${options.hookName}:ERR]`, options.quiet),
    ]);

    await proc.exited;

    const duration = Date.now() - startTime;
    const exitCode = proc.exitCode ?? -ONE;

    return {
      duration,
      exitCode,
      killed: proc.killed,
      signalCode: proc.signalCode,
      stderr,
      stdout,
      success: exitCode === 0,
      timedOut: proc.killed && proc.signalCode === "SIGTERM",
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      duration,
      exitCode: -ONE,
      killed: false,
      signalCode: null,
      stderr: `Failed to execute hook: ${errorMessage}`,
      stdout: "",
      success: false,
      timedOut: false,
    };
  }
};

/**
 * High-level function to discover, validate, and execute a hook for a lifecycle point.
 *
 * @param lifecyclePoint - Name of the lifecycle point (e.g., "pre-create")
 * @param repoPath - Absolute path to the repository
 * @param operationData - Context-specific data for the hook
 * @param options - Optional settings (skipHooks, timeout)
 * @returns Execution result if hook ran, null if skipped or not found
 */
const normalizeRunLifecycleHookArgs = (...args: RunLifecycleHookArgs): RunLifecycleHookOptions => {
  const [firstArg, repoPath, operationData, options] = args;
  if (
    typeof firstArg === "object" &&
    firstArg !== null &&
    "lifecyclePoint" in firstArg &&
    "repoPath" in firstArg &&
    "operationData" in firstArg
  ) {
    return firstArg as RunLifecycleHookOptions;
  }

  return {
    lifecyclePoint: firstArg as string,
    operationData: operationData as Record<string, string>,
    options,
    repoPath: repoPath as string,
  };
};

export const runLifecycleHook = async (
  ...args: RunLifecycleHookArgs
): Promise<HookResult | null> => {
  const { lifecyclePoint, operationData, options, repoPath } = normalizeRunLifecycleHookArgs(
    ...args,
  );
  if (options?.skipHooks) {
    console.log(`⏭️  Skipping hooks (--no-hooks flag)`);
    return null;
  }

  const hookPath = await findHook(lifecyclePoint, repoPath);
  if (!hookPath) {
    return null;
  }

  const validation = await validateHook(hookPath);
  if (!validation.valid) {
    console.error(`❌ Hook validation failed: ${validation.error}`);
    return null;
  }

  const result = await executeHook({
    context: {
      hookName: lifecyclePoint,
      operationData,
      repoPath,
    },
    hookName: lifecyclePoint,
    scriptPath: hookPath,
    timeout: options?.timeout,
  });

  if (result.success) {
    console.log(`✅ Hook "${lifecyclePoint}" succeeded (${result.duration}ms)`);
  } else if (result.timedOut) {
    console.warn(`⏱️  Hook "${lifecyclePoint}" timed out after ${result.duration}ms`);
  } else {
    console.warn(`⚠️  Hook "${lifecyclePoint}" failed with exit code ${result.exitCode}`);
  }

  return result;
};
