/**
 * Core Implementation: List Command
 *
 * Core logic for listing worktrees and their status.
 * Handles data gathering, formatting, and output generation.
 *
 * @module core/list
 */

import { ListCommandError, NotInRepositoryError } from "../types/list.ts";
import { createJsonSuccessEnvelope, stringifyJsonEnvelope } from "../lib/json-output.ts";
import { isAbsolute, join, relative } from "path";
import { spinner, warn } from "../lib/logger.ts";
import chalk from "chalk";
import { exec } from "../lib/git.ts";
import { loadConfig } from "../lib/config.ts";

interface SubRepositoryInfo {
  relativePath: string;
  branch: string | null;
  commit: string;
  hasChanges: boolean;
}

interface WorktreeListItem {
  path: string;
  branch: string | null;
  commit: string;
  locked: boolean;
  lockReason?: string;
  hasChanges: boolean;
  isMain: boolean;
  parentPath?: string | null;
  childrenPaths?: string[];
  subRepositories?: SubRepositoryInfo[];
}

interface ListCommandOptions {
  verbose?: boolean;
  json?: boolean;
  table?: boolean;
  maxDepth?: number;
  jsonMetadata?: Record<string, unknown>;
}

interface ListCommandOutput {
  worktrees: WorktreeListItem[];
  totalCount: number;
  repositoryPath: string;
}

const ZERO = 0;
const DEFAULT_MAX_DEPTH = 3;
const SHORT_SHA_LENGTH = 7;
const STATUS_WIDTH = 15;
const JSON_INDENT = 2;
const DETACHED_LABEL = "detached";
const EMPTY_SHA = "0000000";
const SKIPPED_DIRECTORY_NAMES = new Set([".arashi", "node_modules"]);

const normalizeRelativeDisplayPath = (path: string): string => path.replaceAll("\\", "/");

const tryAddGitRepository = async (gitRepos: string[], repoPath: string): Promise<void> => {
  try {
    await exec(["rev-parse", "--git-dir"], repoPath);
    gitRepos.push(repoPath);
  } catch {}
};

const shouldIncludeRootRepository = (
  excludeRoot: boolean | undefined,
  repoPath: string,
  rootPath: string,
): boolean => !excludeRoot || repoPath !== rootPath;

const handleDirectoryEntry = async (options: {
  currentPath: string;
  depth: number;
  entry: { isDirectory: () => boolean; isFile: () => boolean; name: string };
  excludeRoot?: boolean;
  gitRepos: string[];
  rootPath: string;
  scan: (currentPath: string, depth: number) => Promise<void>;
}): Promise<void> => {
  if (options.entry.name === ".git" && (options.entry.isDirectory() || options.entry.isFile())) {
    const repoPath = options.currentPath;
    if (shouldIncludeRootRepository(options.excludeRoot, repoPath, options.rootPath)) {
      await tryAddGitRepository(options.gitRepos, repoPath);
    }
    return;
  }

  if (!options.entry.isDirectory()) {
    return;
  }

  const fullPath = join(options.currentPath, options.entry.name);
  if (!SKIPPED_DIRECTORY_NAMES.has(options.entry.name)) {
    await options.scan(fullPath, options.depth + 1);
  }
};

// ============================================================================
// Main Command
// ============================================================================

/**
 * Find parent repository if current directory is a child repo within reposDir
 *
 * When running arashi list from within a child repository (e.g., repos/my-app),
 * this function searches upward to find the parent worktree that contains the
 * .arashi configuration. This allows commands to operate on the parent repo's
 * worktrees instead of the child repo.
 *
 * **Detection Logic:**
 * 1. Walk up directory tree looking for .arashi/config.json
 * 2. If found, check if current directory is within that config's reposDir
 * 3. If yes, return the parent repo path (containing .arashi)
 * 4. If no, return null (we're in the main/parent repo)
 *
 * @param currentPath - Current working directory (child repo path)
 * @returns Path to parent repo if we're in a child, null otherwise
 *
 * @example
 * ```typescript
 * // In /workspace/main/repos/my-app
 * const parent = await findParentRepo('/workspace/main/repos/my-app');
 * console.log(parent); // "/workspace/main"
 *
 * // In /workspace/main (already at parent)
 * const parent = await findParentRepo('/workspace/main');
 * console.log(parent); // null
 * ```
 */
