import { runtime } from "../lib/runtime.ts";
/**
 * Repository Management - Core Module
 *
 * Provides repository discovery, default branch detection, setup script detection,
 * workspace validation, cloning, and metadata gathering capabilities.
 */

import { basename, join, resolve } from "path";
import { spinner as createSpinner, warn } from "../lib/logger.ts";
import { readdir, rm, stat } from "fs/promises";
import { exec as execGit } from "../lib/git.ts";
import { fileExists } from "../lib/filesystem.ts";

const ZERO = 0;
const ONE = 1;
const SECOND_CAPTURE = 2;
const THIRD_CAPTURE = 3;
const DECIMAL_RADIX = 10;
const DEFAULT_SCAN_DEPTH = 3;
const CLONE_COMPLETE_PERCENTAGE = 100;
const DEFAULT_EXCLUDE_PATTERNS = ["node_modules", ".git"];
const COMMON_BRANCHES = ["main", "master", "develop", "trunk"];

const comparePaths = (left: { path: string }, right: { path: string }): number =>
  left.path.localeCompare(right.path, "en");

const scanSymlinkDirectory = async (options: {
  dirPath: string;
  entryName: string;
  errors: DiscoveryError[];
  scanDirectory: (dirPath: string, depth: number) => Promise<void>;
  depth: number;
}): Promise<void> => {
  try {
    const subPath = resolve(options.dirPath, options.entryName);
    const stats = await stat(subPath);
    if (stats.isDirectory()) {
      await options.scanDirectory(subPath, options.depth + ONE);
    }
  } catch (symlinkError) {
    options.errors.push(classifyError(join(options.dirPath, options.entryName), symlinkError));
  }
};

// ============================================================================
// Enums and Error Codes (T006)
// ============================================================================

/**
 * Error codes for repository operations
 */
export const ErrorCode = {
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_A_DIRECTORY: "NOT_A_DIRECTORY",
  INVALID_GIT_REPO: "INVALID_GIT_REPO",
  SYMLINK_LOOP: "SYMLINK_LOOP",
  IO_ERROR: "IO_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================================
// Core Interfaces (T007-T010)
// ============================================================================

/**
 * Represents a git repository with its metadata and location (T007)
 */
export interface Repository {
  /** Repository name (derived from directory name) */
  name: string;
  /** Absolute filesystem path to repository root */
  path: string;
  /** Default branch name (main, master, develop, etc.) */
  defaultBranch: string;
  /** Whether repository contains a setup script */
  hasSetupScript: boolean;
  /** Path to setup script if present */
  setupScriptPath?: string;
  /** Primary remote URL (usually origin) */
  remoteUrl?: string;
  /** Optional semantic groups this repository belongs to */
  groups?: string[];
}

/**
 * Options for repository discovery (T008)
 */
export interface DiscoveryOptions {
  /** Maximum depth to scan (default: 3) */
  maxDepth?: number;
  /** Whether to follow symbolic links (default: false) */
  followSymlinks?: boolean;
  /** Patterns to exclude from scan (e.g., "node_modules", ".git") */
  excludePatterns?: string[];
  /** Setup script file patterns to detect (default: ["setup.sh"]) */
  setupScriptPatterns?: string[];
}

/**
 * Non-fatal error encountered during repository discovery (T009)
 */
export interface DiscoveryError {
  /** Path where error occurred */
  path: string;
  /** Error description */
  message: string;
  /** Categorized error type */
  code: ErrorCode;
  /** Original error if applicable */
  cause?: Error;
}

/**
 * Result of scanning a workspace directory for repositories (T010)
 */
export interface RepositoryDiscoveryResult {
  /** Discovered repositories */
  repositories: Repository[];
  /** Path that was scanned */
  workspacePath: string;
  /** Maximum depth that was scanned */
  scanDepth: number;
  /** Total directories examined */
  scannedDirectories: number;
  /** Non-fatal errors encountered */
  errors: DiscoveryError[];
  /** Time taken in milliseconds */
  duration: number;
}

/**
 * Configuration for expected repositories (T056)
 */
export interface WorkspaceConfiguration {
  /** Base workspace path */
  workspacePath: string;
  /** Expected repositories */
  repositories: RepositoryConfig[];
}

/**
 * Expected repository configuration (T057)
 */
export interface RepositoryConfig {
  /** Repository name */
  name: string;
  /** Expected path relative to workspace (optional) */
  path?: string;
  /** Git URL for cloning if missing (optional) */
  url?: string;
}

/**
 * Result of workspace validation (T058)
 */
export interface ValidationResult {
  /** Whether workspace is valid (no missing repos, no errors) */
  isValid: boolean;
  /** Repositories present in both config and workspace */
  present: Repository[];
  /** Repositories in config but missing from workspace */
  missing: RepositoryConfig[];
  /** Repositories in workspace but not in config */
  extra: Repository[];
  /** Errors encountered during validation */
  errors: DiscoveryError[];
}

/**
 * Options for workspace validation (T059)
 */
export interface ValidationOptions {
  /** Whether to treat extra repos as errors (default: false) */
  strictMode?: boolean;
  /** Discovery options to use when scanning */
  discoveryOptions?: DiscoveryOptions;
}

/**
 * Status of a clone operation (T071)
 */
export const CloneStatus = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
} as const;

