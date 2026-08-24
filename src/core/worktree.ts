export { planRepositoryMaterialization } from "../lib/materialization.ts";
export { materializeRepository } from "../lib/materializer.ts";
import type {
  ExecutedMaterializationOutcome,
  RepositoryMaterializationPlan,
} from "../lib/materialization.ts";
import {
  planConfiguredRepositoryMaterialization,
  preserveCorrectReusableMaterialization,
} from "../lib/materialization-preflight.ts";
import {
  materializeRepository,
  rollbackMaterializationOwnership,
  type MaterializationOwnershipEntry,
  type MaterializationResult,
} from "../lib/materializer.ts";
import { runtime } from "../lib/runtime.ts";
/**
 * Worktree Orchestration Module
 *
 * Coordinates worktree creation across multiple git repositories with:
 * - Automatic rollback on failure
 * - Branch conflict detection and resolution
 * - Repository filtering (all/explicit/interactive)
 * - Progress tracking with spinners
 * - Lifecycle hook execution
 *
 * Feature: 001-worktree-orchestration
 */

import { ConfigNotFoundError, loadConfig, resolveGitPrimarySourceCheckout } from "../lib/config.ts";

import type { DirtyStatus, WorktreeEntry, WorktreeInfo } from "../types/remove.ts";
import {
  GLOBAL_HOOKS,
  DEFAULT_LIFECYCLE_HOOK_TIMEOUT,
  buildHookOperationData,
  discoverLifecycleHookCandidates,
  executeHook,
  executeInlineHook,
  getRepoSpecificHookName,
  mapHookExecutionResult,
  mapHookSkippedOutcome,
  prepareLifecycleHookSources,
} from "../lib/hooks.ts";
import type {
  HookInputMode,
  HookScope,
  LifecycleHookPreparationCandidate,
  LifecycleHookOutcome,
  PreparedLifecycleHookEntry,
} from "../lib/hooks.ts";
import { basename, join, parse, resolve, sep } from "path";
import { exec, isBareRepo } from "../lib/git.ts";
import { multiSelect, select } from "../lib/prompts.ts";
import { spinner, warn } from "../lib/logger.ts";
import { OperationLog } from "./rollback.ts";
import type { Repository } from "./repository.ts";
import { existsSync } from "fs";
import { realpath } from "node:fs/promises";
import { resolveWorktreesBasePath } from "../lib/worktree-location.ts";
import type { CreateBaseResolutionPlan } from "../lib/create-base.ts";
import { isValidGitBranchNameLiteral } from "../lib/git-branch-name.ts";

type ArashiConfig = Awaited<ReturnType<typeof loadConfig>>;

interface Choice<T> {
  value: T;
  name: string;
  description?: string;
}

type HookOutcomeStatus = "success" | "failure" | "skipped";
type HookOutcomeReasonCode =
  | "none"
  | "not_found"
  | "disabled"
  | "validation_failed"
  | "interpreter_unavailable"
  | "timeout"
  | "exit_non_zero"
  | "not_applicable";

interface HookOutcomeMapping {
  hookStatus: HookOutcomeStatus;
  reasonCode: HookOutcomeReasonCode;
  message: string;
  durationMs?: number;
}

const ZERO = 0;
const ONE = 1;

const PARENT_PATH_OFFSET = 2;
const GRANDPARENT_PATH_OFFSET = 3;

const NULL_PATH: string | null = null;
const NULL_SUMMARY: string | null = null;
const NULL_RESULT_ERROR: Error | null = null;
const NULL_HOOK_ERROR: HookExecutionError | null = null;
const NULL_CONFLICT_STRATEGY: ConflictResolutionStrategy | null = null;

const describeConflictLocation = (existsLocally: boolean, existsRemotely: boolean): string => {
  if (existsLocally && existsRemotely) {
    return "locally and remotely";
  }

  if (existsLocally) {
    return "locally";
  }

  return "remotely";
};

const fallbackConfig = (): ArashiConfig => ({
  repos: {},
  reposDir: "./repos",
  version: "1.0.0",
});

const loadResolvedConfig = async (
  mainRepoPath: string,
  resolvedConfig?: ArashiConfig,
): Promise<ArashiConfig> => {
  if (resolvedConfig) {
    return resolvedConfig;
  }

  try {
    return await loadConfig(mainRepoPath);
  } catch (error) {
    if (error instanceof ConfigNotFoundError) {
      return fallbackConfig();
    }

    throw error;
  }
};

// ============================================================================
// Core Types (T005)
// ============================================================================

/**
 * Filtering modes for repository selection
 */
export type RepositoryFilterMode = "all" | "explicit" | "interactive";

/**
 * Strategies for resolving branch name conflicts
 */
export type ConflictResolutionStrategy = "ABORT" | "REUSE_EXISTING" | "CREATE_ALTERNATE";

/**
 * Hook types supported by the system
 */
export type HookType = "pre-create" | "post-create";

/**
 * Result status for individual repository operations
 */
export type RepositoryResultStatus = "success" | "failed" | "skipped";

/**
 * Operation states during execution
 */
export type OperationState =
  | "INITIALIZING"
  | "VALIDATING"
  | "FILTERING"
  | "CONFLICT_CHECKING"
  | "EXECUTING"
  | "ROLLING_BACK"
  | "COMPLETED"
  | "FAILED";

/**
 * Classification of repository based on location and configuration
 * Feature: 001-nested-worktree-paths
 */
export type RepositoryType =
  | "meta-repo" // Repository with .arashi/config.json
  | "child" // Repository inside a meta-repo's repos/ folder
  | "standalone"; // Independent repository (not meta-repo or child)

/**
 * Result of repository type detection
 * Feature: 001-nested-worktree-paths
 */
export interface RepositoryTypeInfo {
  /** Detected or forced repository type */
  type: RepositoryType;

  /** For 'child' type: parent repository name */
  parentName?: string;

  /** For 'child' type: repos directory name from config */
  reposDir?: string;

  /** Human-readable explanation of type classification */
  reason: string;
}

// ============================================================================
// Configuration and Options (T006)
// ============================================================================

/**
 * Options for worktree creation operation
 */
export interface WorktreeOperationOptions {
  /** Immutable configured destination plan captured before command-layer mutation. */
  worktreePathPlan?: ReadonlyMap<Repository, CalculatedWorktreePath>;

  /** Existing exact Git registrations that command preflight proved safe to reuse. */
  reusableWorktreePaths?: ReadonlySet<string>;

  /** Immutable per-repository base resolutions captured before mutation */
  createBasePlan?: CreateBaseResolutionPlan;

  /** Immutable materialization plans captured before command-layer mutation. */
  materializationPlans?: readonly RepositoryMaterializationPlan[];

  /** Whether to execute pre-create and post-create hooks (default: true) */
  executeHooks?: boolean;

  /** Timeout in milliseconds for hook execution (default: 60000) */
  hookTimeout?: number;
  /** Suppress hook process output (required for JSON stdout isolation) */
  quietHooks?: boolean;
  /** Command-wide lifecycle hook input policy */
  hookInputMode?: HookInputMode;

  /** Whether to use interactive repository selection (default: false) */
  interactive?: boolean;

  /** Pre-selected conflict resolution strategy (null to prompt user) */
  conflictResolution?: ConflictResolutionStrategy | null;

  /** Whether to display progress spinners (default: true) */
  showProgress?: boolean;

  /** Whether to simulate operation without making changes (default: false) */
  dryRun?: boolean;

  /** Canonical workspace root for hook lookup and execution context */
  workspaceRoot?: string;

  /** Pre-resolved workspace configuration from command layer */
  resolvedConfig?: ArashiConfig;
}

interface NormalizedWorktreeOptions {
  materializationPlans: readonly RepositoryMaterializationPlan[];
  reusableWorktreePaths: ReadonlySet<string>;
  executeHooks: boolean;
  hookTimeout: number;
  hookInputMode: HookInputMode;
  quietHooks: boolean;
  interactive: boolean;
  conflictResolution: ConflictResolutionStrategy | null;
  showProgress: boolean;
  dryRun: boolean;
}

// ==========================================================================
// Dry-run Planning Types (T002)
// ==========================================================================

export type DryRunPlanStatus = "actionable" | "blocked";

export interface PlannedWorktree {
  repository: Repository;
  repositoryName: string;
  worktreePath: string | null;
  branchName: string;
  planStatus: DryRunPlanStatus;
}

export interface DryRunConflict {
  repository: Repository;
  repositoryName: string;
  conflictType: "branch_exists" | "path_exists" | "permission_issue" | "invalid_configuration";
  scope: string;
  message: string;
  blocking: boolean;
}

export type TargetAction = "created" | "reused";

export interface DryRunOutcome {
  materializationPlans?: readonly RepositoryMaterializationPlan[];
  overallStatus: DryRunPlanStatus;
  plannedWorktrees: PlannedWorktree[];
  conflicts: DryRunConflict[];
  targetActionByRepositoryPath: ReadonlyMap<string, TargetAction>;
  summaryCounts: {
    plannedTotal: number;
    conflictTotal: number;
    blockingTotal: number;
  };
}

// ============================================================================
// Repository Filter (T007)
// ============================================================================

/**
 * Repository filter criteria
 */
export interface RepositoryFilter {
  /** Filtering mode */
  mode: RepositoryFilterMode;

  /** Explicit list of repository names (only used when mode is 'explicit') */
  explicitList: string[];

  /** Resolved repositories after filtering (populated after filter application) */
  selectedRepositories: Repository[] | null;

  /** Repositories that must be included even when interactive selection is used */
  requiredRepositories?: Repository[];
}

// ============================================================================
// Conflict Detection (T008)
// ============================================================================

/**
 * Detected branch name conflict
 */
export interface BranchConflict {
  /** Repository with the conflict */
  repository: Repository;