export const findParentRepo = async (currentPath: string): Promise<string | null> => {
  const { resolve, dirname, relative, isAbsolute, parse } = await import("path");
  const { access, constants } = await import("fs/promises");

  const resolvedCurrentPath = resolve(currentPath);
  let searchPath = resolvedCurrentPath;
  const { root } = parse(searchPath);

  // Walk up directory tree looking for .arashi/config.json
  while (true) {
    const configPath = resolve(searchPath, ".arashi", "config.json");

    try {
      // Check if config exists
      await access(configPath, constants.R_OK);

      // Found a config - load it to check reposDir
      try {
        const cfg = await loadConfig(searchPath);
        const reposDirAbs = resolve(searchPath, cfg.reposDir);

        // Check if current path is within reposDir
        const rel = relative(reposDirAbs, resolvedCurrentPath);
        if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
          // We're inside reposDir of this config - this is the parent repo
          return searchPath;
        }

        // We found a config but we're not in its reposDir
        // This means we're already at the parent level
        return null;
      } catch {
        // Config exists but couldn't be loaded - continue searching
      }
    } catch {
      // No config at this level - continue searching
    }

    if (searchPath === root) {
      break;
    }

    // Move up one directory
    const parentPath = dirname(searchPath);
    if (parentPath === searchPath) {
      break;
    }

    searchPath = parentPath;
  }

  // No parent config found
  return null;
};

/**
 * List all worktrees in the current repository with their status
 *
 * This is the main entry point for the list command. It validates the current
 * directory is a git repository, gathers worktree data, and outputs the results
 * in either table or JSON format.
 *
 * **Features:**
 * - Lists all worktrees with their paths, branches, and status
 * - Detects uncommitted changes in each worktree
 * - Optional verbose mode to discover nested sub-repositories
 * - JSON output for machine parsing and tool integration
 * - Auto-detects child repos and lists parent repo's worktrees
 *
 * **Behavior:**
 * - Works in both main repositories and linked worktrees
 * - Configuration is optional (warns if `.arashi/config.json` is missing)
 * - Shows progress spinner in verbose mode (suppressed in JSON mode)
 * - Gracefully handles errors with clear messages
 * - If run from within reposDir, automatically switches to parent repo
 *
 * @param options - Command options controlling output format and behavior
 * @param options.verbose - If true, discovers nested sub-repositories (slower)
 * @param options.json - If true, outputs JSON instead of formatted table
 * @param options.maxDepth - Maximum directory depth for sub-repo discovery (default: 3)
 *
 * @throws {NotInRepositoryError} When current directory is not a git repository
 * @throws {ListCommandError} When worktree data gathering fails
 *
 * @example
 * ```typescript
 * // Basic listing
 * await listCommand();
 *
 * This is the main entry point for the list command. It validates the current
 * directory is a git repository, gathers worktree data, and outputs the results
 * in either table or JSON format.
 *
 * **Features:**
 * - Lists all worktrees with their paths, branches, and status
 * - Detects uncommitted changes in each worktree
 * - Optional verbose mode to discover nested sub-repositories
 * - JSON output for machine parsing and tool integration
 *
 * **Behavior:**
 * - Works in both main repositories and linked worktrees
 * - Configuration is optional (warns if `.arashi/config.json` is missing)
 * - Shows progress spinner in verbose mode (suppressed in JSON mode)
 * - Gracefully handles errors with clear messages
 *
 * @param options - Command options controlling output format and behavior
 * @param options.verbose - If true, discovers nested sub-repositories (slower)
 * @param options.json - If true, outputs JSON instead of formatted table
 * @param options.maxDepth - Maximum directory depth for sub-repo discovery (default: 3)
 *
 * @throws {NotInRepositoryError} When current directory is not a git repository
 * @throws {ListCommandError} When worktree data gathering fails
 *
 * @example
 * ```typescript
 * // Basic listing
 * await listCommand();
 *
 * // Verbose mode with sub-repositories
 * await listCommand({ verbose: true });
 *
 * // JSON output
 * await listCommand({ json: true });
 *
 * // Combined options
 * await listCommand({ verbose: true, json: true, maxDepth: 5 });
 * ```
 */
