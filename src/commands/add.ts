import { runtime } from "../lib/runtime.ts";
/**
 * Add Command
 *
 * Adds a Git repository to the Arashi workspace by cloning it into the repos directory,
 * detecting repository metadata (default branch, setup scripts), and updating the
 * workspace configuration file.
 *
 * @module commands/add
 */

import { AddCommandError, AddCommandErrorCode, ArashiError } from "../lib/errors.ts";
import { basename, dirname, join, relative, resolve } from "path";
import { randomUUID } from "node:crypto";
import { clone, exec as gitExec, getDefaultBranch } from "../lib/git.ts";
import {
  configExists,
  getConfigPath,
  loadConfig,
  saveConfig,
  serializeConfig,
} from "../lib/config.ts";
import {
  findConfiguredWorkspaceRoots,
  throwIfStandaloneWorkspace,
} from "../lib/workspace-context.ts";
import { info, error as logError, spinner, success } from "../lib/logger.ts";
import { Command } from "commander";
import { executeClone } from "./clone.ts";
import { confirm as promptConfirm } from "../lib/prompts.ts";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  reconcileRepositoryManagedIgnore,
  classifyManagedPaths,
  restoreManagedIgnore,
  verifyManagedIgnoreRestored,
  inspectRepositoryManagedIgnore,
  type ManagedIgnoreReconciliation,
} from "../lib/managed-ignore.ts";
import { DEFAULT_WORKTREES_DIR } from "../lib/worktree-location.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { resolveGitMainWorktree } from "../lib/workspace-context.ts";

type RepoConfig = Awaited<ReturnType<typeof loadConfig>>["repos"][string];
type WorkspaceRoots = Awaited<ReturnType<typeof findConfiguredWorkspaceRoots>>;

const ZERO = 0;
const ERROR_EXIT_CODE = 1;
const CANCELLED_EXIT_CODE = 2;

const detectDefaultBranchOrThrow = async (clonePath: string, gitUrl: string): Promise<string> => {
  try {
    return await getDefaultBranch(clonePath);
  } catch {
    throw new AddCommandError(
      "Unable to detect default branch: repository has no remote branches",
      AddCommandErrorCode.BRANCH_DETECTION_FAILED,
      { repositoryPath: clonePath, url: gitUrl },
    );
  }
};

const hasMakefileSetupTarget = async (file: { text(): Promise<string> }): Promise<boolean> => {
  try {
    const content = await file.text();
    return /^(setup|install):/m.test(content);
  } catch {
    return false;
  }
};

const maybeRunCloneFallback = async (
  error: AddCommandError,
  workspaceRoots: WorkspaceRoots,
): Promise<void> => {
  if (
    error.code !== AddCommandErrorCode.DUPLICATE_NAME ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    return;
  }

  const fallback = await promptConfirm(
    "Repository is already configured. Run `arashi clone` now?",
    true,
  );
  if (fallback.status === "ok" && fallback.value) {
    const cloneResult = await executeClone({}, { workspaceRoots });
    if (cloneResult.status === "cancelled") {
      process.exit(ZERO);
    }

    process.exit(cloneResult.failed.length > ZERO ? ERROR_EXIT_CODE : ZERO);
  }
};

const getLastPathSegment = (pathParts: string[]): string => {
  const filteredParts = pathParts.filter((part) => part.length > ZERO);
  const lastPart = filteredParts.at(-1);
  if (!lastPart) {
    throw new Error("Unable to determine repository name from path");
  }

  return lastPart;
};

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Git URL information parsed from a repository URL
 */
export interface GitUrlInfo {
  /** Original URL string */
  url: string;
  /** Detected protocol */
  protocol: "https" | "ssh" | "git" | "file" | "scp";
  /** Git host domain (null for file:// URLs) */
  host: string | null;
  /** Repository owner or organization */
  owner: string | null;
  /** Repository name (without .git suffix) */
  repository: string;
  /** Auto-derived repository name (suitable for use as config key) */
  derivedName: string;
}

/**
 * Command-line options for the add command
 */
export interface AddCommandOptions {
  /** Custom repository name (overrides auto-derived name) */
  name?: string;
  /** Whether to create setup.sh template if no setup script found */
  createSetup?: boolean;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Output result as JSON instead of human-readable format */
  json?: boolean;
}

export const shouldTreatFailedCloneAsMaterialized = (destinationExists: boolean): boolean =>
  destinationExists;

/**
 * Result of add operation
 */
export interface AddCommandResult {
  /** Name of the added repository */
  repositoryName: string;
  /** Absolute filesystem path where repository was cloned */
  clonePath: string;
  /** Config-relative repository path. */
  path: string;
  materialization: "clone" | "coordinated-worktree";
  canonicalPath: string;
  worktreePath: string | null;
  coordinatedBranch: string | null;
  /** Detected default branch name */
  defaultBranch: string;
  /** Path to detected or created setup script (null if none) */
  setupScript: string | null;
  /** Whether a new setup script was created */
  setupScriptCreated: boolean;
  /** Original Git URL that was cloned */
  gitUrl: string;
  /** Managed ignore reconciliation retained for the materialized repository. */
  managedIgnore: ManagedIgnoreReconciliation;
}

/**
 * Operation metadata for rollback mechanism
 */
export type AddRollbackFailurePhase =
  | "worktree-remove"
  | "branch-delete"
  | "clone-remove"
  | "config-restore"
  | "managed-ignore-restore"
  | "final-state-observe";

export interface AddRollbackDetails {
  complete: boolean;
  failures: Array<{ message: string; phase: AddRollbackFailurePhase }>;
  finalState: {
    canonical: { exists: boolean | null; path: string };
    worktree: { exists: boolean | null; metadataPresent: boolean | null; path: string } | null;
    coordinatedBranch: {
      createdByInvocation: boolean;
      exists: boolean | null;
      name: string;
    } | null;
    configEntryPresent: boolean | null;
    configRestored: boolean | null;
    managedIgnore: { changed: boolean; restored: boolean | null };
  };
}