export type CloneStatus = (typeof CloneStatus)[keyof typeof CloneStatus];

/**
 * Phase of clone operation (T073)
 */
export const ClonePhase = {
  VALIDATING: "VALIDATING",
  CLONING: "CLONING",
  RECEIVING: "RECEIVING",
  RESOLVING: "RESOLVING",
  COMPLETED: "COMPLETED",
} as const;

export type ClonePhase = (typeof ClonePhase)[keyof typeof ClonePhase];

/**
 * Error codes for clone operations (T075)
 */
export const CloneErrorCode = {
  TARGET_EXISTS: "TARGET_EXISTS",
  INVALID_URL: "INVALID_URL",
  NETWORK_ERROR: "NETWORK_ERROR",
  AUTH_FAILED: "AUTH_FAILED",
  TIMEOUT: "TIMEOUT",
  DISK_FULL: "DISK_FULL",
  UNKNOWN: "UNKNOWN",
} as const;

export type CloneErrorCode = (typeof CloneErrorCode)[keyof typeof CloneErrorCode];

/**
 * Clone progress information (T072)
 */
export interface CloneProgress {
  /** Current phase of the clone operation */
  phase: ClonePhase;
  /** Percentage complete (0-100) */
  percentage: number;
  /** Number of objects received */
  objectsReceived?: number;
  /** Total number of objects */
  objectsTotal?: number;
  /** Number of deltas resolved */
  deltasResolved?: number;
  /** Total number of deltas */
  deltasTotal?: number;
  /** Bytes received */
  bytesReceived?: number;
  /** Human-readable status message */
  message: string;
}

/**
 * Clone error information (T074)
 */
export interface CloneError {
  /** Error code */
  code: CloneErrorCode;
  /** Error message */
  message: string;
  /** Original error if available */
  cause?: Error;
}

/**
 * Clone operation result (T070)
 */
export interface CloneOperation {
  /** Unique identifier for this operation */
  id: string;
  /** Source Git URL */
  url: string;
  /** Target path for cloned repository */
  targetPath: string;
  /** Current status */
  status: CloneStatus;
  /** Progress information */
  progress?: CloneProgress;
  /** Error information if failed */
  error?: CloneError;
  /** Start time */
  startTime: Date;
  /** End time if completed or failed */
  endTime?: Date;
  /** Duration in milliseconds */
  duration?: number;
}

/**
 * Options for cloning repositories (T076)
 */
export interface CloneOptions {
  /** Specific branch to clone (default: default branch) */
  branch?: string;
  /** Shallow clone depth (default: full clone) */
  depth?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Progress callback */
  onProgress?: (progress: CloneProgress) => void;
  /** Whether to overwrite existing directory (default: false) */
  force?: boolean;
}

// ============================================================================
// Error Classes (T011)
// ============================================================================

/**
 * Base error class for repository operations
 */
export class RepositoryError extends Error {
  public readonly repository: string;
  public readonly cause?: Error;