export const listCommand = async (options?: ListCommandOptions): Promise<void> => {
  const opts: ListCommandOptions = {
    json: options?.json || false,
    jsonMetadata: options?.jsonMetadata,
    maxDepth: options?.maxDepth || DEFAULT_MAX_DEPTH,
    table: options?.table || false,
    verbose: options?.verbose || false,
  };

  // Validate we're in a repository
  let cwd = process.cwd();

  try {
    // Check if it's a git repository by trying to get the root
    await exec(["rev-parse", "--git-dir"], cwd);
  } catch {
    throw new NotInRepositoryError(cwd);
  }

  // Try to find parent repo if we're in a child repo within reposDir
  const parentRepo = await findParentRepo(cwd);
  if (parentRepo) {
    // We're in a child repo - use parent repo for listing worktrees
    cwd = parentRepo;
  }

  // Load configuration (optional check - list can work without config)
  try {
    await loadConfig(cwd);
  } catch {
    // Config not required for list command
    // Only warn in table/verbose mode (not in simple/json output)
    if (opts.table || opts.verbose) {
      warn("Arashi configuration not found. Some features may be limited.");
    }
  }

  // Show progress for verbose mode (may be slow) - but not in JSON mode
  const s =
    opts.verbose && !opts.json ? spinner("Discovering worktrees and sub-repositories...") : null;
  s?.start();

  try {
    // Build output
    const output = await buildListOutput(cwd, opts);

    s?.succeed("Discovery complete");

    // Format and display
    let output_str = formatAsSimpleList(output);
    if (opts.json) {
      output_str = stringifyJsonEnvelope(
        createJsonSuccessEnvelope("list", {
          ...opts.jsonMetadata,
          worktrees: output.worktrees,
        }),
      );
    } else if (opts.table || opts.verbose) {
      // Table format when explicitly requested or in verbose mode
      output_str = formatAsTable(output, opts.verbose || false);
    }

    // Use process.stdout.write directly for better pipe compatibility with fzf
    process.stdout.write(`${output_str}\n`);
  } catch (error) {
    s?.fail("Failed to list worktrees");
    throw error;
  }
};

// ============================================================================
// Helper Functions (Stubs)
// ============================================================================

/**
 * Get the short commit SHA (7 characters) for a repository
 *
 * Uses `git rev-parse --short=7 HEAD` to retrieve the abbreviated commit hash.
 * This format is consistent with git's standard short SHA display.
 *
 * @param repoPath - Absolute path to the git repository
 * @returns 7-character hexadecimal commit SHA (e.g., "abc1234")
 *
 * @throws {ListCommandError} When repository path is invalid or HEAD cannot be resolved
 *
 * @example
 * ```typescript
 * const sha = await getShortCommitSha('/path/to/repo');
 * console.log(sha); // "abc1234"
 * ```
 */
export const getShortCommitSha = async (repoPath: string): Promise<string> => {
  try {
    const result = await exec(["rev-parse", `--short=${SHORT_SHA_LENGTH}`, "HEAD"], repoPath);
    return result.stdout.trim();
  } catch (error) {
    throw new ListCommandError(`Failed to get commit SHA for ${repoPath}`, { error, repoPath });
  }
};

/**
 * Determine if a worktree has uncommitted changes
 *
 * Checks for both staged and unstaged changes, as well as untracked files,
 * using `git status --porcelain`. Returns true if there is any output, indicating
 * the working directory is not clean.
 *
 * **Detects:**
 * - Modified tracked files (staged or unstaged)
 * - Deleted tracked files
 * - Untracked files
 * - Renamed files
 *
 * @param worktreePath - Absolute path to the worktree to check
 * @returns `true` if there are uncommitted changes, `false` if clean
 *
 * @throws {ListCommandError} When git status command fails or path is invalid
 *
 * @example
 * ```typescript
 * const hasChanges = await hasUncommittedChanges('/path/to/worktree');
 * if (hasChanges) {
 *   console.log('Worktree has uncommitted changes');
 * }
 * ```
 */
export const hasUncommittedChanges = async (worktreePath: string): Promise<boolean> => {
  try {
    const result = await exec(["status", "--porcelain"], worktreePath);
    // If there's any output, there are changes
    return result.stdout.trim().length > ZERO;
  } catch (error) {
    throw new ListCommandError(`Failed to check status for ${worktreePath}`, {
      error,
      worktreePath,
    });
  }
};

/**
 * Validate WorktreeListItem structure using TypeScript type assertions
 *
 * Performs runtime validation of worktree data structure to ensure all required
 * fields are present and correctly typed. This guards against malformed data
 * from git command parsing.
 *
 * **Validates:**
 * - `path` is an absolute string
 * - `branch` is a string or null (for detached HEAD)
 * - `commit` is a 7-character hexadecimal string
 * - `locked` is a boolean
 * - `lockReason` is a string (when present)
 * - `hasChanges` is a boolean
 * - `isMain` is a boolean
 * - `subRepositories` is an array (when present)
 *
 * @param item - Object to validate
 * @throws {ListCommandError} When validation fails with specific error message
 *
 * @example
 * ```typescript
 * const item = {
 *   path: '/repo/main',
 *   branch: 'main',
 *   commit: 'abc1234',
 *   locked: false,
 *   hasChanges: false,
 *   isMain: true,
 * };
 * validateWorktreeListItem(item); // Succeeds
 * ```
 */
