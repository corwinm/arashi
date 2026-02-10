/**
 * Git Utility Library
 *
 * Core git operations for the Arashi worktree manager.
 * All functions use Bun.spawn() for git command execution.
 *
 * @module git
 */

import { dirname, basename } from "path";
import type { CommandResult } from "../types/git";
import { ArashiError } from "./errors";

/**
 * Execute a git command and capture output
 *
 * @param args - Git command arguments (e.g., ['status', '--porcelain'])
 * @param cwd - Working directory to execute command in
 * @returns Command result with stdout, stderr, and exit code
 * @throws {ArashiError} If command fails (non-zero exit code)
 * @throws {Error} If args is empty or cwd is invalid
 *
 * @example
 * const result = await exec(['status', '--porcelain'], '/path/to/repo');
 * console.log(result.stdout);
 */
export async function exec(args: string[], cwd: string): Promise<CommandResult> {
  // T012: Input validation
  if (!args || args.length === 0) {
    throw new Error("Git command arguments cannot be empty");
  }

  if (!cwd || typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("Working directory (cwd) must be a non-empty string");
  }

  // T010: Execute git command using Bun.spawn()
  let proc;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
  } catch (error) {
    // Handle spawn errors (e.g., directory doesn't exist, git not found)
    throw new ArashiError(`Failed to spawn git command: ${(error as Error).message}`, {
      stdout: "",
      stderr: (error as Error).message,
      exitCode: -1,
      args,
      cwd,
    });
  }

  // Capture stdout and stderr
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // T011: Error handling - throw ArashiError on non-zero exit code
  if (exitCode !== 0) {
    const errorMessage = stderr.trim() || stdout.trim() || "Git command failed with no output";
    throw new ArashiError(`Git command failed: ${errorMessage}`, {
      stdout,
      stderr,
      exitCode,
      args,
      cwd,
    });
  }

  return {
    stdout,
    stderr,
    exitCode,
  };
}

/**
 * Check if a repository is bare (has no working directory)
 *
 * A bare repository only contains the git database and is typically used
 * as a central remote. It has no working directory for checked-out files.
 *
 * This function correctly handles worktrees by checking the main/common
 * git directory to determine if the parent repository is bare.
 *
 * @param repoPath - Path to the repository or worktree
 * @returns true if repository (or parent of worktree) is bare, false otherwise
 * @throws {ArashiError} If git command fails or path is not a git repository
 *
 * @example
 * const isBare = await isBarerepo('/path/to/repo.git');
 * if (isBare) {
 *   console.log('This is a bare repository');
 * }
 *
 * @example
 * // For a worktree of a bare repository
 * const isBare = await isBareRepo('/path/to/worktree');
 * // Returns true if the main repository is bare
 */
export async function isBareRepo(repoPath: string): Promise<boolean> {
  // Get the common git directory (main repository location)
  // For regular repos: returns .git
  // For worktrees: returns the main repository's .git directory
  const commonDirResult = await exec(["rev-parse", "--git-common-dir"], repoPath);
  const commonDir = commonDirResult.stdout.trim();

  // Check if the current path is bare
  const result = await exec(["rev-parse", "--is-bare-repository"], repoPath);
  const isBareInCwd = result.stdout.trim() === "true";

  // If the current directory reports as bare, it's definitely bare
  if (isBareInCwd) {
    return true;
  }

  // For worktrees of a bare repository:
  // - commonDir will point to the bare repository (not ending in /.git)
  // - We need to check if that common directory is itself bare
  //
  // For regular repos or worktrees of regular repos:
  // - commonDir will be ".git" or end with "/.git"
  if (commonDir === ".git" || commonDir.endsWith("/.git")) {
    // This is a regular repository or a worktree of a regular repository
    return false;
  }

  // commonDir doesn't end with /.git, so it might be a bare repo
  // We need to check by running git command in the common directory
  try {
    const bareCheckResult = await exec(["rev-parse", "--is-bare-repository"], commonDir);
    return bareCheckResult.stdout.trim() === "true";
  } catch {
    // If we can't check the common directory, assume it's not bare
    return false;
  }
}

/**
 * Clone a Git repository
 *
 * @param gitUrl - Git repository URL to clone (HTTPS, SSH, Git, File, or SCP format)
 * @param destPath - Destination path where repository will be cloned
 * @returns Command result with stdout, stderr, and exit code
 * @throws {ArashiError} If clone operation fails
 *
 * @example
 * await clone('https://github.com/user/repo.git', '/path/to/destination');
 */