  constructor(message: string, repository: string, cause?: Error) {
    super(message);
    this.repository = repository;
    this.cause = cause;
    this.name = "RepositoryError";

    // Maintain proper stack trace (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when repository is not found
 */
export class RepositoryNotFoundError extends RepositoryError {
  constructor(repository: string, cause?: Error) {
    super(`Repository not found: ${repository}`, repository, cause);
    this.name = "RepositoryNotFoundError";
  }
}

/**
 * Error thrown when repository is invalid or corrupt
 */
export class RepositoryInvalidError extends RepositoryError {
  constructor(repository: string, cause?: Error) {
    super(`Invalid repository: ${repository}`, repository, cause);
    this.name = "RepositoryInvalidError";
  }
}

/**
 * Error thrown when repository clone fails
 */
export class RepositoryCloneError extends RepositoryError {
  constructor(repository: string, message: string, cause?: Error) {
    super(`Clone failed for ${repository}: ${message}`, repository, cause);
    this.name = "RepositoryCloneError";
  }
}

/**
 * Error thrown when repository metadata gathering fails
 */
export class RepositoryMetadataError extends RepositoryError {
  constructor(repository: string, cause?: Error) {
    super(`Failed to gather metadata for ${repository}`, repository, cause);
    this.name = "RepositoryMetadataError";
  }
}

// ============================================================================
// User Story 1: Repository Discovery (T019-T028)
// ============================================================================

/**
 * Discovers git repositories in a workspace directory (T019)
 *
 * Recursively scans the workspace directory up to the specified depth,
 * identifying valid git repositories and gathering basic information.
 */
export const discoverRepositories = async (
  workspacePath: string,
  options: DiscoveryOptions = {},
): Promise<RepositoryDiscoveryResult> => {
  const startTime = Date.now();
  const repositories: Repository[] = [];
  const errors: DiscoveryError[] = [];
  let scannedDirectories = ZERO;

  const maxDepth = options.maxDepth ?? DEFAULT_SCAN_DEPTH;
  const followSymlinks = options.followSymlinks ?? false;
  const excludePatterns = options.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;

  // T027: Add progress spinner
  const discoverySpinner = createSpinner("Discovering repositories...");
  discoverySpinner.start();

  const scanDirectory = async (dirPath: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      return;
    }

    scannedDirectories += ONE;

    try {
      const gitDir = join(dirPath, ".git");
      const hasGit = await fileExists(gitDir);

      if (hasGit) {
        const repository = await createRepositoryInfo(dirPath);
        repositories.push(repository);
        return;
      }

      const entries = await readdir(dirPath, { withFileTypes: true });

      await Promise.all(
        entries.map(async (entry) => {
          if (excludePatterns.some((pattern) => entry.name.includes(pattern))) {
            return;
          }

          if (entry.isDirectory()) {
            const subPath = join(dirPath, entry.name);
            await scanDirectory(subPath, depth + ONE);
          }

          if (entry.isSymbolicLink() && followSymlinks) {
            await scanSymlinkDirectory({
              depth,
              dirPath,
              entryName: entry.name,
              errors,
              scanDirectory,
            });
          }
        }),
      );
    } catch (error: unknown) {
      errors.push(classifyError(dirPath, error));
    }
  };

  try {
    await scanDirectory(workspacePath, ZERO);

    let repositoryLabel = "repositories";
    if (repositories.length === ONE) {
      repositoryLabel = "repository";
    }

    discoverySpinner.succeed(`Found ${repositories.length} ${repositoryLabel}`);

    repositories.sort(comparePaths);
    errors.sort(comparePaths);

    return {
      duration: Date.now() - startTime,
      errors,
      repositories,
      scanDepth: maxDepth,
      scannedDirectories,
      workspacePath,
    };
  } catch (error) {
    discoverySpinner.fail("Discovery failed");
    throw error;
  }
};

/**
 * Create Repository info object (T026, updated T040, T055)
 *
 * Now includes default branch detection (US2) and setup script detection (US3).
 */
const createRepositoryInfo = async (repoPath: string): Promise<Repository> => {
  const name = basename(repoPath);

  let defaultBranch = "main";
  try {
    defaultBranch = await detectDefaultBranch(repoPath);
  } catch (error) {
    let errorMessage = "unknown error";
    if (error instanceof Error) {
      errorMessage = error.message;
    }

    warn(`Could not detect default branch for ${name}: ${errorMessage}`);
  }

  const setupResult = await detectSetupScript(repoPath);

  return {
    defaultBranch,
    hasSetupScript: setupResult.hasSetupScript,
    name,
    path: repoPath,
    remoteUrl: undefined,
    setupScriptPath: setupResult.setupScriptPath,
  };
};

/**
 * Classify an error into an ErrorCode
 */
const classifyError = (path: string, error: unknown): DiscoveryError => {
  let candidate: { code?: unknown; message?: unknown } = {};
  if (typeof error === "object" && error) {
    candidate = error as { code?: unknown; message?: unknown };
  }

  let code: ErrorCode = ErrorCode.IO_ERROR;
  let message = "I/O error";

  if (candidate.code === "EACCES" || candidate.code === "EPERM") {
    code = ErrorCode.PERMISSION_DENIED;
    message = "Permission denied";
  } else if (candidate.code === "ENOTDIR") {
    code = ErrorCode.NOT_A_DIRECTORY;
    message = "Not a directory";
  } else if (candidate.code === "ELOOP") {
    code = ErrorCode.SYMLINK_LOOP;
    message = "Symbolic link loop detected";
  } else {
    if (typeof candidate.message === "string") {
      ({ message } = candidate);
    }
  }

  let cause: Error | undefined = undefined;
  if (error instanceof Error) {
    cause = error;
  }

  return {
    cause,
    code,
    message,
    path,
  };
};

// ============================================================================
// User Story 2: Default Branch Detection (T035-T041)
// ============================================================================

/**
 * Detects the default branch for a repository (T035)
 *
 * Uses git symbolic-ref with fallback strategies to reliably detect
 * the default branch across different repository configurations.
 *
 * @param repositoryPath - Absolute path to repository root
 * @returns Default branch name (e.g., "main", "master", "develop")
 * @throws {RepositoryInvalidError} If default branch cannot be determined
 */
export const detectDefaultBranch = async (repositoryPath: string): Promise<string> => {
  // The common non-bare layout can be resolved without spawning Git. Discovery
  // may inspect many repositories at once, so avoiding two subprocess rounds per
  // repository keeps large workspaces responsive. Unusual Git layouts continue
  // through the authoritative command-based fallback below.
  const gitDirectory = join(repositoryPath, ".git");
  const remoteHeadPath = join(gitDirectory, "refs", "remotes", "origin", "HEAD");
  try {
    const remoteHead = await runtime.file(remoteHeadPath).text();
    const match = remoteHead.trim().match(/^ref: refs\/remotes\/origin\/(.+)$/);
    if (match?.[ONE]) return match[ONE].trim();
  } catch {}

  for (const branch of COMMON_BRANCHES) {
    if (await runtime.file(join(gitDirectory, "refs", "heads", branch)).exists()) return branch;
  }

  try {
    const head = await runtime.file(join(gitDirectory, "HEAD")).text();
    const match = head.trim().match(/^ref: refs\/heads\/(.+)$/);
    if (match?.[ONE]) return match[ONE].trim();
  } catch {}

  try {
    const result = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], repositoryPath);

