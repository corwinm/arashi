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

import type { Repository } from "./repository.ts";
import { basename, sep, join, parse, resolve } from "path";
import { existsSync } from "fs";
import type { Config as ArashiConfig } from "../lib/config.ts";
import { loadConfig, ConfigNotFoundError } from "../lib/config.ts";
import { isBareRepo } from "../lib/git.ts";
import type { DirtyStatus, WorktreeEntry, WorktreeInfo } from "../types/remove.ts";

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
  /** Whether to execute pre-create and post-create hooks (default: true) */
  executeHooks?: boolean;

  /** Timeout in milliseconds for hook execution (default: 60000) */
  hookTimeout?: number;

  /** Whether to use interactive repository selection (default: false) */
  interactive?: boolean;

  /** Pre-selected conflict resolution strategy (null to prompt user) */
  conflictResolution?: ConflictResolutionStrategy | null;

  /** Whether to display progress spinners (default: true) */
  showProgress?: boolean;

  /** Whether to simulate operation without making changes (default: false) */
  dryRun?: boolean;
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

export interface DryRunOutcome {
  overallStatus: DryRunPlanStatus;
  plannedWorktrees: PlannedWorktree[];
  conflicts: DryRunConflict[];
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

  /** Detailed results for each repository */
  repositoryResults: RepositoryResult[];

  /** Whether rollback was triggered */
  rolledBack: boolean;

  /** Total operation time in milliseconds */
  totalDuration: number;

  /** Human-readable error summary if operation failed */
  errorSummary: string | null;

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

// ============================================================================
// Error Classes (T012)
// ============================================================================

/**
 * Error thrown when repository validation fails
 */
export class RepositoryValidationError extends Error {
  constructor(
    message: string,
    public readonly repositoryName: string,
    public readonly repositoryPath?: string,
  ) {
    super(message);
    this.name = "RepositoryValidationError";
  }
}

/**
 * Error thrown when git operation fails
 */
export class GitOperationError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly repository: Repository,
    public readonly originalError: Error,
  ) {
    super(message);
    this.name = "GitOperationError";
  }
}

/**
 * Error thrown when hook execution fails
 */
export class HookExecutionError extends Error {
  constructor(
    message: string,
    public readonly hookType: HookType,
    public readonly repository: Repository,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "HookExecutionError";
  }
}

/**
 * Error thrown when user aborts due to conflicts
 */
export class ConflictAbortedError extends Error {
  constructor(
    message: string,
    public readonly conflicts: BranchConflict[],
  ) {
    super(message);
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
  constructor(
    message: string,
    public readonly branchName: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "InvalidBranchNameError";
  }
}

/**
 * Error thrown when insufficient permissions
 */
export class InsufficientPermissionsError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly operation: string,
  ) {
    super(message);
    this.name = "InsufficientPermissionsError";
  }
}

async function runHookIfPresent(options: {
  hookName: string;
  hookType: HookType;
  hookRootPath: string;
  repoContextPath: string;
  operationData: Record<string, string>;
  timeout: number;
  repository: Repository;
}): Promise<void> {
  const hookPath = await hooks.findHook(options.hookName, options.hookRootPath);
  if (!hookPath) {
    return;
  }

  const validation = await hooks.validateHook(hookPath);
  if (!validation.valid) {
    throw new HookExecutionError(
      `Hook validation failed for ${options.hookName}: ${validation.error}`,
      options.hookType,
      options.repository,
      -1,
      validation.error ?? "Hook validation failed",
    );
  }

  const result = await hooks.executeHook({
    hookName: options.hookName,
    scriptPath: hookPath,
    context: {
      hookName: options.hookName,
      repoPath: options.repoContextPath,
      operationData: options.operationData,
    },
    timeout: options.timeout,
  });

  if (!result.success) {
    throw new HookExecutionError(
      `Hook execution failed for ${options.hookName}`,
      options.hookType,
      options.repository,
      result.exitCode,
      result.stderr,
    );
  }
}

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
export async function detectRepositoryType(
  repo: Repository,
  config: ArashiConfig | null,
): Promise<RepositoryTypeInfo> {
  // Check if repository has .arashi/config.json → meta-repo
  const configPath = join(repo.path, ".arashi", "config.json");
  try {
    const configFile = Bun.file(configPath);
    const exists = await configFile.exists();
    if (exists) {
      return {
        type: "meta-repo",
        reason: "Contains .arashi/config.json",
      };
    }
  } catch {
    // File system access error - treat as not meta-repo
  }

  // Check if this is a child repository
  // A child repo must be directly inside a repos_dir/ folder, and that repos_dir
  // must be inside a meta-repo (has .arashi/config.json)
  if (config) {
    const reposDir = basename(config.repos_dir);
    const pathParts = repo.path.split(sep);

    // Check if the immediate parent directory is the repos_dir
    const parentDir = pathParts[pathParts.length - 2];
    if (parentDir === reposDir) {
      // Check if grandparent has .arashi/config.json (is a meta-repo)
      const grandparentPath = join(repo.path, "..", "..");
      const metaConfigPath = join(grandparentPath, ".arashi", "config.json");

      try {
        const metaConfigFile = Bun.file(metaConfigPath);
        const metaExists = await metaConfigFile.exists();

        if (metaExists) {
          const parentName = pathParts[pathParts.length - 3];
          return {
            type: "child",
            parentName,
            reposDir,
            reason: `Located in ${reposDir}/ folder of parent repository '${parentName}'`,
          };
        }
      } catch {
        // Not a child repo - fall through to standalone
      }
    }
  }

  // Default → standalone
  return {
    type: "standalone",
    reason: "Not a meta-repo and not in repos/ folder",
  };
}

