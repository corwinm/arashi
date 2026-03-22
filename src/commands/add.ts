/**
 * Add Command
 *
 * Adds a Git repository to the Arashi workspace by cloning it into the repos directory,
 * detecting repository metadata (default branch, setup scripts), and updating the
 * workspace configuration file.
 *
 * @module commands/add
 */

import { Command } from "commander";
import { basename, join } from "path";
import { info, error as logError, spinner, success } from "../lib/logger.ts";
import { clone, getDefaultBranch } from "../lib/git.ts";
import { configExists, getConfigPath, loadConfig, saveConfig } from "../lib/config.ts";
import { AddCommandError, AddCommandErrorCode } from "../lib/errors.ts";
import { confirm as promptConfirm } from "../lib/prompts.ts";
import { executeClone } from "./clone.ts";
import type { RepoConfig } from "../lib/config.ts";

const ZERO = 0;
const JSON_INDENT = 2;
const ERROR_EXIT_CODE = 1;
const CANCELLED_EXIT_CODE = 2;

const getLastPathSegment = (pathParts: string[]): string => {
  const lastPart = pathParts.at(-1);
  if (!lastPart) {
    throw new Error("Unable to determine repository name from path");
  }

  return lastPart;
};

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Git URL information parsed from a repository URL
 */
interface GitUrlInfo {
  /** Original URL string */
  url: string;
  /** Detected protocol */
  protocol: "https" | "ssh" | "git" | "file" | "scp";
  /** Git host domain (null for file:// URLs) */
  host: string | null;
  /** Repository owner or organization */
  owner: string | null;
  /** Repository name (without .git suffix) */
  repository: string;
  /** Auto-derived repository name (suitable for use as config key) */
  derivedName: string;
}

/**
 * Command-line options for the add command
 */
interface AddCommandOptions {
  /** Custom repository name (overrides auto-derived name) */
  name?: string;
  /** Whether to create setup.sh template if no setup script found */
  createSetup?: boolean;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Output result as JSON instead of human-readable format */
  json?: boolean;
}

/**
 * Result of add operation
 */
interface AddCommandResult {
  /** Name of the added repository */
  repositoryName: string;
  /** Absolute filesystem path where repository was cloned */
  clonePath: string;
  /** Detected default branch name */
  defaultBranch: string;
  /** Path to detected or created setup script (null if none) */
  setupScript: string | null;
  /** Whether a new setup script was created */
  setupScriptCreated: boolean;
  /** Original Git URL that was cloned */
  gitUrl: string;
}

/**
 * Operation metadata for rollback mechanism
 */