  /** Conflicting branch name */
  branchName: string;

  /** Whether branch exists locally */
  existsLocally: boolean;

  /** Whether branch exists on remote */
  existsRemotely: boolean;

  /** User's chosen resolution (null until resolved) */
  resolution: ConflictResolutionStrategy | null;
}

/**
 * Result of conflict detection pre-flight check
 */
export interface ConflictCheckResult {
  /** Whether any conflicts were detected */
  hasConflicts: boolean;

  /** List of detected conflicts */
  conflicts: BranchConflict[];

  /** Repositories without conflicts (can proceed immediately) */
  nonConflictingRepositories: Repository[];
}

export type HookOutcomeRecord = LifecycleHookOutcome;

// ============================================================================
// Repository Result (T009)
// ============================================================================

/**
 * Result of worktree creation for a single repository
 */
export interface RepositoryResult {
  /** Repository processed */
  repository: Repository;

  /** Outcome status */
  status: RepositoryResultStatus;

  /** Path to created worktree (null if failed or skipped) */
  worktreePath: string | null;

  /** Branch name used (may differ from requested if alternate created) */
  branchName: string;

  /** Error object if status is 'failed' */
  error: Error | null;

  /** Non-fatal warnings */
  warnings: string[];

  /** Time taken to process this repository in milliseconds */
  duration: number;

  /** Materialization outcomes recorded while processing this repository. */
  materializationOutcomes?: ExecutedMaterializationOutcome[];

  /** Internal owned-object ledger for command-wide rollback before worktree removal. */
  materializationOwnershipLedger?: MaterializationOwnershipEntry[];

  /** Entry-local rollback result when materialization failed. */
  materializationRollback?: MaterializationResult["materializationRollback"];

  /** Hook outcomes recorded while processing this repository */
  hookOutcomes: HookOutcomeRecord[];

  /** Whether the target branch was created by this invocation or reused */
  targetAction: TargetAction;
}

// ============================================================================
// Operation Summary (T010)
// ============================================================================

/**
 * Summary of completed worktree creation operation
 */
export interface OperationSummary {
  /** Total number of repositories attempted */
  totalRepositories: number;

  /** Number of repositories where worktree was successfully created */
  successCount: number;

  /** Number of repositories that failed */
  failureCount: number;

  /** Number of repositories skipped */
  skippedCount: number;

  /** Detailed results for each repository that reached processing */
  repositoryResults: RepositoryResult[];

  /** Complete planned actions for every selected repository, keyed by canonical path */
  targetActionByRepositoryPath: ReadonlyMap<string, TargetAction>;

  /** Materialization-specific rollback result across processed repositories. */
  materializationRollback?: MaterializationResult["materializationRollback"];

  /** Whether rollback was triggered */
  rolledBack: boolean;

  /** Total operation time in milliseconds */
  totalDuration: number;

  /** Human-readable error summary if operation failed */
  errorSummary: string | null;

  /** Flattened hook outcomes across all processed repositories */
  hookOutcomes: HookOutcomeRecord[];

  /** Actionable next steps for failed outcomes */
  nextSteps: string[];

  /** Dry-run planning details (present only for dry-run) */
  dryRunOutcome?: DryRunOutcome;

  /** Indicates dry-run mode */
  isDryRun?: boolean;
}

// ============================================================================
// Hook Execution Context (T011)
// ============================================================================

/**
 * Context for hook script execution
 */
export interface HookExecutionContext {
  /** Type of hook being executed */
  hookType: HookType;

  /** Target branch name */
  branchName: string;

  /** Absolute path to repository */
  repositoryPath: string;

  /** Name of repository from configuration */
  repositoryName: string;

  /** Path to worktree (null for pre-create, populated for post-create) */
  worktreePath: string | null;

  /** Environment variables to pass to hook script */
  environment: Record<string, string>;

  /** Timeout in milliseconds */
  timeout: number;
}

interface GitOperationErrorOptions {
  message: string;
  operation: string;
  repository: Repository;
  originalError: Error;
}

interface HookExecutionErrorOptions {
  message: string;
  hookType: HookType;
  repository: Repository;
  exitCode: number;
  stderr: string;
}

interface CalculateWorktreePathOptions {
  repo: Repository;
  branchName: string;
  config: ArashiConfig;
  knownType?: RepositoryTypeInfo;
  authoritativeParentWorktreePath?: string;
}

type CalculateWorktreePathArgs =
  | [repo: Repository, branchName: string, config: ArashiConfig, knownType?: RepositoryTypeInfo]
  | [options: CalculateWorktreePathOptions];

export interface CalculatedWorktreePath {
  path: string;
  repositoryType: RepositoryType;
  strategy: "sibling" | "nested";
  parentWorktreePath?: string;
}

interface BuildDryRunOutcomeOptions {
  branchName: string;
  repositories: Repository[];
  conflictCheck: ConflictCheckResult;
  options: NormalizedWorktreeOptions;
  targetActionByRepositoryPath: ReadonlyMap<string, TargetAction>;
  worktreePathPlan: ReadonlyMap<Repository, CalculatedWorktreePath>;
}

interface ProcessRepositoryOptions {
  repo: Repository;
  branchName: string;
  operationLog: OperationLog;
  options: NormalizedWorktreeOptions;
  config: ArashiConfig;
  mainRepoPath: string;
  createBasePlan?: CreateBaseResolutionPlan;
  targetAction: TargetAction;
  reuseExistingWorktree: boolean;
  preparedHooks: PreparedCreateHooks;
  plannedPath: CalculatedWorktreePath;
}

interface ShouldReuseBranchOptions {
  repo: Repository;
  conflicts: BranchConflict[];
  strategy: ConflictResolutionStrategy;
}

// ============================================================================
// Error Classes (T012)
// ============================================================================

/**
 * Error thrown when repository validation fails
 */
export class RepositoryValidationError extends Error {
  public readonly repositoryName: string;
  public readonly repositoryPath?: string;

  constructor(message: string, repositoryName: string, repositoryPath?: string) {
    super(message);
    this.repositoryName = repositoryName;
    this.repositoryPath = repositoryPath;
    this.name = "RepositoryValidationError";
  }
}

/**
 * Error thrown when git operation fails
 */
export class GitOperationError extends Error {
  public readonly operation: string;
  public readonly repository: Repository;
  public readonly originalError: Error;

  constructor(options: GitOperationErrorOptions) {
    super(options.message);
    this.operation = options.operation;
    this.repository = options.repository;
    this.originalError = options.originalError;
    this.name = "GitOperationError";
  }
}

/**
 * Error thrown when hook execution fails
 */
export class HookExecutionError extends Error {
  public readonly hookType: HookType;
  public readonly repository: Repository;
  public readonly exitCode: number;
  public readonly stderr: string;

  constructor(options: HookExecutionErrorOptions) {
    super(options.message);
    this.hookType = options.hookType;
    this.repository = options.repository;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
    this.name = "HookExecutionError";
  }
}

/**
 * Error thrown when user aborts due to conflicts
 */
export class ConflictAbortedError extends Error {
  public readonly conflicts: BranchConflict[];

  constructor(message: string, conflicts: BranchConflict[]) {
    super(message);
    this.conflicts = conflicts;
    this.name = "ConflictAbortedError";
  }
}

/**
 * Error thrown when user cancels an interactive prompt
 */
export class UserAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAbortedError";
  }
}

/**
 * Error thrown when branch name is invalid
 */
export class InvalidBranchNameError extends Error {
  public readonly branchName: string;
  public readonly reason: string;

  constructor(message: string, branchName: string, reason: string) {
    super(message);
    this.branchName = branchName;
    this.reason = reason;
    this.name = "InvalidBranchNameError";
  }
}

/**
 * Error thrown when insufficient permissions
 */
export class InsufficientPermissionsError extends Error {
  public readonly path: string;
  public readonly operation: string;

  constructor(message: string, path: string, operation: string) {
    super(message);
    this.path = path;
    this.operation = operation;
    this.name = "InsufficientPermissionsError";
  }
}

interface HookExecutionRunResult {
  outcome: HookOutcomeRecord | null;
  error: HookExecutionError | null;
}

type PreparedCreateHook = { kind: "absent" | "omitted" } | PreparedLifecycleHookEntry;

type PreparedCreateHooks = ReadonlyMap<string, PreparedCreateHook>;

class ConfiguredHookPreflightError extends Error {
  readonly outcome: HookOutcomeRecord;

  constructor(outcome: HookOutcomeRecord) {
    super(outcome.message);
    this.name = "ConfiguredHookPreflightError";
    this.outcome = outcome;
  }
}

const toHookOutcomeRecord = (
  options: {
    executionPath: string;
    hookName: string;
    repositoryId: string;
    scope: HookScope;
    sourceKind: "file" | "inline-config";
    sourceOwnerKind: "repository" | "user-global" | "workspace";
    sourceOwnerName: string | null;
    sourceScriptPath: string | null;
    targetRepositoryName?: string;
    targetRepositoryPath?: string;
    targetWorktreePath?: string;
  },
  mapping: HookOutcomeMapping,
): HookOutcomeRecord => ({
  durationMs: mapping.durationMs,
  executionPath: options.executionPath,
  hookName: options.hookName,
  hookStatus: mapping.hookStatus,
  message: mapping.message,
  reasonCode: mapping.reasonCode,
  repositoryId: options.repositoryId,
  scope: options.scope,
  sourceKind: options.sourceKind,
  sourceOwnerKind: options.sourceOwnerKind,
  sourceOwnerName: options.sourceOwnerName,
  sourceScriptPath: options.sourceScriptPath,
  targetRepositoryName: options.targetRepositoryName ?? null,
  targetRepositoryPath: options.targetRepositoryPath ?? null,
  targetWorktreePath: options.targetWorktreePath ?? null,
  workspaceMode: "configured",
});

