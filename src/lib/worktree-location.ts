import { isAbsolute, posix, resolve } from "path";

export const DEFAULT_WORKTREES_DIR = ".arashi/worktrees";
export const DEFAULT_WORKTREES_GITIGNORE_ENTRY = ".arashi/worktrees/";

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;

export class WorktreeLocationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeLocationValidationError";
  }
}

function normalizeSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

export function normalizeWorktreesDir(worktreesDir: string): string {
  const trimmed = worktreesDir.trim();
  if (trimmed.length === 0) {
    throw new WorktreeLocationValidationError("must be a non-empty string if present");
  }

  if (isAbsolute(trimmed) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) {
    throw new WorktreeLocationValidationError("must be a relative path");
  }

  const normalized = posix.normalize(normalizeSeparators(trimmed));
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");

  if (withoutTrailingSlash.length === 0 || withoutTrailingSlash === ".") {
    return ".";
  }

  return withoutTrailingSlash;
}

export function normalizeWorktreesDirWithDefault(worktreesDir?: string): string {
  if (worktreesDir === undefined) {
    return DEFAULT_WORKTREES_DIR;
  }

  return normalizeWorktreesDir(worktreesDir);
}

export function resolveWorktreesBasePath(workspaceRoot: string, worktreesDir?: string): string {
  return resolve(workspaceRoot, normalizeWorktreesDirWithDefault(worktreesDir));
}

export function isDefaultWorktreesDir(worktreesDir?: string): boolean {
  return normalizeWorktreesDirWithDefault(worktreesDir) === DEFAULT_WORKTREES_DIR;
}
