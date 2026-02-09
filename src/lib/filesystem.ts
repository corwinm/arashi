import { mkdir, exists as bunExists, stat, copyFile as bunCopyFile, rm } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { constants } from "node:fs";

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for filesystem operations
 */
export class FilesystemError extends Error {
  constructor(
    public operation: string,
    public path: string,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "FilesystemError";
    Object.setPrototypeOf(this, FilesystemError.prototype);
  }
}

/**
 * Error thrown when insufficient permissions to perform operation
 */
export class PermissionError extends FilesystemError {
  constructor(operation: string, path: string, code: string, message: string) {
    super(operation, path, code, message);
    this.name = "PermissionError";
    Object.setPrototypeOf(this, PermissionError.prototype);
  }
}

/**
 * Error thrown when file or directory not found
 */
export class NotFoundError extends FilesystemError {
  constructor(operation: string, path: string, code: string, message: string) {
    super(operation, path, code, message);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Error thrown when disk is full
 */
export class DiskFullError extends FilesystemError {
  constructor(operation: string, path: string, code: string, message: string) {
    super(operation, path, code, message);
    this.name = "DiskFullError";
    Object.setPrototypeOf(this, DiskFullError.prototype);
  }
}

/**
 * Error thrown when path is invalid
 */
export class InvalidPathError extends FilesystemError {
  constructor(operation: string, path: string, code: string, message: string) {
    super(operation, path, code, message);
    this.name = "InvalidPathError";
    Object.setPrototypeOf(this, InvalidPathError.prototype);
  }
}

/**
 * Error thrown when file encoding is invalid
 */
export class EncodingError extends FilesystemError {
  constructor(operation: string, path: string, code: string, message: string) {
    super(operation, path, code, message);
    this.name = "EncodingError";
    Object.setPrototypeOf(this, EncodingError.prototype);
  }
}

// ============================================================================
// Error Mapping Utility
// ============================================================================

/**
 * Maps Node.js error codes to appropriate FilesystemError subclasses
 */
function mapError(operation: string, path: string, error: unknown): FilesystemError {
  const nodeError =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : {};
  const code = typeof nodeError.code === "string" ? nodeError.code : "UNKNOWN";
  const message = typeof nodeError.message === "string" ? nodeError.message : "Unknown error";

  switch (code) {
    case "EACCES":
    case "EPERM":
      return new PermissionError(operation, path, code, `Permission denied: ${message}`);

    case "ENOENT":
      return new NotFoundError(operation, path, code, `Not found: ${message}`);

    case "ENOSPC":
      return new DiskFullError(operation, path, code, `No space left on device: ${message}`);

    case "EINVAL":
    case "ENAMETOOLONG":
      return new InvalidPathError(operation, path, code, `Invalid path: ${message}`);

    default:
      return new FilesystemError(operation, path, code, message);
  }
}

// ============================================================================
// US1: Safe Directory Operations
// ============================================================================

/**
 * Create a directory and all parent directories if they don't exist
 *
 * @param path - Absolute or relative path to directory
 * @throws PermissionError - Insufficient permissions to create directory
 * @throws DiskFullError - No space left on device
 * @throws InvalidPathError - Path is invalid or exceeds length limits
 */
export async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch (error: unknown) {
    throw mapError("ensureDir", path, error);
  }
}

// ============================================================================
// US2: File Existence and Permission Checks
// ============================================================================

/**
 * Check if a file or directory exists
 *
 * @param path - Absolute or relative path to check
 * @returns true if exists, false otherwise
 * @throws Never throws - returns false for permission errors
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return await bunExists(path);
  } catch {
    return false;
  }
}

/**
 * Check if a file has executable permissions
 *
 * On Unix/macOS: Checks execute permission bit
 * On Windows: Checks file extension (.exe, .bat, .cmd, .com)
 *
 * @param path - Absolute or relative path to file
 * @returns true if executable, false otherwise
 * @throws Never throws - returns false for errors
 */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    // Check if file exists first
    if (!(await fileExists(path))) {
      return false;
    }

    const stats = await stat(path);

    // Return false for directories
    if (stats.isDirectory()) {
      return false;
    }

    // Platform-specific executable check
    if (process.platform === "win32") {
      // On Windows, check file extension
      const executableExtensions = [".exe", ".bat", ".cmd", ".com"];
      return executableExtensions.some((ext) => path.toLowerCase().endsWith(ext));
    } else {
      // On Unix/macOS, check execute permission bit
      // Check if any execute bit is set (owner, group, or other)
      return !!(stats.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH));
    }
  } catch {
    return false;
  }
}