    const match = result.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match && match[ONE]) {
      return match[ONE].trim();
    }
  } catch {}

  try {
    const result = await execGit(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      repositoryPath,
    );
    const branches = new Set(
      result.stdout
        .split("\n")
        .map((branch) => branch.trim())
        .filter(Boolean),
    );

    for (const branch of COMMON_BRANCHES) {
      if (branches.has(branch)) {
        return branch;
      }
    }

    const result2 = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repositoryPath);
    const currentBranch = result2.stdout.trim();
    if (currentBranch && currentBranch !== "HEAD") {
      return currentBranch;
    }
  } catch {}

  throw new RepositoryInvalidError(repositoryPath, new Error("Could not determine default branch"));
};

// ============================================================================
// User Story 3: Setup Script Detection (T050-T055)
// ============================================================================

/**
 * Result of setup script detection
 */
export interface SetupScriptResult {
  /** Whether a setup script was found */
  hasSetupScript: boolean;
  /** Absolute path to the setup script if found */
  setupScriptPath?: string;
}

/**
 * Default setup script patterns to look for
 */
const DEFAULT_SETUP_PATTERNS = ["setup.sh", "setup.bash", ".arashi/setup.sh"];

/**
 * Detects setup scripts in a repository (T050-T054)
 *
 * Checks for the presence of setup scripts using configurable patterns.
 * Default patterns include: setup.sh, setup.bash, .arashi/setup.sh
 *
 * @param repositoryPath - Absolute path to repository root
 * @param patterns - Optional custom script patterns to look for
 * @returns Object with hasSetupScript flag and setupScriptPath if found
 */
