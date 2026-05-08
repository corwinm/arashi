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
  saveConfig,
} from "../lib/config.ts";
import {
  DEFAULT_WORKTREES_DIR,
  DEFAULT_WORKTREES_GITIGNORE_ENTRY,
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
import { info, error as logError, success, warn } from "../lib/logger.ts";
import { isAbsolute, join, relative, resolve } from "path";
import { Command } from "commander";
import { discoverRepositories } from "../core/repository.ts";
import { exec as gitExec } from "../lib/git.ts";

type Config = Parameters<typeof saveConfig>[1];
type RepoConfig = Config["repos"][string];
type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason: "exit" | "abort" };

const ZERO = 0;
const JSON_INDENT = 2;
const PATH_MAX_LENGTH = 4096;
const EXISTING_CONFIG_WARNING = "\n⚠ Warning: Existing configuration will be backed up";

// ============================================================================
// Data Types
// ============================================================================

interface InitOptions {
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

  /** Override stdin tty detection for tests */
  stdinIsTTY?: boolean;
}

interface HookTemplate {
  /** Hook filename (e.g., 'pre-create.sh.example') */
  filename: string;

  /** Hook script content */
  content: string;
}

type OperationType = "CREATE_DIR" | "WRITE_FILE" | "MODIFY_FILE" | "BACKUP_FILE";

interface Operation {
  /** Type of operation performed */
  type: OperationType;

  /** Path affected by operation */
  path: string;

  /** Original content (for MODIFY_FILE) */
  originalContent?: string;

  /** Rollback function */
  rollback: () => Promise<void>;
}

