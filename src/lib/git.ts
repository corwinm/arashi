/**
 * Git Utility Library
 * 
 * Core git operations for the Arashi worktree manager.
 * All functions use Bun.spawn() for git command execution.
 * 
 * @module git
 */

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