export const detectSetupScript = async (
  repositoryPath: string,
  patterns: string[] = DEFAULT_SETUP_PATTERNS,
): Promise<SetupScriptResult> => {
  for (const pattern of patterns) {
    const scriptPath = join(repositoryPath, pattern);

    try {
      const file = runtime.file(scriptPath);
      const exists = await file.exists();

      if (exists) {
        return {
          hasSetupScript: true,
          setupScriptPath: scriptPath,
        };
      }
    } catch {}
  }

  return {
    hasSetupScript: false,
    setupScriptPath: undefined,
  };
};

// ============================================================================
// User Story 5: Workspace Validation (T064-T069)
// ============================================================================

/**
 * Validates workspace structure against expected configuration (T064-T069)
 *
 * Compares discovered repositories with expected configuration to identify
 * present, missing, and extra repositories.
 *
 * @param config - Workspace configuration with expected repositories
 * @param options - Optional validation options
 * @returns Validation result with categorized repositories
 */
export const validateWorkspace = async (
  config: WorkspaceConfiguration,
  options: ValidationOptions = {},
): Promise<ValidationResult> => {
  const discoveryResult = await discoverRepositories(
    config.workspacePath,
    options.discoveryOptions,
  );

  const actualRepos = discoveryResult.repositories;
  const expectedRepos = config.repositories;

  // T067: Implement set-based comparison (present, missing, extra)
  const present: Repository[] = [];
  const missing: RepositoryConfig[] = [];
  const extra: Repository[] = [];

  const expectedMap = new Map<string, RepositoryConfig>();
  for (const expectedRepo of expectedRepos) {
    expectedMap.set(expectedRepo.name, expectedRepo);
  }

  const actualNames = new Set(actualRepos.map((repository) => repository.name));

  for (const actualRepo of actualRepos) {
    if (expectedMap.has(actualRepo.name)) {
      present.push(actualRepo);
    } else {
      extra.push(actualRepo);
    }
  }

  for (const expectedRepo of expectedRepos) {
    if (!actualNames.has(expectedRepo.name)) {
      missing.push(expectedRepo);
    }
  }

  const isValid = missing.length === ZERO && discoveryResult.errors.length === ZERO;

  return {
    errors: discoveryResult.errors,
    extra,
    isValid,
    missing,
    present,
  };
};

// ============================================================================
// User Story 4: Repository Cloning (T082-T092)
// ============================================================================

/**
 * Clones a git repository from a URL to a target path (T082-T092)
 *
 * Executes git clone with progress reporting and comprehensive error handling.
 * Supports shallow clones, specific branches, and progress callbacks.
 *
 * @param url - Git repository URL to clone from
 * @param targetPath - Target directory path for cloned repository
 * @param options - Optional clone options
 * @returns CloneOperation with status and progress information
 */
export const cloneRepository = async (
  url: string,
  targetPath: string,
  options: CloneOptions = {},
): Promise<CloneOperation> => {
  const operation: CloneOperation = {
    id: crypto.randomUUID(),
    startTime: new Date(),
    status: CloneStatus.PENDING,
    targetPath,
    url,
  };

  try {
    let targetExists = false;
    try {
      await stat(targetPath);
      targetExists = true;
    } catch {
      targetExists = false;
    }

    if (targetExists && !options.force) {
      operation.status = CloneStatus.FAILED;
      operation.error = {
        code: CloneErrorCode.TARGET_EXISTS,
        message: `Target path already exists: ${targetPath}`,
      };
      operation.endTime = new Date();
      operation.duration = operation.endTime.getTime() - operation.startTime.getTime();
      return operation;
    }

    if (targetExists && options.force) {
      await rm(targetPath, { force: true, recursive: true });
    }

    operation.status = CloneStatus.IN_PROGRESS;

    const args = ["clone"];

    if (options.depth) {
      args.push("--depth", options.depth.toString());
    }

    if (options.branch) {
      args.push("--branch", options.branch);
    }

    args.push("--progress");
    args.push(url);
    args.push(targetPath);

    const updateProgress = (progress: CloneProgress) => {
      operation.progress = progress;
      if (options.onProgress) {
        options.onProgress(progress);
      }
    };

    updateProgress({
      message: "Cloning repository...",
      percentage: ZERO,
      phase: ClonePhase.CLONING,
    });

    try {
      const result = await execGit(args, process.cwd());

      if (result.stderr) {
        parseCloneProgress(result.stderr, updateProgress);
      }

      let gitDirExists = false;
      try {
        const gitDirStat = await stat(join(targetPath, ".git"));
        gitDirExists = gitDirStat.isDirectory();
      } catch {
        gitDirExists = false;
      }

      if (!gitDirExists) {
        throw new Error("Clone completed but .git directory not found");
      }

      operation.status = CloneStatus.COMPLETED;
      operation.progress = {
        message: "Clone completed successfully",
        percentage: CLONE_COMPLETE_PERCENTAGE,
        phase: ClonePhase.COMPLETED,
      };
    } catch (error: unknown) {
      await handleCloneFailure(operation, error, targetPath);
    }
  } catch (error: unknown) {
    await handleCloneFailure(operation, error, targetPath);
  }

  operation.endTime = new Date();
  operation.duration = operation.endTime.getTime() - operation.startTime.getTime();

  return operation;
};