const runHookIfPresent = async (options: {
  hookName: string;
  hookType: HookType;
  hookRootPath: string;
  repoContextPath: string;
  operationData: Record<string, string>;
  timeout: number;
  repository: Repository;
  repositoryId: string;
  scope: HookScope;
  targetRepositoryName?: string;
  targetRepositoryPath?: string;
  targetWorktreePath?: string;
  parentRepoPath?: string;
  quiet?: boolean;
  hookInputMode: HookInputMode;
  spinnerInstance?: ReturnType<typeof spinner> | null;
  preparedHook?: PreparedCreateHook;
}): Promise<HookExecutionRunResult> => {
  const preparedHook = options.preparedHook ?? { kind: "absent" as const };
  if (preparedHook.kind === "omitted") {
    return { error: NULL_HOOK_ERROR, outcome: null };
  }
  const hookPath = preparedHook.kind === "file" ? preparedHook.scriptPath : null;
  const plannedSource = "plan" in preparedHook ? preparedHook.plan : null;
  const outcomeContext = {
    executionPath: options.repoContextPath,
    hookName: options.hookName,
    repositoryId: options.repositoryId,
    scope: options.scope,
    sourceKind: plannedSource?.sourceKind ?? "file",
    sourceOwnerKind:
      plannedSource?.sourceOwnerKind === "global"
        ? ("user-global" as const)
        : (plannedSource?.sourceOwnerKind ??
          (options.scope === "repository" ? "repository" : "workspace")),
    sourceOwnerName:
      plannedSource === null
        ? options.scope === "repository"
          ? (options.targetRepositoryName ?? null)
          : null
        : plannedSource.sourceOwnerName,
    sourceScriptPath: hookPath,
    targetRepositoryName: options.targetRepositoryName,
    targetRepositoryPath: options.targetRepositoryPath,
    targetWorktreePath: options.targetWorktreePath,
  };
  if (preparedHook.kind === "inline-config") {
    const { result } = await executeInlineHook({
      context: {
        hookName: options.hookName,
        hookScope: options.scope,
        mainRepoPath: options.operationData.MAIN_REPO_PATH,
        operationData: options.operationData,
        parentRepoPath: options.parentRepoPath,
        repoPath: options.repoContextPath,
        targetRepoName: options.targetRepositoryName,
        targetRepoPath: options.targetRepositoryPath,
        targetWorktreePath: options.targetWorktreePath,
        workspaceMode: "configured",
      },
      hookInputMode: options.hookInputMode,
      hookName: options.hookName,
      outputSpinner: options.quiet ? null : options.spinnerInstance,
      quiet: options.quiet,
      resolution: preparedHook.resolution,
      snippet: preparedHook.snippet,
      source: {
        sourceKind: "inline-config",
        sourceOwnerKind:
          preparedHook.plan.sourceOwnerKind === "repository" ? "repository" : "workspace",
        sourceOwnerName: preparedHook.plan.sourceOwnerName,
        sourceScriptPath: null,
      },
      timeout: options.timeout,
    });
    const mapping = mapHookExecutionResult(result);
    return {
      error:
        mapping.hookStatus === "failure"
          ? new HookExecutionError({
              exitCode: result.exitCode,
              hookType: options.hookType,
              message: `Hook execution failed for ${options.hookName}`,
              repository: options.repository,
              stderr: result.stderr,
            })
          : NULL_HOOK_ERROR,
      outcome: toHookOutcomeRecord(outcomeContext, {
        ...mapping,
        message:
          mapping.hookStatus === "failure" && result.stderr.trim().length > ZERO
            ? result.stderr.trim()
            : mapping.message,
      }),
    };
  }
  if (!hookPath) {
    return {
      error: NULL_HOOK_ERROR,
      outcome: toHookOutcomeRecord(
        outcomeContext,
        mapHookSkippedOutcome("not_found", "Hook script not found"),
      ),
    };
  }

  const result = await executeHook({
    context: {
      hookName: options.hookName,
      hookScope: options.scope,
      mainRepoPath: options.operationData.MAIN_REPO_PATH,
      operationData: options.operationData,
      parentRepoPath: options.parentRepoPath,
      repoPath: options.repoContextPath,
      sourceScriptPath: hookPath,
      targetRepoName: options.targetRepositoryName,
      targetRepoPath: options.targetRepositoryPath,
      targetWorktreePath: options.targetWorktreePath,
      workspaceMode: "configured",
    },
    hookInputMode: options.hookInputMode,
    hookName: options.hookName,
    outputSpinner: options.quiet ? null : options.spinnerInstance,
    quiet: options.quiet,
    scriptPath: hookPath,
    timeout: options.timeout,
  });

  const mapping = mapHookExecutionResult(result);
  if (mapping.hookStatus === "failure") {
    return {
      error: new HookExecutionError({
        exitCode: result.exitCode,
        hookType: options.hookType,
        message: `Hook execution failed for ${options.hookName}`,
        repository: options.repository,
        stderr: result.stderr,
      }),
      outcome: toHookOutcomeRecord(outcomeContext, {
        ...mapping,
        message: result.stderr.trim().length > ZERO ? result.stderr.trim() : mapping.message,
      }),
    };
  }

  return {
    error: NULL_HOOK_ERROR,
    outcome: toHookOutcomeRecord(outcomeContext, mapping),
  };
};

const preflightConfiguredCreateHooks = async (
  mainRepoPath: string,
  repositories: Repository[],
  config: ArashiConfig,
  branchName: string,
): Promise<PreparedCreateHooks> => {
  const locations = [
    {
      executionPath: mainRepoPath,
      hookName: GLOBAL_HOOKS.preCreate,
      lifecycle: "pre-create" as const,
      repositoryId: "workspace",
      scope: "workspace" as const,
    },
    ...repositories.flatMap((repository) =>
      (["pre-create", "post-create"] as const).map((lifecycle) => ({
        executionPath: repository.path,
        hookName: getRepoSpecificHookName(lifecycle, repository.name),
        lifecycle,
        repositoryId: repository.name,
        scope: "repository" as const,
        targetRepositoryName: repository.name,
        targetRepositoryPath: repository.path,
      })),
    ),
    {
      executionPath: mainRepoPath,
      hookName: GLOBAL_HOOKS.postCreate,
      lifecycle: "post-create" as const,
      repositoryId: "workspace",
      scope: "workspace" as const,
    },
  ];
  const candidates: LifecycleHookPreparationCandidate[] = [];
  for (const location of locations) {
    for (const scriptPath of await discoverLifecycleHookCandidates(
      location.hookName,
      mainRepoPath,
    )) {
      candidates.push({
        kind: "file",
        source: {
          executionPath: location.executionPath,
          lifecycle: location.lifecycle,
          scope: location.scope,
          sourceKind: "file",
          sourceOwnerKind: location.scope,
          sourceOwnerName:
            "targetRepositoryName" in location ? location.targetRepositoryName : null,
          sourceScriptPath: scriptPath,
        },
      });
    }
    const inline =
      location.scope === "workspace"
        ? config.hooks?.scripts?.[location.lifecycle]
        : config.repos["targetRepositoryName" in location ? location.targetRepositoryName : ""]
            ?.hooks?.[location.lifecycle];
    if (inline) {
      candidates.push({
        interpreters: typeof inline === "string" ? { bash: inline } : inline,
        kind: "inline-config",
        source: {
          configuredField:
            location.scope === "workspace"
              ? `hooks.scripts.${location.lifecycle}`
              : `repos.${location.targetRepositoryName}.hooks.${location.lifecycle}`,
          executionPath: location.executionPath,
          lifecycle: location.lifecycle,
          scope: location.scope,
          sourceKind: "inline-config",
          sourceOwnerKind: location.scope,
          sourceOwnerName:
            "targetRepositoryName" in location ? location.targetRepositoryName : null,
          sourceScriptPath: null,
        },
      });
    }
  }

  const targets = await Promise.all(
    repositories.map(async (repository) => ({
      branchName,
      repositoryName: repository.name,
      repositoryPath: repository.path,
      worktreePath: (await calculateWorktreePath(repository, branchName, config)).path,
    })),
  );
  const preparation = await prepareLifecycleHookSources({
    candidates,
    consumer: "create",
    env: process.env,
    platform: process.platform,
    targets,
    workspaceRoot: mainRepoPath,
  });

  const preflightError = (
    hookName: string,
    source: LifecycleHookPreparationCandidate["source"],
    mapping: HookOutcomeMapping,
  ): ConfiguredHookPreflightError =>
    new ConfiguredHookPreflightError(
      toHookOutcomeRecord(
        {
          executionPath: source.executionPath,
          hookName,
          repositoryId: source.sourceOwnerName ?? "workspace",
          scope: source.scope,
          sourceKind: source.sourceKind,
          sourceOwnerKind:
            source.sourceOwnerKind === "global" ? "user-global" : source.sourceOwnerKind,
          sourceOwnerName: source.sourceOwnerName,
          sourceScriptPath: source.sourceScriptPath,
          targetRepositoryName: source.sourceOwnerName ?? undefined,
          targetRepositoryPath:
            source.sourceOwnerName === null
              ? undefined
              : repositories.find((repository) => repository.name === source.sourceOwnerName)?.path,
        },
        mapping,
      ),
    );

  if (preparation.classification === "ambiguous") {
    const failure = preparation.plan.failure;
    const source = candidates.find(
      (candidate) =>
        candidate.source.lifecycle === failure.hookName &&
        candidate.source.scope === failure.scope &&
        candidate.source.sourceOwnerName === failure.sourceOwnerName,
    )?.source;
    if (!source) throw new Error("Lifecycle planner returned an unknown ambiguous create source");
    if (source.lifecycle !== "pre-create" && source.lifecycle !== "post-create") {
      throw new Error("Create lifecycle planner returned a non-create source");
    }
    const hookName =
      source.sourceOwnerName === null
        ? source.lifecycle
        : getRepoSpecificHookName(source.lifecycle, source.sourceOwnerName);
    throw preflightError(hookName, source, {
      hookStatus: "failure",
      message: `Hook source is ambiguous for ${hookName}: ${failure.sourceKinds.join(" and ")} are both configured${failure.sourceScriptPath ? ` (${failure.sourceScriptPath})` : ""}`,
      reasonCode: "validation_failed",
    });
  }
  if (preparation.classification === "file-invalid") {
    const entry = preparation.plannedEntry;
    throw preflightError(entry.hookName, entry, {
      hookStatus: "failure",
      message: preparation.validation.error ?? "Hook validation failed",
      reasonCode: preparation.validation.reasonCode ?? "validation_failed",
    });
  }
  if (preparation.classification === "interpreter-unavailable") {
    const entry = preparation.plannedEntry;
    throw preflightError(entry.hookName, entry, {
      hookStatus: "failure",
      message: `No configured interpreter is available for ${entry.hookName}`,
      reasonCode: "interpreter_unavailable",
    });
  }

  const inlineLocations = new Set(
    candidates
      .filter((candidate) => candidate.kind === "inline-config")
      .map((candidate) =>
        JSON.stringify([
          candidate.source.lifecycle,
          candidate.source.scope,
          candidate.source.sourceOwnerName,
        ]),
      ),
  );
  const prepared = new Map<string, PreparedCreateHook>(
    locations.map((location) => [
      location.hookName,
      {
        kind: inlineLocations.has(
          JSON.stringify([
            location.lifecycle,
            location.scope,
            "targetRepositoryName" in location ? location.targetRepositoryName : null,
          ]),
        )
          ? "omitted"
          : "absent",
      },
    ]),
  );
  for (const entry of preparation.entries) prepared.set(entry.plan.hookName, entry);
  return prepared;
};