export interface AddExecutionDependencies {
  afterConfigLoad?: () => Promise<void>;
  afterConfigPersist?: () => Promise<void>;
  afterIgnoreReconcile?: () => Promise<void>;
  cloneRepository?: typeof clone;
  createCoordinatedBranch?: (
    canonicalPath: string,
    branch: string,
    startPoint: string,
    track: boolean,
  ) => Promise<void>;
  createWorktree?: (canonicalPath: string, worktreePath: string, branch: string) => Promise<void>;
  deleteBranch?: (canonicalPath: string, branch: string) => Promise<void>;
  isEffectivelyIgnored?: (workspaceRoot: string, path: string) => Promise<boolean>;
  observePath?: (path: string) => Promise<boolean>;
  observeWorktreeMetadata?: (canonicalPath: string, worktreePath: string) => Promise<boolean>;
  removeCanonicalClone?: (path: string) => Promise<void>;
  removeWorktree?: (canonicalPath: string, worktreePath: string) => Promise<void>;
  resolveMainWorktree?: (path: string) => Promise<string | null>;
  readConfigBytes?: (path: string) => Promise<Uint8Array>;
  refExists?: (canonicalPath: string, ref: string) => Promise<boolean>;
  restoreConfigBytes?: (path: string, bytes: Uint8Array) => Promise<void>;
  restoreIgnore?: typeof restoreManagedIgnore;
  verifyIgnoreRestored?: typeof verifyManagedIgnoreRestored;
  transactionLockHeld?: boolean;
}

const CONFIG_LOCK_RETRY_COUNT = 2_000;
const CONFIG_LOCK_RETRY_DELAY_MS = 20;
const INCOMPLETE_LOCK_STALE_MS = 30_000;
const TRANSACTION_LOCK_RETRY_COUNT = 90_000;

interface LockOwner {
  pid: number;
  token: string;
}

const readLockOwner = async (lockPath: string): Promise<LockOwner | null> => {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(owner.pid) && typeof owner.token === "string"
      ? { pid: owner.pid as number, token: owner.token }
      : null;
  } catch {
    return null;
  }
};

const lockOwnerIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const reclaimAbandonedLock = async (lockPath: string): Promise<boolean> => {
  let lockStat: Awaited<ReturnType<typeof stat>>;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const legacyClaimPath = `${lockPath}.reclaim-${lockStat.dev}-${lockStat.ino}`;
  const claimPrefix = `${legacyClaimPath}-`;
  const claimPath = `${claimPrefix}${process.pid}-${randomUUID()}`;
  try {
    await link(lockPath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  try {
    const claimedStat = await stat(claimPath);
    const currentStat = await stat(lockPath).catch(() => null);
    if (
      !currentStat ||
      claimedStat.dev !== currentStat.dev ||
      claimedStat.ino !== currentStat.ino
    ) {
      return true;
    }
    const claimDirectory = dirname(lockPath);
    const claimNamePrefix = basename(claimPrefix);
    const liveClaims: string[] = [];
    for (const name of await readdir(claimDirectory)) {
      if (!name.startsWith(claimNamePrefix)) continue;
      const pid = Number(name.slice(claimNamePrefix.length).split("-", 1)[0]);
      const contenderPath = join(claimDirectory, name);
      if (!Number.isInteger(pid) || !lockOwnerIsAlive(pid)) {
        await rm(contenderPath, { force: true });
        continue;
      }
      liveClaims.push(name);
    }
    if (liveClaims.some((name) => name !== basename(claimPath))) return false;
    const owner = await readLockOwner(claimPath);
    if (owner && lockOwnerIsAlive(owner.pid)) return false;
    if (!owner && Date.now() - claimedStat.mtimeMs < INCOMPLETE_LOCK_STALE_MS) return false;
    const finalCurrentStat = await stat(lockPath).catch(() => null);
    if (
      !finalCurrentStat ||
      claimedStat.dev !== finalCurrentStat.dev ||
      claimedStat.ino !== finalCurrentStat.ino
    ) {
      return true;
    }
    await rm(lockPath);
    await rm(legacyClaimPath, { force: true });
    return true;
  } finally {
    await rm(claimPath, { force: true });
  }
};

const withFileLock = async <T>(
  lockPath: string,
  retryCount: number,
  operation: () => Promise<T>,
): Promise<T> => {
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    try {
      const candidate = await open(lockPath, "wx");
      try {
        await candidate.writeFile(JSON.stringify(owner));
        await candidate.sync();
        lock = candidate;
      } catch (error) {
        await candidate.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimAbandonedLock(lockPath)) continue;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, CONFIG_LOCK_RETRY_DELAY_MS));
    }
  }
  if (!lock) throw new Error(`Timed out waiting for configuration lock: ${lockPath}`);
  try {
    return await operation();
  } finally {
    await lock.close();
    const currentOwner = await readLockOwner(lockPath);
    if (currentOwner?.token === owner.token) await rm(lockPath, { force: true });
  }
};

const withConfigLock = <T>(configPath: string, operation: () => Promise<T>): Promise<T> =>
  withFileLock(
    join(dirname(dirname(configPath)), ".arashi-config.add.lock"),
    CONFIG_LOCK_RETRY_COUNT,
    operation,
  );

const withAddTransactionLock = <T>(lockPath: string, operation: () => Promise<T>): Promise<T> =>
  withFileLock(lockPath, TRANSACTION_LOCK_RETRY_COUNT, operation);

const resolveAddTransactionLockPath = async (workspaceRoot: string): Promise<string> => {
  try {
    const result = await gitExec(["rev-parse", "--git-common-dir"], workspaceRoot);
    const commonDirectory = result.stdout.trim();
    if (!commonDirectory) throw new Error("Git returned an empty common directory.");
    const absoluteCommonDirectory = resolve(workspaceRoot, commonDirectory);
    return join(await realpath(absoluteCommonDirectory), ".arashi-add.transaction.lock");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("not a git repository")) throw error;
    return join(await realpath(workspaceRoot), ".arashi-add.transaction.lock");
  }
};

// ============================================================================
// URL Validation and Parsing
// ============================================================================

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const SCP_GIT_URL = /^(?:([^@\s/:]+)@)?([^@\s/:]+):([^\s]+)$/;
const SSH_GIT_URL = /^ssh:\/\/(?:([^@\s/]+)@)?((?:\[[^\]\s]+\]|[^@\s/:]+)(?::[0-9]+)?)\/([^\s]+)$/;

const parseScpGitUrl = (url: string): RegExpMatchArray | null => {
  if (WINDOWS_DRIVE_PATH.test(url) || url.includes("://")) return null;
  const colonIndex = url.indexOf(":");
  if (colonIndex <= ZERO || url.slice(0, colonIndex).includes("/")) return null;
  return url.match(SCP_GIT_URL);
};

/**
 * Git URL validation patterns for different protocols
 */
const GIT_URL_PATTERNS = {
  file: /^(file:\/\/)?\/[^/].+/,
  git: /^git:\/\/[^/]+\/.+/,
  https: /^https:\/\/[^/]+\/.+/,
  ssh: SSH_GIT_URL,
};

/**
 * Validate if a string is a valid Git URL
 *
 * @param url - URL string to validate
 * @returns true if URL matches one of the supported formats
 *
 * @example
 * isValidGitUrl('https://github.com/user/repo.git') // true
 * isValidGitUrl('invalid-url') // false
 */
