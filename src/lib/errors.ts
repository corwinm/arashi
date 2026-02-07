/**
 * Custom error class for git operations
 * Preserves full diagnostic context from git commands
 */

import type { GitErrorContext } from '../types/git.js';
import { GitErrorCode } from '../types/git.js';

export class ArashiError extends Error {
  /** Error name (always 'ArashiError') */
  readonly name = 'ArashiError' as const;
  
  /** Diagnostic context from failed git operation */
  readonly context: GitErrorContext;
  
  /** Structured error code for programmatic handling */
  readonly code: string;

  constructor(message: string, context: GitErrorContext) {
    super(message);
    this.context = context;
    this.code = this.parseGitErrorCode(context.stderr);
    
    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ArashiError);
    }
  }

  /**
   * Parse stderr output to determine specific error code
   */
  private parseGitErrorCode(stderr: string): string {
    const lowerStderr = stderr.toLowerCase();
    
    // Check for network errors first (before fatal check)
    if (lowerStderr.includes('network') || lowerStderr.includes('connection') || 
        lowerStderr.includes('could not resolve host')) {
      return GitErrorCode.NETWORK_ERROR;
    }
    
    // Check for permission denied (before fatal check)
    if (lowerStderr.includes('permission denied') || lowerStderr.includes('access denied')) {
      return GitErrorCode.PERMISSION_DENIED;
    }
    
    // Check for specific fatal error patterns
    if (lowerStderr.includes('fatal:')) {
      if (lowerStderr.includes('not a git repository')) {
        return GitErrorCode.NOT_A_REPOSITORY;
      }
      if (lowerStderr.includes('already exists')) {
        return GitErrorCode.ALREADY_EXISTS;
      }
      return GitErrorCode.GIT_FATAL;
    }
    
    // Check for not found errors
    if (lowerStderr.includes('not found') || lowerStderr.includes('no such')) {
      return GitErrorCode.NOT_FOUND;
    }
    
    // Generic git error
    return GitErrorCode.GIT_ERROR;
  }

  /**
   * Serialize error to JSON for logging/debugging
   */
  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: {
        stdout: this.context.stdout,
        stderr: this.context.stderr,
        exitCode: this.context.exitCode,
        args: this.context.args,
        cwd: this.context.cwd
      },
      stack: this.stack
    };
  }
}

/**
 * Error codes for Add Command specific errors
 */
export enum AddCommandErrorCode {
  INVALID_URL = 'INVALID_URL',
  DUPLICATE_NAME = 'DUPLICATE_NAME',
  CLONE_FAILED = 'CLONE_FAILED',
  BRANCH_DETECTION_FAILED = 'BRANCH_DETECTION_FAILED',
  CONFIG_UPDATE_FAILED = 'CONFIG_UPDATE_FAILED',
}

/**
 * Custom error class for add command operations
 * Provides specific error codes for programmatic handling
 */
export class AddCommandError extends Error {
  /** Error name (always 'AddCommandError') */
  readonly name = 'AddCommandError' as const;
  
  /** Structured error code for programmatic handling */
  readonly code: AddCommandErrorCode;
  
  /** Additional context for debugging */
  readonly context?: Record<string, any>;

  constructor(message: string, code: AddCommandErrorCode, context?: Record<string, any>) {
    super(message);
    this.code = code;
    this.context = context;
    
    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AddCommandError);
    }
  }

  /**
   * Serialize error to JSON for logging/debugging
   */
  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack
    };
  }
}