/**
 * Calculate nested worktree path for child repositories
 * Feature: 001-nested-worktree-paths (T009)
 *
 * @param repo - Child repository
 * @param parentWorktreeName - Name of parent worktree folder (e.g., 'feature-branch' or 'parent-feature-branch')
 * @param reposDir - Name of repos directory (e.g., "repos")
 * @returns Absolute path to nested worktree
 */
export function calculateChildWorktreePath(
  repo: Repository,
  parentWorktreeName: string,
  reposDir: string,
): string {
  // Navigate up from child repo to workspace level: ../../../
  // Then append parent worktree path and child location
  return join(repo.path, "..", "..", "..", parentWorktreeName, reposDir, repo.name);
}

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
export async function calculateWorktreePath(
  repo: Repository,
  branchName: string,
  config: ArashiConfig,
  knownType?: RepositoryTypeInfo,
): Promise<{
  path: string;
  repositoryType: RepositoryType;
  strategy: "sibling" | "nested";
  parentWorktreePath?: string;
}> {
  // Detect repository type (or use provided type)
  const typeInfo = knownType ?? (await detectRepositoryType(repo, config));

  // Apply appropriate path calculation strategy
  if (typeInfo.type === "child") {
    // Nested strategy for child repositories
    if (!typeInfo.parentName || !typeInfo.reposDir) {
      throw new Error(`Child repository type missing parentName or reposDir: ${repo.name}`);
    }

    // Determine parent repository path (navigate up from child: ../../../)
    const parentRepoPath = join(repo.path, "..", "..");

    // Check if parent is bare to determine worktree naming
    const parentIsBare = await isBareRepo(parentRepoPath);

    // Bare parent: Use branch name only
    // Non-bare parent: Combine parent name + branch
    const parentWorktreeName = parentIsBare ? branchName : `${typeInfo.parentName}-${branchName}`;

    const worktreePath = calculateChildWorktreePath(repo, parentWorktreeName, typeInfo.reposDir);

    const parentWorktreePath = join(repo.path, "..", "..", "..", parentWorktreeName);

    return {
      path: worktreePath,
      repositoryType: "child",
      strategy: "nested",
      parentWorktreePath,
    };
  } else {
    // Sibling strategy for meta-repo and standalone
    // Check if repository is bare to determine naming convention
    const isBare = await isBareRepo(repo.path);

    // Bare repos: Use branch name only (e.g., 'feature-branch/')
    // Non-bare repos: Combine folder name + branch (e.g., 'my-repo-feature-branch/')
    const worktreeName = isBare ? branchName : `${repo.name}-${branchName}`;
    const worktreePath = join(repo.path, "..", worktreeName);

    return {
      path: worktreePath,
      repositoryType: typeInfo.type,
      strategy: "sibling",
    };
  }
}

// ============================================================================
// Worktree Entry Utilities (Remove workflow)
// ============================================================================