interface RollbackOperation {
  /** Type of operation that was performed */
  type: "clone" | "config_update" | "setup_script_create";
  /** Filesystem path affected by operation */
  path: string;
  /** Whether operation can be automatically reversed */
  reversible: boolean;
  /** Metadata for rollback logic (operation-specific) */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// URL Validation and Parsing
// ============================================================================

/**
 * Git URL validation patterns for different protocols
 */
const GIT_URL_PATTERNS = {
  file: /^(file:\/\/)?\/[^/].+/,
  git: /^git:\/\/[^/]+\/.+/,
  https: /^https:\/\/[^/]+\/.+/,
  scp: /^[^@]+@[^:]+:[^/].+/,
  ssh: /^(ssh:\/\/[^@]+@[^/]+\/|git@[^:]+:)[^/].+/,
};

/**
 * Validate if a string is a valid Git URL
 *
 * @param url - URL string to validate
 * @returns true if URL matches one of the supported formats
 *
 * @example
 * isValidGitUrl('https://github.com/user/repo.git') // true
 * isValidGitUrl('invalid-url') // false
 */
const isValidGitUrl = (url: string): boolean => {
  if (!url || typeof url !== "string" || url.trim() === "") {
    return false;
  }

  const trimmedUrl = url.trim();
  return Object.values(GIT_URL_PATTERNS).some((pattern) => pattern.test(trimmedUrl));
};

/**
 * Derive repository name from a Git URL
 *
 * Extracts the last path segment from the URL and removes the .git suffix.
 * Validates that the name contains only safe characters.
 *
 * @param gitUrl - Git repository URL
 * @returns Derived repository name
 * @throws {Error} If unable to derive a valid name
 *
 * @example
 * deriveRepoName('https://github.com/user/my-repo.git') // 'my-repo'
 * deriveRepoName('git@github.com:user/project') // 'project'
 */
const deriveRepoName = (gitUrl: string): string => {
  // Remove trailing slashes and .git suffix
  const url = gitUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  // Extract last path segment
  const parts = url.split(/[/:]/);
  const name = parts[parts.length - 1];

  // Validate name contains safe characters
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid repository name derived from URL: ${name}`);
  }

  return name;
};

/**
 * Parse a Git URL and extract structured information
 *
 * @param gitUrl - Git repository URL to parse
 * @returns Parsed URL information
 * @throws {AddCommandError} If URL is invalid
 *
 * @example
 * const info = parseGitUrl('https://github.com/facebook/react.git');
 * // { protocol: 'https', host: 'github.com', owner: 'facebook', repository: 'react', ... }
 */
const parseGitUrl = (gitUrl: string): GitUrlInfo => {
  if (!isValidGitUrl(gitUrl)) {
    throw new AddCommandError(
      `The URL "${gitUrl}" is not a valid Git repository URL`,
      AddCommandErrorCode.INVALID_URL,
      { url: gitUrl },
    );
  }

  const trimmedUrl = gitUrl.trim();
  let protocol: GitUrlInfo["protocol"];
  let host: string | null = null;
  let owner: string | null = null;
  let repository: string;

  // Determine protocol
  if (GIT_URL_PATTERNS.https.test(trimmedUrl)) {
    protocol = "https";
    const match = trimmedUrl.match(/^https:\/\/([^/]+)\/(.+)/);
    if (match) {
      host = match[1];
      const path = match[2].replace(/\.git$/, "");
      const pathParts = path.split("/");
      if (pathParts.length >= 2) {
        owner = pathParts[0];
        repository = getLastPathSegment(pathParts);
      } else {
        repository = getLastPathSegment(pathParts);
      }
    } else {
      repository = deriveRepoName(trimmedUrl);
    }
  } else if (GIT_URL_PATTERNS.ssh.test(trimmedUrl) || GIT_URL_PATTERNS.scp.test(trimmedUrl)) {
    protocol = "ssh";
    // Match patterns like git@github.com:user/repo.git or ssh://git@github.com/user/repo.git
    const sshMatch = trimmedUrl.match(/^(?:ssh:\/\/)?([^@]+)@([^:/]+):?(.+)/);
    if (sshMatch) {
      host = sshMatch[2];
      const path = sshMatch[3].replace(/^\//, "").replace(/\.git$/, "");
      const pathParts = path.split("/");
      if (pathParts.length >= 2) {
        owner = pathParts[0];
        repository = getLastPathSegment(pathParts);
      } else {
        repository = getLastPathSegment(pathParts);
      }
    } else {
      repository = deriveRepoName(trimmedUrl);
    }
  } else if (GIT_URL_PATTERNS.git.test(trimmedUrl)) {
    protocol = "git";
    const match = trimmedUrl.match(/^git:\/\/([^/]+)\/(.+)/);
    if (match) {
      host = match[1];
      const path = match[2].replace(/\.git$/, "");
      const pathParts = path.split("/");
      if (pathParts.length >= 2) {
        owner = pathParts[0];
        repository = getLastPathSegment(pathParts);
      } else {
        repository = getLastPathSegment(pathParts);
      }
    } else {
      repository = deriveRepoName(trimmedUrl);
    }
  } else if (GIT_URL_PATTERNS.file.test(trimmedUrl)) {
    protocol = "file";
    const path = trimmedUrl.replace(/^file:\/\//, "").replace(/\.git$/, "");
    repository = basename(path);
  } else {
    // Fallback - shouldn't reach here if isValidGitUrl passed
    protocol = "scp";
    repository = deriveRepoName(trimmedUrl);
  }

  const derivedName = deriveRepoName(trimmedUrl);

  return {
    derivedName,
    host,
    owner,
    protocol,
    repository,
    url: trimmedUrl,
  };
};

// ============================================================================
// Setup Script Detection
// ============================================================================

/**
 * Common setup script filenames to detect (in priority order)
 */
const SETUP_SCRIPT_NAMES = [
  "setup.sh",
  "setup.bash",
  "install.sh",
  "bootstrap.sh",
  "setup.ps1",
  "setup.bat",
  "setup.py",
  "setup.rb",
  "Makefile",
];

/**
 * Detect setup script in a repository
 *
 * Checks for common setup script patterns in the repository root.
 * For Makefiles, verifies that a 'setup' or 'install' target exists.
 *
 * @param repoPath - Path to the repository
 * @returns Path to detected setup script, or null if none found
 *
 * @example
 * const setupScript = await detectSetupScript('/path/to/repo');
 * if (setupScript) {
 *   console.log(`Found setup script: ${setupScript}`);
 * }
 */
const detectSetupScript = async (repoPath: string): Promise<string | null> => {
  for (const scriptName of SETUP_SCRIPT_NAMES) {
    const scriptPath = join(repoPath, scriptName);
    const file = Bun.file(scriptPath);

    if (await file.exists()) {
      // For Makefile, verify it has setup/install target
      if (scriptName === "Makefile") {
        try {
          const content = await file.text();
          if (/^(setup|install):/m.test(content)) {
            return scriptPath;
          }
        } catch {}
      } else {
        return scriptPath;
      }
    }
  }

  return null;
};

// ============================================================================
// Add Command Implementation
// ============================================================================

/**
 * Execute the add command
 *
 * @param gitUrl - Git repository URL to add
 * @param options - Command options
 * @param workspaceRoot - Root directory of the workspace
 * @returns Result of add operation
 */
const executeAdd = async (
  gitUrl: string,
  options: AddCommandOptions,
  workspaceRoot: string,
): Promise<AddCommandResult> => {
  const operations: RollbackOperation[] = [];

  try {
    // Step 1: Validate workspace is initialized
    const hasConfig = await configExists(workspaceRoot);
    if (!hasConfig) {
      throw new AddCommandError(
        'Workspace not initialized. Run "arashi init" first.',
        AddCommandErrorCode.CONFIG_UPDATE_FAILED,
        { configPath: getConfigPath(workspaceRoot) },
      );
    }

    // Step 2: Parse and validate Git URL
    const s1 = spinner("Validating Git URL...").start();
    const urlInfo = parseGitUrl(gitUrl);
    s1.succeed("Git URL validated");

    // Step 3: Determine repository name
    const repositoryName = options.name || urlInfo.derivedName;

    // Step 4: Check for duplicate name
    const config = await loadConfig(workspaceRoot);
    if (config.repos[repositoryName]) {
      throw new AddCommandError(
        `Repository name "${repositoryName}" already exists at ${config.repos[repositoryName].path}`,
        AddCommandErrorCode.DUPLICATE_NAME,
        {
          existingPath: config.repos[repositoryName].path,
          gitUrl,
          name: repositoryName,
        },
      );
    }

    // Step 5: Prepare clone destination
    const reposDir = join(workspaceRoot, config.reposDir);
    const clonePath = join(reposDir, repositoryName);

    // Step 6: Clone repository
    const s2 = spinner(`Cloning repository from ${gitUrl}...`).start();
    try {
      await clone(gitUrl, clonePath);
      operations.push({ path: clonePath, reversible: true, type: "clone" });
      s2.succeed("Repository cloned");
    } catch (error) {
      s2.fail("Clone failed");
      throw new AddCommandError(
        `Git clone operation failed: ${(error as Error).message}`,
        AddCommandErrorCode.CLONE_FAILED,
        { error: (error as Error).message, url: gitUrl },
      );
    }

    // Step 7: Detect default branch
    const s3 = spinner("Detecting default branch...").start();
    let defaultBranch: string;
    try {
      defaultBranch = await getDefaultBranch(clonePath);
      s3.succeed(`Detected default branch: ${defaultBranch}`);
    } catch {
      s3.fail("Branch detection failed");
      throw new AddCommandError(
        "Unable to detect default branch: repository has no remote branches",
        AddCommandErrorCode.BRANCH_DETECTION_FAILED,
        { repositoryPath: clonePath, url: gitUrl },
      );
    }

    // Step 8: Detect setup script
    const s4 = spinner("Checking for setup script...").start();
    const setupScript = await detectSetupScript(clonePath);
    if (setupScript) {
      s4.succeed(`Found setup script: ${basename(setupScript)}`);
    } else {
      s4.info("No setup script found");
    }

    // Step 9: Update configuration
    const s5 = spinner("Updating configuration...").start();
    try {
      const repoConfig: RepoConfig = {
        gitUrl: urlInfo.url,
        path: join(".", config.reposDir, repositoryName),
      };

      config.repos[repositoryName] = repoConfig;
      await saveConfig(workspaceRoot, config);
      s5.succeed("Configuration updated");
    } catch (error) {
      s5.fail("Configuration update failed");
      throw new AddCommandError(
        `Failed to update configuration file: ${(error as Error).message}`,
        AddCommandErrorCode.CONFIG_UPDATE_FAILED,
        { configPath: getConfigPath(workspaceRoot), error: (error as Error).message },
      );
    }

    // Success!
    return {
      clonePath,
      defaultBranch,
      gitUrl,
      repositoryName,
      setupScript,
      setupScriptCreated: false,
    };
  } catch (error) {
    // Rollback operations in reverse order
    const rollbackOperations = [...operations];
    rollbackOperations.reverse();

    for (const operation of rollbackOperations) {
      try {
        if (operation.type === "clone") {
          await Bun.$`rm -rf ${operation.path}`;
        }
      } catch (cleanupError) {
        info(`Warning: Failed to clean up ${operation.path}: ${(cleanupError as Error).message}`);
        info(`Please manually remove: rm -rf ${operation.path}`);
      }
    }

    // Re-throw original error
    throw error;
  }
};

/**
 * Display success message in human-readable format
 */
const displaySuccess = (result: AddCommandResult, workspaceRoot: string): void => {
  success("\nRepository added successfully:");
  console.log(`  Name:     ${result.repositoryName}`);
  console.log(`  Location: ${result.clonePath.replace(workspaceRoot, ".")}`);
  console.log(`  Branch:   ${result.defaultBranch}`);

  if (result.setupScript) {
    console.log(`  Setup:    ${basename(result.setupScript)}`);
    console.log("\nNext steps:");
    console.log(
      `  1. Run setup: cd ${result.clonePath.replace(workspaceRoot, ".")} && ./${basename(result.setupScript)}`,
    );
    console.log(`  2. Create worktree: arashi create my-branch`);
  } else {
    console.log("\nNext steps:");
    console.log(`  Create worktree: arashi create my-branch`);
  }
};

/**
 * Display error message in human-readable format
 */
const displayError = (error: AddCommandError): void => {
  logError(`\n✗ ${error.message}\n`);

  if (error.code === AddCommandErrorCode.INVALID_URL) {
    console.log("Supported formats:");
    console.log("  - HTTPS: https://github.com/user/repo.git");
    console.log("  - SSH:   git@github.com:user/repo.git");
    console.log("  - Git:   git://host/repo.git");
    console.log("  - File:  file:///path/to/repo.git");
    console.log("  - SCP:   user@host:repo.git");
  } else if (error.code === AddCommandErrorCode.DUPLICATE_NAME) {
    console.log("Solutions:");
    console.log("  1. Clone the configured repository if it is missing locally: arashi clone");
    console.log("  2. Inspect current workspace status: arashi status");
  } else if (error.code === AddCommandErrorCode.CLONE_FAILED) {
    console.log("Common causes:");
    console.log("  - Network connectivity issues");
    console.log("  - Repository doesn't exist or is private");
    console.log("  - Authentication required (use SSH with configured keys)");
    console.log("  - Insufficient disk space");
  }
};

/**
 * Create the add command for Commander.js
 *
 * @returns Commander Command object
 */
const createCommand = (): Command => {
  const cmd = new Command("add");

  cmd
    .description("Add a Git repository to the workspace")
    .argument("<git-url>", "Git repository URL (HTTPS, SSH, Git, File, or SCP format)")
    .option("-n, --name <name>", "Custom repository name")
    .option("--create-setup", "Create setup.sh template if no setup script found", false)
    .option("-f, --force", "Skip confirmation prompts", false)
    .option("--json", "Output result as JSON", false)
    .action(async (gitUrl: string, options: AddCommandOptions) => {
      try {
        const workspaceRoot = process.cwd();
        const result = await executeAdd(gitUrl, options, workspaceRoot);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                repository: {
                  name: result.repositoryName,
                  path: result.clonePath.replace(workspaceRoot, "."),
                  gitUrl: result.gitUrl,
                  defaultBranch: result.defaultBranch,
                  setupScript: result.setupScript
                    ? result.setupScript.replace(workspaceRoot, ".")
                    : null,
                  setupScriptCreated: result.setupScriptCreated,
                },
                success: true,
              },
              null,
              2,
            ),
          );
        } else {
          displaySuccess(result, workspaceRoot);
        }

        process.exit(0);
      } catch (error) {
        if (error instanceof AddCommandError) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  error: {
                    code: error.code,
                    message: error.message,
                    details: error.context,
                  },
                  success: false,
                },
                null,
                JSON_INDENT,
              ),
            );
          } else {
            displayError(error);

            if (
              error.code === AddCommandErrorCode.DUPLICATE_NAME &&
              process.stdin.isTTY &&
              process.stdout.isTTY
            ) {
              const fallback = await promptConfirm(
                "Repository is already configured. Run `arashi clone` now?",
                true,
              );

              if (fallback.status === "ok" && fallback.value) {
                const cloneResult = await executeClone({}, { workspaceRoot: process.cwd() });
                if (cloneResult.status === "cancelled") {
                  process.exit(ZERO);
                }
                process.exit(cloneResult.failed.length > ZERO ? ERROR_EXIT_CODE : ZERO);
              }
            }
          }
          process.exit(CANCELLED_EXIT_CODE);
        } else {
          logError(`\nUnexpected error: ${(error as Error).message}`);
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  error: {
                    code: "UNKNOWN_ERROR",
                    message: (error as Error).message,
                  },
                  success: false,
                },
                null,
                JSON_INDENT,
              ),
            );
          }
          process.exit(ERROR_EXIT_CODE);
        }
      }
    });

  return cmd;
};

export { createCommand, detectSetupScript, deriveRepoName, isValidGitUrl, parseGitUrl };

export type { AddCommandOptions, AddCommandResult, GitUrlInfo };