interface InitResolution {
  bootstrapTarget?: string;
  bootstrapped: boolean;
  workspaceRoot: string;
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

/**
 * Add an operation to the rollback stack
 */
const addOperation = (operation: Operation): void => {
  operations.push(operation);
};

/**
 * Execute rollback of all tracked operations in LIFO order
 */
const executeRollback = async (): Promise<void> => {
  info("\nRolling back changes...");

  const reversedOps = [...operations];
  reversedOps.reverse();

  for (const op of reversedOps) {
    try {
      await op.rollback();
      info(`  • Rolled back: ${op.path}`);
    } catch (error) {
      warn(`  • Failed to rollback: ${op.path} - ${(error as Error).message}`);
    }
  }

  operations.length = ZERO;
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

const resolveInitRoot = async (
  cwd: string,
  options: InitOptions,
  deps: InitDependencies,
): Promise<InitResolution | InitResult> => {
  const runGit = deps.gitExec ?? gitExec;
  const promptConfirm = deps.promptConfirm ?? confirm;
  const promptInput = deps.promptInput ?? input;

  logVerbose("Checking if current directory is a git repository...", options);
  try {
    await runGit(["rev-parse", "--git-dir"], cwd);
    logVerbose(`✓ Confirmed git repository at: ${cwd}`, options);
    return {
      bootstrapped: false,
      workspaceRoot: cwd,
    };
  } catch {
    logVerbose(`Current directory is not a git repository: ${cwd}`, options);
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
      logDryRun("CREATE_DIR", workspaceRoot);
    }
    logDryRun("GIT_INIT", workspaceRoot);
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
const logDryRun = (action: string, details: string): void => {
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

const HOOK_TEMPLATES: HookTemplate[] = [
  {
    content: `#!/usr/bin/env bash
# Pre-Create Hook Example
#
# This hook runs BEFORE creating a worktree in each repository.
# Use it to validate preconditions or prepare the environment.
#
# Environment variables:
#   ARASHI_BRANCH     - Branch name being created
#   ARASHI_REPO_NAME  - Repository name
#   ARASHI_REPO_PATH  - Repository path
#
# Exit codes:
#   0 - Success, continue with worktree creation
#   Non-zero - Abort worktree creation for this repository

set -e

echo "Pre-create hook: Validating branch name..."

# Example: Enforce branch naming convention
if [[ ! "$ARASHI_BRANCH" =~ ^(feature|bugfix|hotfix)/.+ ]]; then
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
# This hook runs AFTER successfully creating a worktree in each repository.
# Use it to perform setup tasks like installing dependencies or running scripts.
#
# Environment variables:
#   ARASHI_BRANCH       - Branch name created
#   ARASHI_REPO_NAME    - Repository name
#   ARASHI_REPO_PATH    - Repository path
#   ARASHI_WORKTREE_PATH - Worktree path
#
# Exit codes:
#   0 - Success
#   Non-zero - Warning logged, does not abort operation

set -e

echo "Post-create hook: Setting up worktree..."

# Example: Install dependencies
cd "$ARASHI_WORKTREE_PATH"

if [ -f "package.json" ]; then
  echo "Installing npm dependencies..."
  npm install
fi

if [ -f "Gemfile" ]; then
  echo "Installing ruby gems..."
  bundle install
fi

echo "Post-create hook: Setup complete"
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
#
# Exit codes:
#   0 - Success, continue removal
#   Non-zero - Abort remove command before destructive operations

set -e

echo "Pre-remove hook: preparing to remove worktrees"

# Example: stop a tmux session tied to branch name
if [ -n "$ARASHI_BRANCH_NAME" ]; then
  tmux has-session -t "$ARASHI_BRANCH_NAME" 2>/dev/null && tmux kill-session -t "$ARASHI_BRANCH_NAME" || true
fi

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
# Setup Hook Example
#
# This hook runs during repository initialization.
# Use it to perform one-time setup tasks for newly discovered repositories.
#
# Environment variables:
#   ARASHI_REPO_NAME    - Repository name
#   ARASHI_REPO_PATH    - Repository path
#
# Exit codes:
#   0 - Success
#   Non-zero - Warning logged, does not abort operation

set -e

echo "Setup hook: Initializing repository..."

cd "$ARASHI_REPO_PATH"

# Example: Configure git settings
git config core.hooksPath .arashi/hooks

echo "Setup hook: Initialization complete"
exit 0
`,
    filename: "setup.sh.example",
  },
];

/**
 * Write hook template files to hooks directory
 */
const writeHookTemplates = async (hooksDir: string): Promise<void> => {
  for (const template of HOOK_TEMPLATES) {
    const templatePath = join(hooksDir, template.filename);

    if (!(await fileExists(templatePath))) {
      await writeTextFile(templatePath, template.content);

      addOperation({
        path: templatePath,
        rollback: async () => {
          const file = Bun.file(templatePath);
          if (await file.exists()) {
            await Bun.write(templatePath, "");
            await removeDir(templatePath);
          }
        },
        type: "WRITE_FILE",
      });
    }
  }
};

// ============================================================================
// Gitignore Helper
// ============================================================================

/**
 * Update .gitignore to exclude managed directories (idempotent)
 */
const normalizeGitignorePattern = (directoryPath: string): string => {
  let pattern = directoryPath.replace(/^\.\//, "");
  if (!pattern.endsWith("/")) {
    pattern += "/";
  }
  return pattern;
};

const hasGitignorePattern = (content: string, pattern: string): boolean => {
  const alternate = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  return content
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === pattern || line === alternate);
};

const getManagedWorktreesGitignorePattern = (worktreesDir: string): string | undefined => {
  const normalizedWorktreesDir = normalizeWorktreesDir(worktreesDir);

  if (
    normalizedWorktreesDir === "." ||
    normalizedWorktreesDir === ".." ||
    normalizedWorktreesDir.startsWith("../")
  ) {
    return undefined;
  }

  if (normalizedWorktreesDir === DEFAULT_WORKTREES_DIR) {
    return DEFAULT_WORKTREES_GITIGNORE_ENTRY;
  }

  return normalizeGitignorePattern(normalizedWorktreesDir);
};

const getManagedGitignorePatterns = (reposDir: string, worktreesDir: string): string[] => {
  const patterns = [normalizeGitignorePattern(reposDir)];
  const worktreesPattern = getManagedWorktreesGitignorePattern(worktreesDir);
  if (worktreesPattern) {
    patterns.push(worktreesPattern);
  }

  return patterns;
};

const updateGitignore = async (
  cwd: string,
  reposDir: string,
  worktreesDir: string,
): Promise<void> => {
  const gitignorePath = join(cwd, ".gitignore");
  const patterns = getManagedGitignorePatterns(reposDir, worktreesDir);

  let content = "";
  let originalContent: string | undefined = undefined;

  if (await fileExists(gitignorePath)) {
    originalContent = await readTextFile(gitignorePath);
    content = originalContent;
  }

  const missingPatterns = patterns.filter((pattern) => !hasGitignorePattern(content, pattern));
  if (missingPatterns.length === 0) {
    return;
  }

  if (content && !content.endsWith("\n")) {
    content += "\n";
  }

  content += "\n# Arashi managed repositories\n";
  for (const pattern of missingPatterns) {
    content += `${pattern}\n`;
  }

  await writeTextFile(gitignorePath, content);

  if (originalContent === undefined) {
    addOperation({
      path: gitignorePath,
      rollback: async () => {
        const file = Bun.file(gitignorePath);
        if (await file.exists()) {
          await Bun.write(gitignorePath, "");
          await removeDir(gitignorePath);
        }
      },
      type: "WRITE_FILE",
    });
  } else {
    addOperation({
      originalContent,
      path: gitignorePath,
      rollback: async () => {
        await writeTextFile(gitignorePath, originalContent);
      },
      type: "MODIFY_FILE",
    });
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

  operations.length = ZERO;

  // Dry-run header
  if (options.dryRun) {
    console.log("=== DRY RUN MODE ===");
    console.log("No changes will be made to the filesystem.\n");
  }

  try {
    const initRoot = await resolveInitRoot(cwd, options, deps);
    if ("success" in initRoot) {
      return initRoot;
    }

    const { workspaceRoot } = initRoot;

    // 2. Check if already initialized (without --force)
    logVerbose("Checking for existing Arashi configuration...", options);
    if (!options.force && (await configExists(workspaceRoot))) {
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
        logDryRun("BACKUP", `${existingConfigPath} → ${backupPath}`);
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
        await executeRollback();
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
        await executeRollback();
      }

      return {
        error: `Invalid worktrees directory path: ${rawWorktreesDir}`,
        exitCode: ExitCode.INVALID_PATH,
        success: false,
        workspaceRoot,
      };
    }

    let worktreesDir = DEFAULT_WORKTREES_DIR;
    try {
      worktreesDir = normalizeWorktreesDir(rawWorktreesDir ?? DEFAULT_WORKTREES_DIR);
    } catch (error) {
      if (error instanceof WorktreeLocationValidationError) {
        if (initRoot.bootstrapped && !options.dryRun) {
          await executeRollback();
        }

        return {
          error: `Invalid worktrees directory path: ${rawWorktreesDir ?? DEFAULT_WORKTREES_DIR} (${error.message})`,
          exitCode: ExitCode.INVALID_PATH,
          success: false,
          workspaceRoot,
        };
      }

      throw error;
    }
    logVerbose(`Resolved worktrees directory: ${resolve(workspaceRoot, worktreesDir)}`, options);

    // 5. Create .arashi directory
    const arashiDir = join(workspaceRoot, ".arashi");

    if (options.dryRun) {
      logDryRun("CREATE_DIR", arashiDir);
    } else {
      logVerbose(`Creating .arashi directory: ${arashiDir}`, options);
      try {
        await ensureDir(arashiDir);
        addOperation({
          path: arashiDir,
          rollback: async () => {
            await removeDir(arashiDir);
          },
          type: "CREATE_DIR",
        });
        logVerbose("✓ .arashi directory created", options);
      } catch (error) {
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
      logDryRun("CREATE_DIR", hooksDir);
    } else {
      logVerbose(`Creating hooks directory: ${hooksDir}`, options);
      try {
        await ensureDir(hooksDir);
        addOperation({
          path: hooksDir,
          rollback: async () => {
            await removeDir(hooksDir);
          },
          type: "CREATE_DIR",
        });
        logVerbose("✓ Hooks directory created", options);
      } catch (error) {
        await executeRollback();
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
      for (const template of HOOK_TEMPLATES) {
        const templatePath = join(hooksDir, template.filename);
        logDryRun("WRITE_FILE", `${templatePath} (${template.content.length} bytes)`);
      }
    } else {
      logVerbose(`Writing ${HOOK_TEMPLATES.length} hook templates...`, options);
      try {
        await writeHookTemplates(hooksDir);
        logVerbose("✓ Hook templates written", options);
      } catch (error) {
        await executeRollback();
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
      logDryRun("CREATE_DIR", absoluteReposPath);
    } else {
      logVerbose(`Creating repos directory: ${absoluteReposPath}`, options);
      try {
        await ensureDir(absoluteReposPath);
        addOperation({
          path: absoluteReposPath,
          rollback: async () => {
            await removeDir(absoluteReposPath);
          },
          type: "CREATE_DIR",
        });
        logVerbose("✓ Repos directory created", options);
      } catch (error) {
        await executeRollback();
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
      logDryRun("DISCOVER", `Scan ${reposDir} for git repositories`);
      discoveredCount = 0; // Can't discover in dry-run mode
    } else {
      logVerbose(`Discovering repositories in: ${reposDir}`, options);
      try {
        const discoveryResult = await discoverRepositories(absoluteReposPath);
        discoveredCount = discoveryResult.repositories.length;
        logVerbose(`✓ Found ${discoveredCount} repositories`, options);
        collectDiscoveredRepos(discoveredRepos, options, discoveryResult.repositories);
      } catch (error) {
        await executeRollback();
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
      logDryRun("WRITE_FILE", `${configPath}`);
      console.log("\nConfiguration preview:");
      console.log(JSON.stringify(arashiConfig, null, JSON_INDENT));
    } else {
      logVerbose("Writing configuration file...", options);
      try {
        await saveConfig(workspaceRoot, arashiConfig);

        addOperation({
          path: configPath,
          rollback: async () => {
            const file = Bun.file(configPath);
            if (await file.exists()) {
              await Bun.write(configPath, "");
              await removeDir(configPath);
            }
          },
          type: "WRITE_FILE",
        });
        logVerbose("✓ Configuration written", options);
      } catch (error) {
        await executeRollback();
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

    // 11. Update .gitignore
    const gitignorePath = join(workspaceRoot, ".gitignore");
    const managedPatterns = getManagedGitignorePatterns(reposDir, worktreesDir);
    if (options.dryRun) {
      logDryRun("UPDATE_FILE", `${gitignorePath} (add: ${managedPatterns.join(", ")})`);
    } else {
      logVerbose("Updating .gitignore...", options);
      try {
        await updateGitignore(workspaceRoot, reposDir, worktreesDir);
        logVerbose("✓ .gitignore updated", options);
      } catch (error) {
        await executeRollback();
        if (error instanceof PermissionError) {
          return {
            error: `Failed to update .gitignore: ${(error as Error).message}`,
            exitCode: ExitCode.PERMISSION_DENIED,
            success: false,
            workspaceRoot,
          };
        }
        throw error;
      }
    }

    // 12. Success!
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logVerbose(`Initialization completed in ${duration}s`, options);

    if (options.dryRun) {
      console.log("\n=== DRY RUN COMPLETE ===");
      console.log("No changes were made. Run without --dry-run to apply.");
    }

    operations.length = ZERO;

    return {
      configPath: configPath,
      discoveredCount,
      exitCode: ExitCode.SUCCESS,
      hooksPath: hooksDir,
      reposPath: absoluteReposPath,
      success: true,
      workspaceRoot,
    };
  } catch (error) {
    // Unexpected error - rollback and exit
    if (!options.dryRun) {
      await executeRollback();
    }

    return {
      error: `Unexpected error: ${(error as Error).message}`,
      exitCode: ExitCode.UNKNOWN,
      success: false,
      workspaceRoot: cwd,
    };
  }
};

/**
 * Display success message with details
 */
const displaySuccess = (result: InitResult, options: InitOptions): void => {
  success("Initialized Arashi workspace");

  console.log("\nCreated:");
  console.log(`  • Configuration: ${result.configPath}`);
  console.log(`  • Hooks directory: ${result.hooksPath}`);
  console.log(`  • Repositories directory: ${result.reposPath}`);

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

  const reposDir = options.reposDir || "./repos";
  const worktreesDir = options.worktreesDir || DEFAULT_WORKTREES_DIR;
  const managedPatterns = getManagedGitignorePatterns(reposDir, worktreesDir);
  console.log(`\nUpdated .gitignore to exclude: ${managedPatterns[0]}`);
  for (const pattern of managedPatterns.slice(1)) {
    console.log(`  • ${pattern}`);
  }

  console.log("\nNext steps:");
  if (result.discoveredCount && result.discoveredCount > 0) {
    console.log("  • Create a worktree: arashi create <branch-name>");
  } else {
    console.log("  • Add repositories: arashi add <path>");
  }
  console.log("  • View configuration: cat .arashi/config.json");
  console.log("  • Customize hooks: cp .arashi/hooks/*.example .arashi/hooks/<name>.sh");
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
    .option("--repos-dir <path>", "Custom location for managed repositories", "./repos")
    .option(
      "--worktrees-dir <path>",
      "Custom base location for managed worktrees",
      DEFAULT_WORKTREES_DIR,
    )
    .option("--force", "Overwrite existing configuration if present")
    .option("--no-discover", "Skip automatic repository discovery")
    .option("--dry-run", "Show what would be done without making changes")
    .option("--verbose", "Show detailed information during initialization")
    .action(async (options: InitOptions & { discover?: boolean }) => {
      // Commander converts --no-discover to discover: false
      const normalizedOptions: InitOptions = {
        dryRun: options.dryRun,
        force: options.force,
        noDiscover: options.discover === false, // --no-discover sets discover: false
        reposDir: options.reposDir,
        verbose: options.verbose,
        worktreesDir: options.worktreesDir,
      };

      const result = await executeInit(normalizedOptions);

      if (result.success) {
        if (!options.dryRun) {
          displaySuccess(result, normalizedOptions);
        }
        process.exit(ExitCode.SUCCESS);
      } else {
        displayError(result);
        process.exit(result.exitCode);
      }
    });
}

export default createCommand;
