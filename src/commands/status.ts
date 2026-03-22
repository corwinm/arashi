/**
 * CLI Command: Status
 *
 * Shows the status of all managed repositories in the workspace.
 * Executes git status for each repository and displays results with color-coded indicators.
 * Supports three output modes: default, verbose, and short.
 */

import { Command } from "commander";
import { stat } from "fs/promises";
import { resolve } from "path";
import { loadConfig, findWorkspaceRoot } from "../lib/config.js";
import type { Config } from "../lib/config.js";
import { getFullGitStatus, getGitStatus } from "../lib/git.js";
import * as logger from "../lib/logger.js";

/**
 * Command-line options for the status command
 */
export interface StatusOptions {
  /** Show full git status output for each repository */
  verbose?: boolean;
  /** Show one-line summary per repository */
  short?: boolean;
}

/**
 * Status of a single file in a git repository
 */
export interface GitFileStatus {
  /** Relative path to the file */
  path: string;
  /** Status in staging area (one character: ' ', 'M', 'A', 'D', 'R', 'C') */
  stagingStatus: string;
  /** Status in working tree (one character: ' ', 'M', 'D', '?') */
  workingStatus: string;
}

/**
 * Branch tracking information relative to remote
 */
export interface BranchTrackingInfo {
  /** Name of the local branch */
  localBranch: string;
  /** Name of the remote tracking branch (null if no remote) */
  remoteBranch: string | null;
  /** Number of commits ahead of remote */
  ahead: number;
  /** Number of commits behind remote */
  behind: number;
  /** True if HEAD is detached */
  isDetached: boolean;
}

/**
 * Complete status information for a single repository
 */
export interface RepoStatus {
  /** Repository name (from config) */
  name: string;
  /** Absolute path to repository */
  path: string;
  /** Branch and tracking information */
  branch: BranchTrackingInfo;
  /** List of changed files */
  files: GitFileStatus[];
  /** Error message if status check failed */
  error: string | null;
  /** Full git status output (for verbose mode) */
  fullStatus?: string;
}

/**
 * Parse git status porcelain output
 *
 * Parses the output of `git status --porcelain=v1 --branch` into structured data.
 *
 * @param output - Git status porcelain output
 * @returns Parsed file statuses and branch information
 */
export function parseGitStatus(output: string): {
  files: GitFileStatus[];
  branch: BranchTrackingInfo;
} {
  const lines = output.split("\n").filter((line) => line.length > 0);
  const files: GitFileStatus[] = [];
  let branch: BranchTrackingInfo = {
    ahead: 0,
    behind: 0,
    isDetached: false,
    localBranch: "unknown",
    remoteBranch: null,
  };

  for (const line of lines) {
    // Parse branch line (starts with ##)
    if (line.startsWith("##")) {
      branch = parseBranchLine(line);
      continue;
    }

    // Parse file status (2 characters + space + path)
    const stagingStatus = line[0];
    const workingStatus = line[1];
    const path = line.slice(3);

    files.push({
      path,
      stagingStatus,
      workingStatus,
    });
  }

  return { branch, files };
}

/**
 * Parse branch line from git status porcelain output
 *
 * Parses the ## line that contains branch and tracking information.
 * Format: "## branch...remote [ahead X, behind Y]"
 *
 * @param line - Branch line starting with ##
 * @returns Parsed branch tracking information
 */