export function isValidGitUrl(url: string): boolean {
  if (!url || typeof url !== "string" || url.trim() === "") {
    return false;
  }

  const trimmedUrl = url.trim();
  return (
    Object.values(GIT_URL_PATTERNS).some((pattern) => pattern.test(trimmedUrl)) ||
    parseScpGitUrl(trimmedUrl) !== null
  );
}

/**
 * Derive repository name from a Git URL
 *
 * Extracts the last path segment from the URL and removes the .git suffix.
 * Validates that the name contains only safe characters.
 *
 * @param gitUrl - Git repository URL
 * @returns Derived repository name
 * @throws {Error} If unable to derive a valid name
 *
 * @example
 * deriveRepoName('https://github.com/user/my-repo.git') // 'my-repo'
 * deriveRepoName('git@github.com:user/project') // 'project'
 */
export function deriveRepoName(gitUrl: string): string {
  // Remove trailing slashes and .git suffix
  const url = gitUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  // Extract last path segment
  const parts = url.split(/[/:]/);
  const name = getLastPathSegment(parts);

  // Validate name contains safe characters
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid repository name derived from URL: ${name}`);
  }

  return name;
}

/**
 * Parse a Git URL and extract structured information
 *
 * @param gitUrl - Git repository URL to parse
 * @returns Parsed URL information
 * @throws {AddCommandError} If URL is invalid
 *
 * @example
 * const info = parseGitUrl('https://github.com/facebook/react.git');
 * // { protocol: 'https', host: 'github.com', owner: 'facebook', repository: 'react', ... }
 */
export function parseGitUrl(gitUrl: string): GitUrlInfo {
  if (!isValidGitUrl(gitUrl)) {
    throw new AddCommandError(
      `The URL "${gitUrl}" is not a valid Git repository URL`,
      AddCommandErrorCode.INVALID_URL,
      { url: gitUrl },
    );
  }

  const trimmedUrl = gitUrl.trim();
  let protocol: GitUrlInfo["protocol"] = "scp";
  let host: string | null = null;
  let owner: string | null = null;
  let repository = deriveRepoName(trimmedUrl);

  // Determine protocol
  if (GIT_URL_PATTERNS.https.test(trimmedUrl)) {
    protocol = "https";
    const match = trimmedUrl.match(/^https:\/\/([^/]+)\/(.+)/);
    if (match) {
      const [, matchedHost, matchedPath] = match;
      host = matchedHost;
      const path = matchedPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
      const pathParts = path.split("/");
      if (pathParts.length >= 2) owner = pathParts[0];
      repository = getLastPathSegment(pathParts);
    }
  } else {
    const sshMatch = trimmedUrl.match(SSH_GIT_URL) ?? parseScpGitUrl(trimmedUrl);
    if (sshMatch) {
      protocol = "ssh";
      const [, _gitUser, matchedHost, matchedPath] = sshMatch;
      host = matchedHost;
      const path = matchedPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
      const pathParts = path.split("/").filter(Boolean);
      if (pathParts.length >= 2) owner = pathParts[0];
      repository = getLastPathSegment(pathParts);
    } else if (GIT_URL_PATTERNS.git.test(trimmedUrl)) {
      protocol = "git";
      const match = trimmedUrl.match(/^git:\/\/([^/]+)\/(.+)/);
      if (match) {
        const [, matchedHost, matchedPath] = match;
        host = matchedHost;
        const path = matchedPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
        const pathParts = path.split("/");
        if (pathParts.length >= 2) owner = pathParts[0];
        repository = getLastPathSegment(pathParts);
      }
    } else if (GIT_URL_PATTERNS.file.test(trimmedUrl)) {
      protocol = "file";
      const path = trimmedUrl
        .replace(/^file:\/\//, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "");
      repository = basename(path);
    }
  }

  const derivedName = deriveRepoName(trimmedUrl);

  return {
    derivedName,
    host,
    owner,
    protocol,
    repository,
    url: trimmedUrl,
  };
}

// ============================================================================
// Setup Script Detection
// ============================================================================

/**
 * Common setup script filenames to detect (in priority order)
 */
const SETUP_SCRIPT_NAMES = [
  "setup.sh",
  "setup.bash",
  "install.sh",
  "bootstrap.sh",
  "setup.ps1",
  "setup.bat",
  "setup.py",
  "setup.rb",
  "Makefile",
];

/**
 * Detect setup script in a repository
 *
 * Checks for common setup script patterns in the repository root.
 * For Makefiles, verifies that a 'setup' or 'install' target exists.
 *
 * @param repoPath - Path to the repository
 * @returns Path to detected setup script, or null if none found
 *
 * @example
 * const setupScript = await detectSetupScript('/path/to/repo');
 * if (setupScript) {
 *   console.log(`Found setup script: ${setupScript}`);
 * }
 */
export async function detectSetupScript(repoPath: string): Promise<string | null> {
  for (const scriptName of SETUP_SCRIPT_NAMES) {
    const scriptPath = join(repoPath, scriptName);
    const file = runtime.file(scriptPath);

    if (await file.exists()) {
      // For Makefile, verify it has setup/install target
      if (scriptName === "Makefile") {
        if (await hasMakefileSetupTarget(file)) {
          return scriptPath;
        }
      } else {
        return scriptPath;
      }
    }
  }

  return null;
}

// ============================================================================
// Add Command Implementation
// ============================================================================

/**
 * Execute the add command
 *
 * @param gitUrl - Git repository URL to add
 * @param options - Command options
 * @param workspaceRoot - Root directory of the workspace
 * @returns Result of add operation
 */
const pathExists = async (path: string): Promise<boolean> => runtime.file(path).exists();

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const gitRefExists = async (repositoryPath: string, ref: string): Promise<boolean> => {
  try {
    await gitExec(["show-ref", "--verify", "--quiet", ref], repositoryPath);
    return true;
  } catch (error) {
    if (error instanceof ArashiError && error.context.exitCode === 1) return false;
    throw error;
  }
};

const gitPathIsEffectivelyIgnored = async (
  workspaceRoot: string,
  path: string,
): Promise<boolean> => {
  try {
    await gitExec(["check-ignore", "--no-index", "--", path], workspaceRoot);
    return true;
  } catch (error) {
    if (error instanceof ArashiError && error.context.exitCode === 1) return false;
    throw error;
  }
};

const resolveSymbolicBranch = async (workspaceRoot: string): Promise<string | null> => {
  try {
    const result = await gitExec(["symbolic-ref", "--quiet", "--short", "HEAD"], workspaceRoot);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
};

const hasWorktreeMetadata = async (
  canonicalPath: string,
  worktreePath: string,
): Promise<boolean> => {
  const listing = await gitExec(
    ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
    canonicalPath,
  );
  const target = resolve(worktreePath);
  return listing.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some((line) => resolve(line.slice("worktree ".length)) === target);
};

const findWorktreeForBranch = async (
  canonicalPath: string,
  branch: string,
): Promise<string | null> => {
  const listing = await gitExec(
    ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
    canonicalPath,
  );
  for (const block of listing.stdout.trim().split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.includes(`branch refs/heads/${branch}`)) {
      const pathLine = lines.find((line) => line.startsWith("worktree "));
      if (pathLine) return resolve(pathLine.slice("worktree ".length));
    }
  }
  return null;
};

const addFailure = (
  message: string,
  code: AddCommandErrorCode,
  phase: "preflight" | "clone" | "branch" | "worktree" | "config",
  context: Record<string, unknown> = {},
): AddCommandError => new AddCommandError(message, code, { ...context, phase });

export const executeAdd = async (
  gitUrl: string,
  options: AddCommandOptions,
  workspaceRoots: WorkspaceRoots,
  dependencies: AddExecutionDependencies = {},
): Promise<AddCommandResult> => {
  const workspaceRoot = workspaceRoots.configurationRoot;
  if (!dependencies.transactionLockHeld) {
    const transactionLockPath = await resolveAddTransactionLockPath(workspaceRoot);
    return withAddTransactionLock(transactionLockPath, () =>
      executeAdd(gitUrl, options, workspaceRoots, {
        ...dependencies,
        transactionLockHeld: true,
      }),
    );
  }
  const cloneRepository = dependencies.cloneRepository ?? clone;
  const createCoordinatedBranch =
    dependencies.createCoordinatedBranch ??
    (async (repositoryPath: string, branch: string, startPoint: string, track: boolean) => {
      await gitExec(
        track ? ["branch", "--track", branch, startPoint] : ["branch", branch, startPoint],
        repositoryPath,
      );
    });
  const createWorktree =
    dependencies.createWorktree ??
    (async (repositoryPath: string, worktreePath: string, branch: string) => {
      await gitExec(["worktree", "add", worktreePath, branch], repositoryPath);
    });
  const refExists = dependencies.refExists ?? gitRefExists;
  const isEffectivelyIgnored = dependencies.isEffectivelyIgnored ?? gitPathIsEffectivelyIgnored;
  const observePath = dependencies.observePath ?? pathExists;
  const observeWorktreeMetadata = dependencies.observeWorktreeMetadata ?? hasWorktreeMetadata;
  const afterConfigLoad = dependencies.afterConfigLoad;
  const afterConfigPersist = dependencies.afterConfigPersist;
  const afterIgnoreReconcile = dependencies.afterIgnoreReconcile;
  const resolveMainWorktree =
    dependencies.resolveMainWorktree ??
    ((path: string) => resolveGitMainWorktree(path, { strict: true }));
  const readConfigBytes = dependencies.readConfigBytes ?? readFile;
  const restoreIgnore = dependencies.restoreIgnore ?? restoreManagedIgnore;
  const verifyIgnoreRestored = dependencies.verifyIgnoreRestored ?? verifyManagedIgnoreRestored;
  const removeWorktree =
    dependencies.removeWorktree ??
    (async (repositoryPath: string, path: string) => {
      await gitExec(["worktree", "remove", "--force", path], repositoryPath);
    });
  const deleteBranch =
    dependencies.deleteBranch ??
    (async (repositoryPath: string, branch: string) => {
      await gitExec(["branch", "-D", branch], repositoryPath);
    });
  const removeCanonicalClone =
    dependencies.removeCanonicalClone ??
    (async (path: string) => rm(path, { force: true, recursive: true }));
  const restoreConfigBytes = dependencies.restoreConfigBytes ?? writeFile;
  const executionRoot = workspaceRoots.executionRoot;
  let canonicalPath = "";
  let activePath: string | null = null;
  let coordinatedBranch: string | null = null;
  let repositoryName = "";
  let configWriteAttempted = false;
  let cloneCreated = false;
  let branchCreated = false;
  let preExistingCoordinatedBranch = false;
  let worktreeCreated = false;
  let worktreeCreationAttempted = false;
  let setupScriptCreated = false;
  let originalConfigBytes: Uint8Array | null = null;
  let persistedConfigBytes: Uint8Array | null = null;
  let currentPhase: "preflight" | "clone" | "branch" | "worktree" | "config" = "preflight";
  let managedIgnore: ManagedIgnoreReconciliation | undefined = undefined;
  const startSpinner = (text: string) => (options.json ? undefined : spinner(text).start());
  const inspectEffectiveIgnore = async (root: string, path: string): Promise<boolean> => {
    try {
      return await isEffectivelyIgnored(root, path);
    } catch (error) {
      throw addFailure(
        `Failed to inspect managed-ignore coverage for '${path}': ${(error as Error).message}`,
        AddCommandErrorCode.CONFIG_UPDATE_FAILED,
        "preflight",
        { error: (error as Error).message, path, workspaceRoot: root },
      );
    }
  };

  try {
    // Step 1: Validate workspace is initialized
    const hasConfig = await configExists(workspaceRoot);
    if (!hasConfig) {
      await throwIfStandaloneWorkspace("add", workspaceRoot);
      throw new AddCommandError(
        'Workspace not initialized. Run "arashi init" first.',
        AddCommandErrorCode.CONFIG_UPDATE_FAILED,
        { configPath: getConfigPath(workspaceRoot) },
      );
    }

    // Step 2: Parse and validate Git URL
    const s1 = startSpinner("Validating Git URL...");
    const urlInfo = parseGitUrl(gitUrl);
    gitUrl = urlInfo.url;
    s1?.succeed("Git URL validated");

    // Step 3: Determine repository name
    repositoryName = options.name || urlInfo.derivedName;

    // Step 4: Check for duplicate name
    const configPath = getConfigPath(workspaceRoot);
    const configSnapshot = await withConfigLock(configPath, async () => {
      const loadedConfig = await loadConfig(workspaceRoot);
      const bytesAfterLoad = await readFile(configPath);
      await afterConfigLoad?.();
      const bytesAfterHook = await readFile(configPath);
      if (!bytesEqual(bytesAfterLoad, bytesAfterHook)) {
        throw addFailure(
          "Configuration changed while add was loading it; preserved the newer file.",
          AddCommandErrorCode.CONFIG_UPDATE_FAILED,
          "preflight",
        );
      }
      return { bytes: bytesAfterLoad, config: loadedConfig };
    });
    const config = configSnapshot.config;
    originalConfigBytes = configSnapshot.bytes;
    if (config.repos[repositoryName]) {
      throw new AddCommandError(
        `Repository name "${repositoryName}" already exists at ${config.repos[repositoryName].path}`,
        AddCommandErrorCode.DUPLICATE_NAME,
        {
          existingPath: config.repos[repositoryName].path,
          gitUrl,
          name: repositoryName,
        },
      );
    }

    // Step 5: Prepare clone destination
    const configuredRepositoryPath = join(config.reposDir, repositoryName);
    const executionRootReal = await realpath(executionRoot);
    let resolvedMainRoot: string | null;
    try {
      resolvedMainRoot = await resolveMainWorktree(executionRootReal);
    } catch (error) {
      throw addFailure(
        `Failed to inspect parent Git worktree topology: ${(error as Error).message}`,
        AddCommandErrorCode.CLONE_FAILED,
        "preflight",
        { error: (error as Error).message, executionRoot: executionRootReal },
      );
    }
    const topologyCanonicalRoot = resolvedMainRoot
      ? await realpath(resolvedMainRoot)
      : await realpath(workspaceRoot);
    const repositoryPathIsSafe = classifyManagedPaths([config.reposDir])[0]?.safety === "safe";
    const coordinated =
      resolvedMainRoot !== null &&
      topologyCanonicalRoot !== executionRootReal &&
      repositoryPathIsSafe;
    const canonicalRoot = repositoryPathIsSafe ? topologyCanonicalRoot : executionRootReal;
    canonicalPath = resolve(canonicalRoot, configuredRepositoryPath);
    activePath = coordinated ? resolve(executionRootReal, configuredRepositoryPath) : null;

    if (coordinated) {
      coordinatedBranch = await resolveSymbolicBranch(executionRootReal);
      if (!coordinatedBranch) {
        throw addFailure(
          "Cannot coordinate add from a detached parent HEAD. Check out a named parent branch and retry.",
          AddCommandErrorCode.BRANCH_DETECTION_FAILED,
          "preflight",
          { executionRoot: executionRootReal },
        );
      }
    }
    if (await observePath(canonicalPath)) {
      throw addFailure(
        `Canonical repository destination already exists: ${canonicalPath}`,
        AddCommandErrorCode.CLONE_FAILED,
        "preflight",
        { canonicalPath },
      );
    }
    if (activePath && (await observePath(activePath))) {
      throw addFailure(
        `Active worktree destination already exists: ${activePath}`,
        AddCommandErrorCode.CLONE_FAILED,
        "preflight",
        { worktreePath: activePath },
      );
    }

    if (coordinated) {
      const inspection = await inspectRepositoryManagedIgnore({
        reposDir: config.reposDir,
        workspaceRoot,
        worktreesDir: config.worktreesDir ?? DEFAULT_WORKTREES_DIR,
      });
      if (
        inspection.scope === "tracked" &&
        !(await inspectEffectiveIgnore(canonicalRoot, configuredRepositoryPath))
      ) {
        throw addFailure(
          "Tracked managed-ignore scope cannot protect the canonical destination from this linked checkout. Reconcile and commit the managed repository rule on the branch checked out in the canonical parent checkout first.",
          AddCommandErrorCode.CONFIG_UPDATE_FAILED,
          "preflight",
          { canonicalPath, managedIgnoreScope: inspection.scope },
        );
      }
    }

    managedIgnore = await reconcileRepositoryManagedIgnore({
      reposDir: config.reposDir,
      workspaceRoot,
      worktreesDir: config.worktreesDir ?? DEFAULT_WORKTREES_DIR,
    });
    if (coordinated && managedIgnore.scope !== "none") {
      const canonicalCovered = await inspectEffectiveIgnore(
        canonicalRoot,
        configuredRepositoryPath,
      );
      const activeCovered = await inspectEffectiveIgnore(
        executionRootReal,
        configuredRepositoryPath,
      );
      if (!canonicalCovered || !activeCovered) {
        throw addFailure(
          "Managed-ignore reconciliation did not cover both canonical and active repository destinations.",
          AddCommandErrorCode.CONFIG_UPDATE_FAILED,
          "preflight",
          { activeCovered, canonicalCovered },
        );
      }
    } else if (coordinated && managedIgnore.scope === "none") {
      for (const [role, root, destination] of [
        ["canonical", canonicalRoot, canonicalPath],
        ["active", executionRootReal, activePath as string],
      ] as const) {
        if (!(await inspectEffectiveIgnore(root, relative(root, destination)))) {
          managedIgnore.warnings.push(
            `${role} destination '${destination}' remains unignored because scope is none.`,
          );
        }
      }
    }
    if (!options.json) {
      for (const warning of managedIgnore.warnings) {
        info(`Warning: ${warning}`);
      }
    }
    await afterIgnoreReconcile?.();

    // Step 6: Atomically reserve the destination, then clone into the invocation-owned directory.
    currentPhase = "clone";
    const s2 = startSpinner(`Cloning repository from ${gitUrl}...`);
    try {
      await mkdir(join(canonicalPath, ".."), { recursive: true });
    } catch (error) {
      throw addFailure(
        `Failed to prepare the canonical repository parent: ${(error as Error).message}`,
        AddCommandErrorCode.CLONE_FAILED,
        "clone",
        { canonicalPath, error: (error as Error).message },
      );
    }
    try {
      await mkdir(canonicalPath);
      cloneCreated = true;
    } catch (error) {
      s2?.fail("Clone failed");
      throw addFailure(
        `Canonical repository destination could not be reserved: ${(error as Error).message}`,
        AddCommandErrorCode.CLONE_FAILED,
        "clone",
        { canonicalPath, error: (error as Error).message },
      );
    }
    try {
      await cloneRepository(gitUrl, canonicalPath);
      s2?.succeed("Repository cloned");
    } catch (error) {
      s2?.fail("Clone failed");
      throw addFailure(
        `Git clone operation failed: ${(error as Error).message}`,
        AddCommandErrorCode.CLONE_FAILED,
        "clone",
        { error: (error as Error).message, url: gitUrl },
      );
    }

    // Step 7: Detect default branch
    const s3 = startSpinner("Detecting default branch...");
    const defaultBranch = await detectDefaultBranchOrThrow(canonicalPath, gitUrl).catch((error) => {
      s3?.fail("Branch detection failed");
      if (error instanceof AddCommandError) {
        throw addFailure(error.message, error.code, "branch", error.context ?? {});
      }
      throw error;
    });
    s3?.succeed(`Detected default branch: ${defaultBranch}`);

    if (coordinated && activePath && coordinatedBranch) {
      currentPhase = "branch";
      if (coordinatedBranch === defaultBranch) {
        throw addFailure(
          `Coordinated branch '${coordinatedBranch}' conflicts with the child default branch checked out in the canonical clone.`,
          AddCommandErrorCode.BRANCH_DETECTION_FAILED,
          "branch",
          { coordinatedBranch, defaultBranch },
        );
      }
      let localBranchExists: boolean;
      let remoteBranchExists: boolean;
      try {
        localBranchExists = await refExists(canonicalPath, `refs/heads/${coordinatedBranch}`);
        remoteBranchExists = await refExists(
          canonicalPath,
          `refs/remotes/origin/${coordinatedBranch}`,
        );
      } catch (error) {
        throw addFailure(
          `Failed to inspect coordinated child refs for '${coordinatedBranch}': ${(error as Error).message}`,
          AddCommandErrorCode.BRANCH_DETECTION_FAILED,
          "branch",
          { coordinatedBranch, error: (error as Error).message },
        );
      }
      if (localBranchExists) {
        preExistingCoordinatedBranch = true;
        const conflictingWorktree = await findWorktreeForBranch(canonicalPath, coordinatedBranch);
        throw addFailure(
          `Child branch '${coordinatedBranch}' already exists; pre-existing local branch adoption is not supported.`,
          AddCommandErrorCode.BRANCH_DETECTION_FAILED,
          "branch",
          {
            coordinatedBranch,
            ...(conflictingWorktree ? { conflictingWorktree } : {}),
          },
        );
      }
      try {
        await createCoordinatedBranch(
          canonicalPath,
          coordinatedBranch,
          remoteBranchExists ? `origin/${coordinatedBranch}` : defaultBranch,
          remoteBranchExists,
        );
        branchCreated = true;
      } catch (error) {
        // Creation did not return successfully, so ownership is uncertain. A concurrent actor may
        // have created or checked out the branch; preserve the common-directory owner.
        preExistingCoordinatedBranch = true;
        throw addFailure(
          `Failed to create coordinated child branch '${coordinatedBranch}': ${(error as Error).message}`,
          AddCommandErrorCode.BRANCH_DETECTION_FAILED,
          "branch",
          { coordinatedBranch },
        );
      }
      currentPhase = "worktree";
      try {
        await mkdir(join(activePath, ".."), { recursive: true });
        worktreeCreationAttempted = true;
        await createWorktree(canonicalPath, activePath, coordinatedBranch);
        worktreeCreated = true;
      } catch (error) {
        throw addFailure(
          `Failed to create active child worktree: ${(error as Error).message}`,
          AddCommandErrorCode.CLONE_FAILED,
          "worktree",
          { coordinatedBranch, worktreePath: activePath },
        );
      }
    }

    // Step 8: Detect setup script
    const s4 = startSpinner("Checking for setup script...");
    const materializedRepositoryPath = activePath ?? canonicalPath;
    let setupScript = await detectSetupScript(materializedRepositoryPath);
    if (!setupScript && options.createSetup) {
      setupScript = join(materializedRepositoryPath, "setup.sh");
      await writeFile(
        setupScript,
        "#!/usr/bin/env bash\nset -euo pipefail\n\n# Add repository setup commands here.\n",
      );
      await chmod(setupScript, 0o755);
      setupScriptCreated = true;
    }
    if (setupScript) {
      s4?.succeed(
        setupScriptCreated
          ? "Created setup script: setup.sh"
          : `Found setup script: ${basename(setupScript)}`,
      );
    } else {
      s4?.info("No setup script found");
    }

    // Step 9: Update configuration
    currentPhase = "config";
    const s5 = startSpinner("Updating configuration...");
    try {
      const repoConfig: RepoConfig = {
        gitUrl: urlInfo.url,
        path: configuredRepositoryPath,
      };

      await withConfigLock(getConfigPath(workspaceRoot), async () => {
        const currentConfigBytes = await readFile(getConfigPath(workspaceRoot));
        if (!originalConfigBytes || !bytesEqual(currentConfigBytes, originalConfigBytes)) {
          throw new Error(
            "Configuration changed concurrently after add began; preserving the newer file.",
          );
        }
        config.repos[repositoryName] = repoConfig;
        persistedConfigBytes = new TextEncoder().encode(serializeConfig(config));
        configWriteAttempted = true;
        await saveConfig(workspaceRoot, config);
      });
      await afterConfigPersist?.();
      s5?.succeed("Configuration updated");
    } catch (error) {
      s5?.fail("Configuration update failed");
      throw addFailure(
        `Failed to update configuration file: ${(error as Error).message}`,
        AddCommandErrorCode.CONFIG_UPDATE_FAILED,
        "config",
        { configPath: getConfigPath(workspaceRoot), error: (error as Error).message },
      );
    }

    // Success!
    return {
      canonicalPath,
      clonePath: canonicalPath,
      coordinatedBranch,
      defaultBranch,
      gitUrl,
      managedIgnore,
      materialization: coordinated ? "coordinated-worktree" : "clone",
      path: configuredRepositoryPath,
      repositoryName,
      setupScript: setupScript ? join(configuredRepositoryPath, basename(setupScript)) : null,
      setupScriptCreated,
      worktreePath: activePath,
    };
  } catch (error) {
    const canonicalCreatedByInvocation = cloneCreated;
    const branchCreatedByInvocation = branchCreated;
    let branchSurvives = branchCreated;
    const managedIgnoreChangedByInvocation = managedIgnore?.changed ?? false;
    const failures: AddRollbackDetails["failures"] = [];
    const recordFailure = (phase: AddRollbackFailurePhase, cleanupError: unknown): void => {
      failures.push({
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        phase,
      });
    };
    let configRestoreFailed = false;
    if (configWriteAttempted && originalConfigBytes) {
      const configBytesBeforeAdd = originalConfigBytes;
      try {
        await withConfigLock(getConfigPath(workspaceRoot), async () => {
          const currentConfigBytes = await readConfigBytes(getConfigPath(workspaceRoot));
          if (bytesEqual(currentConfigBytes, configBytesBeforeAdd)) {
            // The failed write did not change the file, so the original snapshot already survives.
          } else if (persistedConfigBytes && bytesEqual(currentConfigBytes, persistedConfigBytes)) {
            await restoreConfigBytes(getConfigPath(workspaceRoot), configBytesBeforeAdd);
          } else if (persistedConfigBytes) {
            try {
              const currentConfig = JSON.parse(new TextDecoder().decode(currentConfigBytes)) as {
                repos?: Record<string, unknown>;
              };
              const persistedConfig = JSON.parse(
                new TextDecoder().decode(persistedConfigBytes),
              ) as {
                repos?: Record<string, unknown>;
              };
              const currentEntry = currentConfig.repos?.[repositoryName];
              const persistedEntry = persistedConfig.repos?.[repositoryName];
              const currentRecord =
                typeof currentEntry === "object" && currentEntry !== null
                  ? (currentEntry as Record<string, unknown>)
                  : null;
              const persistedRecord =
                typeof persistedEntry === "object" && persistedEntry !== null
                  ? (persistedEntry as Record<string, unknown>)
                  : null;
              if (
                currentRecord &&
                persistedRecord &&
                currentRecord.path === persistedRecord.path &&
                currentRecord.gitUrl === persistedRecord.gitUrl
              ) {
                delete currentConfig.repos?.[repositoryName];
                await restoreConfigBytes(
                  getConfigPath(workspaceRoot),
                  new TextEncoder().encode(JSON.stringify(currentConfig, null, 2)),
                );
              } else {
                throw new Error(
                  "Configuration changed concurrently during add; preserved the unowned newer bytes.",
                  { cause: error },
                );
              }
            } catch (cleanupError) {
              if (cleanupError instanceof SyntaxError) {
                await restoreConfigBytes(getConfigPath(workspaceRoot), configBytesBeforeAdd);
              } else {
                throw cleanupError;
              }
            }
          } else {
            configRestoreFailed = true;
            recordFailure(
              "config-restore",
              new Error(
                "Configuration changed concurrently during add; preserved the unowned newer bytes.",
              ),
            );
          }
        });
      } catch (cleanupError) {
        configRestoreFailed = true;
        recordFailure("config-restore", cleanupError);
      }
    }
    if (activePath && worktreeCreated) {
      try {
        await removeWorktree(canonicalPath, activePath);
      } catch (cleanupError) {
        recordFailure("worktree-remove", cleanupError);
      }
    }
    const observeFinalPath = async (path: string): Promise<boolean | null> => {
      try {
        return await observePath(path);
      } catch (observeError) {
        recordFailure("final-state-observe", observeError);
        return null;
      }
    };
    let worktreeExists: boolean | null = activePath ? await observeFinalPath(activePath) : null;
    let metadataPresent: boolean | null = activePath && !worktreeCreationAttempted ? false : null;
    if (activePath && worktreeCreationAttempted) {
      try {
        metadataPresent = await observeWorktreeMetadata(canonicalPath, activePath);
      } catch (observeError) {
        recordFailure("final-state-observe", observeError);
      }
    }
    const linkedStateDefinitelyAbsent =
      (!activePath || (worktreeExists === false && metadataPresent === false)) &&
      !preExistingCoordinatedBranch;
    if (branchCreated && coordinatedBranch && linkedStateDefinitelyAbsent) {
      try {
        await deleteBranch(canonicalPath, coordinatedBranch);
        branchSurvives = false;
      } catch (cleanupError) {
        recordFailure("branch-delete", cleanupError);
      }
    }
    if (cloneCreated && linkedStateDefinitelyAbsent && !branchSurvives) {
      try {
        await removeCanonicalClone(canonicalPath);
        cloneCreated = false;
      } catch (cleanupError) {
        recordFailure("clone-remove", cleanupError);
      }
    }
    let canonicalExists: boolean | null = canonicalPath
      ? await observeFinalPath(canonicalPath)
      : false;
    if (activePath) worktreeExists = await observeFinalPath(activePath);
    let configEntryPresent: boolean | null = false;
    try {
      if (repositoryName) {
        configEntryPresent = Boolean((await loadConfig(workspaceRoot)).repos[repositoryName]);
      }
    } catch (observeError) {
      configEntryPresent = null;
      recordFailure("final-state-observe", observeError);
    }
    const expectedConfigBytes = originalConfigBytes as Uint8Array | null;
    let configRestored: boolean | null = configWriteAttempted ? false : null;
    if (configWriteAttempted && expectedConfigBytes) {
      try {
        const finalConfigBytes = await readConfigBytes(getConfigPath(workspaceRoot));
        configRestored =
          finalConfigBytes.byteLength === expectedConfigBytes.byteLength &&
          finalConfigBytes.every((byte, index) => byte === expectedConfigBytes[index]);
        if (!configRestored && !configRestoreFailed) {
          recordFailure(
            "config-restore",
            new Error("Configuration bytes did not match the exact pre-command snapshot."),
          );
        }
      } catch (observeError) {
        configRestored = null;
        recordFailure("final-state-observe", observeError);
      }
    }
    const materializedStateSurvives =
      canonicalExists !== false ||
      worktreeExists === true ||
      (metadataPresent !== false && activePath !== null);
    let managedIgnoreRestored: boolean | null = managedIgnoreChangedByInvocation ? false : null;
    if (
      managedIgnore &&
      managedIgnoreChangedByInvocation &&
      !materializedStateSurvives &&
      configEntryPresent === false
    ) {
      try {
        await restoreIgnore(managedIgnore);
        managedIgnoreRestored = await verifyIgnoreRestored(managedIgnore);
        if (!managedIgnoreRestored) {
          recordFailure(
            "managed-ignore-restore",
            new Error("Managed-ignore state did not match its exact pre-command snapshot."),
          );
        }
      } catch (restoreError) {
        recordFailure("managed-ignore-restore", restoreError);
      }
    }
    let coordinatedBranchExists: boolean | null = null;
    if (coordinatedBranch) {
      if (canonicalExists === false) {
        coordinatedBranchExists = false;
      } else if (canonicalExists === true) {
        try {
          coordinatedBranchExists = await refExists(
            canonicalPath,
            `refs/heads/${coordinatedBranch}`,
          );
        } catch (observeError) {
          recordFailure("final-state-observe", observeError);
        }
      }
    }
    const invocationStateSurvives =
      (canonicalCreatedByInvocation && canonicalExists !== false) ||
      (branchCreatedByInvocation && coordinatedBranchExists !== false) ||
      (worktreeCreated && (worktreeExists !== false || metadataPresent !== false)) ||
      (managedIgnoreChangedByInvocation && managedIgnoreRestored !== true) ||
      (configWriteAttempted && (configEntryPresent !== false || configRestored !== true));
    const rollback: AddRollbackDetails = {
      complete: failures.length === 0 && !invocationStateSurvives,
      failures,
      finalState: {
        canonical: { exists: canonicalExists, path: canonicalPath },
        configEntryPresent,
        configRestored,
        coordinatedBranch: coordinatedBranch
          ? {
              createdByInvocation: branchCreatedByInvocation,
              exists: coordinatedBranchExists,
              name: coordinatedBranch,
            }
          : null,
        managedIgnore: {
          changed: managedIgnoreChangedByInvocation,
          restored: managedIgnoreRestored,
        },
        worktree: activePath ? { exists: worktreeExists, metadataPresent, path: activePath } : null,
      },
    };
    if (error instanceof AddCommandError) {
      throw new AddCommandError(error.message, error.code, {
        ...error.context,
        rollback,
      });
    }
    const fallbackCode =
      currentPhase === "config"
        ? AddCommandErrorCode.CONFIG_UPDATE_FAILED
        : currentPhase === "branch"
          ? AddCommandErrorCode.BRANCH_DETECTION_FAILED
          : AddCommandErrorCode.CLONE_FAILED;
    throw new AddCommandError(
      error instanceof Error ? error.message : String(error),
      fallbackCode,
      { phase: currentPhase, rollback },
    );
  }
};

/**
 * Display success message in human-readable format
 */
const displaySuccess = (result: AddCommandResult): void => {
  success("\nRepository added successfully:");
  console.log(`  Name:              ${result.repositoryName}`);
  console.log(`  Config path:       ${result.path}`);
  console.log(`  Canonical clone:   ${result.canonicalPath}`);
  console.log(`  Default branch:    ${result.defaultBranch}`);
  if (result.worktreePath && result.coordinatedBranch) {
    console.log(`  Active worktree:   ${result.worktreePath}`);
    console.log(`  Coordinated branch: ${result.coordinatedBranch}`);
  }

  if (result.setupScript) {
    console.log(`  Setup:    ${basename(result.setupScript)}`);
    console.log("\nNext steps:");
    console.log(
      `  1. Run setup: cd ${result.worktreePath ?? result.canonicalPath} && ./${basename(result.setupScript)}`,
    );
    console.log(`  2. Create worktree: arashi create my-branch`);
  } else {
    console.log("\nNext steps:");
    console.log(`  Create worktree: arashi create my-branch`);
  }
};

const formatObservation = (value: boolean | null): string =>
  value === null ? "unknown" : value ? "present" : "absent";

/**
 * Display error message in human-readable format
 */
const displayError = (error: AddCommandError): void => {
  logError(`\n✗ ${error.message}\n`);

  const rollback =
    error.context?.phase && error.context.phase !== "preflight"
      ? (error.context.rollback as AddRollbackDetails | undefined)
      : undefined;
  if (rollback) {
    const { finalState } = rollback;
    console.log(`Rollback: ${rollback.complete ? "complete" : "incomplete"}`);
    for (const failure of rollback.failures) {
      console.log(`  Cleanup failure (${failure.phase}): ${failure.message}`);
    }
    console.log(
      `  Canonical clone: ${formatObservation(finalState.canonical.exists)} at ${finalState.canonical.path}`,
    );
    if (finalState.worktree) {
      console.log(
        `  Active worktree: ${formatObservation(finalState.worktree.exists)} at ${finalState.worktree.path}`,
      );
      console.log(`  Worktree metadata: ${formatObservation(finalState.worktree.metadataPresent)}`);
    }
    if (finalState.coordinatedBranch) {
      console.log(
        `  Coordinated branch: ${formatObservation(finalState.coordinatedBranch.exists)} (${finalState.coordinatedBranch.name})`,
      );
    }
    console.log(`  Config entry: ${formatObservation(finalState.configEntryPresent)}`);
    if (finalState.configRestored !== null) {
      console.log(`  Config bytes restored: ${finalState.configRestored ? "yes" : "no"}`);
    }
    if (finalState.managedIgnore.changed) {
      console.log(
        `  Managed-ignore restored: ${formatObservation(finalState.managedIgnore.restored)}`,
      );
    }
  }

  if (error.code === AddCommandErrorCode.INVALID_URL) {
    console.log("Supported formats:");
    console.log("  - HTTPS: https://github.com/user/repo.git");
    console.log("  - SSH URL: ssh://[user@]host/path");
    console.log("  - SSH SCP: [user@]host:path");
    console.log("  - Git:   git://host/repo.git");
    console.log("  - File:  file:///path/to/repo.git");
  } else if (error.code === AddCommandErrorCode.DUPLICATE_NAME) {
    console.log("Solutions:");
    console.log("  1. Clone the configured repository if it is missing locally: arashi clone");
    console.log("  2. Inspect current workspace status: arashi status");
  } else if (error.code === AddCommandErrorCode.CLONE_FAILED) {
    console.log("Common causes:");
    console.log("  - Network connectivity issues");
    console.log("  - Repository doesn't exist or is private");
    console.log("  - Authentication required (use SSH with configured keys)");
    console.log("  - Insufficient disk space");
  }
};

/**
 * Create the add command for Commander.js
 *
 * @returns Commander Command object
 */
export function createCommand(): Command {
  const cmd = new Command("add");

  cmd
    .description("Add a Git repository to the workspace")
    .argument(
      "<git-url>",
      "Git repository URL (HTTPS, Git, File, [user@]host:path, or ssh://[user@]host/path)",
    )
    .option("-n, --name <name>", "Custom repository name")
    .option("--create-setup", "Create setup.sh template if no setup script found", false)
    .option("-f, --force", "Skip confirmation prompts", false)
    .option("-j, --json", "Output result as JSON", false)
    .action(async (gitUrl: string, options: AddCommandOptions) => {
      let workspaceRoots: WorkspaceRoots | null = null;
      try {
        workspaceRoots = await findConfiguredWorkspaceRoots("add", process.cwd());
        const result = await executeAdd(gitUrl, options, workspaceRoots);

        if (options.json) {
          writeJsonEnvelope(
            createJsonSuccessEnvelope("add", {
              managedIgnore: result.managedIgnore,
              repository: {
                defaultBranch: result.defaultBranch,
                canonicalPath: result.canonicalPath,
                coordinatedBranch: result.coordinatedBranch,
                gitUrl: result.gitUrl,
                materialization: result.materialization,
                name: result.repositoryName,
                path: result.path,
                setupScript: result.setupScript,
                setupScriptCreated: result.setupScriptCreated,
                worktreePath: result.worktreePath,
              },
            }),
          );
        } else {
          displaySuccess(result);
        }

        process.exit(0);
      } catch (error) {
        if (error instanceof AddCommandError) {
          if (options.json) {
            writeJsonEnvelope(
              createJsonErrorEnvelope("add", {
                code: error.code,
                details: error.context,
                message: error.message,
              }),
            );
          } else {
            displayError(error);
            if (workspaceRoots) {
              await maybeRunCloneFallback(error, workspaceRoots);
            }
          }
          process.exit(CANCELLED_EXIT_CODE);
        } else {
          if (options.json) {
            writeJsonEnvelope(createJsonErrorEnvelope("add", unknownErrorToJsonError(error)));
          } else {
            logError(`\nUnexpected error: ${(error as Error).message}`);
          }
          process.exit(ERROR_EXIT_CODE);
        }
      }
    });

  return cmd;
}
