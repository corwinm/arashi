/**
 * Repository Management - Core Module
 * 
 * Provides repository discovery, default branch detection, setup script detection,
 * workspace validation, cloning, and metadata gathering capabilities.
 */

// ============================================================================
// Enums and Error Codes (T006)
// ============================================================================

/**
 * Error codes for repository operations
 */
export enum ErrorCode {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NOT_A_DIRECTORY = "NOT_A_DIRECTORY",
  INVALID_GIT_REPO = "INVALID_GIT_REPO",
  SYMLINK_LOOP = "SYMLINK_LOOP",
  IO_ERROR = "IO_ERROR",
}

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
export enum CloneStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

/**
 * Phase of clone operation (T073)
 */
export enum ClonePhase {
  VALIDATING = "VALIDATING",
  CLONING = "CLONING",
  RECEIVING = "RECEIVING",
  RESOLVING = "RESOLVING",
  COMPLETED = "COMPLETED",
}

/**
 * Error codes for clone operations (T075)
 */
export enum CloneErrorCode {
  TARGET_EXISTS = "TARGET_EXISTS",
  INVALID_URL = "INVALID_URL",
  NETWORK_ERROR = "NETWORK_ERROR",
  AUTH_FAILED = "AUTH_FAILED",
  TIMEOUT = "TIMEOUT",
  DISK_FULL = "DISK_FULL",
  UNKNOWN = "UNKNOWN",
}

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
  constructor(
    message: string,
    public readonly repository: string,
    public readonly cause?: Error
  ) {
    super(message);
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
    super(
      `Failed to gather metadata for ${repository}`,
      repository,
      cause
    );
    this.name = "RepositoryMetadataError";
  }
}

// ============================================================================
// Implementation Functions
// ============================================================================

import { readdir, stat, rm } from "fs/promises";
import { join, basename, resolve } from "path";
import { fileExists } from "../lib/filesystem.js";
import { spinner as createSpinner, warn } from "../lib/logger.js";
import * as git from "../lib/git.js";

// ============================================================================
// User Story 1: Repository Discovery (T019-T028)
// ============================================================================

/**
 * Discovers git repositories in a workspace directory (T019)
 * 
 * Recursively scans the workspace directory up to the specified depth,
 * identifying valid git repositories and gathering basic information.
 */
export async function discoverRepositories(
  workspacePath: string,
  options: DiscoveryOptions = {}
): Promise<RepositoryDiscoveryResult> {
  const startTime = Date.now();
  const repositories: Repository[] = [];
  const errors: DiscoveryError[] = [];
  let scannedDirectories = 0;
  
  const maxDepth = options.maxDepth ?? 3;
  const followSymlinks = options.followSymlinks ?? false;
  const excludePatterns = options.excludePatterns ?? ["node_modules", ".git"];
  
  // T027: Add progress spinner
  const s = createSpinner("Discovering repositories...");
  s.start();
  
  try {
    // T020: Implement recursive scanDirectory
    await scanDirectory(workspacePath, 0);
    
    s.succeed(`Found ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`);
    
    // T028: Return RepositoryDiscoveryResult
    return {
      repositories,
      workspacePath,
      scanDepth: maxDepth,
      scannedDirectories,
      errors,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    s.fail("Discovery failed");
    throw error;
  }
  
  /**
   * Recursively scan a directory for git repositories (T020)
   */
  async function scanDirectory(dirPath: string, depth: number): Promise<void> {
    // T023: Implement maxDepth limit
    if (depth > maxDepth) {
      return;
    }
    
    scannedDirectories++;
    
    try {
      // T021: Implement .git directory detection
      const gitDir = join(dirPath, ".git");
      const hasGit = await fileExists(gitDir);
      
      if (hasGit) {
        // T022: Early termination when .git found
        // Found a repository - don't scan subdirectories
        const repo = await createRepositoryInfo(dirPath);
        repositories.push(repo);
        return;
      }
      
      // Not a repo - scan subdirectories
      const entries = await readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        // T024: Implement excludePatterns filtering
        if (excludePatterns.some(pattern => entry.name.includes(pattern))) {
          continue;
        }
        
        // Handle directories
        if (entry.isDirectory()) {
          const subPath = join(dirPath, entry.name);
          await scanDirectory(subPath, depth + 1);
        }
        
        // Handle symlinks if configured
        if (entry.isSymbolicLink() && followSymlinks) {
          try {
            const subPath = resolve(dirPath, entry.name);
            const stats = await stat(subPath);
            if (stats.isDirectory()) {
              await scanDirectory(subPath, depth + 1);
            }
          } catch (symlinkError) {
            // T025: Collect non-fatal errors
            errors.push(classifyError(join(dirPath, entry.name), symlinkError));
          }
        }
      }
    } catch (error: any) {
      // T025: Implement error collection for non-fatal errors
      errors.push(classifyError(dirPath, error));
    }
  }
}