/**
 * Parse git clone progress output (T086-T087)
 */
const parseCloneProgress = (output: string, callback: (progress: CloneProgress) => void): void => {
  const lines = output.split("\n");

  for (const line of lines) {
    const receivingMatch = line.match(/Receiving objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)/);
    if (receivingMatch) {
      callback({
        message: `Receiving objects: ${receivingMatch[ONE]}%`,
        objectsReceived: Number.parseInt(receivingMatch[SECOND_CAPTURE], DECIMAL_RADIX),
        objectsTotal: Number.parseInt(receivingMatch[THIRD_CAPTURE], DECIMAL_RADIX),
        percentage: Number.parseInt(receivingMatch[ONE], DECIMAL_RADIX),
        phase: ClonePhase.RECEIVING,
      });
    } else {
      const resolvingMatch = line.match(/Resolving deltas:\s+(\d+)%\s+\((\d+)\/(\d+)\)/);
      if (resolvingMatch) {
        callback({
          deltasResolved: Number.parseInt(resolvingMatch[SECOND_CAPTURE], DECIMAL_RADIX),
          deltasTotal: Number.parseInt(resolvingMatch[THIRD_CAPTURE], DECIMAL_RADIX),
          message: `Resolving deltas: ${resolvingMatch[ONE]}%`,
          percentage: Number.parseInt(resolvingMatch[ONE], DECIMAL_RADIX),
          phase: ClonePhase.RESOLVING,
        });
      }
    }
  }
};

/**
 * Handle clone failure with proper error categorization and cleanup (T090)
 */
const handleCloneFailure = async (
  operation: CloneOperation,
  error: unknown,
  targetPath: string,
): Promise<void> => {
  let candidate: { message?: unknown } = {};
  if (typeof error === "object" && error) {
    candidate = error as { message?: unknown };
  }

  let errorText = "Clone failed";
  if (typeof candidate.message === "string") {
    errorText = candidate.message;
  }

  operation.status = CloneStatus.FAILED;

  let errorCode: CloneErrorCode = CloneErrorCode.UNKNOWN;
  let errorMessage = errorText;

  if (errorText.includes("timeout") || errorText.includes("timed out")) {
    errorCode = CloneErrorCode.TIMEOUT;
    errorMessage = "Clone operation timed out";
  } else if (errorText.includes("Authentication") || errorText.includes("Permission denied")) {
    errorCode = CloneErrorCode.AUTH_FAILED;
    errorMessage = "Authentication failed";
  } else if (errorText.includes("not found") || errorText.includes("repository not found")) {
    errorCode = CloneErrorCode.INVALID_URL;
    errorMessage = "Repository not found or URL is invalid";
  } else if (errorText.includes("network") || errorText.includes("Could not resolve host")) {
    errorCode = CloneErrorCode.NETWORK_ERROR;
    errorMessage = "Network error during clone";
  } else if (errorText.includes("disk") || errorText.includes("No space left")) {
    errorCode = CloneErrorCode.DISK_FULL;
    errorMessage = "Insufficient disk space";
  }

  let cause: Error | undefined = undefined;
  if (error instanceof Error) {
    cause = error;
  }

  operation.error = {
    cause,
    code: errorCode,
    message: errorMessage,
  };

  try {
    let targetExists = false;
    try {
      await stat(targetPath);
      targetExists = true;
    } catch {
      targetExists = false;
    }

    if (targetExists) {
      await rm(targetPath, { force: true, recursive: true });
    }
  } catch {}
};

// User Story 6: Metadata Gathering (Phase 9) - To be implemented
