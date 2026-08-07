import { runtime } from "../lib/runtime.ts";
/**
 * CLI Command: Initialize Workspace
 *
 * Initialize Arashi workspace in the current git repository.
 * Creates configuration directory, generates default settings, discovers repositories,
 * and provides example hook templates.
 */

import {
  DEFAULT_CONFIG_SCHEMA_URL,
  configExists,
  getConfigPath,
  loadConfig,
  saveConfig,
} from "../lib/config.ts";
import {
  DEFAULT_WORKTREES_DIR,
  WorktreeLocationValidationError,
  normalizeWorktreesDir,
} from "../lib/worktree-location.ts";
import {
  DiskFullError,
  PermissionError,
  copyFile,
  ensureDir,
  fileExists,
  readTextFile,
  removeDir,
  writeTextFile,
} from "../lib/filesystem.ts";
import { confirm, input } from "../lib/prompts.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { info, error as logError, success, warn } from "../lib/logger.ts";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { Command, Option } from "commander";
import { discoverRepositories } from "../core/repository.ts";
import { exec as gitExec } from "../lib/git.ts";
import {
  classifyManagedPaths,
  reconcileRepositoryManagedIgnore,
  restoreManagedIgnore,
  type ManagedIgnoreReconciliation,
  type ManagedIgnoreScope,
} from "../lib/managed-ignore.ts";
import {
  bootstrapZeroConfig,
  type ZeroConfigBootstrapResult,
} from "../lib/zero-config-bootstrap.ts";

type Config = Parameters<typeof saveConfig>[1];
type RepoConfig = Config["repos"][string];
type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason: "exit" | "abort" };

const ZERO = 0;
const JSON_INDENT = 2;
const PATH_MAX_LENGTH = 4096;
const EXISTING_CONFIG_WARNING = "\n⚠ Warning: Existing configuration will be backed up";

const previewBootstrapManagedIgnore = (
  workspaceRoot: string,
  reposDir: string,
  worktreesDir: string,
  requestedScope?: string,
): ManagedIgnoreReconciliation => {
  const validScopes = new Set<ManagedIgnoreScope>(["local", "tracked", "none"]);
  const scope = (requestedScope ?? "local") as ManagedIgnoreScope;
  if (!validScopes.has(scope)) {
    throw new Error("Invalid ignore scope. Expected one of: local, tracked, none.");
  }
  const classifications = classifyManagedPaths([reposDir, worktreesDir]);
  const plannedRules =
    scope === "none"
      ? []
      : classifications.flatMap((path) => (path.safety === "safe" ? [path.rule] : []));
  const localExcludePath = join(workspaceRoot, ".git", "info", "exclude");
  const trackedIgnorePath = join(workspaceRoot, ".gitignore");
  const targetType = scope === "none" ? undefined : scope;
  const targetPath =
    targetType === "local"
      ? localExcludePath
      : targetType === "tracked"
        ? trackedIgnorePath
        : undefined;
  const paths = classifications.map((path) =>
    path.safety === "safe"
      ? {
          input: path.input,
          rule: path.rule,
          safety: "safe" as const,
          status: scope === "none" ? ("unignored" as const) : ("planned" as const),
        }
      : {
          input: path.input,
          safety: "unsafe" as const,
          safetyReason: path.reason,
          status: "unsafe" as const,
        },
  );

  return {
    appliedRules: [],
    attempted: plannedRules.length > 0 || requestedScope !== undefined,
    changed: false,
    fileChanges: { local: false, preference: false, tracked: false },
    localExcludePath,
    paths,
    plannedRules,
    restored: false,
    scope,
    staleRules: [],
    storedPreference: null,
    targetPath,
    targetType,
    trackedIgnorePath,
    warnings:
      scope === "none"
        ? paths.flatMap((path) =>
            path.rule
              ? [`Managed path '${path.rule}' remains unignored because scope is none.`]
              : [],
          )
        : [],
  };
};

// ============================================================================
// Data Types
// ============================================================================

interface InitOptions {
  /** Prepare the implicit standalone .worktrees convention only */
  zeroConfig?: boolean;
  /** Custom location for managed repositories */
  reposDir?: string;

  /** Base location for managed worktrees (workspace-relative) */
  worktreesDir?: string;

  /** Overwrite existing configuration if present */
  force?: boolean;

  /** Skip automatic repository discovery */
  noDiscover?: boolean;

  /** Dry run - show what would be done without making changes */
  dryRun?: boolean;

  /** Verbose output - show detailed information during initialization */
  verbose?: boolean;

  /** Managed Git ignore destination */
  ignoreScope?: string;

  /** Suppress human output for JSON mode */
  quiet?: boolean;
}

interface InitResult {
  /** Whether initialization completed successfully */
  success: boolean;

  /** Path to created configuration file */
  configPath?: string;

  /** Path to hooks directory */
  hooksPath?: string;

  /** Path to repositories directory */
  reposPath?: string;

  /** Number of repositories discovered */
  discoveredCount?: number;

  /** Error message if failed */
  error?: string;

  /** Exit code */
  exitCode: number;

  /** Resolved workspace root used for initialization */
  workspaceRoot?: string;

  /** Normalized base location for managed worktrees */
  worktreesDir?: string;

  /** Managed Git ignore inspection and final reconciliation state */
  managedIgnore?: ManagedIgnoreReconciliation;

  /** Structured managed-ignore failure details for JSON automation */
  managedIgnoreFailure?: ReturnType<typeof unknownErrorToJsonError>;

  /** Structured incomplete-rollback details for JSON automation */
  rollbackFailure?: ReturnType<typeof unknownErrorToJsonError>;

  /** Structured repository resolution details for JSON automation */
  resolutionFailure?: ReturnType<typeof unknownErrorToJsonError>;

  /** Whether only an existing workspace preference was reconciled */
  preferenceOnly?: boolean;
}

interface InitDependencies {
  /** Override current working directory for tests */
  cwd?: string;

  /** Override git command execution for tests */
  gitExec?: typeof gitExec;

  /** Override text prompt implementation for tests */
  promptInput?: (message: string, defaultValue?: string) => Promise<PromptOutcome<string>>;

  /** Override confirmation prompt implementation for tests */
  promptConfirm?: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;

  /** Override managed-ignore restoration for rollback tests */
  restoreManagedIgnore?: typeof restoreManagedIgnore;

  /** Override recursive directory creation for ownership and rollback tests */
  ensureDir?: typeof ensureDir;

  /** Override stdin tty detection for tests */
  stdinIsTTY?: boolean;

  /** Override native lifecycle platform for tests */
  platform?: NodeJS.Platform;
}

interface HookTemplate {
  /** Hook filename (e.g., 'pre-create.sh.example') */
  filename: string;

  /** Hook script content */
  content: string;
}

type OperationType = "CREATE_DIR" | "WRITE_FILE" | "MODIFY_FILE" | "BACKUP_FILE" | "MANAGED_IGNORE";

interface Operation {
  /** Type of operation performed */
  type: OperationType;

