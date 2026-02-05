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

import { readdir, stat } from "fs/promises";
import { join, basename, resolve } from "path";
import { fileExists } from "../lib/filesystem";
import { spinner as createSpinner, warn } from "../lib/logger";
import * as git from "../lib/git";

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

// User Story 4: Repository Cloning (Phase 8) - To be implemented
// User Story 5: Workspace Validation (Phase 7) - To be implemented
// User Story 6: Metadata Gathering (Phase 9) - To be implemented
