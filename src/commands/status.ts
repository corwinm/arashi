/**
 * CLI Command: Status
 *
 * Shows the status of all managed repositories in the workspace.
 * Executes git status for each repository and displays results with color-coded indicators.
 * Supports three output modes: default, verbose, and short.
 */

import {
  compareCurrentBranchToDefaultBranch,
  fetchRemoteTrackingTarget,
  resolveRemoteTrackingTarget,
} from "../lib/git-remote.js";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { findWorkspaceRoot, loadConfig } from "../lib/config.js";
import { getFullGitStatus, getGitStatus } from "../lib/git.js";
import { info, error as logError, spinner } from "../lib/logger.js";
import { Command } from "commander";
import { filterRepositories } from "../lib/config/filter-repos.ts";
import { resolve } from "path";
import { stat } from "fs/promises";

type DefaultBranchComparison = Awaited<ReturnType<typeof compareCurrentBranchToDefaultBranch>>;
type Config = Awaited<ReturnType<typeof loadConfig>>;
type JsonWarning = NonNullable<Parameters<typeof createJsonSuccessEnvelope>[2]>[number];

const ZERO = 0;
const ONE = 1;
const THREE = 3;
const DECIMAL_RADIX = 10;
const SUMMARY_WIDTH = 40;
const USAGE_EXIT_CODE = 2;
const ERROR_EXIT_CODE = 1;

const createEmptyBranchTrackingInfo = (isDetached = false): BranchTrackingInfo => ({
  ahead: ZERO,
  behind: ZERO,
  isDetached,
  localBranch: isDetached ? "" : "unknown",
  remoteBranch: null,
});

const countRepoChanges = (status: RepoStatus) => {
  const stagedCount = status.files.filter((fileStatus) => fileStatus.stagingStatus !== " ").length;
  const untrackedCount = status.files.filter(
    (fileStatus) => fileStatus.workingStatus === "?",
  ).length;
  const modifiedCount = status.files.filter(
    (fileStatus) => fileStatus.workingStatus === "M" && fileStatus.stagingStatus === " ",
  ).length;

  return { modifiedCount, stagedCount, untrackedCount };
};

export const summarizeStatuses = (statuses: RepoStatus[]) => {
  const cleanCount = statuses.filter(
    (status) => status.files.length === ZERO && !status.error,
  ).length;
  const dirtyCount = statuses.filter((status) => status.files.length > ZERO || status.error).length;

  return {
    cleanCount,
    dirtyCount,
    total: statuses.length,
  };
};

/**
 * Command-line options for the status command
 */
