/**
 * Rollback Mechanism
 * 
 * Provides automatic rollback capability for multi-step operations.
 * Maintains an operation log of reversible actions and rolls back all changes when errors occur.
 * 
 * Key Features:
 * - Operation logging with validation
 * - Type-specific rollback for worktrees, branches, directories
 * - Automatic rollback in LIFO order
 * - Resilient error handling (continues despite individual failures)
 * - Concurrent rollback prevention
 * 
 * @module core/rollback
 */

import { exec as gitExec } from '../lib/git';
import { removeDir } from '../lib/filesystem';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Operation types that can be logged and rolled back
 */
export type OperationType = 'worktree_created' | 'branch_created' | 'directory_created';

// ============================================================================
// Log Entry Types (Discriminated Union)
// ============================================================================

/**
 * Log entry for worktree creation
 */
export interface WorktreeCreatedEntry {
  type: 'worktree_created';
  timestamp: number;
  data: {
    repositoryPath: string;
    worktreePath: string;
    branchName: string;
  };
}

/**
 * Log entry for branch creation
 */
export interface BranchCreatedEntry {
  type: 'branch_created';
  timestamp: number;
  data: {
    repositoryPath: string;
    branchName: string;
  };
}

/**
 * Log entry for directory creation
 */
export interface DirectoryCreatedEntry {
  type: 'directory_created';
  timestamp: number;
  data: {
    directoryPath: string;
  };
}

/**
 * Union type for all log entry types
 * 
 * TypeScript discriminated union enables type-safe handling of different operation types.
 */
export type LogEntry = WorktreeCreatedEntry | BranchCreatedEntry | DirectoryCreatedEntry;

// ============================================================================
// Rollback Results
// ============================================================================

/**
 * Details of a failed rollback operation
 */
export interface RollbackFailure {
  /** The log entry that failed to rollback */
  entry: LogEntry;
  
  /** The error that occurred */
  error: Error;
  
  /** Position in operation log (0-based) */
  operationIndex: number;
}

/**
 * Result of rollback execution
 */
export interface RollbackResult {
  /** Total number of operations in log */
  totalOperations: number;
  
  /** Number of successfully reversed operations */
  successCount: number;
  
  /** Number of failed reversal operations */
  failureCount: number;
  
  /** Details of failed operations */
  failures: RollbackFailure[];
  
  /** Total rollback time in milliseconds */
  duration: number;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown when attempting to add entry during rollback
 */
export class RollbackInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RollbackInProgressError';
  }
}

/**
 * Error thrown when attempting concurrent rollback
 */
export class ConcurrentRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentRollbackError';
  }
}

/**
 * Error thrown when log entry is invalid
 */
export class InvalidLogEntryError extends Error {
  constructor(
    message: string,
    public readonly entry: any,
    public readonly reason: string
  ) {
    super(message);
    this.name = 'InvalidLogEntryError';
  }
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate log entry structure
 * 
 * Checks that entry has valid type and all required data fields for that type.
 * 
 * @param entry - Log entry to validate
 * @returns true if valid, false otherwise
 */
export function isValidLogEntry(entry: any): entry is LogEntry {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.timestamp !== 'number' || entry.timestamp <= 0) return false;
  
  switch (entry.type) {
    case 'worktree_created':
      return isValidWorktreeCreatedData(entry.data);
    case 'branch_created':
      return isValidBranchCreatedData(entry.data);
    case 'directory_created':
      return isValidDirectoryCreatedData(entry.data);
    default:
      return false;
  }
}

/**
 * Validate worktree created entry data
 * 
 * @param data - Entry data to validate
 * @returns true if all required fields present
 */
export function isValidWorktreeCreatedData(data: any): boolean {
  return (
    data &&
    typeof data.repositoryPath === 'string' &&
    typeof data.worktreePath === 'string' &&
    typeof data.branchName === 'string'
  );
}

/**
 * Validate branch created entry data
 * 
 * @param data - Entry data to validate
 * @returns true if all required fields present
 */
export function isValidBranchCreatedData(data: any): boolean {
  return (
    data &&
    typeof data.repositoryPath === 'string' &&
    typeof data.branchName === 'string'
  );
}

/**
 * Validate directory created entry data
 * 
 * @param data - Entry data to validate
 * @returns true if all required fields present
 */
export function isValidDirectoryCreatedData(data: any): boolean {
  return (
    data &&
    typeof data.directoryPath === 'string'
  );
}

// ============================================================================
// Operation Log Class
// ============================================================================

/**
 * Operation log for tracking and rolling back operations
 * 
 * Usage:
 * ```typescript
 * const log = new OperationLog();
 * 
 * // Log operations
 * log.add({ type: 'worktree_created', timestamp: Date.now(), data: { ... } });
 * log.add({ type: 'branch_created', timestamp: Date.now(), data: { ... } });
 * 
 * // Rollback on error
 * const result = await log.rollback();
 * console.log(`Rolled back ${result.successCount} of ${result.totalOperations} operations`);
 * ```
 */
export class OperationLog {
  /** Chronological list of logged operations */
  public entries: LogEntry[] = [];
  
  /** Flag to prevent concurrent rollbacks */
  private isRollingBack = false;
  