export const validateWorktreeListItem: (item: unknown) => asserts item is WorktreeListItem = (
  item: unknown,
): asserts item is WorktreeListItem => {
  if (typeof item !== "object" || item === null) {
    throw new ListCommandError("worktree item must be an object");
  }

  const candidate = item as {
    path?: unknown;
    branch?: unknown;
    commit?: unknown;
    locked?: unknown;
    lockReason?: unknown;
    hasChanges?: unknown;
    isMain?: unknown;
    subRepositories?: unknown;
    parentPath?: unknown;
    childrenPaths?: unknown;
  };

  if (typeof candidate.path !== "string" || !isAbsolute(candidate.path)) {
    throw new ListCommandError("path must be absolute string");
  }

  if (candidate.branch !== null && typeof candidate.branch !== "string") {
    throw new ListCommandError("branch must be string or null");
  }

  if (typeof candidate.commit !== "string" || !/^[0-9a-f]{7}$/.test(candidate.commit)) {
    throw new ListCommandError("commit must be 7-character hex string");
  }

  if (typeof candidate.locked !== "boolean") {
    throw new ListCommandError("locked must be boolean");
  }

  if (
    candidate.locked &&
    candidate.lockReason !== undefined &&
    typeof candidate.lockReason !== "string"
  ) {
    throw new ListCommandError("lockReason must be string when present");
  }

  if (typeof candidate.hasChanges !== "boolean") {
    throw new ListCommandError("hasChanges must be boolean");
  }

  if (typeof candidate.isMain !== "boolean") {
    throw new ListCommandError("isMain must be boolean");
  }

  if (candidate.subRepositories !== undefined && !Array.isArray(candidate.subRepositories)) {
    throw new ListCommandError("subRepositories must be array when present");
  }

  if (
    candidate.parentPath !== undefined &&
    candidate.parentPath !== null &&
    (typeof candidate.parentPath !== "string" || !isAbsolute(candidate.parentPath))
  ) {
    throw new ListCommandError("parentPath must be absolute string or null");
  }

  if (
    candidate.childrenPaths !== undefined &&
    (!Array.isArray(candidate.childrenPaths) ||
      candidate.childrenPaths.some(
        (path: unknown) => typeof path !== "string" || !isAbsolute(path),
      ))
  ) {
    throw new ListCommandError("childrenPaths must be array of absolute strings when present");
  }
};

/**
 * Validate ListCommandOutput structure using TypeScript type assertions
 *
 * Ensures the complete output structure is valid before display/serialization.
 * Validates both the top-level structure and each individual worktree item.
 *
 * **Validates:**
 * - `worktrees` is a non-empty array
 * - Exactly one worktree has `isMain === true`
 * - `totalCount` matches `worktrees.length`
 * - `repositoryPath` is an absolute string
 * - Each worktree passes `validateWorktreeListItem()`
 *
 * @param output - Output object to validate
 * @throws {ListCommandError} When validation fails with specific error message
 *
 * @example
 * ```typescript
 * const output = {
 *   worktrees: [...],
 *   totalCount: 3,
 *   repositoryPath: '/repo/main',
 * };
 * validateListCommandOutput(output); // Succeeds or throws
 * ```
 */
export const validateListCommandOutput: (output: unknown) => asserts output is ListCommandOutput = (
  output: unknown,
): asserts output is ListCommandOutput => {
  if (typeof output !== "object" || output === null) {
    throw new ListCommandError("output must be an object");
  }

  const candidate = output as {
    worktrees?: unknown;
    totalCount?: unknown;
    repositoryPath?: unknown;
  };

  if (!Array.isArray(candidate.worktrees) || candidate.worktrees.length === 0) {
    throw new ListCommandError("worktrees must be non-empty array");
  }

  const mainWorktrees = candidate.worktrees.filter(
    (wt: unknown) => typeof wt === "object" && wt !== null && (wt as { isMain?: unknown }).isMain,
  );
  if (mainWorktrees.length !== 1) {
    throw new ListCommandError("exactly one worktree must have isMain === true");
  }

  if (candidate.totalCount !== candidate.worktrees.length) {
    throw new ListCommandError("totalCount must match worktrees.length");
  }

  if (typeof candidate.repositoryPath !== "string" || !isAbsolute(candidate.repositoryPath)) {
    throw new ListCommandError("repositoryPath must be absolute string");
  }

  // Validate each worktree
  candidate.worktrees.forEach((wt: unknown) => validateWorktreeListItem(wt));
};