// ============================================================================
// Repository Type Detection (001-nested-worktree-paths)
// ============================================================================

/**
 * Detect repository type based on location and configuration
 * Feature: 001-nested-worktree-paths (T009)
 *
 * @param repo - Repository to classify
 * @param config - Arashi configuration (null if not in meta-repo context)
 * @returns Repository type information with classification reason
 */
export const detectRepositoryType = async (
  repo: Repository,
  config: ArashiConfig | null,
): Promise<RepositoryTypeInfo> => {
  // Check if repository has .arashi/config.json → meta-repo
  const configPath = join(repo.path, ".arashi", "config.json");
  try {
    const configFile = runtime.file(configPath);
    const exists = await configFile.exists();
    if (exists) {
      return {
        reason: "Contains .arashi/config.json",
        type: "meta-repo",
      };
    }
  } catch {
    // File system access error - treat as not meta-repo
  }

  // Check if this is a child repository
  // A child repo must be directly inside a reposDir/ folder, and that reposDir
  // Must be inside a meta-repo (has .arashi/config.json)
  if (config) {
    const reposDir = basename(
      config.reposDir ?? (config as { repos_dir?: string }).repos_dir ?? "./repos",
    );
    const pathParts = repo.path.split(sep);

    // Check if the immediate parent directory is the reposDir
    const parentDir = pathParts.at(pathParts.length - PARENT_PATH_OFFSET);
    if (parentDir === reposDir) {
      // Check if grandparent has .arashi/config.json (is a meta-repo)
      const grandparentPath = join(repo.path, "..", "..");
      const metaConfigPath = join(grandparentPath, ".arashi", "config.json");

      try {
        const metaConfigFile = runtime.file(metaConfigPath);
        const metaExists = await metaConfigFile.exists();

        if (metaExists) {
          const parentName = pathParts.at(pathParts.length - GRANDPARENT_PATH_OFFSET);
          return {
            parentName,
            reason: `Located in ${reposDir}/ folder of parent repository '${parentName}'`,
            reposDir,
            type: "child",
          };
        }
      } catch {
        // Not a child repo - fall through to standalone
      }
    }
  }

  // Default → standalone
  return {
    reason: "Not a meta-repo and not in repos/ folder",
    type: "standalone",
  };
};

/**
 * Calculate nested worktree path for child repositories
 * Feature: 001-nested-worktree-paths (T009)
 *
 * @param repo - Child repository
 * @param parentWorktreeName - Name of parent worktree folder (e.g., 'feature-branch' or 'parent-feature-branch')
 * @param reposDir - Name of repos directory (e.g., "repos")
 * @returns Absolute path to nested worktree
 */
export const calculateChildWorktreePath = (
  repo: Repository,
  parentWorktreeName: string,
  reposDir: string,
): string => join(repo.path, "..", "..", "..", parentWorktreeName, reposDir, repo.name);

const fallbackBareWorktreeNamespace = (repositoryName: string): string => {
  const withoutGitSuffix = repositoryName.replace(/\.git$/i, "");
  return withoutGitSuffix || repositoryName;
};

/**
 * Calculate destination path for a new worktree based on repository type
 * Feature: 001-nested-worktree-paths (T010)
 *
 * @param repo - Repository for which to calculate path
 * @param branchName - Target branch name
 * @param config - Arashi configuration
 * @param knownType - Optional pre-computed repository type (optimization)
 * @returns Worktree path result with metadata
 */
const normalizeCalculateWorktreePathArgs = (
  ...args: CalculateWorktreePathArgs
): CalculateWorktreePathOptions => {
  const [firstArg, branchName, config, knownType] = args;
  if (
    typeof firstArg === "object" &&
    firstArg !== null &&
    "repo" in firstArg &&
    "branchName" in firstArg &&
    "config" in firstArg
  ) {
    return firstArg as CalculateWorktreePathOptions;
  }

  return {
    branchName: branchName as string,
    config: config as ArashiConfig,
    knownType,
    repo: firstArg as Repository,
  };
};

export const calculateWorktreePath = async (
  ...args: CalculateWorktreePathArgs
): Promise<CalculatedWorktreePath> => {
  const { authoritativeParentWorktreePath, branchName, config, knownType, repo } =
    normalizeCalculateWorktreePathArgs(...args);
  // Detect repository type (or use provided type)
  let typeInfo = knownType;
  if (!typeInfo) {
    typeInfo = await detectRepositoryType(repo, config);
  }

  let workspaceRoot = resolve(repo.path);
  if (typeInfo.type === "child") {
    workspaceRoot = join(repo.path, "..", "..");
  }
  const worktreeBasePath = resolveWorktreesBasePath(workspaceRoot, config.worktreesDir);

  // Apply appropriate path calculation strategy
  if (typeInfo.type === "child") {
    // Nested strategy for child repositories
    if (!typeInfo.parentName || !typeInfo.reposDir) {
      throw new Error(`Child repository type missing parentName or reposDir: ${repo.name}`);
    }

    // Determine parent repository path (navigate up from child: ../../../)
    const parentRepoPath = workspaceRoot;

    // Check if parent is bare to determine worktree naming
    const parentIsBare = await isBareRepo(parentRepoPath);

    // Bare parent: Namespace the branch beneath the canonical parent name
    // Non-bare parent: Use the branch name only
    let parentWorktreeName = branchName;
    if (parentIsBare) {
      const parentNamespace = fallbackBareWorktreeNamespace(typeInfo.parentName);
      parentWorktreeName = join(parentNamespace, branchName);
    }

    const parentWorktreePath =
      authoritativeParentWorktreePath ?? join(worktreeBasePath, parentWorktreeName);
    const worktreePath = join(
      parentWorktreePath,
      typeInfo.reposDir,
      repo.worktreeName ?? repo.name,
    );

    return {
      parentWorktreePath,
      path: worktreePath,
      repositoryType: "child",
      strategy: "nested",
    };
  }
  // Sibling strategy for meta-repo and standalone
  // Check if repository is bare to determine naming convention
  const isBare = await isBareRepo(repo.path);

  // Bare repos: Namespace the branch beneath the canonical worktree name
  // Non-bare repos: Use the branch name only (e.g., 'feature-branch/')
  let worktreeName = branchName;
  if (isBare) {
    const repositoryNamespace = repo.worktreeName ?? fallbackBareWorktreeNamespace(repo.name);
    worktreeName = join(repositoryNamespace, branchName);
  }
  const worktreePath = join(worktreeBasePath, worktreeName);

  return {
    path: worktreePath,
    repositoryType: typeInfo.type,
    strategy: "sibling",
  };
};

export const calculateWorktreePathPlan = async (
  repositories: Repository[],
  branchName: string,
  config: ArashiConfig,
): Promise<ReadonlyMap<Repository, CalculatedWorktreePath>> => {
  const plan = new Map<Repository, CalculatedWorktreePath>();
  let authoritativeParentWorktreePath: string | undefined;
  for (const repo of repositories) {
    const calculated = await calculateWorktreePath({
      authoritativeParentWorktreePath,
      branchName,
      config,
      repo,
    });
    plan.set(repo, calculated);
    if (
      calculated.repositoryType === "meta-repo" &&
      authoritativeParentWorktreePath === undefined
    ) {
      authoritativeParentWorktreePath = calculated.path;
    }
  }
  return plan;
};

// ============================================================================
// Worktree Entry Utilities (Remove workflow)
// ============================================================================

const resolveParentPathForChild = (
  worktreePath: string,
  reposDirName: string,
  repoName: string,
): string | null => {
  const normalized = resolve(worktreePath);
  const parsed = parse(normalized);
  const parts = normalized
    .slice(parsed.root.length)
    .split(sep)
    .filter((part) => part.length > ZERO);

  for (let partIndex = ZERO; partIndex < parts.length - ONE; partIndex += ONE) {
    if (parts[partIndex] === reposDirName && parts[partIndex + ONE] === repoName) {
      const parentParts = parts.slice(ZERO, partIndex);
      return join(parsed.root, ...parentParts);
    }
  }

  return NULL_PATH;
};

