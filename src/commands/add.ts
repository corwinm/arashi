import { runtime } from "../lib/runtime.ts";
/**
 * Add Command
 *
 * Adds a Git repository to the Arashi workspace by cloning it into the repos directory,
 * detecting repository metadata (default branch, setup scripts), and updating the
 * workspace configuration file.
 *
 * @module commands/add
 */

import { AddCommandError, AddCommandErrorCode } from "../lib/errors.ts";
import { basename, join } from "path";
import { clone, getDefaultBranch } from "../lib/git.ts";
import { configExists, getConfigPath, loadConfig, saveConfig } from "../lib/config.ts";
import {
  findConfiguredWorkspaceRoots,
  throwIfStandaloneWorkspace,
} from "../lib/workspace-context.ts";
import { info, error as logError, spinner, success } from "../lib/logger.ts";
import { Command } from "commander";
import { executeClone } from "./clone.ts";
import { confirm as promptConfirm } from "../lib/prompts.ts";
import { rm } from "node:fs/promises";
import {
  reconcileRepositoryManagedIgnore,
  restoreManagedIgnore,
  type ManagedIgnoreReconciliation,
} from "../lib/managed-ignore.ts";
import { DEFAULT_WORKTREES_DIR } from "../lib/worktree-location.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";

type RepoConfig = Awaited<ReturnType<typeof loadConfig>>["repos"][string];
type WorkspaceRoots = Awaited<ReturnType<typeof findConfiguredWorkspaceRoots>>;

const ZERO = 0;
const ERROR_EXIT_CODE = 1;
const CANCELLED_EXIT_CODE = 2;

const detectDefaultBranchOrThrow = async (clonePath: string, gitUrl: string): Promise<string> => {
  try {
    return await getDefaultBranch(clonePath);
  } catch {
    throw new AddCommandError(
      "Unable to detect default branch: repository has no remote branches",
      AddCommandErrorCode.BRANCH_DETECTION_FAILED,
      { repositoryPath: clonePath, url: gitUrl },
    );
  }
};

const hasMakefileSetupTarget = async (file: { text(): Promise<string> }): Promise<boolean> => {
  try {
    const content = await file.text();
    return /^(setup|install):/m.test(content);
  } catch {
    return false;
  }
};

const maybeRunCloneFallback = async (
  error: AddCommandError,
  workspaceRoots: WorkspaceRoots,
): Promise<void> => {
  if (
    error.code !== AddCommandErrorCode.DUPLICATE_NAME ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    return;
  }

  const fallback = await promptConfirm(
    "Repository is already configured. Run `arashi clone` now?",
    true,
  );
  if (fallback.status === "ok" && fallback.value) {
    const cloneResult = await executeClone({}, { workspaceRoots });
    if (cloneResult.status === "cancelled") {
      process.exit(ZERO);
    }

    process.exit(cloneResult.failed.length > ZERO ? ERROR_EXIT_CODE : ZERO);
  }
};