function resolveParentPathForChild(
  worktreePath: string,
  reposDirName: string,
  repoName: string,
): string | null {
  const normalized = resolve(worktreePath);
  const parsed = parse(normalized);
  const parts = normalized
    .slice(parsed.root.length)
    .split(sep)
    .filter((part) => part.length > 0);

  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] !== reposDirName) {
      continue;
    }
    if (parts[i + 1] !== repoName) {
      continue;
    }
    const parentParts = parts.slice(0, i);
    return join(parsed.root, ...parentParts);
  }

  return null;
}

export function attachWorktreeRelationships(
  entries: WorktreeEntry[],
  options: {
    reposDirName: string;
    childRepoNames: Set<string>;
  },
): void {
  const normalizedMap = new Map<string, WorktreeEntry>();

  for (const entry of entries) {
    entry.parentPath = null;
    entry.childrenPaths = [];
    normalizedMap.set(resolve(entry.path), entry);
  }

  for (const entry of entries) {
    if (!options.childRepoNames.has(entry.repository)) {
      continue;
    }

    const parentPath = resolveParentPathForChild(
      entry.path,
      options.reposDirName,
      entry.repository,
    );
    entry.parentPath = parentPath;
  }

  for (const entry of entries) {
    if (!entry.parentPath) {
      continue;
    }
    const parent = normalizedMap.get(resolve(entry.parentPath));
    if (!parent) {
      continue;
    }
    parent.childrenPaths.push(entry.path);
  }
}

export async function getWorktreeDirtyStatus(worktreePath: string): Promise<DirtyStatus> {
  try {
    const result = await git.exec(["status", "--porcelain"], worktreePath);
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    let modifiedFiles = 0;
    let untrackedFiles = 0;
    let stagedFiles = 0;

    for (const line of lines) {
      if (line.startsWith("??")) {
        untrackedFiles += 1;
        continue;
      }

      const indexStatus = line[0];
      const worktreeStatus = line[1];

      if (indexStatus !== " " && indexStatus !== "?") {
        stagedFiles += 1;
      }

      if (worktreeStatus !== " " && worktreeStatus !== "?") {
        modifiedFiles += 1;
      }
    }

    return {
      isDirty: lines.length > 0,
      modifiedFiles,
      untrackedFiles,
      stagedFiles,
    };
  } catch {
    return {
      isDirty: true,
      modifiedFiles: 0,
      untrackedFiles: 0,
      stagedFiles: 0,
    };
  }
}

export async function resolveWorktreeStatuses(
  entries: WorktreeEntry[],
  includeDirtyDetails: boolean,
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
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
      entry.status = status.isDirty ? "dirty" : "present";
    }),
  );
}

export async function buildWorktreeEntries(
  worktrees: WorktreeInfo[],
  options: {
    reposDirName: string;
    childRepoNames: Set<string>;
    includeDirtyDetails: boolean;
  },
): Promise<WorktreeEntry[]> {
  const entries: WorktreeEntry[] = worktrees.map((worktree) => ({
    ...worktree,
    status: "present",
    parentPath: null,
    childrenPaths: [],
  }));

  attachWorktreeRelationships(entries, {
    reposDirName: options.reposDirName,
    childRepoNames: options.childRepoNames,
  });
  await resolveWorktreeStatuses(entries, options.includeDirtyDetails);

  return entries;
}

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
export function isValidBranchName(branchName: string): boolean {
  if (!branchName || branchName.length === 0) {
    return false;
  }

  // Cannot start with - or /
  if (branchName.startsWith("-") || branchName.startsWith("/")) {
    return false;
  }

  // Cannot end with .lock or /
  if (branchName.endsWith(".lock") || branchName.endsWith("/")) {
    return false;
  }

  // Cannot contain spaces
  if (branchName.includes(" ")) {
    return false;
  }

  // Cannot contain invalid characters: ~, ^, :, ?, *, [, \
  const invalidChars = /[~^:?*[\\\]]/;
  if (invalidChars.test(branchName)) {
    return false;
  }

  // Cannot contain ..
  if (branchName.includes("..")) {
    return false;
  }

  // Cannot contain @{
  if (branchName.includes("@{")) {
    return false;
  }

  // Cannot have consecutive slashes
  if (branchName.includes("//")) {
    return false;
  }

  return true;
}

// ============================================================================
// Main Orchestration Functions (T018-T024)
// ============================================================================