export const attachWorktreeRelationships = (
  entries: WorktreeEntry[],
  options: {
    reposDirName: string;
    childRepoNames: Set<string>;
  },
): void => {
  const normalizedMap = new Map<string, WorktreeEntry>();

  for (const entry of entries) {
    entry.parentPath = NULL_PATH;
    entry.childrenPaths = [];
    normalizedMap.set(resolve(entry.path), entry);
  }

  for (const entry of entries) {
    if (options.childRepoNames.has(entry.repository)) {
      const parentPath = resolveParentPathForChild(
        entry.path,
        options.reposDirName,
        entry.repository,
      );
      entry.parentPath = parentPath;
    }
  }

  for (const entry of entries) {
    if (entry.parentPath) {
      const parent = normalizedMap.get(resolve(entry.parentPath));
      if (parent) {
        parent.childrenPaths.push(entry.path);
      }
    }
  }
};

export const getWorktreeDirtyStatus = async (worktreePath: string): Promise<DirtyStatus> => {
  try {
    const result = await exec(["status", "--porcelain"], worktreePath);
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((line: string) => line.length > ZERO);
    let modifiedFiles = ZERO;
    let untrackedFiles = ZERO;
    let stagedFiles = ZERO;

    for (const line of lines) {
      if (line.startsWith("??")) {
        untrackedFiles += ONE;
      } else {
        const indexStatus = line[ZERO];
        const worktreeStatus = line[ONE];

        if (indexStatus !== " " && indexStatus !== "?") {
          stagedFiles += ONE;
        }

        if (worktreeStatus !== " " && worktreeStatus !== "?") {
          modifiedFiles += ONE;
        }
      }
    }

    return {
      isDirty: lines.length > ZERO,
      modifiedFiles,
      stagedFiles,
      untrackedFiles,
    };
  } catch {
    return {
      isDirty: true,
      modifiedFiles: ZERO,
      stagedFiles: ZERO,
      untrackedFiles: ZERO,
    };
  }
};

export const resolveWorktreeStatuses = async (
  entries: WorktreeEntry[],
  includeDirtyDetails: boolean,
): Promise<void> => {
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.pruneReason) {
        entry.status = "prunable";
        entry.isDirty = false;
        entry.dirtyDetails = undefined;
        return;
      }

      if (!existsSync(entry.path)) {
        entry.status = "prunable";
        entry.isDirty = false;
        entry.dirtyDetails = undefined;
        return;
      }

      if (!includeDirtyDetails) {
        entry.status = "present";
        entry.isDirty = undefined;
        entry.dirtyDetails = undefined;
        return;
      }

      const status = await getWorktreeDirtyStatus(entry.path);
      entry.isDirty = status.isDirty;
      entry.dirtyDetails = status;
      if (status.isDirty) {
        entry.status = "dirty";
      } else {
        entry.status = "present";
      }
    }),
  );
};

export const buildWorktreeEntries = async (
  worktrees: WorktreeInfo[],
  options: {
    reposDirName: string;
    childRepoNames: Set<string>;
    includeDirtyDetails: boolean;
  },
): Promise<WorktreeEntry[]> => {
  const entries: WorktreeEntry[] = worktrees.map((worktree) => ({
    ...worktree,
    childrenPaths: [],
    parentPath: NULL_PATH,
    status: worktree.pruneReason ? "prunable" : "present",
  }));

  attachWorktreeRelationships(entries, {
    childRepoNames: options.childRepoNames,
    reposDirName: options.reposDirName,
  });
  await resolveWorktreeStatuses(entries, options.includeDirtyDetails);

  return entries;
};

// ============================================================================
// Helper Functions (T013)
// ============================================================================

/**
 * Validate branch name format according to git naming rules
 *
 * Git branch name rules:
 * - No spaces
 * - No special characters like ~, ^, :, ?, *, [
 * - Cannot start with - or /
 * - Cannot end with .lock
 * - Cannot contain .. or @{
 * - Cannot end with /
 *
 * @param branchName - Branch name to validate
 * @returns true if valid, false otherwise
 */
export const isValidBranchName = (branchName: string): boolean => {
  return isValidGitBranchNameLiteral(branchName);
};

// ============================================================================
// Main Orchestration Functions (T018-T024)
// ============================================================================