export function parseBranchLine(line: string): BranchTrackingInfo {
  // Remove "## "
  const branchInfo = line.slice(3);

  // Handle detached HEAD: "## HEAD (no branch)" or "## HEAD (detached..."
  if (branchInfo.includes("no branch") || branchInfo.startsWith("HEAD (detached")) {
    return {
      ahead: 0,
      behind: 0,
      isDetached: true,
      localBranch: "",
      remoteBranch: null,
    };
  }

  // Format: "main...origin/main [ahead 2, behind 1]"
  const parts = branchInfo.split("...");
  const localBranch = parts[0];
  let remoteBranch: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (parts.length > 1) {
    const remotePart = parts[1];
    // Extract remote branch name (before any bracket)
    const trackingMatch = remotePart.match(/^([^\s[]+)/);
    if (trackingMatch) {
      remoteBranch = trackingMatch[1];
    }

    // Extract ahead count
    const aheadMatch = remotePart.match(/ahead (\d+)/);
    if (aheadMatch) {
      ahead = parseInt(aheadMatch[1], 10);
    }

    // Extract behind count
    const behindMatch = remotePart.match(/behind (\d+)/);
    if (behindMatch) {
      behind = parseInt(behindMatch[1], 10);
    }
  }

  return {
    ahead,
    behind,
    isDetached: false,
    localBranch,
    remoteBranch,
  };
}

/**
 * Check status of a single repository
 *
 * Gets git status for a repository and parses it into structured data.
 * Handles errors gracefully by returning error information in the result.
 *
 * @param name - Repository name
 * @param path - Repository path
 * @param verbose - Whether to get full git status output
 * @returns Repository status information
 */
export async function checkRepoStatus(
  name: string,
  path: string,
  verbose: boolean = false,
): Promise<RepoStatus> {
  const repoExists = await pathExists(path);
  if (!repoExists) {
    return {
      branch: {
        localBranch: "",
        remoteBranch: null,
        ahead: 0,
        behind: 0,
        isDetached: false,
      },
      error: `Repository is missing at ${path}. Run \`arashi clone\` to clone missing repositories.`,
      files: [],
      name,
      path,
    };
  }

  try {
    // Get git status
    const result = await getGitStatus(path);

    // Check for errors
    if (result.error) {
      return {
        branch: {
          localBranch: "",
          remoteBranch: null,
          ahead: 0,
          behind: 0,
          isDetached: false,
        },
        error: result.error,
        files: [],
        name,
        path,
      };
    }

    // Parse status output
    const parsed = parseGitStatus(result.output);

    // Get full status if verbose mode
    let fullStatus: string | undefined;
    if (verbose) {
      const fullResult = await getFullGitStatus(path);
      fullStatus = fullResult.error ? fullResult.error : fullResult.output;
    }

    return {
      branch: parsed.branch,
      error: null,
      files: parsed.files,
      fullStatus,
      name,
      path,
    };
  } catch (error) {
    // Catch any unexpected errors
    return {
      name,
      path,
      branch: {
        localBranch: "",
        remoteBranch: null,
        ahead: 0,
        behind: 0,
        isDetached: false,
      },
      files: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check status of all repositories in the workspace
 *
 * Executes git status for all repositories in parallel for performance.
 * Each repository check is independent and failures don't stop other checks.
 *
 * @param workspaceRoot - Root directory of the workspace
 * @param config - Workspace configuration
 * @param verbose - Whether to get full git status output
 * @returns Array of repository statuses
 */
export async function checkAllRepos(
  workspaceRoot: string,
  config: Config,
  verbose: boolean = false,
): Promise<RepoStatus[]> {
  // Build list of repositories to check
  const reposToCheck: { name: string; path: string }[] = [
    { name: "Main Repository", path: workspaceRoot },
  ];

  // Add all configured repos (resolve relative paths to absolute)
  for (const [name, repoConfig] of Object.entries(config.repos)) {
    const absolutePath = resolve(workspaceRoot, repoConfig.path);
    reposToCheck.push({ name, path: absolutePath });
  }

  // Check all repositories in parallel
  const statusPromises = reposToCheck.map((repo) => checkRepoStatus(repo.name, repo.path, verbose));

  return Promise.all(statusPromises);
}

/**
 * Helper to get clean/dirty symbol
 */
function getStatusSymbol(isClean: boolean): string {
  return isClean ? "✓" : "●";
}

/**
 * Helper to get status color function
 */
function getStatusColor(isClean: boolean, hasError: boolean) {
  if (hasError) {
    return (text: string) => `\x1b[31m${text}\x1b[0m`;
  } // Red
  return isClean
    ? (text: string) => `\x1B[32m${text}\x1B[0m` // Green
    : (text: string) => `\u001b[33m${text}\u001b[0m`; // Yellow
}

/**
 * Helper to apply cyan color
 */
function cyan(text: string): string {
  return `\u001b[36m${text}\u001b[0m`;
}

/**
 * Helper to apply bold
 */
function bold(text: string): string {
  return `\u001b[1m${text}\x1B[0m`;
}

/**
 * Format a single repository section for default output
 *
 * @param status - Repository status
 * @returns Formatted output string
 */
export function formatRepoSection(status: RepoStatus): string {
  let section = `\n${bold(status.name)} (${status.path})\n`;

  // Branch info
  if (status.branch.isDetached) {
    section += `  Branch: ${cyan("(detached HEAD)")}\n`;
  } else {
    section += `  Branch: ${cyan(status.branch.localBranch)}`;
    if (status.branch.remoteBranch) {
      section += ` → ${status.branch.remoteBranch}`;
      if (status.branch.ahead > 0) {
        section += ` [↑${status.branch.ahead}]`;
      }
      if (status.branch.behind > 0) {
        section += ` [↓${status.branch.behind}]`;
      }
    }
    section += "\n";
  }

  // Status
  if (status.error) {
    const colorFn = getStatusColor(false, true);
    section += `  Status: ${colorFn("✗ Error")}\n`;
    section += `  ${colorFn(status.error)}\n`;
  } else if (status.files.length === 0) {
    const colorFn = getStatusColor(true, false);
    section += `  Status: ${colorFn(getStatusSymbol(true) + " Clean")}\n`;
  } else {
    const colorFn = getStatusColor(false, false);
    const stagedCount = status.files.filter((f) => f.stagingStatus !== " ").length;
    const untrackedCount = status.files.filter((f) => f.workingStatus === "?").length;
    const modifiedCount = status.files.filter(
      (f) => f.workingStatus === "M" && f.stagingStatus === " ",
    ).length;

    section += `  Status: ${colorFn(getStatusSymbol(false) + " Dirty")} (${status.files.length} changes)\n`;

    const parts = [];
    if (stagedCount > 0) {
      parts.push(`${stagedCount} staged`);
    }
    if (modifiedCount > 0) {
      parts.push(`${modifiedCount} modified`);
    }
    if (untrackedCount > 0) {
      parts.push(`${untrackedCount} untracked`);
    }

    section += `    ${parts.join(", ")}\n`;
  }

  return section;
}

/**
 * Format summary line showing clean/dirty counts
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted summary string
 */
export function formatSummary(statuses: RepoStatus[]): string {
  const cleanCount = statuses.filter((s) => s.files.length === 0 && !s.error).length;
  const dirtyCount = statuses.filter((s) => s.files.length > 0 || s.error).length;
  const total = statuses.length;

  return `\n${"─".repeat(40)}\n${bold(`Summary: ${cleanCount} clean, ${dirtyCount} dirty (${total} total)`)}\n`;
}

/**
 * Format default output showing all repository statuses
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted output string
 */
export function formatDefaultOutput(statuses: RepoStatus[]): string {
  let output = "";

  for (const status of statuses) {
    output += formatRepoSection(status);
  }

  output += formatSummary(statuses);
  return output;
}

/**
 * Format verbose output showing full git status for each repository
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted output string
 */
export function formatVerboseOutput(statuses: RepoStatus[]): string {
  let output = "";

  for (const status of statuses) {
    output += `\n${bold(status.name)} (${status.path})\n`;

    // Branch info
    if (status.branch.isDetached) {
      output += `  Branch: ${cyan("(detached HEAD)")}\n\n`;
    } else {
      output += `  Branch: ${cyan(status.branch.localBranch)}`;
      if (status.branch.remoteBranch) {
        output += ` → ${status.branch.remoteBranch}`;
        if (status.branch.ahead > 0 || status.branch.behind > 0) {
          output += ` [`;
          if (status.branch.ahead > 0) {
            output += `↑${status.branch.ahead}`;
          }
          if (status.branch.ahead > 0 && status.branch.behind > 0) {
            output += ", ";
          }
          if (status.branch.behind > 0) {
            output += `↓${status.branch.behind}`;
          }
          output += `]`;
        }
      }
      output += "\n\n";
    }

    // Full git status output
    if (status.error) {
      const colorFn = getStatusColor(false, true);
      output += `  ${colorFn("✗ Error: " + status.error)}\n`;
    } else if (status.fullStatus) {
      // Indent each line of full status
      const lines = status.fullStatus.split("\n");
      for (const line of lines) {
        output += `  ${line}\n`;
      }
    } else {
      const colorFn = getStatusColor(true, false);
      output += `  ${colorFn("✓ Clean - No changes")}\n`;
    }
  }

  output += formatSummary(statuses);
  return output;
}

/**
 * Format a single line for short output
 *
 * @param status - Repository status
 * @returns Formatted line
 */
export function formatShortLine(status: RepoStatus): string {
  let line = `${status.path} (${status.branch.isDetached ? "detached" : status.branch.localBranch}`;

  // Add tracking info
  if (status.branch.ahead > 0 || status.branch.behind > 0) {
    line += " ";
    if (status.branch.ahead > 0) {
      line += `↑${status.branch.ahead}`;
    }
    if (status.branch.behind > 0) {
      line += `↓${status.branch.behind}`;
    }
  }

  line += "): ";

  // Add status
  if (status.error) {
    const colorFn = getStatusColor(false, true);
    if (status.error.includes("arashi clone")) {
      line += colorFn("✗ missing (run arashi clone)");
    } else {
      line += colorFn("✗ error");
    }
  } else if (status.files.length === 0) {
    const colorFn = getStatusColor(true, false);
    line += colorFn("✓ clean");
  } else {
    const colorFn = getStatusColor(false, false);
    const stagedCount = status.files.filter((f) => f.stagingStatus !== " ").length;
    const untrackedCount = status.files.filter((f) => f.workingStatus === "?").length;
    const modifiedCount = status.files.filter(
      (f) => f.workingStatus === "M" && f.stagingStatus === " ",
    ).length;

    const parts = [];
    if (stagedCount > 0) {
      parts.push(`${stagedCount} staged`);
    }
    if (modifiedCount > 0) {
      parts.push(`${modifiedCount} modified`);
    }
    if (untrackedCount > 0) {
      parts.push(`${untrackedCount} untracked`);
    }

    line += colorFn(`● ${status.files.length} changes (${parts.join(", ")})`);
  }

  return line;
}

/**
 * Format short output showing one line per repository
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted output string
 */
export function formatShortOutput(statuses: RepoStatus[]): string {
  let output = "";

  for (const status of statuses) {
    output += formatShortLine(status) + "\n";
  }

  // Add simplified summary
  const cleanCount = statuses.filter((s) => s.files.length === 0 && !s.error).length;
  const dirtyCount = statuses.filter((s) => s.files.length > 0 || s.error).length;

  output += `\nSummary: ${cleanCount} clean, ${dirtyCount} dirty\n`;
  return output;
}

/**
 * Main status command implementation
 *
 * @param options - Command options
 */
async function statusCommand(options: StatusOptions): Promise<void> {
  // Validate mutually exclusive options
  if (options.verbose && options.short) {
    logger.error("Cannot use --verbose and --short together");
    logger.info("Use 'arashi status --help' for usage information");
    process.exit(2);
  }

  // Find workspace root (walk up directory tree if needed)
  let workspaceRoot: string;
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    logger.error("Not in an arashi workspace");
    logger.info("Run 'arashi init' to initialize a workspace");
    process.exit(2);
  }

  // Load config
  let config: Config;
  try {
    config = await loadConfig(workspaceRoot);
  } catch (error) {
    logger.error("Failed to load workspace configuration");
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  // Show progress
  const s = logger.spinner("Checking repository status...");
  s.start();

  // Check all repos (with verbose flag if needed)
  const statuses = await checkAllRepos(workspaceRoot, config, options.verbose || false);

  s.stop();

  // Format and display output
  let output: string;
  if (options.verbose) {
    output = formatVerboseOutput(statuses);
  } else if (options.short) {
    output = formatShortOutput(statuses);
  } else {
    output = formatDefaultOutput(statuses);
  }

  console.log(output);

  // Exit with appropriate code
  const hasErrors = statuses.some((s) => s.error !== null);
  if (hasErrors) {
    process.exit(1);
  }
}

/**
 * Create the status command for Commander
 *
 * @returns Commander Command instance
 */
export function createCommand(): Command {
  return new Command("status")
    .description("Show status of all managed repositories")
    .option("-v, --verbose", "Show full git status output")
    .option("-s, --short", "Show one-line summary per repository")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi status                    # Default output with colors
  $ arashi status --verbose          # Full git status for each repo
  $ arashi status --short            # One line per repository
`,
    )
    .action(statusCommand);
}