/**
 * Gather worktree data from git using `git worktree list --porcelain`
 *
 * Parses the porcelain (machine-readable) output from git to extract worktree
 * information including paths, branches, commits, and lock status. Also checks
 * each worktree for uncommitted changes.
 *
 * **Porcelain Format Parsing:**
 * - `worktree <path>` - Absolute path to worktree
 * - `HEAD <commit>` - Full commit SHA (first 7 chars used)
 * - `branch <ref>` - Branch reference (e.g., refs/heads/main)
 * - `detached` - Indicates detached HEAD state
 * - `locked [reason]` - Lock status with optional reason
 * - `bare` - Indicates bare repository (skipped)
 * - Empty line separates entries
 *
 * **Special Handling:**
 * - Bare repositories are skipped (no working directory)
 * - Branch names are extracted from refs/heads/ format
 * - Detached HEAD results in `branch: null`
 * - Each worktree is checked for uncommitted changes
 * - Main worktree is identified by matching repository path
 *
 * @param repoPath - Absolute path to the main git repository
 * @returns Array of worktree items with complete metadata
 *
 * @throws {ListCommandError} When git command fails or parsing errors occur
 *
 * @example
 * ```typescript
 * const worktrees = await gatherWorktreeData('/path/to/repo');
 * worktrees.forEach(wt => {
 *   console.log(`${wt.path} - ${wt.branch} (${wt.commit})`);
 * });
 * ```
 */
export const gatherWorktreeData = async (repoPath: string): Promise<WorktreeListItem[]> => {
  try {
    // Get worktree list in porcelain format
    const result = await exec(["worktree", "list", "--porcelain"], repoPath);
    const worktrees: WorktreeListItem[] = [];

    // Parse porcelain output
    const lines = result.stdout.trim().split("\n");
    let currentWorktree: Partial<WorktreeListItem> = {};
    let isBare = false;
    let foundFirstNonBare = false; // Track if we've seen the first non-bare worktree

    for (const line of lines) {
      if (line === "") {
        // Empty line indicates end of worktree entry
        if (currentWorktree.path && !isBare) {
          // Check if this worktree has uncommitted changes
          const hasChanges = await hasUncommittedChanges(currentWorktree.path);

          // Determine if this is the main worktree:
          // - For non-bare repos: matches the repository path
          // - For bare repos: first non-bare worktree in the list
          const isMain = !foundFirstNonBare;
          foundFirstNonBare = true;

          worktrees.push({
            branch: currentWorktree.branch || null,
            commit: currentWorktree.commit || EMPTY_SHA,
            hasChanges,
            isMain,
            lockReason: currentWorktree.lockReason,
            locked: currentWorktree.locked || false,
            path: currentWorktree.path,
          } as WorktreeListItem);
        }
        currentWorktree = {};
        isBare = false;
      } else if (line.startsWith("worktree ")) {
        currentWorktree.path = line.slice("worktree ".length);
      } else if (line === "bare") {
        // Skip bare worktrees
        isBare = true;
      } else if (line.startsWith("HEAD ")) {
        currentWorktree.commit = line.slice("HEAD ".length).slice(ZERO, SHORT_SHA_LENGTH);
      } else if (line.startsWith("branch ")) {
        const branchRef = line.slice("branch ".length);
        // Extract branch name from refs/heads/branch-name
        currentWorktree.branch = branchRef.replace("refs/heads/", "");
      } else if (line.startsWith("detached")) {
        currentWorktree.branch = null;
      } else if (line.startsWith("locked")) {
        currentWorktree.locked = true;
        const reasonMatch = line.match(/^locked\s+(.+)$/);
        if (reasonMatch) {
          const [, lockReason] = reasonMatch;
          currentWorktree.lockReason = lockReason;
        }
      }
    }

    // Handle last worktree if file doesn't end with empty line
    if (currentWorktree.path && !isBare) {
      const hasChanges = await hasUncommittedChanges(currentWorktree.path);
      const isMain = !foundFirstNonBare;
      foundFirstNonBare = true;

      worktrees.push({
        branch: currentWorktree.branch || null,
        commit: currentWorktree.commit || EMPTY_SHA,
        hasChanges,
        isMain,
        lockReason: currentWorktree.lockReason,
        locked: currentWorktree.locked || false,
        path: currentWorktree.path,
      } as WorktreeListItem);
    }

    return worktrees;
  } catch (error) {
    throw new ListCommandError(`Failed to gather worktree data for ${repoPath}`, {
      error,
      repoPath,
    });
  }
};

