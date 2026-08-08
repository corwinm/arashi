/**
 * Types for the remove command
 */

import type { LifecycleHookOutcome } from "../lib/hooks.ts";

export interface DirtyStatus {
  /** True if any uncommitted changes exist */
  isDirty: boolean;
  /** Count of modified tracked files (staged or unstaged) */
  modifiedFiles: number;
  /** Count of untracked files */
  untrackedFiles: number;
  /** Count of staged files */
  stagedFiles: number;
}

export type WorktreeStatus = "present" | "prunable" | "dirty";

export interface WorktreeInfo {
  /** Absolute filesystem path to worktree */
  path: string;
  /** Branch name checked out in worktree */
  branch: string;
  /** Repository name */
  repository: string;
  /** True if this is the main worktree */
  isMain: boolean;
  /** Git-provided reason when this worktree metadata is prunable */
  pruneReason?: string;
  /** Dirty status (if checked) */
  isDirty?: boolean;
  /** Optional detailed dirty status */
  dirtyDetails?: DirtyStatus;
}

export interface WorktreeEntry extends WorktreeInfo {
  /** Status derived from filesystem + git state */
  status: WorktreeStatus;
  /** Parent worktree path if nested */
  parentPath: string | null;
  /** Child worktree paths if parent */
  childrenPaths: string[];
}

export interface WorktreeGroup {
  /** Parent entry for the group */
  parent: WorktreeEntry;
  /** Child entries grouped under the parent */
  children: WorktreeEntry[];
}

export interface WorktreeGrouping {
  /** Parent/child groups */
  groups: WorktreeGroup[];
  /** Entries without a parent or missing parent */
  orphans: WorktreeEntry[];
}

export interface RemovalOperation {
  /** Operation type */
  type: "worktree_remove" | "worktree_detach" | "branch_delete";
  /** Repository name */
  repository: string;
  /** Target branch name */
  branchName: string;
  /** Worktree path for worktree removal */
  worktreePath?: string;
  /** Status of the operation */
  status: "pending" | "success" | "failed";
  /** Error message if failed */
  error?: string;
}

export interface RemoveHookPreview {
  /** Lifecycle hook name */
  hookName: "pre-remove" | "post-remove";
  /** Target repository name */
  repository: string;
  /** Hook discovery scope */
  scope: string;
  /** Hook script path */
  scriptPath: string;
  /** Whether the hook would be valid for a real run */
  valid: boolean;
  /** Validation error, if any */
  error?: string;
}

export interface RemovalSummary {
  /** Total worktrees targeted for removal */
  totalWorktrees: number;
  /** Successful worktree removals */
  successfulWorktrees: number;
  /** Total branches targeted for deletion */
  totalBranches: number;
  /** Successful branch deletions */
  successfulBranches: number;
  /** All operations performed */
  operations: RemovalOperation[];
  /** Error messages for failed operations */
  errors: string[];
  /** Total duration in milliseconds */
  duration: number;
  /** True when this summary represents a non-mutating preview */
  dryRun?: boolean;
  /** Effective options that shaped the removal plan */
  effectiveOptions?: {
    checkDirty: boolean;
    keepWorktrees: boolean;
    keepBranches: boolean;
    force: boolean;
  };
  /** Dirty worktrees discovered while planning */
  dirtyWorktrees?: WorktreeEntry[];
  /** Lifecycle hooks that would be considered by a real remove */
  hookPreviews?: RemoveHookPreview[];
  /** Complete ordered lifecycle-hook outcome ledger */
  hookOutcomes: LifecycleHookOutcome[];
}

export interface RemoveCommandOptions {
  /** Skip uncommitted changes check */
  checkDirty?: boolean;
  /** Keep worktree directories */
  keepWorktrees?: boolean;
  /** Keep git branches */
  keepBranches?: boolean;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Treat argument as worktree path */
  path?: boolean;
  /** Output JSON */
  json?: boolean;
  /** Allow lifecycle hooks to inherit eligible terminal input */
  hookInput?: boolean;
  /** Testable effective stdin terminal capability for direct executor callers */
  stdinIsTTY?: boolean;
  /** Preview planned removals without mutating repositories */
  dryRun?: boolean;
}