const buildDryRunOutcome = async ({
  branchName,
  conflictCheck,
  options,
  repositories,
  targetActionByRepositoryPath,
  worktreePathPlan,
}: BuildDryRunOutcomeOptions): Promise<DryRunOutcome> => {
  const plannedWorktrees: PlannedWorktree[] = [];
  const conflicts: DryRunConflict[] = [];
  const conflictByRepo = new Map<string, BranchConflict>();

  for (const conflict of conflictCheck.conflicts) {
    conflictByRepo.set(conflict.repository.name, conflict);
  }

  for (const repo of repositories) {
    let worktreePath: string | null = NULL_PATH;
    let planStatus: DryRunPlanStatus = "actionable";

    try {
      const pathResult = worktreePathPlan.get(repo);
      if (!pathResult) throw new Error(`Repository '${repo.name}' is missing a planned path`);
      worktreePath = pathResult.path;

      const repositoryPath = await realpath(repo.path);
      const reusableExistingPath =
        targetActionByRepositoryPath.get(repositoryPath) === "reused" &&
        options.reusableWorktreePaths?.has(resolve(worktreePath)) === true;
      if (existsSync(worktreePath) && !reusableExistingPath) {
        conflicts.push({
          blocking: true,
          conflictType: "path_exists",
          message: `Worktree path already exists: ${worktreePath}`,
          repository: repo,
          repositoryName: repo.name,
          scope: `${repo.name}:${worktreePath}`,
        });
        planStatus = "blocked";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      conflicts.push({
        blocking: true,
        conflictType: "invalid_configuration",
        message: `Unable to calculate worktree path: ${message}`,
        repository: repo,
        repositoryName: repo.name,
        scope: repo.name,
      });
      planStatus = "blocked";
    }

    const branchConflict = conflictByRepo.get(repo.name);
    if (branchConflict) {
      const location = describeConflictLocation(
        branchConflict.existsLocally,
        branchConflict.existsRemotely,
      );
      const blocking = options.conflictResolution !== "REUSE_EXISTING";
      conflicts.push({
        blocking,
        conflictType: "branch_exists",
        message: `Branch '${branchConflict.branchName}' already exists ${location}`,
        repository: repo,
        repositoryName: repo.name,
        scope: `${repo.name}:${branchConflict.branchName}`,
      });
      if (blocking) {
        planStatus = "blocked";
      }
    }

    plannedWorktrees.push({
      branchName,
      planStatus,
      repository: repo,
      repositoryName: repo.name,
      worktreePath,
    });
  }

  const blockingTotal = conflicts.filter((conflict) => conflict.blocking).length;
  let overallStatus: DryRunPlanStatus = "actionable";
  if (blockingTotal > ZERO) {
    overallStatus = "blocked";
  }

  return {
    conflicts,
    materializationPlans: options.materializationPlans ?? [],
    overallStatus,
    plannedWorktrees,
    targetActionByRepositoryPath,
    summaryCounts: {
      blockingTotal,
      conflictTotal: conflicts.length,
      plannedTotal: plannedWorktrees.length,
    },
  };
};

const collectHookOutcomes = (
  workspacePre: HookOutcomeRecord[],
  results: RepositoryResult[],
  workspacePost: HookOutcomeRecord[],
): HookOutcomeRecord[] => [
  ...workspacePre,
  ...results.flatMap((result) => result.hookOutcomes),
  ...workspacePost,
];

const buildHookRecoveryGuidance = (hookOutcomes: HookOutcomeRecord[]): string[] => {
  const guidance = new Set<string>();

  for (const outcome of hookOutcomes) {
    if (outcome.hookStatus === "failure") {
      if (outcome.reasonCode === "timeout") {
        guidance.add(
          `Hook timed out for ${outcome.repositoryId} (${outcome.hookName}); increase hook timeout or optimize the script, then rerun create.`,
        );
      } else {
        guidance.add(
          `Inspect hook output for ${outcome.repositoryId} (${outcome.hookName}) and rerun create after fixing the script.`,
        );
      }
    }
  }

  return [...guidance];
};

const planTargetActions = async (
  repositories: Repository[],
  conflicts: BranchConflict[],
  strategy: ConflictResolutionStrategy,
): Promise<ReadonlyMap<string, TargetAction>> =>
  new Map(
    await Promise.all(
      repositories.map(
        async (repository) =>
          [
            await realpath(repository.path),
            shouldReuseBranch({ conflicts, repo: repository, strategy }) ? "reused" : "created",
          ] as const,
      ),
    ),
  );

/**
 * Create coordinated worktrees across multiple repositories (T018)
 *
 * This is the main entry point for worktree orchestration. It coordinates
 * repository filtering, conflict detection, worktree creation, hook execution,
 * and automatic rollback on failure.
 *
 * @param branchName - Branch name to create across repositories
 * @param repositories - List of repositories to process
 * @param options - Operation options
 * @returns Promise resolving to operation summary
 * @throws RepositoryValidationError if repositories don't exist or aren't valid
 * @throws InvalidBranchNameError if branch name is invalid
 * @throws GitOperationError if git operations fail (triggers rollback)
 */
export const createCoordinatedWorktrees = async (
  branchName: string,
  repositories: Repository[],
  options: WorktreeOperationOptions = {},
): Promise<OperationSummary> => {
  const startTime = Date.now();
  const operationLog = new OperationLog();
  const results: RepositoryResult[] = [];
  const workspacePreHookOutcomes: HookOutcomeRecord[] = [];
  const workspacePostHookOutcomes: HookOutcomeRecord[] = [];
  const preflightHookOutcomes: HookOutcomeRecord[] = [];
  let preparedHooks: PreparedCreateHooks = new Map();
  const mainRepoPath = resolve(options.workspaceRoot ?? ".");
  let targetActionByRepositoryPath: ReadonlyMap<string, TargetAction> = options.createBasePlan
    ? new Map(
        options.createBasePlan.repositories.map(
          (resolution) => [resolution.repositoryPath, "created"] as const,
        ),
      )
    : new Map();

  // Set default options
  const opts: NormalizedWorktreeOptions = {
    conflictResolution: options.conflictResolution ?? NULL_CONFLICT_STRATEGY,
    dryRun: options.dryRun ?? false,
    executeHooks: options.executeHooks ?? true,
    hookTimeout: options.hookTimeout ?? DEFAULT_LIFECYCLE_HOOK_TIMEOUT,
    hookInputMode: options.hookInputMode ?? "unavailable",
    quietHooks: options.quietHooks ?? false,
    interactive: options.interactive ?? false,
    materializationPlans: options.materializationPlans ?? [],
    reusableWorktreePaths: options.reusableWorktreePaths ?? new Set(),
    showProgress: options.showProgress ?? true,
  };

  try {
    // 1. Validate branch name (T018)
    if (!isValidBranchName(branchName)) {
      throw new InvalidBranchNameError(
        `Invalid branch name: ${branchName}`,
        branchName,
        "Branch name contains invalid characters or format",
      );
    }

    // 2. Validate we have repositories
    if (!repositories || repositories.length === ZERO) {
      throw new RepositoryValidationError("No repositories provided for worktree creation", "");
    }

    targetActionByRepositoryPath = await planTargetActions(repositories, [], "ABORT");

    // 3. T039: Pre-flight conflict check and plan every selected repository's action.
    // Keep this ahead of hook preflight so every later failure summary has the complete ledger.
    const conflictCheck = await checkBranchConflicts(branchName, repositories);
    let resolvedStrategy: ConflictResolutionStrategy | null = NULL_CONFLICT_STRATEGY;
    let conflictsToHandle: BranchConflict[] = [];

    if (opts.dryRun) {
      targetActionByRepositoryPath = await planTargetActions(
        repositories,
        conflictCheck.conflicts,
        opts.conflictResolution ?? "ABORT",
      );
    } else if (conflictCheck.hasConflicts) {
      // Attempt to resolve conflicts
      resolvedStrategy = await resolveConflicts(conflictCheck.conflicts, options);
      conflictsToHandle = conflictCheck.conflicts;
      targetActionByRepositoryPath = await planTargetActions(
        repositories,
        conflictsToHandle,
        resolvedStrategy,
      );
    }

    // 4. Load canonical workspace configuration after the target-action plan is complete.
    const config = await loadResolvedConfig(mainRepoPath, options.resolvedConfig);
    const worktreePathPlan =
      options.worktreePathPlan ??
      (await calculateWorktreePathPlan(repositories, branchName, config));

    if (!opts.dryRun) {
      for (const [repository, plannedPath] of worktreePathPlan) {
        const repositoryPath = await realpath(repository.path);
        const reusableExistingPath =
          targetActionByRepositoryPath.get(repositoryPath) === "reused" &&
          options.reusableWorktreePaths?.has(resolve(plannedPath.path)) === true;
        if (existsSync(plannedPath.path) && !reusableExistingPath) {
          throw new Error(`Worktree path already exists: ${plannedPath.path} (${repository.name})`);
        }
      }
    }

    if (opts.executeHooks && !opts.dryRun) {
      preparedHooks = await preflightConfiguredCreateHooks(
        mainRepoPath,
        repositories,
        config,
        branchName,
      );
    }

    if (opts.dryRun) {
      const dryRunOutcome = await buildDryRunOutcome({
        branchName,
        conflictCheck,
        options: opts,
        repositories,
        targetActionByRepositoryPath,
        worktreePathPlan,
      });

      let errorSummary: string | null = NULL_SUMMARY;
      if (dryRunOutcome.overallStatus === "blocked") {
        errorSummary = "Blocking conflicts detected during dry-run";
      }

      return {
        dryRunOutcome,
        errorSummary,
        failureCount: ZERO,
        hookOutcomes: [],
        isDryRun: true,
        nextSteps: [],
        repositoryResults: [],
        targetActionByRepositoryPath,
        rolledBack: false,
        skippedCount: repositories.length,
        successCount: ZERO,
        totalDuration: Date.now() - startTime,
        totalRepositories: repositories.length,
      };
    }

    // 5. Execute global pre-create hook (once)
    if (opts.executeHooks) {
      const preHookResult = await runHookIfPresent({
        hookName: GLOBAL_HOOKS.preCreate,
        hookRootPath: mainRepoPath,
        hookType: "pre-create",
        preparedHook: preparedHooks.get(GLOBAL_HOOKS.preCreate),
        operationData: buildHookOperationData({
          branchName,
          mainRepoPath,
        }),
        repoContextPath: mainRepoPath,
        repository: repositories[ZERO],
        repositoryId: "workspace",
        scope: "workspace",
        hookInputMode: opts.hookInputMode,
        quiet: opts.quietHooks,
        timeout: opts.hookTimeout,
      });
      if (preHookResult.outcome) workspacePreHookOutcomes.push(preHookResult.outcome);

      if (preHookResult.error) {
        throw preHookResult.error;
      }
    }

    // 6. Process each repository sequentially (T019-T023, T041)
    for (const repo of repositories) {
      const targetAction = targetActionByRepositoryPath.get(await realpath(repo.path));
      if (!targetAction) {
        throw new Error(`Repository '${repo.name}' is missing a planned target action`);
      }
      const plannedPath = worktreePathPlan.get(repo);
      if (!plannedPath) {
        throw new Error(`Repository '${repo.name}' is missing a planned path`);
      }
      const repoResult = await processRepository({
        branchName,
        config,
        createBasePlan: options.createBasePlan,
        mainRepoPath,
        operationLog,
        options: opts,
        plannedPath,
        preparedHooks,
        repo,
        reuseExistingWorktree:
          targetAction === "reused" &&
          options.reusableWorktreePaths?.has(resolve(plannedPath.path)) === true,
        targetAction,
      });
      results.push(repoResult);

      // If repository processing failed, trigger rollback
      if (repoResult.status === "failed") {
        throw repoResult.error ?? new Error(`Repository processing failed for ${repo.name}`);
      }
    }

    // 7. Execute global post-create hook (once)
    if (opts.executeHooks) {
      const postHookResult = await runHookIfPresent({
        hookName: GLOBAL_HOOKS.postCreate,
        hookRootPath: mainRepoPath,
        hookType: "post-create",
        preparedHook: preparedHooks.get(GLOBAL_HOOKS.postCreate),
        operationData: buildHookOperationData({
          branchName,
          mainRepoPath,
        }),
        repoContextPath: mainRepoPath,
        repository: repositories[ZERO],
        repositoryId: "workspace",
        scope: "workspace",
        hookInputMode: opts.hookInputMode,
        quiet: opts.quietHooks,
        timeout: opts.hookTimeout,
      });
      if (postHookResult.outcome) workspacePostHookOutcomes.push(postHookResult.outcome);

      if (postHookResult.error) {
        throw postHookResult.error;
      }
    }

    const hookOutcomes = [
      ...preflightHookOutcomes,
      ...collectHookOutcomes(workspacePreHookOutcomes, results, workspacePostHookOutcomes),
    ];

    // 8. Build successful operation summary (T024)
    return {
      errorSummary: NULL_SUMMARY,
      failureCount: ZERO,
      hookOutcomes,
      nextSteps: buildHookRecoveryGuidance(hookOutcomes),
      repositoryResults: results,
      targetActionByRepositoryPath,
      rolledBack: false,
      skippedCount: ZERO,
      successCount: results.filter((repositoryResult) => repositoryResult.status === "success")
        .length,
      totalDuration: Date.now() - startTime,
      totalRepositories: repositories.length,
    };
  } catch (error) {
    if (error instanceof ConfiguredHookPreflightError) {
      preflightHookOutcomes.push(error.outcome);
    }
    // Remove invocation-owned materialized objects before Git removes worktrees.
    for (const result of results.toReversed()) {
      const ledger = result.materializationOwnershipLedger ?? [];
      if (ledger.length === ZERO) continue;
      const firstOutcome = result.materializationOutcomes?.[ZERO];
      result.materializationRollback = await rollbackMaterializationOwnership(
        result.repository.name,
        firstOutcome?.action ?? "copy",
        firstOutcome?.path ?? "materialization",
        ledger,
      );
    }

    // Automatic whole-worktree rollback on any error (T023)
    const rollbackResult = await operationLog.rollback();
    const residualWorktrees = results
      .filter(
        (result) =>
          result.targetAction !== "reused" &&
          result.worktreePath &&
          existsSync(result.worktreePath),
      )
      .map((result) => `${result.repository.name}:${result.worktreePath}`);

    let rollbackNote = "";
    if (rollbackResult.failureCount > ZERO) {
      rollbackNote = ` Rollback encountered ${rollbackResult.failureCount} cleanup failures.`;
    }
    if (residualWorktrees.length > ZERO) {
      rollbackNote += ` Residual worktrees detected: ${residualWorktrees.join(", ")}.`;
    }

    const hookOutcomes = [
      ...preflightHookOutcomes,
      ...collectHookOutcomes(workspacePreHookOutcomes, results, workspacePostHookOutcomes),
    ];
    let errorMessage = String(error);
    if (error instanceof Error) {
      errorMessage = error.message;
    }

    const materializationFailures = results.flatMap(
      (result) => result.materializationRollback?.failures ?? [],
    );
    const materializationAttempted = results.some(
      (result) => (result.materializationOutcomes?.length ?? ZERO) > ZERO,
    );
    if (materializationAttempted) {
      for (const result of results) {
        const worktreeRemoved = !result.worktreePath || !existsSync(result.worktreePath);
        for (const outcome of result.materializationOutcomes ?? []) {
          if (worktreeRemoved && (outcome.status === "copied" || outcome.status === "linked")) {
            outcome.status = "rolled-back";
            outcome.reasonCode = "rolled_back";
            outcome.message = `Rolled back '${outcome.path}'`;
          }
        }
      }
    }

    return {
      errorSummary: `${errorMessage}${rollbackNote}`,
      failureCount: ONE,
      ...(materializationAttempted
        ? {
            materializationRollback: {
              attempted: true,
              complete: materializationFailures.length === ZERO,
              failureCount: materializationFailures.length,
              failures: materializationFailures,
            },
          }
        : {}),
      hookOutcomes,
      nextSteps: buildHookRecoveryGuidance(hookOutcomes),
      repositoryResults: results,
      targetActionByRepositoryPath,
      rolledBack: true,
      skippedCount: ZERO,
      successCount: ZERO,
      totalDuration: Date.now() - startTime,
      totalRepositories: repositories.length,
    };
  }
};

const refExists = async (repoPath: string, ref: string): Promise<boolean> => {
  try {
    await exec(["show-ref", "--verify", ref], repoPath);
    return true;
  } catch {
    return false;
  }
};

const resolveBranchStartPoint = async (
  repoPath: string,
  defaultBranch: string,
): Promise<string> => {
  const normalizedBranch = defaultBranch.replace(/^origin\//, "");
  const candidates = [`refs/heads/${normalizedBranch}`, `refs/remotes/origin/${normalizedBranch}`];

  for (const candidate of candidates) {
    if (await refExists(repoPath, candidate)) {
      return candidate;
    }
  }

  const localRefs = await exec(["for-each-ref", "--format=%(refname)", "refs/heads"], repoPath);
  const firstLocalRef = localRefs.stdout
    .split("\n")
    .map((value: string) => value.trim())
    .find((value: string) => value.length > ZERO);

  if (firstLocalRef) {
    return firstLocalRef;
  }

  return defaultBranch;
};

/**
 * Process a single repository - create branch and worktree (T019)
 *
 * This function handles the entire lifecycle for one repository:
 * 1. Check if branch should be reused (if REUSE_EXISTING strategy)
 * 2. Create branch from default branch (skip if reusing)
 * 3. Log branch creation
 * 4. Create worktree for the branch
 * 5. Log worktree creation
 *
 * @param repo - Repository to process
 * @param branchName - Branch name to create
 * @param operationLog - Operation log for rollback tracking
 * @param options - Operation options
 * @param config - Arashi configuration for path calculation
 * @param conflicts - Detected conflicts (for reuse logic)
 * @param strategy - Resolved conflict strategy
 * @returns RepositoryResult with status and details
 */
const processRepository = async ({
  branchName,
  config,
  createBasePlan,
  mainRepoPath,
  operationLog,
  options,
  plannedPath,
  preparedHooks,
  repo,
  reuseExistingWorktree,
  targetAction,
}: ProcessRepositoryOptions): Promise<RepositoryResult> => {
  const startTime = Date.now();
  const hookOutcomes: HookOutcomeRecord[] = [];
  let materializationOutcomes: ExecutedMaterializationOutcome[] = [];
  let materializationOwnershipLedger: MaterializationOwnershipEntry[] = [];
  let materializationRollback: MaterializationResult["materializationRollback"] | undefined;
  let worktreePath: string | null = NULL_PATH;
  const shouldReuse = targetAction === "reused";

  // Create spinner if progress is enabled
  let spinnerInstance = null;
  if (options.showProgress) {
    spinnerInstance = spinner(`Processing ${repo.name}...`);
  }

  if (spinnerInstance) {
    spinnerInstance.start();
  }

  try {
    // T041: Check if we should reuse existing branch
    const baseResolution = createBasePlan
      ? createBasePlan.byCanonicalPath.get(await realpath(repo.path))
      : undefined;
    if (shouldReuse) {
      if (spinnerInstance) {
        spinnerInstance.text = `Reusing existing branch '${branchName}' in ${repo.name}...`;
      }
    } else {
      // T020: Create branch from default branch
      if (spinnerInstance) {
        spinnerInstance.text = `Creating branch '${branchName}' in ${repo.name}...`;
      }

      try {
        const startPoint =
          baseResolution?.resolvedOid ??
          (await resolveBranchStartPoint(repo.path, repo.defaultBranch));
        await exec(["branch", branchName, startPoint], repo.path);
      } catch (error) {
        if (spinnerInstance) {
          spinnerInstance.fail(`Failed to create branch '${branchName}' in ${repo.name}`);
        }
        throw new GitOperationError({
          message: `Failed to create branch '${branchName}' in ${repo.name}`,
          operation: "branch_create",
          originalError: error as Error,
          repository: repo,
        });
      }

      // T022: Log branch creation for rollback
      operationLog.add({
        data: {
          branchName,
          repositoryPath: repo.path,
        },
        timestamp: Date.now(),
        type: "branch_created",
      });
    }

    // T021: Create a worktree unless command preflight proved this exact registration reusable.
    if (spinnerInstance) {
      spinnerInstance.text = reuseExistingWorktree
        ? `Reusing existing worktree for ${repo.name}...`
        : `Creating worktree for ${repo.name}...`;
    }

    const pathResult = plannedPath;
    worktreePath = pathResult.path;
    if (!reuseExistingWorktree) {
      try {
        await exec(["worktree", "add", worktreePath, branchName], repo.path);
      } catch (error) {
        if (spinnerInstance) {
          spinnerInstance.fail(`Failed to create worktree in ${repo.name}`);
        }
        throw new GitOperationError({
          message: `Failed to create worktree in ${repo.name}`,
          operation: "worktree_create",
          originalError: error as Error,
          repository: repo,
        });
      }

      // T022: Log worktree creation for rollback
      operationLog.add({
        data: {
          branchName,
          repositoryPath: repo.path,
          worktreePath,
        },
        timestamp: Date.now(),
        type: "worktree_created",
      });
    }

    const parentRepoPath = pathResult.parentWorktreePath ?? mainRepoPath;
    const repoOperationData = buildHookOperationData({
      branchName,
      mainRepoPath,
      parentRepoPath,
      repoName: repo.name,
      worktreePath,
    });
    repoOperationData.REPO_PATH = worktreePath;

    // Execute repository pre-create before declarative materialization.
    if (options.executeHooks) {
      if (spinnerInstance) {
        spinnerInstance.text = `Running repo-specific pre-create hook for ${repo.name}...`;
      }

      const preHookResult = await runHookIfPresent({
        hookName: getRepoSpecificHookName("pre-create", repo.name),
        hookRootPath: mainRepoPath,
        hookType: "pre-create",
        preparedHook: preparedHooks.get(getRepoSpecificHookName("pre-create", repo.name)),
        operationData: repoOperationData,
        repoContextPath: worktreePath,
        repository: repo,
        repositoryId: repo.name,
        scope: "repository",
        targetRepositoryName: repo.name,
        targetRepositoryPath: repo.path,
        targetWorktreePath: worktreePath,
        parentRepoPath,
        hookInputMode: options.hookInputMode,
        quiet: options.quietHooks,
        spinnerInstance,
        timeout: options.hookTimeout,
      });
      if (
        preHookResult.outcome &&
        (config.repos[repo.name] || preHookResult.outcome.reasonCode !== "not_found")
      ) {
        hookOutcomes.push(preHookResult.outcome);
      }
      if (preHookResult.error) {
        throw preHookResult.error;
      }
    }

    const materializationPolicy = config.repos[repo.name];
    const materializationCopy = materializationPolicy?.copy ?? [];
    const materializationSymlink = materializationPolicy?.symlink ?? [];
    if (materializationCopy.length > ZERO || materializationSymlink.length > ZERO) {
      const canonicalRepositoryPath = await realpath(repo.path);
      const sourceRoot = await resolveGitPrimarySourceCheckout(canonicalRepositoryPath, repo.name);
      let refreshedPlan = await planConfiguredRepositoryMaterialization({
        copy: materializationCopy,
        destinationRoot: worktreePath,
        dryRun: false,
        platform: process.platform,
        repositoryId: repo.name,
        repositoryPath: canonicalRepositoryPath,
        sourceRoot,
        symlink: materializationSymlink,
        targetOid: `refs/heads/${branchName}`,
      });
      if (reuseExistingWorktree) {
        refreshedPlan = await preserveCorrectReusableMaterialization({
          copy: materializationCopy,
          destinationRoot: worktreePath,
          plan: refreshedPlan,
          sourceRoot,
          symlink: materializationSymlink,
        });
      }
      if (refreshedPlan.classification === "blocked") {
        materializationOutcomes = refreshedPlan.outcomes
          .filter((outcome) => outcome.status === "blocked")
          .map((outcome) => ({
            action: outcome.action,
            message: outcome.message,
            path: outcome.path,
            reasonCode: outcome.reasonCode,
            status: "failed" as const,
          }));
        throw new Error(`Materialization plan for '${repo.name}' became blocked after pre-create`);
      }
      const materialized = await materializeRepository({
        copy: materializationCopy,
        destinationRoot: worktreePath,
        plan: refreshedPlan,
        repositoryId: repo.name,
        sourceRoot,
        symlink: materializationSymlink,
      });
      materializationOutcomes = materialized.outcomes;
      materializationOwnershipLedger = materialized.ownershipLedger;
      materializationRollback = materialized.materializationRollback;
      if (materializationOutcomes.some((outcome) => outcome.status === "failed")) {
        throw new Error(`Materialization failed for '${repo.name}'`);
      }
    }

    // Execute repository post-create only after materialization completes.
    if (options.executeHooks) {
      if (spinnerInstance) {
        spinnerInstance.text = `Running repo-specific post-create hook for ${repo.name}...`;
      }

      const postHookResult = await runHookIfPresent({
        hookName: getRepoSpecificHookName("post-create", repo.name),
        hookRootPath: mainRepoPath,
        hookType: "post-create",
        preparedHook: preparedHooks.get(getRepoSpecificHookName("post-create", repo.name)),
        operationData: repoOperationData,
        repoContextPath: worktreePath,
        repository: repo,
        repositoryId: repo.name,
        scope: "repository",
        targetRepositoryName: repo.name,
        targetRepositoryPath: repo.path,
        targetWorktreePath: worktreePath,
        parentRepoPath,
        hookInputMode: options.hookInputMode,
        quiet: options.quietHooks,
        spinnerInstance,
        timeout: options.hookTimeout,
      });
      if (
        postHookResult.outcome &&
        (config.repos[repo.name] || postHookResult.outcome.reasonCode !== "not_found")
      ) {
        hookOutcomes.push(postHookResult.outcome);
      }
      if (postHookResult.error) {
        throw postHookResult.error;
      }
    }

    // Success!
    if (spinnerInstance) {
      spinnerInstance.succeed(`${repo.name} - worktree created at ${worktreePath}`);
    }

    // T024: Return success result
    let warnings: string[] = [];
    if (shouldReuse) {
      warnings = [`Reused existing branch '${branchName}'`];
    }

    return {
      branchName,
      duration: Date.now() - startTime,
      error: NULL_RESULT_ERROR,
      hookOutcomes,
      materializationOutcomes,
      materializationOwnershipLedger,
      materializationRollback,
      repository: repo,
      status: "success",
      targetAction,
      warnings,
      worktreePath,
    };
  } catch (error) {
    // T023: Return failure result (will trigger rollback in caller)
    return {
      branchName,
      duration: Date.now() - startTime,
      error: error as Error,
      hookOutcomes,
      materializationOutcomes,
      materializationOwnershipLedger,
      materializationRollback,
      repository: repo,
      status: "failed",
      targetAction,
      warnings: [],
      worktreePath,
    };
  }
};

// ============================================================================
// Conflict Detection and Resolution (T035-T041)
// ============================================================================

/**
 * Check for branch name conflicts across repositories (T035)
 *
 * Scans all repositories in parallel to detect if the specified branch name
 * already exists locally or remotely.
 *
 * @param branchName - Branch name to check
 * @param repositories - Repositories to check
 * @returns Promise resolving to conflict check result
 */
export const checkBranchConflicts = async (
  branchName: string,
  repositories: Repository[],
): Promise<ConflictCheckResult> => {
  const conflicts: BranchConflict[] = [];
  const nonConflicting: Repository[] = [];

  // T035: Check all repositories in parallel (read-only operation, safe to parallelize)
  const checks = repositories.map(async (repo) => {
    try {
      // Check local branches
      const localResult = await exec(["branch", "--list", branchName], repo.path);
      const existsLocally = localResult.stdout.trim().length > ZERO;

      // Check remote branches (check if origin exists first)
      let existsRemotely = false;
      try {
        const remoteResult = await exec(["ls-remote", "--heads", "origin", branchName], repo.path);
        existsRemotely = remoteResult.stdout.trim().length > ZERO;
      } catch {
        // Remote doesn't exist or not accessible, that's OK
        existsRemotely = false;
      }

      if (existsLocally || existsRemotely) {
        return {
          conflict: {
            branchName,
            existsLocally,
            existsRemotely,
            repository: repo,
            resolution: NULL_CONFLICT_STRATEGY,
          } as BranchConflict,
          hasConflict: true,
        };
      }
      return { hasConflict: false, repo };
    } catch {
      // If we can't check, assume no conflict and let later operations handle errors
      return { hasConflict: false, repo };
    }
  });

  const results = await Promise.all(checks);

  // T036: Build ConflictCheckResult
  for (const result of results) {
    if (result.hasConflict) {
      if (result.conflict) {
        conflicts.push(result.conflict);
      }
    } else if (result.repo) {
      nonConflicting.push(result.repo);
    }
  }

  return {
    conflicts,
    hasConflicts: conflicts.length > ZERO,
    nonConflictingRepositories: nonConflicting,
  };
};

/**
 * Resolve branch conflicts with user interaction or pre-selected strategy (T037)
 *
 * If a conflict resolution strategy is pre-selected in options, uses that.
 * Otherwise, prompts the user to choose a strategy.
 *
 * @param conflicts - Detected conflicts to resolve
 * @param options - Operation options (may include pre-selected strategy)
 * @returns Promise resolving to chosen conflict resolution strategy
 * @throws ConflictAbortedError if user chooses to abort
 */
export const resolveConflicts = async (
  conflicts: BranchConflict[],
  options: WorktreeOperationOptions = {},
): Promise<ConflictResolutionStrategy> => {
  // If strategy pre-selected in options, use it
  if (options.conflictResolution) {
    // T040: Handle ABORT strategy
    if (options.conflictResolution === "ABORT") {
      throw new ConflictAbortedError("Operation aborted due to branch conflicts", conflicts);
    }
    return options.conflictResolution;
  }

  // T038: Build conflict resolution dialog message
  const conflictList = conflicts
    .map((conflict) => {
      const location = describeConflictLocation(conflict.existsLocally, conflict.existsRemotely);
      return `  • ${conflict.repository.name} (${location})`;
    })
    .join("\n");

  warn(
    `Branch "${conflicts[ZERO].branchName}" already exists in ${conflicts.length} repositories:`,
  );
  console.log(conflictList);
  console.log("");

  // T037: Interactive conflict resolution with prompt
  const choices: Choice<ConflictResolutionStrategy>[] = [
    {
      description: "Create worktrees using the existing branches without creating new ones",
      name: "Reuse existing branches",
      value: "REUSE_EXISTING",
    },
    {
      description: "Cancel the operation and do not create any worktrees",
      name: "Abort operation",
      value: "ABORT",
    },
    // Future: CREATE_ALTERNATE not yet implemented
    // {
    //   Value: 'CREATE_ALTERNATE',
    //   Name: 'Create alternate branch names',
    //   Description: 'Create new branches with alternate names (e.g., feature-1, feature-2)',
    // },
  ];

  const strategy = await select<ConflictResolutionStrategy>(
    "How would you like to proceed?",
    choices,
  );

  if (strategy.status === "cancelled") {
    throw new ConflictAbortedError(
      "Operation cancelled by user due to branch conflicts",
      conflicts,
    );
  }

  // T040: Handle ABORT strategy
  if (strategy.value === "ABORT") {
    throw new ConflictAbortedError("Operation aborted by user due to branch conflicts", conflicts);
  }

  return strategy.value;
};

/**
 * Determine if we should reuse an existing branch (T041)
 * Helper function called during repository processing
 */
const shouldReuseBranch = ({ conflicts, repo, strategy }: ShouldReuseBranchOptions): boolean => {
  if (strategy !== "REUSE_EXISTING") {
    return false;
  }

  // Check if this repo has a conflict
  const conflict = conflicts.find((branchConflict) => branchConflict.repository.name === repo.name);
  return conflict !== undefined && conflict.existsLocally;
};

// ============================================================================
// Repository Filtering (T047-T053)
// ============================================================================

/**
 * Apply repository filter to get selected repositories (T047)
 *
 * Applies the specified filter mode to the configured repositories:
 * - 'all': Returns all configured repositories
 * - 'explicit': Returns only repositories in explicitList
 * - 'interactive': Prompts user to select repositories (not yet implemented)
 *
 * @param filter - Repository filter criteria
 * @param allRepositories - All configured repositories
 * @returns Promise resolving to filtered repository list
 * @throws RepositoryValidationError if explicit names don't match any repositories
 */
export const applyRepositoryFilter = async (
  filter: RepositoryFilter,
  allRepositories: Repository[],
): Promise<Repository[]> => {
  switch (filter.mode) {
    case "all": {
      // T048: Return all repositories
      return allRepositories;
    }

    case "explicit": {
      // T049: Validate names and return matching repositories
      const selected: Repository[] = [];

      for (const name of filter.explicitList) {
        const repo = allRepositories.find((repository) => repository.name === name);
        if (!repo) {
          throw new RepositoryValidationError(`Repository not found: ${name}`, name);
        }
        selected.push(repo);
      }

      // T053: Validate non-empty result
      if (selected.length === ZERO) {
        throw new RepositoryValidationError("Explicit filter resulted in no repositories", "");
      }

      return selected;
    }

    case "interactive": {
      // T050: Interactive mode - prompt user to select optional repositories
      const requiredRepositories = filter.requiredRepositories ?? [];
      const requiredNames = new Set(requiredRepositories.map((repo) => repo.name));
      const selectableRepositories = allRepositories.filter(
        (repo) => !requiredNames.has(repo.name),
      );

      if (selectableRepositories.length === ZERO) {
        return requiredRepositories;
      }

      const choices = selectableRepositories.map((repo) => ({
        description: repo.path,
        name: repo.name,
        value: repo,
      }));

      const selectedRepos = await multiSelect<Repository>(
        "Select child repositories to create worktrees in:",
        choices,
      );

      if (selectedRepos.status === "cancelled") {
        throw new UserAbortedError("Repository selection cancelled by user");
      }

      const selection = [...requiredRepositories, ...selectedRepos.value];

      // T053: Validate non-empty result
      if (selection.length === ZERO) {
        throw new RepositoryValidationError("No repositories selected", "");
      }

      return selection;
    }

    default: {
      throw new Error(`Unknown filter mode: ${String((filter as { mode?: unknown }).mode)}`);
    }
  }
};
