/**
 * Type definitions for git utility library
 * Based on data-model.md
 */

/**
 * Result of executing a git command
 */
export interface CommandResult {
  /** Standard output from command */
  stdout: string;
  /** Standard error output from command */
  stderr: string;
  /** Process exit code (0 = success) */
  exitCode: number;
}

/**
 * Diagnostic context for git operation errors
 */
export interface GitErrorContext {
  /** Standard output from failed command */
  stdout: string;
  /** Standard error output from failed command */
  stderr: string;
  /** Process exit code */
  exitCode: number;
  /** Git command arguments that were executed */
  args: string[];
  /** Working directory where command was executed */
  cwd?: string;
}

/**
 * Represents a git worktree (working directory linked to repository)
 */
export interface Worktree {
  /** Absolute filesystem path to worktree */
  path: string;
  /** Branch name checked out in worktree (null if detached HEAD) */
  branch: string | null;
  /** Commit SHA that worktree is at */
  commit: string;
  /** Whether worktree is locked (cannot be removed) */
  locked: boolean;
  /** Reason for lock (if locked=true) */
  lockReason?: string;
}

/**
 * Represents a git branch reference
 */
export interface Branch {
  /** Branch name (without refs/heads/ prefix) */
  name: string;
  /** Commit SHA that branch points to */
  commit: string;
  /** Upstream tracking branch (e.g., 'origin/main') */
  upstream: string | null;
  /** Whether branch is fully merged into HEAD */
  merged: boolean;
}

/**
 * Represents a file status in git working tree
 */
export interface StatusEntry {
  /** Relative path to file from repository root */
  path: string;
  /** Status in index (staging area): ' ', 'M', 'A', 'D', 'R', 'C', 'U', '?' */
  indexStatus: string;
  /** Status in worktree: ' ', 'M', 'D', '?' */
  worktreeStatus: string;
  /** Original path (for renames/copies) */
  originalPath?: string;
}

/**
 * Represents a git repository location and type
 */
export interface RepositoryInfo {
  /** Absolute filesystem path to repository */
  path: string;
  /** Repository type */
  type: "normal" | "bare";
  /** Default branch name (e.g., 'main', 'master') */
  defaultBranch: string | null;
}

/**
 * Error codes for git operations
 */
export const GitErrorCode = {
  GIT_FATAL: "GIT_FATAL",
  NOT_A_REPOSITORY: "NOT_A_REPOSITORY",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NETWORK_ERROR: "NETWORK_ERROR",
  GIT_ERROR: "GIT_ERROR",
} as const;

export type GitErrorCode = (typeof GitErrorCode)[keyof typeof GitErrorCode];