import { OperationLog } from "./rollback.ts";
import * as git from "../lib/git.ts";
import * as logger from "../lib/logger.ts";
import * as hooks from "../lib/hooks.ts";
import * as prompts from "../lib/prompts.ts";

async function buildDryRunOutcome(
  branchName: string,
  repositories: Repository[],
  conflictCheck: ConflictCheckResult,
  options: Required<WorktreeOperationOptions>,
  config: ArashiConfig,
): Promise<DryRunOutcome> {
  const plannedWorktrees: PlannedWorktree[] = [];
  const conflicts: DryRunConflict[] = [];
  const conflictByRepo = new Map<string, BranchConflict>();

  for (const conflict of conflictCheck.conflicts) {
    conflictByRepo.set(conflict.repository.name, conflict);
  }

  for (const repo of repositories) {
    let worktreePath: string | null = null;
    let planStatus: DryRunPlanStatus = "actionable";

    try {
      const pathResult = await calculateWorktreePath(repo, branchName, config);
      worktreePath = pathResult.path;

      if (existsSync(worktreePath)) {
        conflicts.push({
          repository: repo,
          repositoryName: repo.name,
          conflictType: "path_exists",
          scope: `${repo.name}:${worktreePath}`,
          message: `Worktree path already exists: ${worktreePath}`,
          blocking: true,
        });
        planStatus = "blocked";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      conflicts.push({
        repository: repo,
        repositoryName: repo.name,
        conflictType: "invalid_configuration",
        scope: repo.name,
        message: `Unable to calculate worktree path: ${message}`,
        blocking: true,
      });
      planStatus = "blocked";
    }

    const branchConflict = conflictByRepo.get(repo.name);
    if (branchConflict) {
      const location =
        branchConflict.existsLocally && branchConflict.existsRemotely
          ? "locally and remotely"
          : branchConflict.existsLocally
            ? "locally"
            : "remotely";
      const blocking = options.conflictResolution !== "REUSE_EXISTING";
      conflicts.push({
        repository: repo,
        repositoryName: repo.name,
        conflictType: "branch_exists",
        scope: `${repo.name}:${branchConflict.branchName}`,
        message: `Branch '${branchConflict.branchName}' already exists ${location}`,
        blocking,
      });
      if (blocking) {
        planStatus = "blocked";
      }
    }

    plannedWorktrees.push({
      repository: repo,
      repositoryName: repo.name,
      worktreePath,
      branchName,
      planStatus,
    });
  }

  const blockingTotal = conflicts.filter((conflict) => conflict.blocking).length;
  const overallStatus: DryRunPlanStatus = blockingTotal > 0 ? "blocked" : "actionable";

  return {
    overallStatus,
    plannedWorktrees,
    conflicts,
    summaryCounts: {
      plannedTotal: plannedWorktrees.length,
      conflictTotal: conflicts.length,
      blockingTotal,
    },
  };
}

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
export async function createCoordinatedWorktrees(
  branchName: string,
  repositories: Repository[],
  options: WorktreeOperationOptions = {},
): Promise<OperationSummary> {
  const startTime = Date.now();
  const operationLog = new OperationLog();
  const results: RepositoryResult[] = [];
  const mainRepoPath = resolve(".");

  // Set default options
  const opts: Required<WorktreeOperationOptions> = {
    executeHooks: options.executeHooks ?? true,
    hookTimeout: options.hookTimeout ?? 60000,
    interactive: options.interactive ?? false,
    conflictResolution: options.conflictResolution ?? null,
    showProgress: options.showProgress ?? true,
    dryRun: options.dryRun ?? false,
  };

  try {
    // 1. Load Arashi configuration (T012)
    // Try to load config, but provide default if not found (for standalone repos or tests)
    let config: ArashiConfig;
    try {
      config = await loadConfig(".");
    } catch (error) {
      if (error instanceof ConfigNotFoundError) {
        // No config found - use minimal default for standalone repos
        config = {
          version: "1.0.0",
          repos_dir: "./repos",
          auto_setup: false,
          discovered_repos: {},
        };
      } else {
        throw error; // Re-throw other config errors
      }
    }

    // 2. Validate branch name (T018)
    if (!isValidBranchName(branchName)) {
      throw new InvalidBranchNameError(
        `Invalid branch name: ${branchName}`,
        branchName,
        "Branch name contains invalid characters or format",
      );
    }

    // 2. Validate we have repositories
    if (!repositories || repositories.length === 0) {
      throw new RepositoryValidationError("No repositories provided for worktree creation", "");
    }

    // 3. T039: Pre-flight conflict check
    const conflictCheck = await checkBranchConflicts(branchName, repositories);
    let resolvedStrategy: ConflictResolutionStrategy | null = null;
    let conflictsToHandle: BranchConflict[] = [];

    if (opts.dryRun) {
      const dryRunOutcome = await buildDryRunOutcome(
        branchName,
        repositories,
        conflictCheck,
        opts,
        config,
      );

      return {
        totalRepositories: repositories.length,
        successCount: 0,
        failureCount: 0,
        skippedCount: repositories.length,
        repositoryResults: [],
        rolledBack: false,
        totalDuration: Date.now() - startTime,
        errorSummary:
          dryRunOutcome.overallStatus === "blocked"
            ? "Blocking conflicts detected during dry-run"
            : null,
        dryRunOutcome,
        isDryRun: true,
      };
    }

    if (conflictCheck.hasConflicts) {
      // Attempt to resolve conflicts
      resolvedStrategy = await resolveConflicts(conflictCheck.conflicts, options);
      conflictsToHandle = conflictCheck.conflicts;
    }

    // 4. Execute global pre-create hook (once)
    if (opts.executeHooks) {
      await runHookIfPresent({
        hookName: hooks.GLOBAL_HOOKS.preCreate,
        hookType: "pre-create",
        hookRootPath: mainRepoPath,
        repoContextPath: mainRepoPath,
        operationData: hooks.buildHookOperationData({
          branchName,
          mainRepoPath,
          parentRepoPath: mainRepoPath,
        }),
        timeout: opts.hookTimeout,
        repository: repositories[0],
      });
    }

    // 5. Process each repository sequentially (T019-T023, T041)
    for (const repo of repositories) {
      const repoResult = await processRepository(
        repo,
        branchName,
        operationLog,
        opts,
        config,
        conflictsToHandle,
        resolvedStrategy,
        mainRepoPath,
      );
      results.push(repoResult);

      // If repository processing failed, trigger rollback
      if (repoResult.status === "failed") {
        throw repoResult.error;
      }
    }

    // 6. Execute global post-create hook (once)
    if (opts.executeHooks) {
      await runHookIfPresent({
        hookName: hooks.GLOBAL_HOOKS.postCreate,
        hookType: "post-create",
        hookRootPath: mainRepoPath,
        repoContextPath: mainRepoPath,
        operationData: hooks.buildHookOperationData({
          branchName,
          mainRepoPath,
          parentRepoPath: mainRepoPath,
        }),
        timeout: opts.hookTimeout,
        repository: repositories[0],
      });
    }

    // 7. Build successful operation summary (T024)
    return {
      totalRepositories: repositories.length,
      successCount: results.filter((r) => r.status === "success").length,
      failureCount: 0,
      skippedCount: 0,
      repositoryResults: results,
      rolledBack: false,
      totalDuration: Date.now() - startTime,
      errorSummary: null,
    };
  } catch (error) {
    // Automatic rollback on any error (T023)
    const rollbackResult = await operationLog.rollback();
    const residualWorktrees = results
      .filter((result) => result.worktreePath && existsSync(result.worktreePath))
      .map((result) => `${result.repository.name}:${result.worktreePath}`);

    let rollbackNote = "";
    if (rollbackResult.failureCount > 0) {
      rollbackNote = ` Rollback encountered ${rollbackResult.failureCount} cleanup failures.`;
    }
    if (residualWorktrees.length > 0) {
      rollbackNote += ` Residual worktrees detected: ${residualWorktrees.join(", ")}.`;
    }

    return {
      totalRepositories: repositories.length,
      successCount: 0,
      failureCount: 1,
      skippedCount: 0,
      repositoryResults: results,
      rolledBack: true,
      totalDuration: Date.now() - startTime,
      errorSummary: `${error instanceof Error ? error.message : String(error)}${rollbackNote}`,
    };
  }
}

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
async function processRepository(
  repo: Repository,
  branchName: string,
  operationLog: OperationLog,
  options: Required<WorktreeOperationOptions>,
  config: ArashiConfig,
  conflicts: BranchConflict[] = [],
  strategy: ConflictResolutionStrategy | null = null,
  mainRepoPath: string,
): Promise<RepositoryResult> {
  const startTime = Date.now();

  // Create spinner if progress is enabled
  const spinner = options.showProgress ? logger.spinner(`Processing ${repo.name}...`) : null;

  if (spinner) {
    spinner.start();
  }

  try {
    // T041: Check if we should reuse existing branch
    const shouldReuse = shouldReuseBranch(repo, branchName, conflicts, strategy || "ABORT");

    if (!shouldReuse) {
      // T020: Create branch from default branch
      if (spinner) {
        spinner.text = `Creating branch '${branchName}' in ${repo.name}...`;
      }

      try {
        await git.exec(["branch", branchName, repo.defaultBranch], repo.path);
      } catch (error) {
        if (spinner) {
          spinner.fail(`Failed to create branch '${branchName}' in ${repo.name}`);
        }
        throw new GitOperationError(
          `Failed to create branch '${branchName}' in ${repo.name}`,
          "branch_create",
          repo,
          error as Error,
        );
      }

      // T022: Log branch creation for rollback
      operationLog.add({
        type: "branch_created",
        timestamp: Date.now(),
        data: {
          repositoryPath: repo.path,
          branchName,
        },
      });
    } else {
      if (spinner) {
        spinner.text = `Reusing existing branch '${branchName}' in ${repo.name}...`;
      }
    }

    // T021: Create worktree for the branch (whether new or existing)
    if (spinner) {
      spinner.text = `Creating worktree for ${repo.name}...`;
    }

    const pathResult = await calculateWorktreePath(repo, branchName, config);
    const worktreePath = pathResult.path;
    try {
      await git.exec(["worktree", "add", worktreePath, branchName], repo.path);
    } catch (error) {
      if (spinner) {
        spinner.fail(`Failed to create worktree in ${repo.name}`);
      }
      throw new GitOperationError(
        `Failed to create worktree in ${repo.name}`,
        "worktree_create",
        repo,
        error as Error,
      );
    }

    // T022: Log worktree creation for rollback
    operationLog.add({
      type: "worktree_created",
      timestamp: Date.now(),
      data: {
        repositoryPath: repo.path,
        worktreePath,
        branchName,
      },
    });

    // Execute repo-specific hooks if enabled
    if (options.executeHooks) {
      const parentRepoPath = pathResult.parentWorktreePath ?? mainRepoPath;
      const repoOperationData = hooks.buildHookOperationData({
        branchName,
        repoName: repo.name,
        worktreePath,
        mainRepoPath,
        parentRepoPath,
      });

      if (spinner) {
        spinner.text = `Running repo-specific pre-create hook for ${repo.name}...`;
      }

      await runHookIfPresent({
        hookName: hooks.getRepoSpecificHookName("pre-create", repo.name),
        hookType: "pre-create",
        hookRootPath: mainRepoPath,
        repoContextPath: worktreePath,
        operationData: repoOperationData,
        timeout: options.hookTimeout,
        repository: repo,
      });

      if (spinner) {
        spinner.text = `Running repo-specific post-create hook for ${repo.name}...`;
      }

      await runHookIfPresent({
        hookName: hooks.getRepoSpecificHookName("post-create", repo.name),
        hookType: "post-create",
        hookRootPath: mainRepoPath,
        repoContextPath: worktreePath,
        operationData: repoOperationData,
        timeout: options.hookTimeout,
        repository: repo,
      });
    }

    // Success!
    if (spinner) {
      spinner.succeed(`${repo.name} - worktree created at ${worktreePath}`);
    }

    // T024: Return success result
    return {
      repository: repo,
      status: "success",
      worktreePath,
      branchName,
      error: null,
      warnings: shouldReuse ? [`Reused existing branch '${branchName}'`] : [],
      duration: Date.now() - startTime,
    };
  } catch (error) {
    // T023: Return failure result (will trigger rollback in caller)
    return {
      repository: repo,
      status: "failed",
      worktreePath: null,
      branchName,
      error: error as Error,
      warnings: [],
      duration: Date.now() - startTime,
    };
  }
}

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
export async function checkBranchConflicts(
  branchName: string,
  repositories: Repository[],
): Promise<ConflictCheckResult> {
  const conflicts: BranchConflict[] = [];
  const nonConflicting: Repository[] = [];

  // T035: Check all repositories in parallel (read-only operation, safe to parallelize)
  const checks = repositories.map(async (repo) => {
    try {
      // Check local branches
      const localResult = await git.exec(["branch", "--list", branchName], repo.path);
      const existsLocally = localResult.stdout.trim().length > 0;

      // Check remote branches (check if origin exists first)
      let existsRemotely = false;
      try {
        const remoteResult = await git.exec(
          ["ls-remote", "--heads", "origin", branchName],
          repo.path,
        );
        existsRemotely = remoteResult.stdout.trim().length > 0;
      } catch {
        // Remote doesn't exist or not accessible, that's OK
        existsRemotely = false;
      }

      if (existsLocally || existsRemotely) {
        return {
          hasConflict: true,
          conflict: {
            repository: repo,
            branchName,
            existsLocally,
            existsRemotely,
            resolution: null,
          } as BranchConflict,
        };
      } else {
        return { hasConflict: false, repo };
      }
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
    } else {
      if (result.repo) {
        nonConflicting.push(result.repo);
      }
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    nonConflictingRepositories: nonConflicting,
  };
}

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
export async function resolveConflicts(
  conflicts: BranchConflict[],
  options: WorktreeOperationOptions = {},
): Promise<ConflictResolutionStrategy> {
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
    .map((c) => {
      const location =
        c.existsLocally && c.existsRemotely
          ? "locally and remotely"
          : c.existsLocally
            ? "locally"
            : "remotely";
      return `  • ${c.repository.name} (${location})`;
    })
    .join("\n");

  logger.warn(
    `Branch "${conflicts[0].branchName}" already exists in ${conflicts.length} repositories:`,
  );
  console.log(conflictList);
  console.log("");

  // T037: Interactive conflict resolution with prompt
  const choices: prompts.Choice<ConflictResolutionStrategy>[] = [
    {
      value: "REUSE_EXISTING",
      name: "Reuse existing branches",
      description: "Create worktrees using the existing branches without creating new ones",
    },
    {
      value: "ABORT",
      name: "Abort operation",
      description: "Cancel the operation and do not create any worktrees",
    },
    // Future: CREATE_ALTERNATE not yet implemented
    // {
    //   value: 'CREATE_ALTERNATE',
    //   name: 'Create alternate branch names',
    //   description: 'Create new branches with alternate names (e.g., feature-1, feature-2)',
    // },
  ];

  const strategy = await prompts.select<ConflictResolutionStrategy>(
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
}

/**
 * Determine if we should reuse an existing branch (T041)
 * Helper function called during repository processing
 */
function shouldReuseBranch(
  repo: Repository,
  branchName: string,
  conflicts: BranchConflict[],
  strategy: ConflictResolutionStrategy,
): boolean {
  if (strategy !== "REUSE_EXISTING") {
    return false;
  }

  // Check if this repo has a conflict
  const conflict = conflicts.find((c) => c.repository.name === repo.name);
  return conflict !== undefined && conflict.existsLocally;
}

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
export async function applyRepositoryFilter(
  filter: RepositoryFilter,
  allRepositories: Repository[],
): Promise<Repository[]> {
  switch (filter.mode) {
    case "all":
      // T048: Return all repositories
      return allRepositories;

    case "explicit":
      // T049: Validate names and return matching repositories
      const selected: Repository[] = [];

      for (const name of filter.explicitList) {
        const repo = allRepositories.find((r) => r.name === name);
        if (!repo) {
          throw new RepositoryValidationError(`Repository not found: ${name}`, name);
        }
        selected.push(repo);
      }

      // T053: Validate non-empty result
      if (selected.length === 0) {
        throw new RepositoryValidationError("Explicit filter resulted in no repositories", "");
      }

      return selected;

    case "interactive":
      // T050: Interactive mode - prompt user to select repositories
      const choices = allRepositories.map((repo) => ({
        value: repo,
        name: repo.name,
        description: repo.path,
      }));

      const selectedRepos = await prompts.multiSelect<Repository>(
        "Select repositories to create worktrees in:",
        choices,
      );

      if (selectedRepos.status === "cancelled") {
        throw new UserAbortedError("Repository selection cancelled by user");
      }

      // T053: Validate non-empty result
      if (selectedRepos.value.length === 0) {
        throw new RepositoryValidationError("No repositories selected", "");
      }

      return selectedRepos.value;

    default:
      throw new Error(`Unknown filter mode: ${String((filter as { mode?: unknown }).mode)}`);
  }
}