  /** Path affected by operation */
  path: string;

  /** Original content (for MODIFY_FILE) */
  originalContent?: string;

  /** Rollback function */
  rollback: () => Promise<void>;

  /** Final-state guard for rollbacks that would remove required coverage */
  shouldRollback?: () => Promise<boolean>;
}

interface InitResolution {
  bootstrapTarget?: string;
  bootstrapped: boolean;
  repositoryType: "bare" | "non-bare";
  workspaceRoot: string;
}

class InitRepositoryResolutionError extends Error {
  readonly code = "INIT_REPOSITORY_CLASSIFICATION_FAILED";
  readonly details: { cwd: string };

  constructor(cwd: string, cause: unknown) {
    super(
      `Unable to classify or canonicalize the existing Git repository at ${cwd}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "InitRepositoryResolutionError";
    this.details = { cwd };
  }
}

// ============================================================================
// Exit Codes
// ============================================================================

const ExitCode = {
  CANCELLED: 8,
  CONFIG_EXISTS: 2,
  CONFIG_WRITE_FAILED: 6,
  DISCOVERY_FAILED: 7,
  DISK_FULL: 4,
  INVALID_PATH: 5,
  NOT_GIT_REPOSITORY: 1,
  PERMISSION_DENIED: 3,
  SUCCESS: 0,
  UNKNOWN: 99,
} as const;

// ============================================================================
// Rollback Tracking
// ============================================================================

const operations: Operation[] = [];

class InitRollbackError extends Error {
  readonly code = "INIT_ROLLBACK_FAILED";
  readonly details: {
    failures: Array<{ message: string; path: string }>;
    finalState: Array<{ exists: boolean; path: string }>;
    originalFailure: ReturnType<typeof unknownErrorToJsonError>;
  };

  constructor(
    originalFailure: unknown,
    failures: Array<{ message: string; path: string }>,
    finalState: Array<{ exists: boolean; path: string }>,
  ) {
    super(`Initialization rollback was incomplete for ${failures.length} operation(s).`);
    this.name = "InitRollbackError";
    this.details = {
      failures,
      finalState,
      originalFailure: unknownErrorToJsonError(originalFailure),
    };
  }
}

/**
 * Add an operation to the rollback stack
 */
const addOperation = (operation: Operation): void => {
  operations.push(operation);
};

/**
 * Execute rollback of all tracked operations in LIFO order
 */
const executeRollback = async (
  quiet = false,
  originalFailure: unknown = new Error("Initialization failed"),
): Promise<void> => {
  if (!quiet) {
    info("\nRolling back changes...");
  }

  const reversedOps = [...operations];
  reversedOps.reverse();
  const failures: Array<{ message: string; path: string }> = [];

  for (const op of reversedOps) {
    try {
      if (op.shouldRollback && !(await op.shouldRollback())) {
        if (!quiet) {
          info(`  • Retained: ${op.path} (managed state still exists)`);
        }
        continue;
      }
      await op.rollback();
      if (!quiet) {
        info(`  • Rolled back: ${op.path}`);
      }
    } catch (error) {
      failures.push({
        message: error instanceof Error ? error.message : String(error),
        path: op.path,
      });
      if (!quiet) {
        warn(`  • Failed to rollback: ${op.path} - ${(error as Error).message}`);
      }
    }
  }

  const finalState = await Promise.all(
    reversedOps.map(async (operation) => ({
      exists: await fileExists(operation.path),
      path: operation.path,
    })),
  );
  operations.length = ZERO;
  if (failures.length > ZERO) {
    throw new InitRollbackError(originalFailure, failures, finalState);
  }
};

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate path format
 */
const isValidPath = (path: string): boolean => {
  if (!path || path.trim() === "") {
    return false;
  }

  if (path.includes("\0")) {
    return false;
  }

  if (path.length > PATH_MAX_LENGTH) {
    return false;
  }

  return true;
};

const isSupportedBootstrapTarget = (value: string): boolean => {
  if (!value || value.trim() === "") {
    return false;
  }

  const target = value.trim();
  if (target === ".") {
    return true;
  }

  if (isAbsolute(target) || target === ".." || target.includes("/") || target.includes("\\")) {
    return false;
  }

  return !target.includes("\0") && target.length <= PATH_MAX_LENGTH;
};

const getInteractiveAvailability = (deps: InitDependencies): boolean => {
  if (deps.stdinIsTTY !== undefined) {
    return deps.stdinIsTTY;
  }

  return Boolean(process.stdin.isTTY);
};

const createCancelledResult = (cwd: string): InitResult => ({
  error: "Initialization cancelled.",
  exitCode: ExitCode.CANCELLED,
  success: false,
  workspaceRoot: cwd,
});

const canonicalizeConfiguredBareRoot = async (
  commonRoot: string,
  runGit: typeof gitExec,
): Promise<string | undefined> => {
  if (!(await configExists(commonRoot))) {
    return undefined;
  }

  const commonTypeResult = await runGit(["rev-parse", "--is-bare-repository"], commonRoot);
  const commonType = commonTypeResult.stdout.trim();
  if (commonType !== "true" && commonType !== "false") {
    throw new Error(`Git returned an invalid repository type: '${commonType}'.`);
  }
  if (commonType === "false") {
    return undefined;
  }

  const rootResult = await runGit(["rev-parse", "--absolute-git-dir"], commonRoot);
  const workspaceRoot = rootResult.stdout.trim();
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
    throw new Error(`Git returned an invalid absolute directory: '${workspaceRoot}'.`);
  }
  return workspaceRoot;
};

const findEnclosingConfiguredBareRoot = async (
  cwd: string,
  options: InitOptions,
  runGit: typeof gitExec,
): Promise<string | undefined> => {
  const checkedCommonRoots = new Set<string>();
  let candidatePath = resolve(cwd);
  while (true) {
    let commonOutput: string | undefined = undefined;
    try {
      const commonResult = await runGit(["rev-parse", "--git-common-dir"], candidatePath);
      commonOutput = commonResult.stdout.trim() || undefined;
    } catch (error) {
      logVerbose(
        `No Git common repository resolved from ancestor ${candidatePath}: ${error instanceof Error ? error.message : String(error)}`,
        options,
      );
    }

    if (commonOutput) {
      const commonRoot = isAbsolute(commonOutput)
        ? resolve(commonOutput)
        : resolve(candidatePath, commonOutput);
      if (!checkedCommonRoots.has(commonRoot)) {
        checkedCommonRoots.add(commonRoot);
        const workspaceRoot = await canonicalizeConfiguredBareRoot(commonRoot, runGit);
        if (workspaceRoot) {
          return workspaceRoot;
        }
      }
    }

    const parentPath = dirname(candidatePath);
    if (parentPath === candidatePath) {
      return undefined;
    }
    candidatePath = parentPath;
  }
};

const resolveInitRoot = async (
  cwd: string,
  options: InitOptions,
  deps: InitDependencies,
): Promise<InitResolution | InitResult> => {
  const runGit = deps.gitExec ?? gitExec;
  const promptConfirm = deps.promptConfirm ?? confirm;
  const promptInput = deps.promptInput ?? input;

  logVerbose("Checking if current directory is a git repository...", options);
  let existingRepository = false;
  try {
    await runGit(["rev-parse", "--git-dir"], cwd);
    existingRepository = true;
  } catch {
    logVerbose(`Current directory is not a git repository: ${cwd}`, options);
  }

  if (existingRepository) {
    try {
      const typeResult = await runGit(["rev-parse", "--is-bare-repository"], cwd);
      const type = typeResult.stdout.trim();
      if (type !== "true" && type !== "false") {
        throw new Error(`Git returned an invalid repository type: '${type}'.`);
      }
      const repositoryType = type === "true" ? "bare" : "non-bare";
      let workspaceRoot = cwd;
      if (repositoryType === "bare") {
        const rootResult = await runGit(["rev-parse", "--absolute-git-dir"], cwd);
        workspaceRoot = rootResult.stdout.trim();
        if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
          throw new Error(`Git returned an invalid absolute directory: '${workspaceRoot}'.`);
        }
        logVerbose(`✓ Confirmed ${repositoryType} git repository at: ${workspaceRoot}`, options);
        return { bootstrapped: false, repositoryType, workspaceRoot };
      }

      // Linked worktrees report non-bare even when their common Git directory is configured bare.
      // Nested child repositories require ancestor common-directory checks to recover authority.
      const configuredBareRoot = await findEnclosingConfiguredBareRoot(cwd, options, runGit);
      if (configuredBareRoot) {
        logVerbose(`✓ Resolved configured bare repository at: ${configuredBareRoot}`, options);
        return { bootstrapped: false, repositoryType: "bare", workspaceRoot: configuredBareRoot };
      }

      logVerbose(`✓ Confirmed ${repositoryType} git repository at: ${workspaceRoot}`, options);
      return { bootstrapped: false, repositoryType, workspaceRoot };
    } catch (error) {
      throw new InitRepositoryResolutionError(cwd, error);
    }
  }

  if (!getInteractiveAvailability(deps)) {
    return {
      error: "Not a git repository",
      exitCode: ExitCode.NOT_GIT_REPOSITORY,
      success: false,
      workspaceRoot: cwd,
    };
  }

  const shouldCreateRepo = await promptConfirm(
    "This directory is not a git repository. Create one here or in a child directory?",
    true,
  );
  if (shouldCreateRepo.status === "cancelled") {
    return createCancelledResult(cwd);
  }

  if (!shouldCreateRepo.value) {
    return createCancelledResult(cwd);
  }

  const targetOutcome = await promptInput(
    "Repository target ('.' for current directory or a child directory name)",
    ".",
  );
  if (targetOutcome.status === "cancelled") {
    return createCancelledResult(cwd);
  }

  const bootstrapTarget = targetOutcome.value.trim();
  if (!isSupportedBootstrapTarget(bootstrapTarget)) {
    return {
      error: `Invalid bootstrap target: ${bootstrapTarget}`,
      exitCode: ExitCode.INVALID_PATH,
      success: false,
      workspaceRoot: cwd,
    };
  }

  const workspaceRoot = bootstrapTarget === "." ? cwd : resolve(cwd, bootstrapTarget);

  if (options.dryRun) {
    if (bootstrapTarget !== ".") {
      logDryRun("CREATE_DIR", workspaceRoot, options);
    }
    logDryRun("GIT_INIT", workspaceRoot, options);
  } else {
    logVerbose(`Bootstrapping git repository at: ${workspaceRoot}`, options);

    const gitDir = join(workspaceRoot, ".git");
    const gitDirExisted = await fileExists(gitDir);

    if (bootstrapTarget !== "." && !(await fileExists(workspaceRoot))) {
      await ensureDir(workspaceRoot);
      addOperation({
        path: workspaceRoot,
        rollback: async () => {
          await removeDir(workspaceRoot);
        },
        type: "CREATE_DIR",
      });
    }

    await runGit(["init"], workspaceRoot);
    if (!gitDirExisted) {
      addOperation({
        path: gitDir,
        rollback: async () => {
          await removeDir(gitDir);
        },
        type: "CREATE_DIR",
      });
    }
    logVerbose(`✓ Bootstrapped git repository at: ${workspaceRoot}`, options);
  }

  return {
    bootstrapTarget,
    bootstrapped: true,
    repositoryType: "non-bare",
    workspaceRoot,
  };
};

// ============================================================================
// Verbose Logging & Dry-Run Helpers
// ============================================================================

/**
 * Log verbose message if verbose mode enabled
 */
const logVerbose = (message: string, options: InitOptions): void => {
  if (options.verbose) {
    info(`[VERBOSE] ${message}`);
  }
};

/**
 * Log dry-run action
 */
const logDryRun = (action: string, details: string, options: InitOptions): void => {
  if (options.quiet) {
    return;
  }
  console.log(`[DRY RUN] ${action}: ${details}`);
};

const collectDiscoveredRepos = (
  discoveredRepos: Record<string, RepoConfig>,
  options: InitOptions,
  repositories: Awaited<ReturnType<typeof discoverRepositories>>["repositories"],
): void => {
  for (const repo of repositories) {
    if (options.verbose) {
      logVerbose(`  - ${repo.name} (${repo.defaultBranch})`, options);
    }

    discoveredRepos[repo.name] = {
      path: repo.path,
    };
  }
};

// ============================================================================
// Hook Templates
// ============================================================================

const POSIX_HOOK_TEMPLATES: HookTemplate[] = [
  {
    content: `#!/usr/bin/env bash
# Pre-Create Hook Example
#
# This workspace hook runs once BEFORE branch or worktree mutation.
# Use only workspace-level context here.
#
# Environment variables:
#   ARASHI_BRANCH_NAME         - Branch name being created
#   ARASHI_MAIN_REPO_PATH      - Configured workspace root
#   ARASHI_HOOK_EXECUTION_PATH - Workspace root (also the process cwd)
#
# Exit codes:
#   0 - Success, continue with worktree creation
#   Non-zero - Abort the coordinated create operation

set -e

# Lifecycle input is available only for an eligible human terminal invocation.
# ARASHI_HOOK_INPUT is always tty, disabled, or unavailable. TTY mode inherits
# terminal stdin; disabled and unavailable modes receive immediate EOF.
# --no-hook-input is invocation-only and does not replace --no-hooks or create's
# --interactive selection. --json takes precedence and selects disabled mode.
# Native examples use Bash read, PowerShell Read-Host, and cmd set /p.
# Do not enter a password, token, or other secret into lifecycle hook prompts.
if [ "\${ARASHI_HOOK_INPUT:-unavailable}" = "tty" ]; then
  printf 'Continue create? [y/N] '
  IFS= read -r answer
  [ "$answer" = "y" ] || exit 1
fi

echo "Pre-create hook: Validating branch name..."

# Example: Enforce branch naming convention
if [[ ! "$ARASHI_BRANCH_NAME" =~ ^(feature|bugfix|hotfix)/.+ ]]; then
  echo "Error: Branch name must start with feature/, bugfix/, or hotfix/"
  exit 1
fi

echo "Pre-create hook: Validation passed"
exit 0
`,
    filename: "pre-create.sh.example",
  },
  {
    content: `#!/usr/bin/env bash
# Post-Create Hook Example
#
# This workspace hook runs once after coordinated Git creation and before move/switch/launch.
#
# Environment variables:
#   ARASHI_BRANCH_NAME         - Branch name created
#   ARASHI_MAIN_REPO_PATH      - Configured workspace root
#   ARASHI_HOOK_EXECUTION_PATH - Workspace root (also the process cwd)
#
# Exit codes:
#   0 - Success
#   Non-zero - Fail the owning operation

set -e

echo "Post-create hook: Finalizing coordinated create..."

# Dependency setup belongs in post-create.<repo>.sh. Follow that repository's
# committed packageManager and lockfile; do not infer npm from package.json.

echo "Post-create hook: Finalization complete"
exit 0
`,
    filename: "post-create.sh.example",
  },
  {
    content: `#!/usr/bin/env bash
# Pre-Remove Hook Example
#
# This hook runs BEFORE remove operations start.
# Use it to stop related services/sessions or validate removal preconditions.
#
# Environment variables:
#   ARASHI_HOOK_NAME                 - Hook name (\`pre-remove\`)
#   ARASHI_MAIN_REPO_PATH            - Workspace root path
#   ARASHI_BRANCH_NAME               - Primary target branch (if available)
#   ARASHI_WORKTREE_PATH             - Primary target worktree path (if available)
#   ARASHI_REMOVE_TARGET_BRANCHES    - Comma-separated target branches
#   ARASHI_REMOVE_TARGET_WORKTREES   - Comma-separated target worktree paths
#   ARASHI_REMOVE_TARGET_REPOSITORIES - Comma-separated target repositories
#   ARASHI_REMOVE_TARGETS_JSON        - Canonical structured targets
#
# Exit codes:
#   0 - Success, continue removal
#   Non-zero - Abort remove command before destructive operations

set -e

echo "Pre-remove hook: preparing to remove worktrees"

# Parse ARASHI_REMOVE_TARGETS_JSON for command-wide cleanup. Scalar branch and
# worktree variables describe only this repository invocation and may be absent.
printf '%s\n' "$ARASHI_REMOVE_TARGETS_JSON"

exit 0
`,
    filename: "pre-remove.sh.example",
  },
  {
    content: `#!/usr/bin/env bash
# Post-Remove Hook Example
#
# This hook runs AFTER remove operations are attempted.
# Use it to finalize cleanup or trigger follow-up automation.
#
# Environment variables:
#   ARASHI_HOOK_NAME                 - Hook name (\`post-remove\`)
#   ARASHI_MAIN_REPO_PATH            - Workspace root path
#   ARASHI_BRANCH_NAME               - Primary target branch (if available)
#   ARASHI_WORKTREE_PATH             - Primary target worktree path (if available)
#   ARASHI_REMOVE_TARGET_BRANCHES    - Comma-separated target branches
#   ARASHI_REMOVE_TARGET_WORKTREES   - Comma-separated target worktree paths
#   ARASHI_REMOVE_TARGET_REPOSITORIES - Comma-separated target repositories
#   ARASHI_REMOVE_TARGETS_JSON        - Canonical structured targets
#
# Exit codes:
#   0 - Success
#   Non-zero - Mark remove command as failed

set -e

echo "Post-remove hook: cleanup complete for $ARASHI_REMOVE_TARGET_BRANCHES"
exit 0
`,
    filename: "post-remove.sh.example",
  },
  {
    content: `#!/usr/bin/env bash
# Repository-specific Pre-Create Example
# Runs after <repo>'s worktree is materialized and before its setup.
set -e
: "\${ARASHI_BRANCH_NAME:?missing branch}"
: "\${ARASHI_HOOK_TARGET_REPOSITORY:?missing target repository}"
: "\${ARASHI_HOOK_TARGET_WORKTREE_PATH:?missing target worktree}"
test "$PWD" = "$ARASHI_HOOK_TARGET_WORKTREE_PATH"
`,
    filename: "pre-create.<repo>.sh.example",
  },
  {
    content: `#!/usr/bin/env bash
# Repository-specific Post-Create Example
# Replace <repo> in the filename, then follow that repository's packageManager and lockfile.
set -e
: "\${ARASHI_HOOK_TARGET_WORKTREE_PATH:?missing target worktree}"
test "$PWD" = "$ARASHI_HOOK_TARGET_WORKTREE_PATH"
# For a pinned pnpm child in a coordinated workspace:
# CI=true corepack pnpm --ignore-workspace install --frozen-lockfile
`,
    filename: "post-create.<repo>.sh.example",
  },
  {
    content: `#!/usr/bin/env bash
# Setup Hook Example
#
# This setup script runs from the repository being set up. Setup discovery is
# separate from lifecycle hooks and does not promise lifecycle environment variables.
#
# Exit codes:
#   0 - Success
#   Non-zero - Fail the owning operation

set -e

echo "Setup hook: Initializing repository from $PWD..."

echo "Setup hook: Initialization complete"
exit 0
`,
    filename: "../setup.sh.example",
  },
];

const WINDOWS_LIFECYCLE_NAMES = [
  "pre-create",
  "post-create",
  "pre-remove",
  "post-remove",
  "pre-create.<repo>",
  "post-create.<repo>",
] as const;

const windowsHookContent = (hookName: (typeof WINDOWS_LIFECYCLE_NAMES)[number]): string => {
  const repositorySpecific = hookName.includes(".<repo>");
  const lifecycle = hookName.split(".")[0];
  const targetAssertions = repositorySpecific
    ? `$required = @("ARASHI_HOOK_TARGET_REPOSITORY", "ARASHI_HOOK_TARGET_REPO_PATH", "ARASHI_HOOK_TARGET_WORKTREE_PATH", "ARASHI_PARENT_REPO_PATH")\nforeach ($name in $required) { if (-not (Test-Path "Env:$name")) { throw "Missing $name" } }\nif ((Get-Location).Path -ne $env:ARASHI_HOOK_TARGET_WORKTREE_PATH) { throw "Unexpected hook cwd" }`
    : "# Workspace create hooks are untargeted; remove hooks receive one current target.";
  const packageExample =
    hookName === "post-create.<repo>"
      ? '# Follow the repository\'s committed packageManager and lockfile.\n# For a pinned pnpm child:\n# $env:CI = "true"\n# corepack pnpm --ignore-workspace install --frozen-lockfile'
      : "";
  const branchAssertion = lifecycle.includes("create")
    ? 'if (-not $env:ARASHI_BRANCH_NAME) { throw "Missing ARASHI_BRANCH_NAME" }'
    : "# Remove branch/worktree scalars are omitted when ambiguous; parse ARASHI_REMOVE_TARGETS_JSON.";
  return `# ${hookName} lifecycle hook example
# Copy this one file without .example to activate it.
$ErrorActionPreference = "Stop"
# ARASHI_HOOK_INPUT is tty, disabled, or unavailable. Only tty inherits terminal
# stdin; disabled and unavailable receive immediate EOF. --no-hook-input is
# invocation-only and does not skip hooks; --json takes precedence as disabled.
# Do not enter passwords or secrets into lifecycle hook prompts.
if ($env:ARASHI_HOOK_INPUT -eq "tty") { $answer = Read-Host "Continue $lifecycle? [y/N]"; if ($answer -ne "y") { exit 1 } }
${branchAssertion}
${targetAssertions}
${packageExample}
Write-Output "${lifecycle} hook complete"
`;
};

const windowsCmdHookContent = (hookName: (typeof WINDOWS_LIFECYCLE_NAMES)[number]): string => {
  const lifecycle = hookName.split(".")[0];
  return `@echo off
rem ${hookName} lifecycle hook example
rem ARASHI_HOOK_INPUT is tty, disabled, or unavailable. Only tty inherits terminal
rem stdin; disabled and unavailable receive immediate EOF. --no-hook-input is
rem invocation-only and does not skip hooks; --json takes precedence as disabled.
rem Do not enter passwords or secrets into lifecycle hook prompts.
if not "%ARASHI_HOOK_INPUT%"=="tty" goto arashi_hook_input_done
set "ARASHI_HOOK_ANSWER="
set /p "ARASHI_HOOK_ANSWER=Continue ${lifecycle}? [y/N] "
if /i not "%ARASHI_HOOK_ANSWER%"=="y" exit /b 1
:arashi_hook_input_done
echo ${lifecycle} hook complete
`;
};

export const getInitHookTemplates = (
  platform: NodeJS.Platform = process.platform,
): HookTemplate[] =>
  platform === "win32"
    ? WINDOWS_LIFECYCLE_NAMES.flatMap((hookName) => {
        const basename = hookName.replace(".<repo>", ".REPO");
        return [
          { content: windowsHookContent(hookName), filename: `${basename}.ps1.example` },
          { content: windowsCmdHookContent(hookName), filename: `${basename}.cmd.example` },
        ];
      })
    : POSIX_HOOK_TEMPLATES;

/**
 * Write hook template files to hooks directory
 */
const writeHookTemplates = async (hooksDir: string, templates: HookTemplate[]): Promise<void> => {
  for (const template of templates) {
    const templatePath = join(hooksDir, template.filename);

    if (!(await fileExists(templatePath))) {
      await writeTextFile(templatePath, template.content);

      addOperation({
        path: templatePath,
        rollback: async () => {
          const file = runtime.file(templatePath);
          if (await file.exists()) {
            await runtime.write(templatePath, "");
            await removeDir(templatePath);
          }
        },
        type: "WRITE_FILE",
      });
    }
  }
};

// ============================================================================
// Main Command Logic
// ============================================================================

/**
 * Execute init command
 */
export const executeInit = async (
  options: InitOptions,
  deps: InitDependencies = {},
): Promise<InitResult> => {
  const startTime = Date.now();
  const cwd = deps.cwd ?? process.cwd();
  const restoreIgnore = deps.restoreManagedIgnore ?? restoreManagedIgnore;
  const createDirectory = deps.ensureDir ?? ensureDir;
  const hookTemplates = getInitHookTemplates(deps.platform);
  let resolvedWorkspaceRoot = cwd;

  operations.length = ZERO;

  // Dry-run header
  if (options.dryRun && !options.quiet) {
    console.log("=== DRY RUN MODE ===");
    console.log("No changes will be made to the filesystem.\n");
  }

  try {
    const initRoot = await resolveInitRoot(cwd, options, deps);
    if ("success" in initRoot) {
      return initRoot;
    }

    const { repositoryType, workspaceRoot } = initRoot;
    resolvedWorkspaceRoot = workspaceRoot;

    // 2. Check if already initialized (without --force)
    logVerbose("Checking for existing Arashi configuration...", options);
    const hasExistingConfig = await configExists(workspaceRoot);
    if (
      !options.force &&
      hasExistingConfig &&
      options.ignoreScope !== undefined &&
      options.reposDir === undefined &&
      options.worktreesDir === undefined
    ) {
      const existingConfig = await loadConfig(workspaceRoot);
      const worktreesDir = existingConfig.worktreesDir ?? DEFAULT_WORKTREES_DIR;
      const managedIgnore = await reconcileRepositoryManagedIgnore({
        dryRun: options.dryRun,
        repositoryType,
        reposDir: existingConfig.reposDir,
        requestedScope: options.ignoreScope,
        workspaceRoot,
        worktreesDir,
      });
      return {
        configPath: getConfigPath(workspaceRoot),
        discoveredCount: Object.keys(existingConfig.repos).length,
        exitCode: ExitCode.SUCCESS,
        hooksPath: join(workspaceRoot, ".arashi", "hooks"),
        managedIgnore,
        preferenceOnly: true,
        reposPath: resolve(workspaceRoot, existingConfig.reposDir),
        success: true,
        worktreesDir,
        workspaceRoot,
      };
    }
    if (!options.force && hasExistingConfig) {
      const existingConfigPath = getConfigPath(workspaceRoot);
      return {
        error: `Arashi configuration already exists at: ${existingConfigPath}`,
        exitCode: ExitCode.CONFIG_EXISTS,
        success: false,
        workspaceRoot,
      };
    }

    // 3. Backup existing config if --force is used
    if (options.force && (await configExists(workspaceRoot))) {
      const existingConfigPath = getConfigPath(workspaceRoot);
      const timestamp = new Date()
        .toISOString()
        .replaceAll(/[:.]/g, "-")
        .split("T")
        .join("T")
        .slice(0, -5);
      const backupPath = `${existingConfigPath}.backup-${timestamp}`;

      if (options.dryRun) {
        logDryRun("BACKUP", `${existingConfigPath} → ${backupPath}`, options);
      } else {
        warn(EXISTING_CONFIG_WARNING);
        info(`Backing up: ${existingConfigPath} → ${backupPath}\n`);
        logVerbose("Reading existing configuration...", options);
        await readTextFile(existingConfigPath);
        logVerbose("Copying configuration to backup...", options);
        await copyFile(existingConfigPath, backupPath);
        logVerbose("✓ Backup created successfully", options);
      }
    } else {
      logVerbose("No existing configuration found", options);
    }

    // 4. Validate and resolve repos directory/worktree paths
    const reposDir = options.reposDir || "./repos";
    logVerbose(`Validating repos directory path: ${reposDir}`, options);

    if (!isValidPath(reposDir)) {
      if (initRoot.bootstrapped && !options.dryRun) {
        await executeRollback(options.quiet);
      }

      return {
        error: `Invalid repos directory path: ${reposDir}`,
        exitCode: ExitCode.INVALID_PATH,
        success: false,
        workspaceRoot,
      };
    }

    const absoluteReposPath = resolve(workspaceRoot, reposDir);
    logVerbose(`Resolved repos directory: ${absoluteReposPath}`, options);

    const rawWorktreesDir = options.worktreesDir;
    if (rawWorktreesDir !== undefined && !isValidPath(rawWorktreesDir)) {
      if (initRoot.bootstrapped && !options.dryRun) {
        await executeRollback(options.quiet);
      }

      return {
        error: `Invalid worktrees directory path: ${rawWorktreesDir}`,
        exitCode: ExitCode.INVALID_PATH,
        success: false,
        workspaceRoot,
      };
    }

    const omittedWorktreesDir = repositoryType === "bare" ? ".." : DEFAULT_WORKTREES_DIR;
    let worktreesDir = omittedWorktreesDir;
    try {
      worktreesDir = normalizeWorktreesDir(rawWorktreesDir ?? omittedWorktreesDir);
    } catch (error) {
      if (error instanceof WorktreeLocationValidationError) {
        if (initRoot.bootstrapped && !options.dryRun) {
          await executeRollback(options.quiet, error);
        }

        return {
          error: `Invalid worktrees directory path: ${rawWorktreesDir ?? omittedWorktreesDir} (${error.message})`,
          exitCode: ExitCode.INVALID_PATH,
          success: false,
          workspaceRoot,
        };
      }

      throw error;
    }
    logVerbose(`Resolved worktrees directory: ${resolve(workspaceRoot, worktreesDir)}`, options);

    // Reconcile before any managed directories are materialized.
    logVerbose("Reconciling managed Git ignore rules...", options);
    const managedIgnore =
      options.dryRun && initRoot.bootstrapped
        ? previewBootstrapManagedIgnore(workspaceRoot, reposDir, worktreesDir, options.ignoreScope)
        : await reconcileRepositoryManagedIgnore({
            dryRun: options.dryRun,
            repositoryType,
            reposDir,
            requestedScope: options.ignoreScope,
            workspaceRoot,
            worktreesDir,
          });
    if (options.dryRun && managedIgnore.targetPath) {
      logDryRun(
        "UPDATE_FILE",
        `${managedIgnore.targetPath} (add: ${managedIgnore.plannedRules.join(", ")})`,
        options,
      );
    }
    if (options.dryRun && !options.quiet) {
      for (const path of managedIgnore.paths) {
        if (path.status === "non-applicable") {
          logDryRun("MANAGED_PATH", `${path.input} (non-applicable in bare repository)`, options);
        } else if (path.status === "unsafe") {
          logDryRun("MANAGED_PATH", `${path.input} (unsafe: ${path.safetyReason})`, options);
        }
      }
    }
    logVerbose("✓ Managed Git ignore rules reconciled", options);
    if (!options.dryRun && managedIgnore.attempted) {
      addOperation({
        path: managedIgnore.targetPath ?? "clone-local arashi.ignoreScope",
        rollback: async () => {
          await restoreIgnore(managedIgnore);
        },
        shouldRollback: async () => {
          const applicablePaths = managedIgnore.paths.filter((path) => path.safety === "safe");
          for (const path of applicablePaths) {
            if (await fileExists(resolve(workspaceRoot, path.input))) {
              return false;
            }
          }
          return true;
        },
        type: "MANAGED_IGNORE",
      });
    }

    // 5. Create .arashi directory
    const arashiDir = join(workspaceRoot, ".arashi");

    if (options.dryRun) {
      logDryRun("CREATE_DIR", arashiDir, options);
    } else {
      logVerbose(`Creating .arashi directory: ${arashiDir}`, options);
      try {
        const existedBefore = await fileExists(arashiDir);
        await createDirectory(arashiDir);
        if (!existedBefore) {
          addOperation({
            path: arashiDir,
            rollback: async () => {
              await removeDir(arashiDir);
            },
            type: "CREATE_DIR",
          });
        }
        logVerbose("✓ .arashi directory created", options);
      } catch (error) {
        await executeRollback(options.quiet, error);
        if (error instanceof PermissionError) {
          return {
            error: `Permission denied creating directory: ${arashiDir}`,
            exitCode: ExitCode.PERMISSION_DENIED,
            success: false,
            workspaceRoot,
          };
        }
        throw error;
      }
    }

    // 6. Create hooks directory
    const hooksDir = join(arashiDir, "hooks");

    if (options.dryRun) {
      logDryRun("CREATE_DIR", hooksDir, options);
    } else {
      logVerbose(`Creating hooks directory: ${hooksDir}`, options);
      try {
        const existedBefore = await fileExists(hooksDir);
        await createDirectory(hooksDir);
        if (!existedBefore) {
          addOperation({
            path: hooksDir,
            rollback: async () => {
              await removeDir(hooksDir);
            },
            type: "CREATE_DIR",
          });
        }
        logVerbose("✓ Hooks directory created", options);
      } catch (error) {
        await executeRollback(options.quiet, error);
        if (error instanceof PermissionError) {
          return {
            error: `Permission denied creating hooks directory: ${hooksDir}`,
            exitCode: ExitCode.PERMISSION_DENIED,
            success: false,
            workspaceRoot,
          };
        }
        throw error;
      }
    }

    // 7. Write hook templates
    if (options.dryRun) {
      for (const template of hookTemplates) {
        const templatePath = join(hooksDir, template.filename);
        logDryRun("WRITE_FILE", `${templatePath} (${template.content.length} bytes)`, options);
      }
    } else {
      logVerbose(`Writing ${hookTemplates.length} hook templates...`, options);
      try {
        await writeHookTemplates(hooksDir, hookTemplates);
        logVerbose("✓ Hook templates written", options);
      } catch (error) {
        await executeRollback(options.quiet, error);
        if (error instanceof PermissionError || error instanceof DiskFullError) {
          return {
            error: `Failed to write hook templates: ${(error as Error).message}`,
            exitCode:
              error instanceof DiskFullError ? ExitCode.DISK_FULL : ExitCode.PERMISSION_DENIED,
            success: false,
            workspaceRoot,
          };
        }
        throw error;
      }
    }

    // 8. Create repos directory
    if (options.dryRun) {
      logDryRun("CREATE_DIR", absoluteReposPath, options);
    } else {
      logVerbose(`Creating repos directory: ${absoluteReposPath}`, options);
      try {
        const existedBefore = await fileExists(absoluteReposPath);
        await createDirectory(absoluteReposPath);
        if (!existedBefore) {
          addOperation({
            path: absoluteReposPath,
            rollback: async () => {
              await removeDir(absoluteReposPath);
            },
            type: "CREATE_DIR",
          });
        }
        logVerbose("✓ Repos directory created", options);
      } catch (error) {
        await executeRollback(options.quiet, error);
        if (error instanceof PermissionError) {
          return {
            error: `Permission denied creating repos directory: ${absoluteReposPath}`,
            exitCode: ExitCode.PERMISSION_DENIED,
            success: false,
            workspaceRoot,
          };
        } else if (error instanceof DiskFullError) {
          return {
            error: `Insufficient disk space creating repos directory: ${absoluteReposPath}`,
            exitCode: ExitCode.DISK_FULL,
            success: false,
            workspaceRoot,
          };
        }
        throw error;
      }
    }

    // 9. Discover repositories (unless --no-discover)
    let discoveredCount = 0;
    const discoveredRepos: Record<string, RepoConfig> = {};

    if (options.noDiscover) {
      logVerbose("Skipping repository discovery (--no-discover)", options);
    } else if (options.dryRun) {
      logDryRun("DISCOVER", `Scan ${reposDir} for git repositories`, options);
      discoveredCount = 0; // Can't discover in dry-run mode
    } else {
      logVerbose(`Discovering repositories in: ${reposDir}`, options);
      try {
        const discoveryResult = await discoverRepositories(absoluteReposPath);
        discoveredCount = discoveryResult.repositories.length;
        logVerbose(`✓ Found ${discoveredCount} repositories`, options);
        collectDiscoveredRepos(discoveredRepos, options, discoveryResult.repositories);
      } catch (error) {
        await executeRollback(options.quiet, error);
        return {
          error: `Repository discovery failed: ${(error as Error).message}`,
          exitCode: ExitCode.DISCOVERY_FAILED,
          success: false,
          workspaceRoot,
        };
      }
    }

    // 10. Generate and write config
    const arashiConfig: Config = {
      $schema: DEFAULT_CONFIG_SCHEMA_URL,
      repos: discoveredRepos,
      reposDir: reposDir,
      version: "1.0.0",
      worktreesDir,
    };

    const configPath = getConfigPath(workspaceRoot);
    if (options.dryRun) {
      logDryRun("WRITE_FILE", `${configPath}`, options);
      if (!options.quiet) {
        console.log("\nConfiguration preview:");
        console.log(JSON.stringify(arashiConfig, null, JSON_INDENT));
      }
    } else {
      logVerbose("Writing configuration file...", options);
      try {
        await saveConfig(workspaceRoot, arashiConfig);

        addOperation({
          path: configPath,
          rollback: async () => {
            const file = runtime.file(configPath);
            if (await file.exists()) {
              await runtime.write(configPath, "");
              await removeDir(configPath);
            }
          },
          type: "WRITE_FILE",
        });
        logVerbose("✓ Configuration written", options);
      } catch (error) {
        await executeRollback(options.quiet, error);
        if (error instanceof PermissionError || error instanceof DiskFullError) {
          return {
            error: `Failed to write configuration: ${(error as Error).message}`,
            exitCode:
              error instanceof DiskFullError ? ExitCode.DISK_FULL : ExitCode.CONFIG_WRITE_FAILED,
            success: false,
            workspaceRoot,
          };
        }
        throw error;
      }
    }

    // 11. Success!
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logVerbose(`Initialization completed in ${duration}s`, options);

    if (options.dryRun && !options.quiet) {
      console.log("\n=== DRY RUN COMPLETE ===");
      console.log("No changes were made. Run without --dry-run to apply.");
    }

    operations.length = ZERO;

    return {
      configPath: configPath,
      discoveredCount,
      exitCode: ExitCode.SUCCESS,
      hooksPath: hooksDir,
      managedIgnore,
      reposPath: absoluteReposPath,
      success: true,
      worktreesDir,
      workspaceRoot,
    };
  } catch (error) {
    // Unexpected error - rollback and preserve both failures when cleanup is incomplete.
    let reportedError = error;
    if (!options.dryRun) {
      try {
        await executeRollback(options.quiet, error);
      } catch (rollbackError) {
        reportedError = rollbackError;
      }
    }
    const structuredError = unknownErrorToJsonError(reportedError);

    return {
      error: `Unexpected error: ${(reportedError as Error).message}`,
      exitCode: ExitCode.UNKNOWN,
      ...(structuredError.code === "MANAGED_IGNORE_RECONCILIATION_FAILED"
        ? { managedIgnoreFailure: structuredError }
        : {}),
      ...(structuredError.code === "INIT_ROLLBACK_FAILED"
        ? { rollbackFailure: structuredError }
        : {}),
      ...(structuredError.code === "INIT_REPOSITORY_CLASSIFICATION_FAILED"
        ? { resolutionFailure: structuredError }
        : {}),
      success: false,
      workspaceRoot: resolvedWorkspaceRoot,
    };
  }
};

/**
 * Display success message with details
 */
const displaySuccess = (result: InitResult, options: InitOptions): void => {
  success(
    result.preferenceOnly ? "Updated managed ignore preference" : "Initialized Arashi workspace",
  );

  console.log("\nCreated:");
  console.log(`  • Configuration: ${result.configPath}`);
  console.log(`  • Hooks directory: ${result.hooksPath}`);
  console.log(`  • Repositories directory: ${result.reposPath}`);
  console.log(`  • Worktrees directory: ${result.worktreesDir}`);

  if (result.workspaceRoot && result.workspaceRoot !== process.cwd()) {
    const changeDirTarget = relative(process.cwd(), result.workspaceRoot) || ".";
    console.log(`  • Workspace root: ${result.workspaceRoot}`);
    console.log(`  • Change into workspace: cd ${changeDirTarget}`);
  }

  if (options.noDiscover) {
    console.log("\nDiscovery skipped (--no-discover)");
  } else {
    console.log(`\nDiscovered ${result.discoveredCount} repositories`);
  }

  if (result.managedIgnore) {
    console.log(`\nManaged ignore scope: ${result.managedIgnore.scope}`);
    for (const path of result.managedIgnore.paths) {
      if (path.status === "unsafe") {
        console.log(`  • Skipped unsafe path: ${path.input} (${path.safetyReason})`);
      } else if (path.status === "non-applicable") {
        console.log(`  • Non-applicable bare path: ${path.input}`);
      } else if (path.source) {
        console.log(
          `  • ${path.rule}: already ignored by ${path.source.type} (${path.source.path})`,
        );
      } else {
        console.log(`  • ${path.rule}: ${path.status}`);
      }
    }
    for (const warning of result.managedIgnore.warnings) {
      warn(warning);
    }
  }

  console.log("\nNext steps:");
  if (result.discoveredCount && result.discoveredCount > 0) {
    console.log("  • Create a worktree: arashi create <branch-name>");
  } else {
    console.log("  • Add repositories: arashi add <path>");
  }
  console.log("  • View configuration: cat .arashi/config.json");
  if (process.platform === "win32") {
    console.log(
      "  • Activate one lifecycle hook: Copy-Item .arashi/hooks/pre-create.ps1.example .arashi/hooks/pre-create.ps1",
    );
    console.log(
      "  • Setup remains POSIX-only; see docs/commands/init.md for current setup support",
    );
  } else {
    console.log(
      "  • Activate one lifecycle hook: install -m 755 .arashi/hooks/pre-create.sh.example .arashi/hooks/pre-create.sh",
    );
    console.log("  • Activate setup: install -m 755 .arashi/setup.sh.example .arashi/setup.sh");
  }
};

/**
 * Display error message with guidance
 */
const displayError = (result: InitResult): void => {
  logError(result.error || "Unknown error");

  switch (result.exitCode) {
    case ExitCode.NOT_GIT_REPOSITORY: {
      console.log("\nThe current directory is not a git repository.");
      console.log(
        "Run this command in an interactive terminal to let Arashi bootstrap a repository, or run 'git init' manually.",
      );
      break;
    }

    case ExitCode.CANCELLED: {
      console.log("\nNo repository or Arashi workspace was created.");
      break;
    }

    case ExitCode.CONFIG_EXISTS: {
      console.log("\nTo reinitialize, use: arashi init --force");
      console.log("This will backup your existing configuration.");
      break;
    }

    case ExitCode.PERMISSION_DENIED: {
      console.log("\nCheck directory permissions and try again.");
      break;
    }

    case ExitCode.DISK_FULL: {
      console.log("\nFree up disk space and try again.");
      break;
    }

    case ExitCode.INVALID_PATH: {
      console.log("\nUse a valid relative or absolute path.");
      console.log("For repo bootstrap, use '.' or a direct child directory name.");
      break;
    }

    case ExitCode.CONFIG_WRITE_FAILED: {
      console.log("\nCheck permissions and disk space.");
      break;
    }

    case ExitCode.DISCOVERY_FAILED: {
      console.log("\nUse --no-discover to skip discovery, or fix the error and try again.");
      break;
    }
  }
};

// ============================================================================
// Command Definition
// ============================================================================

export function createCommand(): Command {
  return new Command("init")
    .description("Initialize Arashi workspace in the current repository or bootstrap a new one")
    .option("--repos-dir <path>", "Custom location for managed repositories")
    .option(
      "--worktrees-dir <path>",
      "Custom worktree base (default: .. for bare repositories; .arashi/worktrees otherwise)",
    )
    .addOption(
      new Option(
        "--ignore-scope <scope>",
        "Managed Git ignore scope: local (default), tracked, or none",
      ).choices(["local", "tracked", "none"]),
    )
    .option("--zero-config", "Prepare implicit standalone mode without creating configuration")
    .option("-f, --force", "Overwrite existing configuration if present")
    .option("--no-discover", "Skip automatic repository discovery")
    .option("-n, --dry-run", "Show what would be done without making changes")
    .option("-v, --verbose", "Show detailed information during initialization")
    .option("-j, --json", "Output result as JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi init --zero-config           # Standalone .worktrees/ convention only
  $ arashi init                         # Local info/exclude rules (default)
  $ arashi init --ignore-scope tracked  # Team-owned .gitignore block
  $ arashi init --ignore-scope none     # Manual ignore management
  $ arashi init --ignore-scope local    # Reset an existing clone to the default

Existing effective tracked, local, or global rules are honored. Arashi never modifies global Git configuration.
      `,
    )
    .action(async (options: InitOptions & { discover?: boolean; json?: boolean }) => {
      if (options.zeroConfig) {
        const conflicts = [
          options.reposDir !== undefined ? "--repos-dir" : undefined,
          options.worktreesDir !== undefined ? "--worktrees-dir" : undefined,
          options.ignoreScope !== undefined ? "--ignore-scope" : undefined,
          options.force ? "--force" : undefined,
          options.discover === false ? "--no-discover" : undefined,
        ].filter((value): value is string => value !== undefined);

        if (conflicts.length > ZERO) {
          const conflictError = new Error(
            `--zero-config is incompatible with ${conflicts.join(", ")}.`,
          );
          if (options.json) {
            writeJsonEnvelope(
              createJsonErrorEnvelope("init", {
                code: "ZERO_CONFIG_INCOMPATIBLE_OPTIONS",
                details: {
                  attempted: { localExclude: false, worktreesDirectory: false },
                  conflicts,
                  finalState: {
                    localExcludeChanged: false,
                    worktreesDirectoryChanged: false,
                  },
                  mode: "standalone",
                },
                message: conflictError.message,
              }),
            );
          } else {
            logError(conflictError.message);
          }
          process.exit(ExitCode.INVALID_PATH);
        }

        let zeroConfigResult: ZeroConfigBootstrapResult;
        try {
          zeroConfigResult = await bootstrapZeroConfig(process.cwd(), {
            dryRun: options.dryRun,
          });
        } catch (bootstrapError) {
          if (options.json) {
            writeJsonEnvelope(
              createJsonErrorEnvelope(
                "init",
                unknownErrorToJsonError(bootstrapError, "ZERO_CONFIG_BOOTSTRAP_FAILED"),
              ),
            );
          } else {
            logError((bootstrapError as Error).message);
          }
          process.exit(ExitCode.NOT_GIT_REPOSITORY);
        }

        if (options.json) {
          writeJsonEnvelope(
            createJsonSuccessEnvelope(
              "init",
              zeroConfigResult as unknown as Record<string, unknown>,
            ),
          );
        } else if (options.dryRun) {
          info("Standalone zero-config bootstrap (dry run)");
          console.log(`  • .worktrees directory: ${zeroConfigResult.worktreesDirectory.path}`);
          console.log(`  • Local exclude rule: ${zeroConfigResult.localExclude.rule}`);
          console.log("No changes were made.");
        } else {
          success("Initialized standalone zero-config workspace");
          console.log(`  • Worktrees: ${zeroConfigResult.worktreesDirectory.path}`);
          console.log(`  • Local exclude: ${zeroConfigResult.localExclude.path}`);
          console.log("  • Create a worktree: arashi create <branch-name>");
          console.log("  • Upgrade for coordination: arashi init");
        }
        process.exit(ExitCode.SUCCESS);
      }

      // Commander converts --no-discover to discover: false
      const normalizedOptions: InitOptions = {
        dryRun: options.dryRun,
        force: options.force,
        ignoreScope: options.ignoreScope,
        noDiscover: options.discover === false, // --no-discover sets discover: false
        quiet: options.json,
        reposDir: options.reposDir,
        verbose: options.json ? false : options.verbose,
        worktreesDir: options.worktreesDir,
      };

      const result = await executeInit(normalizedOptions).catch((error): never => {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("init", unknownErrorToJsonError(error)));
          process.exit(ExitCode.UNKNOWN);
        }
        throw error;
      });

      if (result.success) {
        if (options.json) {
          writeJsonEnvelope(createJsonSuccessEnvelope("init", { ...result }));
        } else if (!options.dryRun) {
          displaySuccess(result, normalizedOptions);
        }
        process.exit(ExitCode.SUCCESS);
      } else {
        if (options.json) {
          writeJsonEnvelope(
            createJsonErrorEnvelope(
              "init",
              result.managedIgnoreFailure ??
                result.rollbackFailure ??
                result.resolutionFailure ?? {
                  code: `INIT_${result.exitCode}`,
                  details: { exitCode: result.exitCode, workspaceRoot: result.workspaceRoot },
                  message: result.error || "Unknown error",
                },
            ),
          );
        } else {
          displayError(result);
        }
        process.exit(result.exitCode);
      }
    });
}

export default createCommand;