const getLastPathSegment = (pathParts: string[]): string => {
  const filteredParts = pathParts.filter((part) => part.length > ZERO);
  const lastPart = filteredParts.at(-1);
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
export interface GitUrlInfo {
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
export interface AddCommandOptions {
  /** Custom repository name (overrides auto-derived name) */
  name?: string;
  /** Whether to create setup.sh template if no setup script found */
  createSetup?: boolean;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Output result as JSON instead of human-readable format */
  json?: boolean;
}

export const shouldTreatFailedCloneAsMaterialized = (destinationExists: boolean): boolean =>
  destinationExists;

/**
 * Result of add operation
 */
export interface AddCommandResult {
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
  /** Managed ignore reconciliation retained for the materialized repository. */
  managedIgnore: ManagedIgnoreReconciliation;
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
export function isValidGitUrl(url: string): boolean {
  if (!url || typeof url !== "string" || url.trim() === "") {
    return false;
  }

  const trimmedUrl = url.trim();
  return Object.values(GIT_URL_PATTERNS).some((pattern) => pattern.test(trimmedUrl));
}

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
export function deriveRepoName(gitUrl: string): string {
  // Remove trailing slashes and .git suffix
  const url = gitUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  // Extract last path segment
  const parts = url.split(/[/:]/);
  const name = getLastPathSegment(parts);

  // Validate name contains safe characters
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid repository name derived from URL: ${name}`);
  }

  return name;
}

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
export function parseGitUrl(gitUrl: string): GitUrlInfo {
  if (!isValidGitUrl(gitUrl)) {
    throw new AddCommandError(
      `The URL "${gitUrl}" is not a valid Git repository URL`,
      AddCommandErrorCode.INVALID_URL,
      { url: gitUrl },
    );
  }

  const trimmedUrl = gitUrl.trim();
  let protocol: GitUrlInfo["protocol"] = "scp";
  let host: string | null = null;
  let owner: string | null = null;
  let repository = deriveRepoName(trimmedUrl);

  // Determine protocol
  if (GIT_URL_PATTERNS.https.test(trimmedUrl)) {
    protocol = "https";
    const match = trimmedUrl.match(/^https:\/\/([^/]+)\/(.+)/);
    if (match) {
      const [, matchedHost, matchedPath] = match;
      host = matchedHost;
      const path = matchedPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
      const pathParts = path.split("/");
      if (pathParts.length >= 2) {
        const [pathOwner] = pathParts;
        owner = pathOwner;
      }
      repository = getLastPathSegment(pathParts);
    }
  } else if (GIT_URL_PATTERNS.ssh.test(trimmedUrl) || GIT_URL_PATTERNS.scp.test(trimmedUrl)) {
    protocol = "ssh";
    // Match patterns like git@github.com:user/repo.git or ssh://git@github.com/user/repo.git
    const sshMatch = trimmedUrl.match(/^(?:ssh:\/\/)?([^@]+)@([^:/]+):?(.+)/);
    if (sshMatch) {
      const [_fullMatch, _gitUser, matchedHost, matchedPath] = sshMatch;
      host = matchedHost;
      const path = matchedPath
        .replace(/^\//, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "");
      const pathParts = path.split("/");
      if (pathParts.length >= 2) {
        const [pathOwner] = pathParts;
        owner = pathOwner;
      }
      repository = getLastPathSegment(pathParts);
    }
  } else if (GIT_URL_PATTERNS.git.test(trimmedUrl)) {
    protocol = "git";
    const match = trimmedUrl.match(/^git:\/\/([^/]+)\/(.+)/);
    if (match) {
      const [, matchedHost, matchedPath] = match;
      host = matchedHost;
      const path = matchedPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
      const pathParts = path.split("/");
      if (pathParts.length >= 2) {
        const [pathOwner] = pathParts;
        owner = pathOwner;
      }
      repository = getLastPathSegment(pathParts);
    }
  } else if (GIT_URL_PATTERNS.file.test(trimmedUrl)) {
    protocol = "file";
    const path = trimmedUrl
      .replace(/^file:\/\//, "")
      .replace(/\.git\/?$/, "")
      .replace(/\/+$/, "");
    repository = basename(path);
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
}

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
export async function detectSetupScript(repoPath: string): Promise<string | null> {
  for (const scriptName of SETUP_SCRIPT_NAMES) {
    const scriptPath = join(repoPath, scriptName);
    const file = runtime.file(scriptPath);

    if (await file.exists()) {
      // For Makefile, verify it has setup/install target
      if (scriptName === "Makefile") {
        if (await hasMakefileSetupTarget(file)) {
          return scriptPath;
        }
      } else {
        return scriptPath;
      }
    }
  }

  return null;
}

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
  let existingFailedCloneDestinationSurvives = false;
  let managedIgnore: ManagedIgnoreReconciliation | undefined = undefined;
  const startSpinner = (text: string) => (options.json ? undefined : spinner(text).start());

  try {
    // Step 1: Validate workspace is initialized
    const hasConfig = await configExists(workspaceRoot);
    if (!hasConfig) {
      await throwIfStandaloneWorkspace("add", workspaceRoot);
      throw new AddCommandError(
        'Workspace not initialized. Run "arashi init" first.',
        AddCommandErrorCode.CONFIG_UPDATE_FAILED,
        { configPath: getConfigPath(workspaceRoot) },
      );
    }

    // Step 2: Parse and validate Git URL
    const s1 = startSpinner("Validating Git URL...");
    const urlInfo = parseGitUrl(gitUrl);
    s1?.succeed("Git URL validated");

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

    managedIgnore = await reconcileRepositoryManagedIgnore({
      reposDir: config.reposDir,
      workspaceRoot,
      worktreesDir: config.worktreesDir ?? DEFAULT_WORKTREES_DIR,
    });
    if (!options.json) {
      for (const warning of managedIgnore.warnings) {
        info(`Warning: ${warning}`);
      }
    }

    // Step 6: Clone repository
    const s2 = startSpinner(`Cloning repository from ${gitUrl}...`);
    const clonePathExistedBefore = await runtime.file(clonePath).exists();
    try {
      await clone(gitUrl, clonePath);
      operations.push({ path: clonePath, reversible: true, type: "clone" });
      s2?.succeed("Repository cloned");
    } catch (error) {
      const clonePathExistsAfterFailure = await runtime.file(clonePath).exists();
      if (clonePathExistedBefore) {
        existingFailedCloneDestinationSurvives = shouldTreatFailedCloneAsMaterialized(
          clonePathExistsAfterFailure,
        );
      } else if (clonePathExistsAfterFailure) {
        operations.push({ path: clonePath, reversible: true, type: "clone" });
      }
      s2?.fail("Clone failed");
      throw new AddCommandError(
        `Git clone operation failed: ${(error as Error).message}`,
        AddCommandErrorCode.CLONE_FAILED,
        { error: (error as Error).message, url: gitUrl },
      );
    }

    // Step 7: Detect default branch
    const s3 = startSpinner("Detecting default branch...");
    const defaultBranch = await detectDefaultBranchOrThrow(clonePath, gitUrl).catch((error) => {
      s3?.fail("Branch detection failed");
      throw error;
    });
    s3?.succeed(`Detected default branch: ${defaultBranch}`);

    // Step 8: Detect setup script
    const s4 = startSpinner("Checking for setup script...");
    const setupScript = await detectSetupScript(clonePath);
    if (setupScript) {
      s4?.succeed(`Found setup script: ${basename(setupScript)}`);
    } else {
      s4?.info("No setup script found");
    }

    // Step 9: Update configuration
    const s5 = startSpinner("Updating configuration...");
    try {
      const repoConfig: RepoConfig = {
        gitUrl: urlInfo.url,
        path: join(".", config.reposDir, repositoryName),
      };

      config.repos[repositoryName] = repoConfig;
      await saveConfig(workspaceRoot, config);
      s5?.succeed("Configuration updated");
    } catch (error) {
      s5?.fail("Configuration update failed");
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
      managedIgnore,
      repositoryName,
      setupScript,
      setupScriptCreated: false,
    };
  } catch (error) {
    let managedIgnoreRestoreError: string | undefined = undefined;
    let materializedStateSurvives = existingFailedCloneDestinationSurvives;
    // Rollback operations in reverse order
    const rollbackOperations = [...operations];
    rollbackOperations.reverse();

    for (const operation of rollbackOperations) {
      try {
        if (operation.type === "clone") {
          await rm(operation.path, { force: true, recursive: true });
        }
      } catch (cleanupError) {
        materializedStateSurvives = true;
        if (!options.json) {
          info(`Warning: Failed to clean up ${operation.path}: ${(cleanupError as Error).message}`);
          info(`Please manually remove: rm -rf ${operation.path}`);
        }
      }
      if (operation.type === "clone" && (await runtime.file(operation.path).exists())) {
        materializedStateSurvives = true;
      }
    }

    if (managedIgnore?.changed && !materializedStateSurvives) {
      try {
        await restoreManagedIgnore(managedIgnore);
      } catch (restoreError) {
        managedIgnoreRestoreError = (restoreError as Error).message;
      }
    }
    if (error instanceof AddCommandError && managedIgnore) {
      throw new AddCommandError(error.message, error.code, {
        ...error.context,
        managedIgnore,
        materializedStateSurvives,
        ...(managedIgnoreRestoreError ? { managedIgnoreRestoreError } : {}),
      });
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
export function createCommand(): Command {
  const cmd = new Command("add");

  cmd
    .description("Add a Git repository to the workspace")
    .argument("<git-url>", "Git repository URL (HTTPS, SSH, Git, File, or SCP format)")
    .option("-n, --name <name>", "Custom repository name")
    .option("--create-setup", "Create setup.sh template if no setup script found", false)
    .option("-f, --force", "Skip confirmation prompts", false)
    .option("-j, --json", "Output result as JSON", false)
    .action(async (gitUrl: string, options: AddCommandOptions) => {
      let workspaceRoots: WorkspaceRoots | null = null;
      try {
        workspaceRoots = await findConfiguredWorkspaceRoots("add", process.cwd());
        const workspaceRoot = workspaceRoots.configurationRoot;
        const result = await executeAdd(gitUrl, options, workspaceRoot);

        if (options.json) {
          writeJsonEnvelope(
            createJsonSuccessEnvelope("add", {
              managedIgnore: result.managedIgnore,
              repository: {
                defaultBranch: result.defaultBranch,
                gitUrl: result.gitUrl,
                name: result.repositoryName,
                path: result.clonePath.replace(workspaceRoot, "."),
                setupScript: result.setupScript
                  ? result.setupScript.replace(workspaceRoot, ".")
                  : null,
                setupScriptCreated: result.setupScriptCreated,
              },
            }),
          );
        } else {
          displaySuccess(result, workspaceRoot);
        }

        process.exit(0);
      } catch (error) {
        if (error instanceof AddCommandError) {
          if (options.json) {
            writeJsonEnvelope(
              createJsonErrorEnvelope("add", {
                code: error.code,
                details: error.context,
                message: error.message,
              }),
            );
          } else {
            displayError(error);
            if (workspaceRoots) {
              await maybeRunCloneFallback(error, workspaceRoots);
            }
          }
          process.exit(CANCELLED_EXIT_CODE);
        } else {
          if (options.json) {
            writeJsonEnvelope(createJsonErrorEnvelope("add", unknownErrorToJsonError(error)));
          } else {
            logError(`\nUnexpected error: ${(error as Error).message}`);
          }
          process.exit(ERROR_EXIT_CODE);
        }
      }
    });

  return cmd;
}
