/**
 * Types for the remove command
 */

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

export interface WorktreeInfo {
  /** Absolute filesystem path to worktree */
  path: string;
  /** Branch name checked out in worktree */
  branch: string;
  /** Repository name */
  repository: string;
  /** True if this is the main worktree */
  isMain: boolean;
  /** Dirty status (if checked) */
  isDirty?: boolean;
  /** Optional detailed dirty status */
  dirtyDetails?: DirtyStatus;
}

export interface RemovalOperation {
  /** Operation type */
  type: 'worktree_remove' | 'branch_delete';
  /** Repository name */
  repository: string;
  /** Target branch name */
  branchName: string;
  /** Worktree path for worktree removal */
  worktreePath?: string;
  /** Status of the operation */
  status: 'pending' | 'success' | 'failed';
  /** Error message if failed */
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
}