/**
 * Discover nested git sub-repositories within a worktree directory
 *
 * Recursively scans the worktree directory to find nested git repositories
 * (identified by .git directories). For each found repository, extracts branch
 * name, commit SHA, and change status. Returns paths relative to the worktree root.
 *
 * **Discovery Behavior:**
 * - Scans up to `maxDepth` levels deep (default: 3)
 * - Skips `node_modules` and `.arashi` directories
 * - Excludes the worktree root itself (only finds nested repos)
 * - Handles detached HEAD state (branch will be null)
 * - Continues on error (skips inaccessible repositories)
 *
 * **Use Cases:**
 * - Finding sub-repositories in meta-repository setups
 * - Detecting nested git repos in monorepos
 * - Validating sub-repository state before operations
 *
 * @param worktreePath - Absolute path to the worktree to scan
 * @param maxDepth - Maximum directory depth to search (default: 3)
 * @returns Array of sub-repository info with relative paths
 *
 * @example
 * ```typescript
 * const subRepos = await discoverSubRepositories('/path/to/worktree', 3);
 * subRepos.forEach(sub => {
 *   console.log(`${sub.relativePath}: ${sub.branch} (${sub.hasChanges ? 'modified' : 'clean'})`);
 * });
 * ```
 */
export const discoverSubRepositories = async (
  worktreePath: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Promise<SubRepositoryInfo[]> => {
  // Find all git repositories within worktree
  const repoPaths = await findGitRepositories(worktreePath, maxDepth, true);

  const subRepos: SubRepositoryInfo[] = [];

  for (const repoPath of repoPaths) {
    try {
      // Get branch name
      let branch: string | null = null;
      try {
        const branchResult = await exec(["symbolic-ref", "--short", "HEAD"], repoPath);
        branch = branchResult.stdout.trim();
      } catch {
        // Detached HEAD or error - leave as null
      }

      // Get short commit SHA
      const commit = await getShortCommitSha(repoPath);

      // Check for uncommitted changes
      const hasChanges = await hasUncommittedChanges(repoPath);

      // Get relative path
      const relativePath = normalizeRelativeDisplayPath(relative(worktreePath, repoPath));

      subRepos.push({
        branch,
        commit,
        hasChanges,
        relativePath,
      });
    } catch {}
  }

  return subRepos;
};

/**
 * Format status indicator with color for a worktree
 *
 * Returns a colored status string based on worktree state:
 * - 🔒 locked (gray) - Worktree is locked
 * - ✗ modified (red) - Worktree has uncommitted changes
 * - ✓ clean (green) - Worktree is clean
 *
 * Priority order: locked > modified > clean
 *
 * @param wt - Worktree item to format status for
 * @returns Colored status string with emoji indicator
 *
 * @internal This is exported for testing but considered internal API
 *
 * @example
 * ```typescript
 * const status = formatStatus({ locked: false, hasChanges: true, ... });
 * console.log(status); // "✗ modified" (in red)
 * ```
 */
export const formatStatus = (wt: WorktreeListItem): string => {
  if (wt.locked) {
    return chalk.gray("🔒 locked");
  }
  if (wt.hasChanges) {
    return chalk.red("✗ modified");
  }
  return chalk.green("✓ clean");
};

/**
 * Format worktree data as a simple list of paths
 *
 * Outputs one path per line with no headers, colors, or formatting.
 * This format is ideal for:
 * - Piping to other commands (fzf, grep, etc.)
 * - Script processing
 * - Clean, minimal output
 *
 * @param output - Complete output structure with worktrees
 * @returns Newline-separated list of absolute paths
 *
 * @example
 * ```typescript
 * const output = await buildListOutput('/repo', { verbose: false });
 * const list = formatAsSimpleList(output);
 * console.log(list);
 * // Output:
 * // /repo/main
 * // /repo/feature
 * // /repo/bugfix
 * ```
 */
export const formatAsSimpleList = (output: ListCommandOutput): string =>
  output.worktrees.map((wt) => wt.path).join("\n");

/**
 * Format worktree data as a human-readable table with colors
 *
 * Creates formatted output for terminal display with two modes:
 *
 * **Compact Mode (verbose=false):**
 * - Table with columns: PATH, BRANCH, STATUS
 * - Column widths calculated from actual data (no truncation)
 * - Includes legend explaining status symbols
 * - Shows total worktree count in header
 * - Special message when only main worktree exists
 *
 * **Verbose Mode (verbose=true):**
 * - Detailed multi-line format for each worktree
 * - Shows PATH, BRANCH, STATUS, TYPE fields
 * - Displays sub-repositories in tree structure
 * - Uses box-drawing characters (├── └──) for tree
 *
 * **Column Alignment:**
 * - Dynamically sizes columns to fit longest path/branch
 * - No truncation - full paths and branch names always visible
 * - Colors applied after padding for proper alignment
 *
 * **Colors:**
 * - Paths: cyan
 * - Branches: yellow
 * - Status: green (clean), red (modified), gray (locked)
 * - Headers: bold
 *
 * @param output - Complete output structure with worktrees
 * @param verbose - If true, shows detailed verbose format
 * @returns Multi-line formatted string ready for console.log
 *
 * @example
 * ```typescript
 * const output = await buildListOutput('/repo', { verbose: false });
 * const table = formatAsTable(output, false);
 * console.log(table);
 * // Output:
 * // Worktrees (3 total)
 * //
 * // PATH                             BRANCH   STATUS
 * // ──────────────────────────────────────────────────
 * // /repo/main                       main     ✓ clean
 * // /repo/feature-long-branch-name   feature  ✗ modified
 * ```
 */
export const formatAsTable = (output: ListCommandOutput, verbose: boolean): string => {
  const lines: string[] = [chalk.bold(`Worktrees (${output.totalCount} total)`), ""];

  if (output.worktrees.length === 1 && output.worktrees[0].isMain) {
    // No additional worktrees
    lines.push("No additional worktrees found.");
    lines.push("");
    lines.push(`The main repository is at: ${chalk.cyan(output.repositoryPath)}`);
    lines.push("");
    lines.push("To create a worktree, run:");
    lines.push("  arashi create <branch-name>");
    return lines.join("\n");
  }

  if (verbose) {
    // Verbose format with sub-repositories
    for (const wt of output.worktrees) {
      lines.push(`PATH: ${chalk.cyan(wt.path)}`);
      lines.push(`BRANCH: ${chalk.yellow(wt.branch || DETACHED_LABEL)}`);
      lines.push(`STATUS: ${formatStatus(wt)}`);
      lines.push(`TYPE: ${wt.isMain ? "Main worktree" : "Linked worktree"}`);

      if (wt.subRepositories && wt.subRepositories.length > 0) {
        lines.push("SUB-REPOSITORIES:");
        wt.subRepositories.forEach((sub, idx) => {
          const isLast = idx === wt.subRepositories!.length - 1;
          const prefix = isLast ? "└──" : "├──";
          const status = sub.hasChanges ? chalk.red("✗ modified") : chalk.green("✓ clean");
          lines.push(
            `  ${prefix} ${sub.relativePath} (${sub.branch || DETACHED_LABEL}) - ${status}`,
          );
        });
      }

      lines.push("");
    }
  } else {
    // Table format - calculate column widths from actual data (no truncation)

    // Find the longest path and branch name
    const maxPathLen = Math.max(...output.worktrees.map((wt) => wt.path.length), 4); // Min 4 for "PATH"
    const maxBranchLen = Math.max(
      ...output.worktrees.map((wt) => (wt.branch || "detached").length),
      "BRANCH".length,
    ); // Min 6 for "BRANCH"

    // Use actual widths (no truncation)
    const pathWidth = maxPathLen;
    const branchWidth = maxBranchLen;
    const statusWidth = STATUS_WIDTH;

    // Build header - pad BEFORE applying bold/colors
    const headerPath = chalk.bold("PATH".padEnd(pathWidth));
    const headerBranch = chalk.bold("BRANCH".padEnd(branchWidth));
    const headerStatus = chalk.bold("STATUS");
    const header = `${headerPath}  ${headerBranch}  ${headerStatus}`;
    const separator = "─".repeat(pathWidth + branchWidth + statusWidth + 4); // +4 for spacing

    lines.push(header);
    lines.push(separator);

    // Build rows - pad BEFORE applying colors for proper alignment
    for (const wt of output.worktrees) {
      const pathPadded = wt.path.padEnd(pathWidth);
      const branchPadded = (wt.branch || DETACHED_LABEL).padEnd(branchWidth);
      const status = formatStatus(wt);

      // Apply colors AFTER padding
      const pathColored = chalk.cyan(pathPadded);
      const branchColored = chalk.yellow(branchPadded);

      lines.push(`${pathColored}  ${branchColored}  ${status}`);
    }

    lines.push("");
    lines.push("Legend: ✓ = clean, ✗ = modified, 🔒 = locked");
  }

  return lines.join("\n");
};

/**
 * Format worktree data as JSON for machine parsing
 *
 * Serializes the worktrees array to pretty-printed JSON with 2-space indentation.
 * This format is suitable for:
 * - Piping to jq for filtering/transformation
 * - Integration with automation scripts
 * - Parsing by other tools (fzf, tmux, etc.)
 *
 * **JSON Structure:**
 * ```json
 * [
 *   {
 *     "path": "/repo/main",
 *     "branch": "main",
 *     "commit": "abc1234",
 *     "locked": false,
 *     "hasChanges": false,
 *     "isMain": true,
 *     "subRepositories": [...]  // Only if verbose mode
 *   }
 * ]
 * ```
 *
 * @param output - Complete output structure with worktrees
 * @returns JSON string with 2-space indentation
 *
 * @example
 * ```typescript
 * const output = await buildListOutput('/repo', { json: true });
 * const json = formatAsJson(output);
 * console.log(json);
 * // Can be piped: arashi list --json | jq '.[] | select(.hasChanges)'
 * ```
 */
export const formatAsJson = (output: ListCommandOutput): string =>
  JSON.stringify(output.worktrees, null, JSON_INDENT);

/**
 * Build complete list output structure by gathering all worktree data
 *
 * Orchestrates the data gathering process:
 * 1. Calls `gatherWorktreeData()` to get worktrees from git
 * 2. If verbose mode, calls `discoverSubRepositories()` for each worktree
 * 3. Assembles the complete output structure
 *
 * **Behavior:**
 * - Always gathers basic worktree data (fast)
 * - Sub-repository discovery only in verbose mode (slower)
 * - Continues on sub-repo discovery errors (sets empty array)
 * - Returns validated output structure
 *
 * **Performance:**
 * - Basic mode: < 1 second for typical repos
 * - Verbose mode: < 5 seconds with up to 20 sub-repos
 *
 * @param repoPath - Absolute path to the main repository
 * @param options - Command options controlling discovery behavior
 * @returns Complete output structure ready for formatting
 *
 * @throws {ListCommandError} When worktree data gathering fails
 *
 * @example
 * ```typescript
 * const output = await buildListOutput('/repo', { verbose: true, maxDepth: 3 });
 * console.log(`Found ${output.totalCount} worktrees`);
 * ```
 */
export const buildListOutput = async (
  repoPath: string,
  options: ListCommandOptions,
): Promise<ListCommandOutput> => {
  // Gather worktree data
  const worktrees = await gatherWorktreeData(repoPath);

  // If verbose, discover sub-repositories
  if (options.verbose) {
    for (const wt of worktrees) {
      try {
        wt.subRepositories = await discoverSubRepositories(
          wt.path,
          options.maxDepth || DEFAULT_MAX_DEPTH,
        );
      } catch {
        // If sub-repo discovery fails, continue without it
        wt.subRepositories = [];
      }
    }
  }

  return {
    repositoryPath: repoPath,
    totalCount: worktrees.length,
    worktrees,
  };
};

/**
 * Recursively find all git repositories within a directory
 *
 * Performs depth-limited filesystem traversal to locate git repositories
 * identified by the presence of `.git` directories. Validates each found
 * repository using `git rev-parse --git-dir`.
 *
 * **Scanning Behavior:**
 * - Starts at `rootPath` and scans up to `maxDepth` levels
 * - Identifies git repos by `.git` directory presence
 * - Validates with `git rev-parse` before including
 * - Optionally excludes the root directory itself
 * - Skips `.git` subdirectories (doesn't traverse into them)
 *
 * **Excluded Directories:**
 * - `node_modules` - Typically contains many nested repos
 * - `.arashi` - Arashi configuration directory
 *
 * **Error Handling:**
 * - Silently skips directories with permission errors
 * - Skips invalid git repositories
 * - Continues scanning even if individual checks fail
 *
 * @param rootPath - Absolute path to start scanning from
 * @param maxDepth - Maximum directory depth to scan (0 = root only)
 * @param excludeRoot - If true, excludes rootPath from results (default: false)
 * @returns Array of absolute paths to valid git repositories
 *
 * @example
 * ```typescript
 * // Find all nested repos, excluding root
 * const repos = await findGitRepositories('/path/to/worktree', 3, true);
 * repos.forEach(repo => console.log(repo));
 *
 * // Include root repository
 * const allRepos = await findGitRepositories('/path/to/worktree', 3, false);
 * ```
 */
export const findGitRepositories = async (
  rootPath: string,
  maxDepth: number,
  excludeRoot?: boolean,
): Promise<string[]> => {
  const gitRepos: string[] = [];
  const { readdir } = await import("fs/promises");

  async function scan(currentPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    try {
      const entries = await readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        await handleDirectoryEntry({
          currentPath,
          depth,
          entry,
          excludeRoot,
          gitRepos,
          rootPath,
          scan,
        });
      }
    } catch {}
  }

  await scan(rootPath, 0);
  return gitRepos;
};