// ============================================================================
// US3: Worktree Path Calculation
// ============================================================================

/**
 * Compute worktree path based on repository configuration
 *
 * @param repoPath - Path to main repository
 * @param branch - Branch name for worktree
 * @param isBare - true if bare repository, false otherwise
 * @param customPath - Override computed path (optional)
 * @returns Computed worktree path
 * @throws InvalidPathError - repoPath is invalid
 */
export function getWorktreePath(
  repoPath: string,
  branch: string,
  isBare: boolean,
  customPath?: string,
): string {
  // Validate repoPath
  if (!repoPath || repoPath.trim() === "") {
    throw new InvalidPathError(
      "getWorktreePath",
      repoPath,
      "EINVAL",
      "Repository path cannot be empty",
    );
  }

  // If custom path provided, return it unchanged
  if (customPath) {
    return customPath;
  }

  // Resolve to absolute path
  const absoluteRepoPath = resolve(repoPath);

  // If bare repository, worktrees go in .git/worktrees/
  if (isBare) {
    return join(absoluteRepoPath, ".git", "worktrees", branch);
  }

  // If non-bare, worktrees go in parent directory
  const parentDir = dirname(absoluteRepoPath);
  return join(parentDir, branch);
}

// ============================================================================
// US4: File I/O Operations
// ============================================================================

/**
 * Read file contents as a UTF-8 string
 *
 * @param path - File path to read
 * @returns File contents as UTF-8 string
 * @throws NotFoundError - File doesn't exist
 * @throws PermissionError - Insufficient read permissions
 * @throws EncodingError - File is not valid UTF-8
 */
export async function readTextFile(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content;
  } catch (error: unknown) {
    const nodeError =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown; message?: unknown })
        : {};
    // Check for encoding errors
    if (
      nodeError.code === "ERR_INVALID_ARG_VALUE" ||
      (typeof nodeError.message === "string" && nodeError.message.includes("encoding"))
    ) {
      throw new EncodingError("readTextFile", path, "ENCODING", "File is not valid UTF-8");
    }
    throw mapError("readTextFile", path, error);
  }
}

/**
 * Write content to a file as UTF-8
 *
 * Creates parent directories if needed.
 * Overwrites file if it exists.
 *
 * @param path - File path to write
 * @param content - Content to write
 * @throws PermissionError - Insufficient write permissions
 * @throws DiskFullError - No space left on device
 * @throws InvalidPathError - Path invalid or too long
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  try {
    // Ensure parent directory exists
    const parentDir = dirname(path);
    await ensureDir(parentDir);

    // Write file
    await writeFile(path, content, "utf8");
  } catch (error: unknown) {
    // If it's already a FilesystemError from ensureDir, rethrow
    if (error instanceof FilesystemError) {
      throw error;
    }
    throw mapError("writeTextFile", path, error);
  }
}

/**
 * Copy a file while preserving permissions
 *
 * @param src - Source file path
 * @param dest - Destination file path
 * @throws NotFoundError - Source file doesn't exist
 * @throws PermissionError - Insufficient permissions
 * @throws DiskFullError - No space left on device
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  try {
    // Check if source exists
    if (!(await fileExists(src))) {
      throw new NotFoundError("copyFile", src, "ENOENT", `Source file not found: ${src}`);
    }

    // Ensure destination parent directory exists
    const destDir = dirname(dest);
    await ensureDir(destDir);

    // Copy file with COPYFILE_FICLONE flag for copy-on-write when available
    await bunCopyFile(src, dest, constants.COPYFILE_FICLONE);
  } catch (error: unknown) {
    // If it's already a FilesystemError, rethrow
    if (error instanceof FilesystemError) {
      throw error;
    }
    throw mapError("copyFile", src, error);
  }
}

// ============================================================================
// US5: Directory Cleanup Operations
// ============================================================================

/**
 * Remove a directory and all its contents recursively
 *
 * Succeeds silently if directory doesn't exist (idempotent).
 *
 * @param path - Directory path to remove
 * @throws PermissionError - Insufficient permissions to remove
 */
export async function removeDir(path: string): Promise<void> {
  try {
    // Check if directory exists first
    if (!(await fileExists(path))) {
      // Idempotent: succeed if already doesn't exist
      return;
    }

    // Remove recursively
    await rm(path, { recursive: true, force: true });
  } catch (error: unknown) {
    throw mapError("removeDir", path, error);
  }
}
