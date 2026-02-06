/**
 * List Command Type Definitions
 * 
 * Type definitions for the list command that displays worktrees and their status.
 * 
 * @module types/list
 */

// ============================================================================
// Data Types
// ============================================================================

/**
 * Represents a nested repository within a worktree
 */
export interface SubRepositoryInfo {
  /** Path relative to parent worktree */
  relativePath: string;
  /** Branch name (null if detached HEAD) */
  branch: string | null;
  /** Short commit SHA (7 characters) */
  commit: string;
  /** Whether uncommitted changes exist */
  hasChanges: boolean;
}

/**
 * Represents a single worktree with its status and metadata
 */
export interface WorktreeListItem {
  /** Absolute filesystem path to worktree */
  path: string;
  /** Branch name (null if detached HEAD) */
  branch: string | null;
  /** Short commit SHA (7 characters) */
  commit: string;
  /** Whether worktree is locked */
  locked: boolean;
  /** Lock reason (if locked) */
  lockReason?: string;
  /** Whether uncommitted changes exist */
  hasChanges: boolean;
  /** True for main worktree, false for linked worktrees */
  isMain: boolean;
  /** Nested sub-repositories (only present in verbose mode) */
  subRepositories?: SubRepositoryInfo[];
}

/**
 * Command-line options for the list command
 */
export interface ListCommandOptions {
  /** Show detailed sub-repository information */
  verbose?: boolean;
  /** Output in JSON format */
  json?: boolean;
  /** Show table format with headers (default: simple list) */
  table?: boolean;
  /** Maximum depth for sub-repository discovery (default: 3) */
  maxDepth?: number;
}

/**
 * Complete output structure for the list command
 */
export interface ListCommandOutput {
  /** List of all worktrees */
  worktrees: WorktreeListItem[];
  /** Total number of worktrees */
  totalCount: number;
  /** Path to main repository */
  repositoryPath: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Custom error class for list command errors
 */
export class ListCommandError extends Error {
  public readonly context?: any;
  
  constructor(message: string, context?: any) {
    super(message);
    this.name = 'ListCommandError';
    this.context = context;
    
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ListCommandError);
    }
  }
}

/**
 * Error thrown when not in a git repository
 */
export class NotInRepositoryError extends ListCommandError {
  constructor(path: string) {
    super(
      `Not a git repository: ${path}. Run from repository root.`,
      { path }
    );
    this.name = 'NotInRepositoryError';
  }
}

/**
 * Error thrown when configuration is missing
 */
export class ConfigurationMissingError extends ListCommandError {
  constructor(path: string) {
    super(
      `Configuration not found at ${path}. Run "arashi init" first.`,
      { path }
    );
    this.name = 'ConfigurationMissingError';
  }
}