/**
 * Create Repository info object (T026, updated T040, T055)
 * 
 * Now includes default branch detection (US2) and setup script detection (US3).
 */
async function createRepositoryInfo(repoPath: string): Promise<Repository> {
  const name = basename(repoPath);
  
  // T040: Integrate detectDefaultBranch()
  let defaultBranch = "main"; // fallback
  try {
    defaultBranch = await detectDefaultBranch(repoPath);
  } catch (error) {
    // T041: Add warning logging when detection fails
    warn(`Could not detect default branch for ${name}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  
  // T055: Integrate detectSetupScript()
  const setupResult = await detectSetupScript(repoPath);
  
  return {
    name,
    path: repoPath,
    defaultBranch,
    hasSetupScript: setupResult.hasSetupScript,
    setupScriptPath: setupResult.setupScriptPath,
    remoteUrl: undefined,
  };
}

/**
 * Classify an error into an ErrorCode
 */
function classifyError(path: string, error: any): DiscoveryError {
  let code: ErrorCode;
  let message: string;
  
  if (error.code === "EACCES" || error.code === "EPERM") {
    code = ErrorCode.PERMISSION_DENIED;
    message = "Permission denied";
  } else if (error.code === "ENOTDIR") {
    code = ErrorCode.NOT_A_DIRECTORY;
    message = "Not a directory";
  } else if (error.code === "ELOOP") {
    code = ErrorCode.SYMLINK_LOOP;
    message = "Symbolic link loop detected";
  } else {
    code = ErrorCode.IO_ERROR;
    message = error.message || "I/O error";
  }
  
  return {
    path,
    message,
    code,
    cause: error instanceof Error ? error : undefined,
  };
}

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
export async function detectDefaultBranch(
  repositoryPath: string
): Promise<string> {
  try {
    // T036: Implement primary method - git symbolic-ref
    const result = await git.exec(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      repositoryPath
    );
    
    // Parse output format: "refs/remotes/origin/main"
    const match = result.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch (error) {
    // Fall through to fallback methods
  }
  
  // T037: Implement fallback 1 - Check common branch names
  const commonBranches = ["main", "master", "develop", "trunk"];
  for (const branch of commonBranches) {
    try {
      await git.exec(
        ["rev-parse", "--verify", `refs/heads/${branch}`],
        repositoryPath
      );
      
      // Branch exists
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }
  
  // T038: Implement fallback 2 - Get current branch from HEAD
  try {
    const result = await git.exec(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      repositoryPath
    );
    
    const currentBranch = result.stdout.trim();
    if (currentBranch && currentBranch !== "HEAD") {
      return currentBranch;
    }
  } catch {
    // Fall through to error
  }
  
  // T039: Add error handling
  throw new RepositoryInvalidError(
    repositoryPath,
    new Error("Could not determine default branch")
  );
}

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
const DEFAULT_SETUP_PATTERNS = [
  "setup.sh",
  "setup.bash",
  ".arashi/setup.sh",
];

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
export async function detectSetupScript(
  repositoryPath: string,
  patterns: string[] = DEFAULT_SETUP_PATTERNS
): Promise<SetupScriptResult> {
  // T051: Implement file existence check for setup.sh in repository root
  // T052: Support configurable script patterns
  for (const pattern of patterns) {
    const scriptPath = join(repositoryPath, pattern);
    
    try {
      // Check if file exists
      const file = Bun.file(scriptPath);
      const exists = await file.exists();
      
      if (exists) {
        // T054: Return object with hasSetupScript flag and setupScriptPath
        return {
          hasSetupScript: true,
          setupScriptPath: scriptPath,
        };
      }
    } catch {
      // File doesn't exist or can't be accessed, continue to next pattern
      continue;
    }
  }
  
  // No setup script found
  return {
    hasSetupScript: false,
    setupScriptPath: undefined,
  };
}

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
export async function validateWorkspace(
  config: WorkspaceConfiguration,
  options: ValidationOptions = {}
): Promise<ValidationResult> {
  // T065: Run discoverRepositories() to get actual repositories
  const discoveryResult = await discoverRepositories(
    config.workspacePath,
    options.discoveryOptions
  );
  
  const actualRepos = discoveryResult.repositories;
  const expectedRepos = config.repositories;
  
  // T067: Implement set-based comparison (present, missing, extra)
  const present: Repository[] = [];
  const missing: RepositoryConfig[] = [];
  const extra: Repository[] = [];
  
  // T066: Parse WorkspaceConfiguration to get expected repositories
  // Create a map of expected repos by name for quick lookup
  const expectedMap = new Map<string, RepositoryConfig>();
  for (const expectedRepo of expectedRepos) {
    expectedMap.set(expectedRepo.name, expectedRepo);
  }
  
  // Create a set of actual repo names for quick lookup
  const actualNames = new Set(actualRepos.map(r => r.name));
  
  // Find present repositories (in both expected and actual)
  for (const actualRepo of actualRepos) {
    if (expectedMap.has(actualRepo.name)) {
      present.push(actualRepo);
    } else {
      // Repository exists but not in config
      extra.push(actualRepo);
    }
  }
  
  // Find missing repositories (in expected but not in actual)
  for (const expectedRepo of expectedRepos) {
    if (!actualNames.has(expectedRepo.name)) {
      missing.push(expectedRepo);
    }
  }
  
  // T068, T069: Build ValidationResult with categorized repositories and isValid flag
  const isValid = missing.length === 0 && discoveryResult.errors.length === 0;
  
  return {
    isValid,
    present,
    missing,
    extra,
    errors: discoveryResult.errors,
  };
}

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
export async function cloneRepository(
  url: string,
  targetPath: string,
  options: CloneOptions = {}
): Promise<CloneOperation> {
  // T084: Create CloneOperation object with unique ID and PENDING status
  const operation: CloneOperation = {
    id: crypto.randomUUID(),
    url,
    targetPath,
    status: CloneStatus.PENDING,
    startTime: new Date(),
  };
  
  try {
    // T083: Implement pre-flight check: verify target path doesn't exist
    let targetExists = false;
    try {
      await stat(targetPath);
      targetExists = true;
    } catch {
      // Target doesn't exist, which is what we want
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
    
    // Clean up if force mode and target exists
    if (targetExists && options.force) {
      await rm(targetPath, { recursive: true, force: true });
    }
    
    // T085: Execute git clone command using git utilities spawn
    operation.status = CloneStatus.IN_PROGRESS;
    
    // Build git clone arguments
    const args = ["clone"];
    
    // T091: Support CloneOptions: depth, branch, timeout
    if (options.depth) {
      args.push("--depth", options.depth.toString());
    }
    
    if (options.branch) {
      args.push("--branch", options.branch);
    }
    
    args.push("--progress"); // Enable progress output
    args.push(url);
    args.push(targetPath);
    
    // T086, T087, T088: Implement progress parsing and callbacks
    let lastProgress: CloneProgress = {
      phase: ClonePhase.VALIDATING,
      percentage: 0,
      message: "Starting clone...",
    };
    
    const updateProgress = (progress: CloneProgress) => {
      lastProgress = progress;
      operation.progress = progress;
      if (options.onProgress) {
        options.onProgress(progress);
      }
    };
    
    updateProgress({
      phase: ClonePhase.CLONING,
      percentage: 0,
      message: "Cloning repository...",
    });
    
    // Execute git clone
    try {
      const result = await git.exec(args, process.cwd(), {
        timeout: options.timeout || 30000,
      });
      
      // T086: Parse progress from stderr (git outputs progress to stderr)
      if (result.stderr) {
        parseCloneProgress(result.stderr, updateProgress);
      }
      
      // T089: Handle clone success: verify .git directory, update status to COMPLETED
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
        phase: ClonePhase.COMPLETED,
        percentage: 100,
        message: "Clone completed successfully",
      };
      
    } catch (error: any) {
      // T090: Handle clone failure: categorize error, cleanup partial clone, update status to FAILED
      await handleCloneFailure(operation, error, targetPath);
    }
    
  } catch (error: any) {
    // T090: Handle unexpected errors
    await handleCloneFailure(operation, error, targetPath);
  }
  
  // Calculate duration
  operation.endTime = new Date();
  operation.duration = operation.endTime.getTime() - operation.startTime.getTime();
  
  return operation;
}

/**
 * Parse git clone progress output (T086-T087)
 */
function parseCloneProgress(
  output: string,
  callback: (progress: CloneProgress) => void
): void {
  const lines = output.split("\n");
  
  for (const line of lines) {
    // Parse "Receiving objects: XX% (X/Y)"
    const receivingMatch = line.match(/Receiving objects:\s+(\d+)%\s+\((\d+)\/(\d+)\)/);
    if (receivingMatch) {
      callback({
        phase: ClonePhase.RECEIVING,
        percentage: parseInt(receivingMatch[1]),
        objectsReceived: parseInt(receivingMatch[2]),
        objectsTotal: parseInt(receivingMatch[3]),
        message: `Receiving objects: ${receivingMatch[1]}%`,
      });
      continue;
    }
    
    // Parse "Resolving deltas: XX% (X/Y)"
    const resolvingMatch = line.match(/Resolving deltas:\s+(\d+)%\s+\((\d+)\/(\d+)\)/);
    if (resolvingMatch) {
      callback({
        phase: ClonePhase.RESOLVING,
        percentage: parseInt(resolvingMatch[1]),
        deltasResolved: parseInt(resolvingMatch[2]),
        deltasTotal: parseInt(resolvingMatch[3]),
        message: `Resolving deltas: ${resolvingMatch[1]}%`,
      });
      continue;
    }
  }
}

/**
 * Handle clone failure with proper error categorization and cleanup (T090)
 */
async function handleCloneFailure(
  operation: CloneOperation,
  error: any,
  targetPath: string
): Promise<void> {
  operation.status = CloneStatus.FAILED;
  
  // Categorize error
  let errorCode = CloneErrorCode.UNKNOWN;
  let errorMessage = error.message || "Clone failed";
  
  if (error.message?.includes("timeout") || error.message?.includes("timed out")) {
    errorCode = CloneErrorCode.TIMEOUT;
    errorMessage = "Clone operation timed out";
  } else if (error.message?.includes("Authentication") || error.message?.includes("Permission denied")) {
    errorCode = CloneErrorCode.AUTH_FAILED;
    errorMessage = "Authentication failed";
  } else if (error.message?.includes("not found") || error.message?.includes("repository not found")) {
    errorCode = CloneErrorCode.INVALID_URL;
    errorMessage = "Repository not found or URL is invalid";
  } else if (error.message?.includes("network") || error.message?.includes("Could not resolve host")) {
    errorCode = CloneErrorCode.NETWORK_ERROR;
    errorMessage = "Network error during clone";
  } else if (error.message?.includes("disk") || error.message?.includes("No space left")) {
    errorCode = CloneErrorCode.DISK_FULL;
    errorMessage = "Insufficient disk space";
  }
  
  operation.error = {
    code: errorCode,
    message: errorMessage,
    cause: error instanceof Error ? error : undefined,
  };
  
  // Cleanup partial clone
  try {
    let targetExists = false;
    try {
      await stat(targetPath);
      targetExists = true;
    } catch {
      targetExists = false;
    }
    
    if (targetExists) {
      await rm(targetPath, { recursive: true, force: true });
    }
  } catch (cleanupError) {
    // Ignore cleanup errors
  }
}

// User Story 6: Metadata Gathering (Phase 9) - To be implemented