export interface StatusOptions {
  /** Filter to repositories in specified groups */
  group?: string[];
  /** Show full git status output for each repository */
  verbose?: boolean;
  /** Show one-line summary per repository */
  short?: boolean;
  /** Output a structured JSON envelope */
  json?: boolean;
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
export interface RepoRefreshWarning {
  kind: "missing-remote-ref" | "stale-remote-tracking";
  message: string;
}

export interface RepoStatus {
  /** Repository name (from config) */
  name: string;
  /** Absolute path to repository */
  path: string;
  /** Branch and tracking information */
  branch: BranchTrackingInfo;
  /** Default branch comparison state */
  defaultBranch?: DefaultBranchComparison | null;
  /** List of changed files */
  files: GitFileStatus[];
  /** Error message if status check failed */
  error: string | null;
  /** Warning shown when remote tracking refresh fails but local status is still available */
  refreshWarning?: RepoRefreshWarning | null;
  /** Full git status output (for verbose mode) */
  fullStatus?: string;
}

interface StatusCommandDependencies {
  compareCurrentBranchToDefaultBranch: typeof compareCurrentBranchToDefaultBranch;
  fetchRemoteTrackingTarget: typeof fetchRemoteTrackingTarget;
  getFullGitStatus: typeof getFullGitStatus;
  getGitStatus: typeof getGitStatus;
  resolveRemoteTrackingTarget: typeof resolveRemoteTrackingTarget;
}

interface CheckRepoStatusOptions {
  dependencies?: StatusCommandDependencies;
  verbose?: boolean;
}

const defaultStatusCommandDependencies: StatusCommandDependencies = {
  compareCurrentBranchToDefaultBranch,
  fetchRemoteTrackingTarget,
  getFullGitStatus,
  getGitStatus,
  resolveRemoteTrackingTarget,
};

/**
 * Parse git status porcelain output
 *
 * Parses the output of `git status --porcelain=v1 --branch` into structured data.
 *
 * @param output - Git status porcelain output
 * @returns Parsed file statuses and branch information
 */
export const parseBranchLine = (line: string): BranchTrackingInfo => {
  const branchInfo = line.slice(THREE);

  if (branchInfo.includes("no branch") || branchInfo.startsWith("HEAD (detached")) {
    return createEmptyBranchTrackingInfo(true);
  }

  const [localBranch, remotePart] = branchInfo.split("...");
  let remoteBranch: string | null = null;
  let ahead = ZERO;
  let behind = ZERO;

  if (remotePart) {
    const trackingMatch = remotePart.match(/^([^\s[]+)/);
    if (trackingMatch) {
      const matchedRemoteBranch = trackingMatch[ONE];
      remoteBranch = matchedRemoteBranch;
    }

    const aheadMatch = remotePart.match(/ahead (\d+)/);
    if (aheadMatch) {
      const aheadCount = aheadMatch[ONE];
      ahead = Number.parseInt(aheadCount, DECIMAL_RADIX);
    }

    const behindMatch = remotePart.match(/behind (\d+)/);
    if (behindMatch) {
      const behindCount = behindMatch[ONE];
      behind = Number.parseInt(behindCount, DECIMAL_RADIX);
    }
  }

  return {
    ahead,
    behind,
    isDetached: false,
    localBranch,
    remoteBranch,
  };
};

export const parseGitStatus = (
  output: string,
): {
  files: GitFileStatus[];
  branch: BranchTrackingInfo;
} => {
  const lines = output.split("\n").filter((line) => line.length > ZERO);
  const files: GitFileStatus[] = [];
  let branch = createEmptyBranchTrackingInfo();

  for (const line of lines) {
    if (line.startsWith("##")) {
      branch = parseBranchLine(line);
    } else {
      const [stagingStatus = "", workingStatus = ""] = line;
      const path = line.slice(THREE);

      files.push({
        path,
        stagingStatus,
        workingStatus,
      });
    }
  }

  return { branch, files };
};

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
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

type RemoteTrackingFetchFailure = Exclude<
  Awaited<ReturnType<typeof fetchRemoteTrackingTarget>>,
  { ok: true }
>;

const createRefreshWarning = (failure: RemoteTrackingFetchFailure): RepoRefreshWarning => {
  if (failure.kind === "missing-remote-ref") {
    return {
      kind: "missing-remote-ref",
      message: failure.message,
    };
  }

  return {
    kind: "stale-remote-tracking",
    message: `Remote tracking may be stale: ${failure.error}`,
  };
};

export const checkRepoStatus = async (
  name: string,
  path: string,
  options: CheckRepoStatusOptions = {},
): Promise<RepoStatus> => {
  const { dependencies = defaultStatusCommandDependencies, verbose = false } = options;
  const repoExists = await pathExists(path);
  if (!repoExists) {
    return {
      branch: createEmptyBranchTrackingInfo(true),
      defaultBranch: null,
      error: `Repository is missing at ${path}. Run \`arashi clone\` to clone missing repositories.`,
      files: [],
      name,
      path,
      refreshWarning: null,
    };
  }

  try {
    let refreshWarning: RepoRefreshWarning | null = null;
    const trackingTarget = await dependencies.resolveRemoteTrackingTarget(path);
    if (trackingTarget.ok) {
      const fetchResult = await dependencies.fetchRemoteTrackingTarget(path, trackingTarget.target);
      if (!fetchResult.ok) {
        refreshWarning = createRefreshWarning(fetchResult);
      }
    }

    const result = await dependencies.getGitStatus(path);

    if (result.error) {
      return {
        branch: createEmptyBranchTrackingInfo(true),
        defaultBranch: null,
        error: result.error,
        files: [],
        name,
        path,
        refreshWarning,
      };
    }

    const parsed = parseGitStatus(result.output);
    const defaultBranch = await dependencies.compareCurrentBranchToDefaultBranch(
      path,
      parsed.branch.localBranch,
      parsed.branch.isDetached,
    );

    let fullStatus: string | undefined = undefined;
    if (verbose) {
      const fullResult = await dependencies.getFullGitStatus(path);
      if (fullResult.error) {
        fullStatus = fullResult.error;
      } else {
        fullStatus = fullResult.output;
      }
    }

    return {
      branch: parsed.branch,
      defaultBranch,
      error: null,
      files: parsed.files,
      fullStatus,
      name,
      path,
      refreshWarning,
    };
  } catch (error) {
    let errorMessage = "Unknown error";
    if (error instanceof Error) {
      errorMessage = error.message;
    }

    return {
      branch: createEmptyBranchTrackingInfo(true),
      defaultBranch: null,
      error: errorMessage,
      files: [],
      name,
      path,
      refreshWarning: null,
    };
  }
};

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
export const checkAllRepos = (
  workspaceRoot: string,
  config: Config,
  verbose = false,
): Promise<RepoStatus[]> => {
  const reposToCheck: { name: string; path: string }[] = [
    { name: "Main Repository", path: workspaceRoot },
  ];

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    const absolutePath = resolve(workspaceRoot, repoConfig.path);
    reposToCheck.push({ name, path: absolutePath });
  }

  const statusPromises = reposToCheck.map((repo) =>
    checkRepoStatus(repo.name, repo.path, { verbose }),
  );

  return Promise.all(statusPromises);
};

const formatTrackingSuffix = (
  branch: BranchTrackingInfo,
  refreshWarning: RepoRefreshWarning | null | undefined = null,
): string => {
  if (refreshWarning?.kind === "missing-remote-ref") {
    return ` → ${refreshWarning.message}`;
  }

  if (!branch.remoteBranch) {
    return "";
  }

  let suffix = ` → ${branch.remoteBranch}`;
  if (branch.ahead > ZERO || branch.behind > ZERO) {
    const trackingParts: string[] = [];
    if (branch.ahead > ZERO) {
      trackingParts.push(`↑${branch.ahead}`);
    }
    if (branch.behind > ZERO) {
      trackingParts.push(`↓${branch.behind}`);
    }
    suffix += ` [${trackingParts.join(", ")}]`;
  }

  return suffix;
};

const formatBranchLine = (status: RepoStatus): string => {
  if (status.branch.isDetached) {
    return `  Branch: ${cyan("(detached HEAD)")}`;
  }

  const trackingSuffix = formatTrackingSuffix(status.branch, status.refreshWarning);
  if (status.refreshWarning?.kind === "missing-remote-ref") {
    return `  ${yellow(`Branch: ${status.branch.localBranch}${trackingSuffix}`)}`;
  }

  return `  Branch: ${cyan(status.branch.localBranch)}${trackingSuffix}`;
};

const shouldShowGenericRefreshWarning = (status: RepoStatus): boolean =>
  status.refreshWarning?.kind === "stale-remote-tracking";

const formatDefaultBranchLine = (status: RepoStatus): string | null => {
  if (!status.defaultBranch) {
    return null;
  }

  if (status.defaultBranch.state === "available" && status.defaultBranch.behind > ZERO) {
    return `  ${yellow(`Default: ${status.defaultBranch.branch} [↓${status.defaultBranch.behind}]`)}`;
  }

  if (status.defaultBranch.state === "unavailable") {
    return `  ${yellow(`Default: ${status.defaultBranch.branch} (unavailable)`)}`;
  }

  return null;
};

const formatShortDefaultIndicator = (status: RepoStatus): string => {
  if (!status.defaultBranch) {
    return "";
  }

  if (status.defaultBranch.state === "available" && status.defaultBranch.behind > ZERO) {
    return ` ${yellow(`default↓${status.defaultBranch.behind}`)}`;
  }

  if (status.defaultBranch.state === "unavailable") {
    return ` ${yellow("(default unavailable)")}`;
  }

  return "";
};

/**
 * Helper to get clean/dirty symbol
 */
const getStatusSymbol = (isClean: boolean): string => {
  if (isClean) {
    return "✓";
  }

  return "●";
};

/**
 * Helper to get status color function
 */
const getStatusColor = (isClean: boolean) => (hasError: boolean) => {
  if (hasError) {
    return (text: string) => `\u001B[31m${text}\u001B[0m`;
  }

  if (isClean) {
    return (text: string) => `\u001B[32m${text}\u001B[0m`;
  }

  return (text: string) => `\u001B[33m${text}\u001B[0m`;
};

/**
 * Helper to apply cyan color
 */
const cyan = (text: string): string => `\u001B[36m${text}\u001B[0m`;

/**
 * Helper to apply yellow color
 */
const yellow = (text: string): string => `\u001B[33m${text}\u001B[0m`;

/**
 * Helper to apply bold
 */
const bold = (text: string): string => `\u001B[1m${text}\u001B[0m`;

/**
 * Format a single repository section for default output
 *
 * @param status - Repository status
 * @returns Formatted output string
 */
export const formatRepoSection = (status: RepoStatus): string => {
  let section = `\n${bold(status.name)} (${status.path})\n`;

  // Branch info
  section += `${formatBranchLine(status)}\n`;

  const defaultBranchLine = formatDefaultBranchLine(status);
  if (defaultBranchLine) {
    section += `${defaultBranchLine}\n`;
  }

  // Status
  if (status.error) {
    const colorFn = getStatusColor(false)(true);
    section += `  Status: ${colorFn("✗ Error")}\n`;
    section += `  ${colorFn(status.error)}\n`;
  } else if (status.files.length === ZERO) {
    const colorFn = getStatusColor(true)(false);
    section += `  Status: ${colorFn(`${getStatusSymbol(true)} Clean`)}\n`;
  } else {
    const colorFn = getStatusColor(false)(false);
    const { modifiedCount, stagedCount, untrackedCount } = countRepoChanges(status);

    section += `  Status: ${colorFn(`${getStatusSymbol(false)} Dirty`)} (${status.files.length} changes)\n`;

    const parts = [];
    if (stagedCount > ZERO) {
      parts.push(`${stagedCount} staged`);
    }
    if (modifiedCount > ZERO) {
      parts.push(`${modifiedCount} modified`);
    }
    if (untrackedCount > ZERO) {
      parts.push(`${untrackedCount} untracked`);
    }

    section += `    ${parts.join(", ")}\n`;
  }

  if (shouldShowGenericRefreshWarning(status)) {
    section += `  ${yellow(`Warning: ${status.refreshWarning?.message}`)}\n`;
  }

  return section;
};

/**
 * Format summary line showing clean/dirty counts
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted summary string
 */
export const formatSummary = (statuses: RepoStatus[]): string => {
  const { cleanCount, dirtyCount, total } = summarizeStatuses(statuses);

  return `\n${"─".repeat(SUMMARY_WIDTH)}\n${bold(`Summary: ${cleanCount} clean, ${dirtyCount} dirty (${total} total)`)}\n`;
};

export const isMissingRepositoryStatus = (status: RepoStatus): boolean =>
  status.error?.includes("arashi clone") === true && status.files.length === ZERO;

export const filterHumanVisibleStatuses = (
  statuses: RepoStatus[],
  options: StatusOptions,
): RepoStatus[] => {
  if (options.verbose || options.json) {
    return statuses;
  }

  return statuses.filter((status) => !isMissingRepositoryStatus(status));
};

/**
 * Format default output showing all repository statuses
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted output string
 */
export const formatDefaultOutput = (statuses: RepoStatus[]): string => {
  let output = "";

  for (const status of statuses) {
    output += formatRepoSection(status);
  }

  output += formatSummary(statuses);
  return output;
};

/**
 * Format verbose output showing full git status for each repository
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted output string
 */
export const formatVerboseOutput = (statuses: RepoStatus[]): string => {
  let output = "";

  for (const status of statuses) {
    output += `\n${bold(status.name)} (${status.path})\n`;

    // Branch info
    output += `${formatBranchLine(status)}\n`;

    const defaultBranchLine = formatDefaultBranchLine(status);
    if (defaultBranchLine) {
      output += `${defaultBranchLine}\n`;
    }

    output += "\n";

    // Full git status output
    if (status.error) {
      const colorFn = getStatusColor(false)(true);
      output += `  ${colorFn(`✗ Error: ${status.error}`)}\n`;
    } else if (status.fullStatus) {
      // Indent each line of full status
      const lines = status.fullStatus.split("\n");
      for (const line of lines) {
        output += `  ${line}\n`;
      }
    } else {
      const colorFn = getStatusColor(true)(false);
      output += `  ${colorFn("✓ Clean - No changes")}\n`;
    }

    if (shouldShowGenericRefreshWarning(status)) {
      output += `  ${yellow(`Warning: ${status.refreshWarning?.message}`)}\n`;
    }
  }

  output += formatSummary(statuses);
  return output;
};

/**
 * Format a single line for short output
 *
 * @param status - Repository status
 * @returns Formatted line
 */
export const formatShortLine = (status: RepoStatus): string => {
  let branchLabel = status.branch.localBranch;
  if (status.branch.isDetached) {
    branchLabel = "detached";
  }

  let line = `${status.path} (${branchLabel}`;

  // Add tracking info
  if (status.branch.ahead > ZERO || status.branch.behind > ZERO) {
    line += " ";
    if (status.branch.ahead > ZERO) {
      line += `↑${status.branch.ahead}`;
    }
    if (status.branch.behind > ZERO) {
      line += `↓${status.branch.behind}`;
    }
  }

  line += "): ";

  // Add status
  if (status.error) {
    const colorFn = getStatusColor(false)(true);
    if (status.error.includes("arashi clone")) {
      line += colorFn("✗ missing (run arashi clone)");
    } else {
      line += colorFn("✗ error");
    }
  } else if (status.files.length === ZERO) {
    const colorFn = getStatusColor(true)(false);
    line += colorFn("✓ clean");
  } else {
    const colorFn = getStatusColor(false)(false);
    const { modifiedCount, stagedCount, untrackedCount } = countRepoChanges(status);

    const parts = [];
    if (stagedCount > ZERO) {
      parts.push(`${stagedCount} staged`);
    }
    if (modifiedCount > ZERO) {
      parts.push(`${modifiedCount} modified`);
    }
    if (untrackedCount > ZERO) {
      parts.push(`${untrackedCount} untracked`);
    }

    line += colorFn(`● ${status.files.length} changes (${parts.join(", ")})`);
  }

  if (status.refreshWarning?.kind === "missing-remote-ref") {
    line += ` ${yellow(`(${status.refreshWarning.message})`)}`;
  } else if (shouldShowGenericRefreshWarning(status)) {
    line += ` ${yellow("(remote tracking stale)")}`;
  }

  line += formatShortDefaultIndicator(status);

  return line;
};

/**
 * Format short output showing one line per repository
 *
 * @param statuses - Array of repository statuses
 * @returns Formatted output string
 */
export const formatShortOutput = (statuses: RepoStatus[]): string => {
  let output = "";

  for (const status of statuses) {
    output += `${formatShortLine(status)}\n`;
  }

  const { cleanCount, dirtyCount } = summarizeStatuses(statuses);

  output += `\nSummary: ${cleanCount} clean, ${dirtyCount} dirty\n`;
  return output;
};

/**
 * Main status command implementation
 *
 * @param options - Command options
 */
export const collectStatusWarnings = (statuses: RepoStatus[]): JsonWarning[] =>
  statuses.flatMap((status) => {
    const warnings: JsonWarning[] = [];
    if (status.refreshWarning) {
      warnings.push({
        code: status.refreshWarning.kind.toUpperCase().replaceAll("-", "_"),
        details: { repository: status.name },
        message: status.refreshWarning.message,
      });
    }
    if (status.defaultBranch?.state === "unavailable" && status.defaultBranch.message) {
      warnings.push({
        code: "DEFAULT_BRANCH_COMPARISON_UNAVAILABLE",
        details: { repository: status.name },
        message: status.defaultBranch.message,
      });
    }
    return warnings;
  });

const statusCommand = async (options: StatusOptions): Promise<void> => {
  if (options.verbose && options.short) {
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("status", {
          code: "CONFLICTING_OPTIONS",
          details: { options: ["--verbose", "--short"] },
          message: "Cannot use --verbose and --short together",
        }),
      );
    } else {
      logError("Cannot use --verbose and --short together");
      info("Use 'arashi status --help' for usage information");
    }
    process.exit(USAGE_EXIT_CODE);
  }

  let workspaceRoot = "";
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("status", {
          code: "NOT_IN_WORKSPACE",
          message: "Not in an arashi workspace",
        }),
      );
    } else {
      logError("Not in an arashi workspace");
      info("Run 'arashi init' to initialize a workspace");
    }
    process.exit(USAGE_EXIT_CODE);
  }

  let config = createEmptyConfig();
  try {
    config = await loadConfig(workspaceRoot);
  } catch (error) {
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("status", unknownErrorToJsonError(error, "CONFIG_LOAD_FAILED")),
      );
    } else {
      logError("Failed to load workspace configuration");
      if (error instanceof Error) {
        logError(error.message);
      } else {
        logError(String(error));
      }
    }
    process.exit(USAGE_EXIT_CODE);
  }

  const statusSpinner = options.json ? null : spinner("Checking repository status...");
  const filterResult = filterRepositories(config.repos, undefined, options.group);
  if (filterResult.unknownGroups.length > ZERO) {
    const message = `Unknown repository groups in --group filter: ${filterResult.unknownGroups.join(", ")}`;
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("status", {
          code: "UNKNOWN_REPOSITORY_GROUPS",
          details: {
            groups: filterResult.filters.groups,
            unknownGroups: filterResult.unknownGroups,
          },
          message,
        }),
      );
    } else {
      logError(message);
    }
    process.exit(USAGE_EXIT_CODE);
  }
  if (filterResult.emptyIntersection) {
    const message = "No repositories matched the combined --only/--group filters";
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("status", {
          code: "EMPTY_REPOSITORY_SELECTION",
          details: { filters: filterResult.filters },
          message,
        }),
      );
    } else {
      logError(message);
    }
    process.exit(USAGE_EXIT_CODE);
  }

  const configForStatus: Config = {
    ...config,
    repos:
      filterResult.filters.groups.length > ZERO
        ? Object.fromEntries(filterResult.repositories.map((repo) => [repo.name, repo.config]))
        : config.repos,
  };

  statusSpinner?.start();

  const statuses = await checkAllRepos(workspaceRoot, configForStatus, options.verbose || false);
  const visibleStatuses = filterHumanVisibleStatuses(statuses, options);

  statusSpinner?.stop();

  const summary = summarizeStatuses(options.json ? statuses : visibleStatuses);
  const statusesForExit = options.json ? statuses : visibleStatuses;
  const hasErrors = statusesForExit.some((status) => status.error !== null);

  if (options.json) {
    writeJsonEnvelope(
      createJsonSuccessEnvelope(
        "status",
        {
          filters: filterResult.filters,
          repositories: statuses,
          summary,
          workspaceRoot,
        },
        collectStatusWarnings(statuses),
      ),
    );
  } else {
    let output = formatDefaultOutput(visibleStatuses);
    if (options.verbose) {
      output = formatVerboseOutput(visibleStatuses);
    } else if (options.short) {
      output = formatShortOutput(visibleStatuses);
    }

    console.log(output);
  }

  if (hasErrors) {
    process.exit(ERROR_EXIT_CODE);
  }
};

const createEmptyConfig = (): Config => ({
  repos: {},
  reposDir: "./repos",
  version: "1.0.0",
  worktreesDir: "../.worktrees",
});

/**
 * Create the status command for Commander
 *
 * @returns Commander Command instance
 */
export const createCommand = (): Command =>
  new Command("status")
    .description("Show status of all managed repositories")
    .option("-v, --verbose", "Show full git status output")
    .option("-s, --short", "Show one-line summary per repository")
    .option(
      "--group <group>",
      "Only include repositories in the requested group (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option("--json", "Output a structured JSON envelope")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi status                    # Default output with colors
  $ arashi status --verbose          # Full git status for each repo
  $ arashi status --short            # One line per repository
  $ arashi status --group docs       # Only check repositories in a group
      `,
    )
    .action(statusCommand);