export async function clone(gitUrl: string, destPath: string): Promise<CommandResult> {
  if (!gitUrl || typeof gitUrl !== "string" || gitUrl.trim() === "") {
    throw new Error("Git URL cannot be empty");
  }

  if (!destPath || typeof destPath !== "string" || destPath.trim() === "") {
    throw new Error("Destination path cannot be empty");
  }

  // Clone to the parent directory, letting Git create the repo directory
  const parentDir = dirname(destPath);
  const repoName = basename(destPath);

  try {
    const proc = Bun.spawn(["git", "clone", gitUrl, repoName], {
      cwd: parentDir,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const errorMessage = stderr.trim() || stdout.trim() || "Git clone failed with no output";
      throw new ArashiError(`Git clone failed: ${errorMessage}`, {
        stdout,
        stderr,
        exitCode,
        args: ["clone", gitUrl, repoName],
        cwd: parentDir,
      });
    }

    return {
      stdout,
      stderr,
      exitCode,
    };
  } catch (error) {
    if (error instanceof ArashiError) {
      throw error;
    }
    throw new ArashiError(`Failed to spawn git clone: ${(error as Error).message}`, {
      stdout: "",
      stderr: (error as Error).message,
      exitCode: -1,
      args: ["clone", gitUrl, repoName],
      cwd: parentDir,
    });
  }
}

/**
 * Get the default branch of a repository
 *
 * Uses the following priority order:
 * 1. git symbolic-ref refs/remotes/origin/HEAD (most reliable)
 * 2. Check common branch names (main, master, develop)
 * 3. Get first remote branch
 *
 * @param repoPath - Path to the cloned repository
 * @returns Name of the default branch (e.g., 'main', 'master')
 * @throws {ArashiError} If unable to detect default branch
 *
 * @example
 * const branch = await getDefaultBranch('/path/to/repo');
 * console.log(`Default branch: ${branch}`);
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  // Try method 1: symbolic-ref (most reliable)
  try {
    const result = await exec(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], repoPath);
    const branch = result.stdout.trim().replace(/^origin\//, "");
    if (branch) {
      return branch;
    }
  } catch {
    // Fall through to next method
  }

  // Try method 2: Check common default branch names
  const commonBranches = ["main", "master", "develop"];
  for (const branch of commonBranches) {
    try {
      await exec(["show-ref", "--verify", `refs/remotes/origin/${branch}`], repoPath);
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }

  // Try method 3: Check common local branch names (bare repos without remotes)
  for (const branch of commonBranches) {
    try {
      await exec(["show-ref", "--verify", `refs/heads/${branch}`], repoPath);
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }

  // Try method 4: Get first local branch (bare repos without remotes)
  try {
    const result = await exec(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      repoPath,
    );
    const branches = result.stdout
      .trim()
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    if (branches.length > 0) {
      return branches[0];
    }
  } catch {
    // Fall through to next method
  }

  // Try method 5: Get first remote branch
  try {
    const result = await exec(["branch", "-r", "--list"], repoPath);
    const branches = result.stdout
      .trim()
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b && !b.includes("HEAD"));

    if (branches.length > 0) {
      const firstBranch = branches[0].replace(/^origin\//, "");
      return firstBranch;
    }
  } catch {
    // Fall through to error
  }

  // Unable to detect default branch
  throw new ArashiError("Unable to detect default branch: repository has no remote branches", {
    stdout: "",
    stderr: "No remote branches found",
    exitCode: 1,
    args: ["branch", "-r", "--list"],
    cwd: repoPath,
  });
}

/**
 * Result of git status command execution
 *
 * @interface GitStatusResult
 * @property {string} output - Git status output (stdout)
 * @property {string | null} error - Error message if command failed (stderr)
 */
export interface GitStatusResult {
  output: string;
  error: string | null;
}

/**
 * Get git status for a repository using porcelain format
 *
 * Executes `git status --porcelain=v1 --branch` to get machine-readable status.
 * This format is stable across git versions and provides consistent output for parsing.
 *
 * @param repoPath - Path to the repository
 * @returns Promise resolving to GitStatusResult with output or error
 *
 * @example
 * const result = await getGitStatus('/path/to/repo');
 * if (result.error) {
 *   console.error('Git status failed:', result.error);
 * } else {
 *   console.log('Status output:', result.output);
 * }
 */
export async function getGitStatus(repoPath: string): Promise<GitStatusResult> {
  try {
    const result = await exec(["status", "--porcelain=v1", "--branch"], repoPath);
    return {
      output: result.stdout.trim(),
      error: null,
    };
  } catch (error) {
    // Return error information instead of throwing
    if (error instanceof ArashiError) {
      return {
        output: "",
        error: error.message,
      };
    }
    return {
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get full human-readable git status for verbose output
 *
 * Executes `git status` without porcelain format to get the full
 * human-readable output including git's helpful messages.
 *
 * @param repoPath - Path to the repository
 * @returns Promise resolving to GitStatusResult with output or error
 *
 * @example
 * const result = await getFullGitStatus('/path/to/repo');
 * console.log(result.output); // Full git status output with colors and hints
 */
export async function getFullGitStatus(repoPath: string): Promise<GitStatusResult> {
  try {
    const result = await exec(["status"], repoPath);
    return {
      output: result.stdout.trim(),
      error: null,
    };
  } catch (error) {
    // Return error information instead of throwing
    if (error instanceof ArashiError) {
      return {
        output: "",
        error: error.message,
      };
    }
    return {
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function resolveDefaultBranchForTrackedRead(repoPath: string): Promise<string> {
  try {
    const head = await exec(["symbolic-ref", "--short", "HEAD"], repoPath);
    const branch = head.stdout.trim();
    if (branch.length > 0) {
      try {
        await exec(["show-ref", "--verify", `refs/heads/${branch}`], repoPath);
        return branch;
      } catch {
        // HEAD may reference an unset branch in a bare repository.
        // Continue to fallback branch detection.
      }
    }
  } catch {
    // Fall through to explicit branch checks
  }

  for (const branch of ["main", "master", "develop"]) {
    try {
      await exec(["show-ref", "--verify", `refs/heads/${branch}`], repoPath);
      return branch;
    } catch {
      // Try next branch candidate
    }
  }

  const refs = await exec(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repoPath);
  const first = refs.stdout
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  if (!first) {
    throw new ArashiError("Unable to resolve default branch for tracked file read", {
      stdout: refs.stdout,
      stderr: refs.stderr,
      exitCode: refs.exitCode,
      args: ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      cwd: repoPath,
    });
  }

  return first;
}

/**
 * Read the content of a tracked file from the repository's default branch.
 */
export async function readTrackedFileFromDefaultBranch(
  repoPath: string,
  filePath: string,
): Promise<string> {
  const branch = await resolveDefaultBranchForTrackedRead(repoPath);
  const result = await exec(["show", `${branch}:${filePath}`], repoPath);
  return result.stdout;
}