  /**
   * Add operation to log
   * 
   * @param entry - Log entry with operation type and reversal data
   * @throws RollbackInProgressError if rollback is in progress
   * @throws InvalidLogEntryError if entry is invalid (missing required fields)
   */
  add(entry: LogEntry): void {
    if (this.isRollingBack) {
      throw new RollbackInProgressError("Cannot add entries during rollback");
    }
    
    // Validate entry
    if (!isValidLogEntry(entry)) {
      throw new InvalidLogEntryError(
        "Invalid log entry: missing required fields or invalid data",
        entry,
        "Missing required fields or invalid data type"
      );
    }
    
    this.entries.push(entry);
  }
  
  /**
   * Rollback all logged operations in reverse order (LIFO)
   * 
   * Continues rollback even if individual operations fail. Returns summary
   * with success/failure counts and details of any failures.
   * 
   * @returns Promise resolving to rollback result
   * @throws ConcurrentRollbackError if rollback already in progress
   */
  async rollback(): Promise<RollbackResult> {
    if (this.isRollingBack) {
      throw new ConcurrentRollbackError("Rollback already in progress");
    }
    
    this.isRollingBack = true;
    const startTime = Date.now();
    const failures: RollbackFailure[] = [];
    
    try {
      // Reverse array for LIFO processing
      const reversedEntries = [...this.entries].reverse();
      
      for (let i = 0; i < reversedEntries.length; i++) {
        const entry = reversedEntries[i];
        
        try {
          await rollbackOperation(entry);
        } catch (error) {
          failures.push({
            entry,
            error: error as Error,
            operationIndex: this.entries.length - 1 - i
          });
          // Continue rollback despite failure
        }
      }
      
      return {
        totalOperations: this.entries.length,
        successCount: this.entries.length - failures.length,
        failureCount: failures.length,
        failures,
        duration: Date.now() - startTime
      };
    } finally {
      this.isRollingBack = false;
    }
  }
  
  /**
   * Check if rollback is currently in progress
   * 
   * @returns true if rollback is executing, false otherwise
   */
  isRollbackInProgress(): boolean {
    return this.isRollingBack;
  }
  
  /**
   * Get number of logged operations
   * 
   * @returns Entry count
   */
  getEntryCount(): number {
    return this.entries.length;
  }
  
  /**
   * Clear all entries from log
   * 
   * @throws RollbackInProgressError if rollback is in progress
   */
  clear(): void {
    if (this.isRollingBack) {
      throw new RollbackInProgressError("Cannot clear log during rollback");
    }
    this.entries = [];
  }
}

// ============================================================================
// Type-Specific Rollback Functions
// ============================================================================

/**
 * Dispatcher function that routes to type-specific rollback function
 * 
 * @param entry - Log entry to rollback
 */
async function rollbackOperation(entry: LogEntry): Promise<void> {
  switch (entry.type) {
    case 'worktree_created':
      return rollbackWorktreeCreated(entry);
    case 'branch_created':
      return rollbackBranchCreated(entry);
    case 'directory_created':
      return rollbackDirectoryCreated(entry);
    default:
      throw new Error(`Unknown operation type: ${(entry as any).type}`);
  }
}

/**
 * Rollback a worktree creation operation
 * 
 * Removes the worktree using git worktree remove command. Handles case where
 * worktree no longer exists (treats as success - idempotent rollback).
 * 
 * @param entry - Worktree creation log entry
 * @throws Error if worktree removal fails (permission denied, etc.)
 */
export async function rollbackWorktreeCreated(entry: WorktreeCreatedEntry): Promise<void> {
  const { repositoryPath, worktreePath } = entry.data;
  
  try {
    // Execute: git worktree remove <worktreePath>
    await gitExec(['worktree', 'remove', worktreePath], repositoryPath);
  } catch (error) {
    // Check if worktree no longer exists (idempotent rollback)
    const errorMessage = (error as Error).message.toLowerCase();
    if (errorMessage.includes('not a working tree') || 
        errorMessage.includes('does not exist') ||
        errorMessage.includes('no such file')) {
      // Already removed, treat as success
      return;
    }
    throw error;
  }
}

/**
 * Rollback a branch creation operation
 * 
 * Deletes the branch using git branch -D command. Handles case where branch
 * no longer exists (treats as success - idempotent rollback).
 * 
 * @param entry - Branch creation log entry
 * @throws Error if branch deletion fails
 */
export async function rollbackBranchCreated(entry: BranchCreatedEntry): Promise<void> {
  const { repositoryPath, branchName } = entry.data;
  
  try {
    // Execute: git branch -D <branchName>
    await gitExec(['branch', '-D', branchName], repositoryPath);
  } catch (error) {
    // Check if branch no longer exists (idempotent rollback)
    const errorMessage = (error as Error).message.toLowerCase();
    if (errorMessage.includes('not found') || 
        errorMessage.includes('does not exist') ||
        errorMessage.includes('no such branch')) {
      // Already deleted, treat as success
      return;
    }
    throw error;
  }
}

/**
 * Rollback a directory creation operation
 * 
 * Removes the directory and its contents recursively. Handles case where
 * directory no longer exists (treats as success - idempotent rollback).
 * 
 * The filesystem.removeDir() function is already idempotent, so this wrapper
 * simply delegates to it.
 * 
 * @param entry - Directory creation log entry
 * @throws Error if directory removal fails (permission denied, file locks, etc.)
 */
export async function rollbackDirectoryCreated(entry: DirectoryCreatedEntry): Promise<void> {
  const { directoryPath } = entry.data;
  
  // removeDir() is already idempotent - returns without error if directory doesn't exist
  await removeDir(directoryPath);
}
