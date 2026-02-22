/**
 * CLI Command: Initialize Workspace
 *
 * Initialize Arashi workspace in the current git repository.
 * Creates configuration directory, generates default settings, discovers repositories,
 * and provides example hook templates.
 */

import { Command } from "commander";
import { join, resolve } from "path";
import * as config from "../lib/config.ts";
import * as logger from "../lib/logger.ts";
import * as filesystem from "../lib/filesystem.ts";
import { exec as gitExec } from "../lib/git.ts";
import { discoverRepositories } from "../core/repository.ts";

// ============================================================================
// Data Types
// ============================================================================

interface InitOptions {
  /** Custom location for managed repositories */
  reposDir?: string;

  /** Overwrite existing configuration if present */
  force?: boolean;

  /** Skip automatic repository discovery */
  noDiscover?: boolean;

  /** Enable or disable automatic setup hook execution */
  autoSetup?: boolean;

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

// ============================================================================
// Exit Codes
// ============================================================================

const ExitCode = {
  SUCCESS: 0,
  NOT_GIT_REPOSITORY: 1,
  CONFIG_EXISTS: 2,
  PERMISSION_DENIED: 3,
  DISK_FULL: 4,
  INVALID_PATH: 5,
  CONFIG_WRITE_FAILED: 6,
  DISCOVERY_FAILED: 7,
  UNKNOWN: 99,
} as const;

// ============================================================================
// Rollback Tracking
// ============================================================================

const operations: Operation[] = [];

/**
 * Add an operation to the rollback stack
 */
function addOperation(operation: Operation): void {
  operations.push(operation);
}

/**
 * Execute rollback of all tracked operations in LIFO order
 */
async function executeRollback(): Promise<void> {
  logger.info("\nRolling back changes...");

  // Reverse order (LIFO)
  const reversedOps = [...operations].reverse();

  for (const op of reversedOps) {
    try {
      await op.rollback();
      logger.info(`  • Rolled back: ${op.path}`);
    } catch (error) {
      logger.warn(`  • Failed to rollback: ${op.path} - ${(error as Error).message}`);
    }
  }

  // Clear operations
  operations.length = 0;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Check if current directory is a git repository
 */
async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    await gitExec(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate path format
 */
function isValidPath(path: string): boolean {
  // Empty or only whitespace
  if (!path || path.trim() === "") {
    return false;
  }

  // Null byte
  if (path.includes("\0")) {
    return false;
  }

  // Path too long (common filesystem limit)
  if (path.length > 4096) {
    return false;
  }

  return true;
}

// ============================================================================
// Verbose Logging & Dry-Run Helpers
// ============================================================================

/**
 * Log verbose message if verbose mode enabled
 */
function logVerbose(message: string, options: InitOptions): void {
  if (options.verbose) {
    logger.info(`[VERBOSE] ${message}`);
  }
}

/**
 * Log dry-run action
 */
function logDryRun(action: string, details: string): void {
  console.log(`[DRY RUN] ${action}: ${details}`);
}

// ============================================================================
// Hook Templates
// ============================================================================

const HOOK_TEMPLATES: HookTemplate[] = [
  {
    filename: "pre-create.sh.example",
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
  },
  {
    filename: "post-create.sh.example",
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
  },
  {
    filename: "pre-remove.sh.example",
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
  },
  {
    filename: "post-remove.sh.example",
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
  },
  {
    filename: "setup.sh.example",
    content: `#!/usr/bin/env bash
# Setup Hook Example
#
# This hook runs during repository initialization (if autoSetup is enabled).
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
  },
];

/**
 * Write hook template files to hooks directory
 */
async function writeHookTemplates(hooksDir: string): Promise<void> {
  for (const template of HOOK_TEMPLATES) {
    const templatePath = join(hooksDir, template.filename);

    // Skip if template already exists (idempotent)
    if (await filesystem.fileExists(templatePath)) {
      continue;
    }

    await filesystem.writeTextFile(templatePath, template.content);

    // Track for rollback
    addOperation({
      type: "WRITE_FILE",
      path: templatePath,
      rollback: async () => {
        const file = Bun.file(templatePath);
        if (await file.exists()) {
          await Bun.write(templatePath, "");
          await filesystem.removeDir(templatePath);
        }
      },
    });
  }
}

// ============================================================================
// Gitignore Helper
// ============================================================================

/**
 * Update .gitignore to exclude repos directory (idempotent)
 */
async function updateGitignore(cwd: string, reposDir: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");

  // Normalize repos dir for gitignore pattern
  // Remove leading ./ if present
  let pattern = reposDir.replace(/^\.\//, "");

  // Ensure trailing slash for directory
  if (!pattern.endsWith("/")) {
    pattern += "/";
  }

  let content = "";
  let originalContent: string | null = null;

  // Read existing .gitignore if it exists
  if (await filesystem.fileExists(gitignorePath)) {
    originalContent = await filesystem.readTextFile(gitignorePath);
    content = originalContent;

    // Check if pattern already exists (idempotent)
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === pattern || trimmed === pattern.slice(0, -1)) {
        // Pattern already exists, no need to add
        return;
      }
    }
  }

  // Ensure content ends with newline before appending
  if (content && !content.endsWith("\n")) {
    content += "\n";
  }

  // Append pattern with comment
  content += `\n# Arashi managed repositories\n${pattern}\n`;

  // Write updated .gitignore
  await filesystem.writeTextFile(gitignorePath, content);

  // Track for rollback
  if (originalContent !== null) {
    addOperation({
      type: "MODIFY_FILE",
      path: gitignorePath,
      originalContent,
      rollback: async () => {
        await filesystem.writeTextFile(gitignorePath, originalContent);
      },
    });
  } else {
    addOperation({
      type: "WRITE_FILE",
      path: gitignorePath,
      rollback: async () => {
        const file = Bun.file(gitignorePath);
        if (await file.exists()) {
          await Bun.write(gitignorePath, "");
          await filesystem.removeDir(gitignorePath);
        }
      },
    });
  }
}

// ============================================================================
// Main Command Logic
// ============================================================================

/**
 * Execute init command
 */
async function executeInit(options: InitOptions): Promise<InitResult> {
  const startTime = Date.now();
  const cwd = process.cwd();

  // Dry-run header
  if (options.dryRun) {
    console.log("=== DRY RUN MODE ===");
    console.log("No changes will be made to the filesystem.\n");
  }

  try {
    // 1. Validate we're in a git repository
    logVerbose("Checking if current directory is a git repository...", options);
    if (!(await isGitRepository(cwd))) {
      return {
        success: false,
        error: "Not a git repository",
        exitCode: ExitCode.NOT_GIT_REPOSITORY,
      };
    }
    logVerbose(`✓ Confirmed git repository at: ${cwd}`, options);

    // 2. Check if already initialized (without --force)
    logVerbose("Checking for existing Arashi configuration...", options);
    if (!options.force && (await config.configExists(cwd))) {
      const existingConfigPath = config.getConfigPath(cwd);
      return {
        success: false,
        error: `Arashi configuration already exists at: ${existingConfigPath}`,
        exitCode: ExitCode.CONFIG_EXISTS,
      };
    }

    // 3. Backup existing config if --force is used
    if (options.force && (await config.configExists(cwd))) {
      const existingConfigPath = config.getConfigPath(cwd);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .split("T")
        .join("T")
        .slice(0, -5);
      const backupPath = `${existingConfigPath}.backup-${timestamp}`;

      if (options.dryRun) {
        logDryRun("BACKUP", `${existingConfigPath} → ${backupPath}`);
      } else {
        logger.warn("\n⚠ Warning: Existing configuration will be backed up");
        logger.info(`Backing up: ${existingConfigPath} → ${backupPath}\n`);
        logVerbose("Reading existing configuration...", options);
        await filesystem.readTextFile(existingConfigPath);
        logVerbose("Copying configuration to backup...", options);
        await filesystem.copyFile(existingConfigPath, backupPath);
        logVerbose("✓ Backup created successfully", options);
      }
    } else {
      logVerbose("No existing configuration found", options);
    }

    // 4. Validate and resolve repos directory path
    const reposDir = options.reposDir || "./repos";
    logVerbose(`Validating repos directory path: ${reposDir}`, options);

    if (!isValidPath(reposDir)) {
      return {
        success: false,
        error: `Invalid repos directory path: ${reposDir}`,
        exitCode: ExitCode.INVALID_PATH,
      };
    }

    const absoluteReposPath = resolve(cwd, reposDir);
    logVerbose(`Resolved repos directory: ${absoluteReposPath}`, options);

    // 5. Create .arashi directory
    const arashiDir = join(cwd, ".arashi");

    if (options.dryRun) {
      logDryRun("CREATE_DIR", arashiDir);
    } else {
      logVerbose(`Creating .arashi directory: ${arashiDir}`, options);
      try {
        await filesystem.ensureDir(arashiDir);
        addOperation({
          type: "CREATE_DIR",
          path: arashiDir,
          rollback: async () => {
            await filesystem.removeDir(arashiDir);
          },
        });
        logVerbose("✓ .arashi directory created", options);
      } catch (error) {
        if (error instanceof filesystem.PermissionError) {
          return {
            success: false,
            error: `Permission denied creating directory: ${arashiDir}`,
            exitCode: ExitCode.PERMISSION_DENIED,
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
        await filesystem.ensureDir(hooksDir);
        addOperation({
          type: "CREATE_DIR",
          path: hooksDir,
          rollback: async () => {
            await filesystem.removeDir(hooksDir);
          },
        });
        logVerbose("✓ Hooks directory created", options);
      } catch (error) {
        await executeRollback();
        if (error instanceof filesystem.PermissionError) {
          return {
            success: false,
            error: `Permission denied creating hooks directory: ${hooksDir}`,
            exitCode: ExitCode.PERMISSION_DENIED,
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
        if (
          error instanceof filesystem.PermissionError ||
          error instanceof filesystem.DiskFullError
        ) {
          return {
            success: false,
            error: `Failed to write hook templates: ${(error as Error).message}`,
            exitCode:
              error instanceof filesystem.DiskFullError
                ? ExitCode.DISK_FULL
                : ExitCode.PERMISSION_DENIED,
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
        await filesystem.ensureDir(absoluteReposPath);
        addOperation({
          type: "CREATE_DIR",
          path: absoluteReposPath,
          rollback: async () => {
            await filesystem.removeDir(absoluteReposPath);
          },
        });
        logVerbose("✓ Repos directory created", options);
      } catch (error) {
        await executeRollback();
        if (error instanceof filesystem.PermissionError) {
          return {
            success: false,
            error: `Permission denied creating repos directory: ${absoluteReposPath}`,
            exitCode: ExitCode.PERMISSION_DENIED,
          };
        } else if (error instanceof filesystem.DiskFullError) {
          return {
            success: false,
            error: `Insufficient disk space creating repos directory: ${absoluteReposPath}`,
            exitCode: ExitCode.DISK_FULL,
          };
        }
        throw error;
      }
    }

    // 9. Discover repositories (unless --no-discover)
    let discoveredCount = 0;
    let discoveredRepos: Record<string, config.RepoConfig> = {};

    if (!options.noDiscover) {
      if (options.dryRun) {
        logDryRun("DISCOVER", `Scan ${reposDir} for git repositories`);
        discoveredCount = 0; // Can't discover in dry-run mode
      } else {
        logVerbose(`Discovering repositories in: ${reposDir}`, options);
        try {
          const discoveryResult = await discoverRepositories(reposDir);
          discoveredCount = discoveryResult.repositories.length;
          logVerbose(`✓ Found ${discoveredCount} repositories`, options);

          // Convert to config format
          for (const repo of discoveryResult.repositories) {
            if (options.verbose) {
              logVerbose(`  - ${repo.name} (${repo.defaultBranch})`, options);
            }
            discoveredRepos[repo.name] = {
              path: repo.path,
            };
          }
        } catch (error) {
          await executeRollback();
          return {
            success: false,
            error: `Repository discovery failed: ${(error as Error).message}`,
            exitCode: ExitCode.DISCOVERY_FAILED,
          };
        }
      }
    } else {
      logVerbose("Skipping repository discovery (--no-discover)", options);
    }

    // 10. Generate and write config
    const arashiConfig: config.Config = {
      $schema: config.DEFAULT_CONFIG_SCHEMA_URL,
      version: "1.0.0",
      reposDir: reposDir,
      autoSetup: options.autoSetup !== undefined ? options.autoSetup : true,
      repos: discoveredRepos,
    };

    const configPath = config.getConfigPath(cwd);
    if (options.dryRun) {
      logDryRun("WRITE_FILE", `${configPath}`);
      console.log("\nConfiguration preview:");
      console.log(JSON.stringify(arashiConfig, null, 2));
    } else {
      logVerbose("Writing configuration file...", options);
      try {
        await config.saveConfig(cwd, arashiConfig);

        addOperation({
          type: "WRITE_FILE",
          path: configPath,
          rollback: async () => {
            const file = Bun.file(configPath);
            if (await file.exists()) {
              await Bun.write(configPath, "");
              await filesystem.removeDir(configPath);
            }
          },
        });
        logVerbose("✓ Configuration written", options);
      } catch (error) {
        await executeRollback();
        if (
          error instanceof filesystem.PermissionError ||
          error instanceof filesystem.DiskFullError
        ) {
          return {
            success: false,
            error: `Failed to write configuration: ${(error as Error).message}`,
            exitCode:
              error instanceof filesystem.DiskFullError
                ? ExitCode.DISK_FULL
                : ExitCode.CONFIG_WRITE_FAILED,
          };
        }
        throw error;
      }
    }

    // 11. Update .gitignore
    const gitignorePath = join(cwd, ".gitignore");
    if (options.dryRun) {
      logDryRun("UPDATE_FILE", `${gitignorePath} (add: ${reposDir}/)`);
    } else {
      logVerbose("Updating .gitignore...", options);
      try {
        await updateGitignore(cwd, reposDir);
        logVerbose("✓ .gitignore updated", options);
      } catch (error) {
        await executeRollback();
        if (error instanceof filesystem.PermissionError) {
          return {
            success: false,
            error: `Failed to update .gitignore: ${(error as Error).message}`,
            exitCode: ExitCode.PERMISSION_DENIED,
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

    return {
      success: true,
      configPath: configPath,
      hooksPath: hooksDir,
      reposPath: absoluteReposPath,
      discoveredCount,
      exitCode: ExitCode.SUCCESS,
    };
  } catch (error) {
    // Unexpected error - rollback and exit
    if (!options.dryRun) {
      await executeRollback();
    }

    return {
      success: false,
      error: `Unexpected error: ${(error as Error).message}`,
      exitCode: ExitCode.UNKNOWN,
    };
  }
}

/**
 * Display success message with details
 */
function displaySuccess(result: InitResult, options: InitOptions): void {
  logger.success("Initialized Arashi workspace");

  console.log("\nCreated:");
  console.log(`  • Configuration: ${result.configPath}`);
  console.log(`  • Hooks directory: ${result.hooksPath}`);
  console.log(`  • Repositories directory: ${result.reposPath}`);

  if (options.noDiscover) {
    console.log("\nDiscovery skipped (--no-discover)");
  } else {
    console.log(`\nDiscovered ${result.discoveredCount} repositories`);
  }

  const reposDir = options.reposDir || "./repos";
  console.log(`\nUpdated .gitignore to exclude: ${reposDir}`);

  console.log("\nNext steps:");
  if (result.discoveredCount && result.discoveredCount > 0) {
    console.log("  • Create a worktree: arashi create <branch-name>");
  } else {
    console.log("  • Add repositories: arashi add <path>");
  }
  console.log("  • View configuration: cat .arashi/config.json");
  console.log("  • Customize hooks: cp .arashi/hooks/*.example .arashi/hooks/<name>.sh");
}

/**
 * Display error message with guidance
 */
function displayError(result: InitResult): void {
  logger.error(result.error || "Unknown error");

  switch (result.exitCode) {
    case ExitCode.NOT_GIT_REPOSITORY:
      console.log("\nThe current directory is not a git repository.");
      console.log("Run 'git init' to initialize a repository first, or 'cd' to a git repository.");
      break;

    case ExitCode.CONFIG_EXISTS:
      console.log("\nTo reinitialize, use: arashi init --force");
      console.log("This will backup your existing configuration.");
      break;

    case ExitCode.PERMISSION_DENIED:
      console.log("\nCheck directory permissions and try again.");
      break;

    case ExitCode.DISK_FULL:
      console.log("\nFree up disk space and try again.");
      break;

    case ExitCode.INVALID_PATH:
      console.log("\nUse a valid relative or absolute path.");
      break;

    case ExitCode.CONFIG_WRITE_FAILED:
      console.log("\nCheck permissions and disk space.");
      break;

    case ExitCode.DISCOVERY_FAILED:
      console.log("\nUse --no-discover to skip discovery, or fix the error and try again.");
      break;
  }
}

// ============================================================================
// Command Definition
// ============================================================================

export function createCommand(): Command {
  return new Command("init")
    .description("Initialize Arashi workspace in the current git repository")
    .option("--repos-dir <path>", "Custom location for managed repositories", "./repos")
    .option("--force", "Overwrite existing configuration if present")
    .option("--no-discover", "Skip automatic repository discovery")
    .option("--auto-setup", "Enable automatic setup hook execution (default: true)")
    .option("--no-auto-setup", "Disable automatic setup hook execution")
    .option("--dry-run", "Show what would be done without making changes")
    .option("--verbose", "Show detailed information during initialization")
    .action(async (options: InitOptions & { discover?: boolean; autoSetup?: boolean }) => {
      // Commander converts --no-discover to discover: false
      // Commander converts --no-auto-setup to autoSetup: false
      const normalizedOptions: InitOptions = {
        reposDir: options.reposDir,
        force: options.force,
        noDiscover: options.discover === false, // --no-discover sets discover: false
        autoSetup: options.autoSetup !== false, // --no-auto-setup sets autoSetup: false
        dryRun: options.dryRun,
        verbose: options.verbose,
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
