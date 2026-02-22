/**
 * Configuration Management Module
 *
 * Handles loading, validation, and persistence of Arashi configuration files.
 * Configuration is stored in `.arashi/config.json` at the repository root.
 *
 * @module config
 */

import { join, dirname, basename, resolve } from "path";
import { mkdir } from "fs/promises";
import { exec, readTrackedFileFromDefaultBranch } from "./git.ts";

// ============================================================================
// Data Types
// ============================================================================

/**
 * Hook configuration for lifecycle events
 */
export interface HookConfig {
  /** Path to script executed before worktree creation */
  preCreate?: string;
  /** Path to script executed after worktree creation */
  postCreate?: string;
  /** Path to script executed during repository setup */
  setup?: string;
}

/**
 * Information about a single git worktree
 */
export interface WorktreeInfo {
  /** Branch name for this worktree */
  branch: string;
  /** Filesystem path to the worktree */
  path: string;
  /** ISO 8601 timestamp when worktree was created */
  createdAt: string;
  /** Optional user-defined metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for a single repository
 */
export interface RepoConfig {
  /** Path to the repository (relative or absolute) */
  path: string;
  /** Canonical git URL for cloning the repository */
  gitUrl?: string;
  /** Custom hook configuration for this repository */
  hooks?: HookConfig;
}

/**
 * Root configuration object for Arashi
 */
export interface Config {
  /** JSON Schema URL for editor validation/autocomplete */
  $schema?: string;
  /** Configuration schema version for migrations */
  version: string;
  /** Directory where repositories are located */
  reposDir: string;
  /** Whether to automatically run setup hooks */
  autoSetup: boolean;
  /** Optional workspace-level hooks settings */
  hooks?: {
    /** Timeout in milliseconds for long-running operations */
    timeout?: number;
  };
  /** Optional sync command settings */
  sync?: {
    /** Sync timeout in seconds */
    timeoutSeconds?: number;
  };
  /** Map of repository names to their configurations */
  repos: Record<string, RepoConfig>;
}

export const DEFAULT_CONFIG_SCHEMA_URL = "https://arashi.haphazard.dev/config.json";

type ConfigErrorContext = {
  errors: string[];
  [key: string]: unknown;
};

/**
 * Resolved repository information from workspace configuration.
 */
export interface WorkspaceRepository {
  /** Repository identifier from config or workspace name */
  name: string;
  /** Absolute path to repository root */
  path: string;
  /** Canonical git URL from configuration, if available */
  gitUrl?: string;
}

export type ConfigSourceType = "local-file" | "repository-content";

export interface LoadedConfig {
  config: Config;
  source: ConfigSourceType;
  configPath: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Base error class for configuration-related errors
 */
export class ConfigError extends Error {
  /**
   * Original error that caused this error (if any)
   */
  public readonly cause?: Error;

  /**
   * Additional context about the error
   */
  public readonly context: ConfigErrorContext;

  constructor(message: string, cause?: Error, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "ConfigError";
    this.cause = cause;
    this.context = { errors: [], ...context };

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigError);
    }
  }
}

/**
 * Error thrown when configuration file is not found
 */
export class ConfigNotFoundError extends ConfigError {
  constructor(path: string) {
    super(`Configuration file not found at ${path}. Run "arashi init" to create it.`, undefined, {
      path,
    });
    this.name = "ConfigNotFoundError";
  }
}

/**
 * Error thrown when configuration file contains invalid JSON
 */
export class ConfigParseError extends ConfigError {
  constructor(path: string, cause: Error) {
    super(`Failed to parse configuration file at ${path}: ${cause.message}`, cause, { path });
    this.name = "ConfigParseError";
  }
}

/**
 * Error thrown when configuration fails validation
 */
export class ConfigValidationError extends ConfigError {
  constructor(errors: string[]) {
    super(
      `Configuration validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      undefined,
      { errors },
    );
    this.name = "ConfigValidationError";
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the full path to the configuration file
 *
 * @param repoPath - Path to the repository
 * @returns Absolute path to .arashi/config.json
 *
 * @example
 * ```typescript
 * const configPath = getConfigPath('/path/to/repo');
 * // Returns: /path/to/repo/.arashi/config.json
 * ```
 */
export function getConfigPath(repoPath: string): string {
  return join(repoPath, ".arashi", "config.json");
}

/**
 * Check if configuration file exists
 *
 * @param repoPath - Path to the repository
 * @returns True if config file exists, false otherwise
 *
 * @example
 * ```typescript
 * if (!await configExists('/path/to/repo')) {
 *   console.log('Run arashi init to create configuration');
 * }
 * ```
 */
export async function configExists(repoPath: string): Promise<boolean> {
  const configPath = getConfigPath(repoPath);
  const file = Bun.file(configPath);
  return await file.exists();
}

/**
 * Find the workspace root by walking up the directory tree
 *
 * Searches for .arashi/config.json starting from the given path and
 * walking up parent directories until found or reaching the filesystem root.
 * Similar to how git finds .git directory.
 *
 * @param startPath - Path to start searching from (defaults to current directory)
 * @returns Absolute path to workspace root
 * @throws {ConfigNotFoundError} If no workspace found in any parent directory
 *
 * @example
 * ```typescript
 * // From /workspace/repos/myrepo/src
 * const workspaceRoot = await findWorkspaceRoot();
 * // Returns: /workspace
 * ```
 */
export async function findWorkspaceRoot(startPath: string = process.cwd()): Promise<string> {
  const { dirname, resolve, parse } = await import("path");

  let currentPath = resolve(startPath);
  const rootPath = parse(currentPath).root;

  // Walk up the directory tree
  while (true) {
    // Check if .arashi/config.json exists in current directory
    if (await configExists(currentPath)) {
      return currentPath;
    }

    // Check if we've reached the filesystem root
    if (currentPath === rootPath) {
      throw new ConfigNotFoundError(getConfigPath(startPath));
    }

    // Move to parent directory
    const parentPath = dirname(currentPath);

    // Additional safety check for infinite loops
    if (parentPath === currentPath) {
      throw new ConfigNotFoundError(getConfigPath(startPath));
    }

    currentPath = parentPath;
  }
}

/**
 * Generate default configuration
 *
 * Creates a minimal valid configuration with sensible defaults:
 * - $schema: "https://arashi.haphazard.dev/config.json"
 * - version: "1.0.0"
 * - reposDir: "./repos"
 * - autoSetup: true
 * - repos: {}
 *
 * @returns Default configuration object
 *
 * @example
 * ```typescript
 * const defaultConfig = generateDefaultConfig();
 * await saveConfig('/path/to/repo', defaultConfig);
 * ```
 */
export function generateDefaultConfig(): Config {
  return {
    $schema: DEFAULT_CONFIG_SCHEMA_URL,
    version: "1.0.0",
    reposDir: "./repos",
    autoSetup: true,
    repos: {},
  };
}

// ============================================================================
// Validation Functions
// ============================================================================

const ROOT_ALLOWED_KEYS = new Set([
  "$schema",
  "version",
  "reposDir",
  "repos_dir",
  "autoSetup",
  "auto_setup",
  "repos",
  "discoveredRepos",
  "discovered_repos",
  "hooks",
  "sync",
]);

const ROOT_HOOKS_ALLOWED_KEYS = new Set(["timeout"]);
const ROOT_SYNC_ALLOWED_KEYS = new Set(["timeoutSeconds", "timeout_seconds"]);

const REPO_ALLOWED_KEYS = new Set([
  "path",
  "gitUrl",
  "git_url",
  "hooks",
  "defaultBranch",
  "default_branch",
  "isBare",
  "is_bare",
  "worktrees",
]);

const REPO_HOOK_ALLOWED_KEYS = new Set([
  "preCreate",
  "pre_create",
  "postCreate",
  "post_create",
  "setup",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFirstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function validateNoUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  prefix: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      const label = prefix ? `${prefix}.${key}` : key;
      errors.push(`${label}: unknown property`);
    }
  }
}

function normalizeRepoHooks(
  value: unknown,
  prefix: string,
  errors: string[],
): HookConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`${prefix}: must be an object if present`);
    return undefined;
  }

  validateNoUnknownKeys(value, REPO_HOOK_ALLOWED_KEYS, prefix, errors);

  const preCreate = getFirstDefined(
    value.preCreate as string | undefined,
    value.pre_create as string | undefined,
  );
  const postCreate = getFirstDefined(
    value.postCreate as string | undefined,
    value.post_create as string | undefined,
  );
  const setup = value.setup as string | undefined;

  const normalized: HookConfig = {};

  if (preCreate !== undefined) {
    if (typeof preCreate !== "string" || preCreate.trim() === "") {
      errors.push(`${prefix}.preCreate: must be a non-empty string if present`);
    } else {
      normalized.preCreate = preCreate;
    }
  }

  if (postCreate !== undefined) {
    if (typeof postCreate !== "string" || postCreate.trim() === "") {
      errors.push(`${prefix}.postCreate: must be a non-empty string if present`);
    } else {
      normalized.postCreate = postCreate;
    }
  }

  if (setup !== undefined) {
    if (typeof setup !== "string" || setup.trim() === "") {
      errors.push(`${prefix}.setup: must be a non-empty string if present`);
    } else {
      normalized.setup = setup;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeRepoConfig(
  repoName: string,
  value: unknown,
  errors: string[],
): RepoConfig | null {
  const prefix = `repos.${repoName}`;

  if (!isRecord(value)) {
    errors.push(`${prefix}: must be an object`);
    return null;
  }

  validateNoUnknownKeys(value, REPO_ALLOWED_KEYS, prefix, errors);

  const path = value.path;
  const gitUrl = getFirstDefined(
    value.gitUrl as string | undefined,
    value.git_url as string | undefined,
  );
  const hooks = normalizeRepoHooks(value.hooks, `${prefix}.hooks`, errors);

  if (typeof path !== "string" || path.trim() === "") {
    errors.push(`${prefix}.path: must be a non-empty string`);
    return null;
  }

  const normalized: RepoConfig = { path };

  if (gitUrl !== undefined) {
    if (typeof gitUrl !== "string" || gitUrl.trim() === "") {
      errors.push(`${prefix}.gitUrl: must be a non-empty string if present`);
    } else {
      normalized.gitUrl = gitUrl;
    }
  }

  if (hooks) {
    normalized.hooks = hooks;
  }

  return normalized;
}

function normalizeWorkspaceHooks(
  value: unknown,
  prefix: string,
  errors: string[],
): Config["hooks"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`${prefix}: must be an object if present`);
    return undefined;
  }

  validateNoUnknownKeys(value, ROOT_HOOKS_ALLOWED_KEYS, prefix, errors);

  const timeout = value.timeout;
  if (timeout === undefined) {
    return undefined;
  }

  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    errors.push(`${prefix}.timeout: must be a positive number if present`);
    return undefined;
  }

  return { timeout };
}

function normalizeSyncConfig(
  value: unknown,
  prefix: string,
  errors: string[],
): Config["sync"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`${prefix}: must be an object if present`);
    return undefined;
  }

  validateNoUnknownKeys(value, ROOT_SYNC_ALLOWED_KEYS, prefix, errors);

  const timeoutSeconds = getFirstDefined(
    value.timeoutSeconds as number | undefined,
    value.timeout_seconds as number | undefined,
  );

  if (timeoutSeconds === undefined) {
    return undefined;
  }

  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 0
  ) {
    errors.push(`${prefix}.timeoutSeconds: must be a non-negative number if present`);
    return undefined;
  }

  return {
    timeoutSeconds,
  };
}

/**
 * Normalize legacy/snake_case config keys to canonical camelCase format.
 *
 * Accepted legacy aliases:
 * - repos_dir -> reposDir
 * - auto_setup -> autoSetup
 * - discovered_repos / discoveredRepos -> repos
 * - git_url -> gitUrl
 * - pre_create/post_create -> preCreate/postCreate
 *
 * Legacy repository metadata keys (`defaultBranch`, `isBare`, `worktrees`) are
 * accepted for backward compatibility but intentionally dropped from the
 * normalized result.
 */
export function normalizeConfig(config: unknown): Config {
  const errors: string[] = [];

  if (!isRecord(config)) {
    throw new ConfigValidationError(["Config must be an object"]);
  }

  validateNoUnknownKeys(config, ROOT_ALLOWED_KEYS, "", errors);

  const schema = config.$schema;
  const version = config.version;
  const reposDir = getFirstDefined(
    config.reposDir as string | undefined,
    config.repos_dir as string | undefined,
  );
  const autoSetup = getFirstDefined(
    config.autoSetup as boolean | undefined,
    config.auto_setup as boolean | undefined,
  );
  const reposRaw = getFirstDefined(
    config.repos as Record<string, unknown> | undefined,
    config.discoveredRepos as Record<string, unknown> | undefined,
    config.discovered_repos as Record<string, unknown> | undefined,
  );
  const hooks = normalizeWorkspaceHooks(config.hooks, "hooks", errors);
  const sync = normalizeSyncConfig(config.sync, "sync", errors);

  if (schema !== undefined && (typeof schema !== "string" || schema.trim() === "")) {
    errors.push("$schema: must be a non-empty string if present");
  }

  if (typeof version !== "string" || version.trim() === "") {
    errors.push("version: must be a non-empty string");
  }

  if (typeof reposDir !== "string" || reposDir.trim() === "") {
    errors.push("reposDir: must be a non-empty string");
  }

  if (typeof autoSetup !== "boolean") {
    errors.push("autoSetup: must be a boolean");
  }

  const normalizedRepos: Record<string, RepoConfig> = {};
  if (!isRecord(reposRaw)) {
    errors.push("repos: must be an object");
  } else {
    for (const [repoName, repoConfig] of Object.entries(reposRaw)) {
      const normalized = normalizeRepoConfig(repoName, repoConfig, errors);
      if (normalized) {
        normalizedRepos[repoName] = normalized;
      }
    }
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  const normalizedVersion = version as string;
  const normalizedReposDir = reposDir as string;
  const normalizedAutoSetup = autoSetup as boolean;

  const normalizedConfig: Config = {
    version: normalizedVersion,
    reposDir: normalizedReposDir,
    autoSetup: normalizedAutoSetup,
    repos: normalizedRepos,
  };

  if (typeof schema === "string") {
    normalizedConfig.$schema = schema;
  }

  if (hooks) {
    normalizedConfig.hooks = hooks;
  }

  if (sync) {
    normalizedConfig.sync = sync;
  }

  return normalizedConfig;
}

/**
 * Validate configuration structure and required fields
 *
 * Checks:
 * - All required fields present (version, reposDir, autoSetup, repos)
 * - Field types are correct
 * - Nested structures valid (RepoConfig, WorktreeInfo, HookConfig)
 *
 * Does NOT check:
 * - File system paths exist
 * - Git repository validity
 * - Hook script permissions
 *
 * @param config - Configuration object to validate
 * @throws {ConfigValidationError} If validation fails with specific error details
 *
 * @example
 * ```typescript
 * try {
 *   validateConfig(loadedData);
 * } catch (error) {
 *   if (error instanceof ConfigValidationError) {
 *     console.error('Validation errors:', error.context.errors);
 *   }
 * }
 * ```
 */
export function validateConfig(config: unknown): asserts config is Config {
  normalizeConfig(config);
}

// ============================================================================
// Core Functions (TO BE IMPLEMENTED)
// ============================================================================

/**
 * Load configuration from .arashi/config.json
 *
 * @param repoPath - Path to the repository (config loaded from repoPath/.arashi/config.json)
 * @returns Parsed and validated configuration object
 * @throws {ConfigNotFoundError} If configuration file doesn't exist
 * @throws {ConfigParseError} If JSON parsing fails
 * @throws {ConfigValidationError} If validation fails
 *
 * @example
 * ```typescript
 * const config = await loadConfig('/path/to/repo');
 * console.log(config.reposDir); // "./repos"
 * ```
 */
export async function loadConfig(repoPath: string): Promise<Config> {
  const configPath = getConfigPath(repoPath);

  // Check if file exists
  if (!(await configExists(repoPath))) {
    throw new ConfigNotFoundError(configPath);
  }

  // Read file
  let text: string;
  try {
    const file = Bun.file(configPath);
    text = await file.text();
  } catch (error) {
    throw new ConfigError(`Failed to read configuration file at ${configPath}`, error as Error, {
      path: configPath,
    });
  }

  // Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError(configPath, error as Error);
  }

  // Validate structure
  return normalizeConfig(data);
}

function parseAndValidateConfig(text: string, configPath: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError(configPath, error as Error);
  }

  return normalizeConfig(data);
}

/**
 * Load configuration from local filesystem first, then optionally from tracked
 * repository content in the default branch.
 */
export async function loadConfigWithFallback(
  workspaceRoot: string,
  options: {
    bareRepoPath?: string;
  } = {},
): Promise<LoadedConfig> {
  const localPath = getConfigPath(workspaceRoot);

  try {
    return {
      config: await loadConfig(workspaceRoot),
      source: "local-file",
      configPath: localPath,
    };
  } catch (error) {
    if (!(error instanceof ConfigNotFoundError) || !options.bareRepoPath) {
      throw error;
    }
  }

  const repoConfigPath = ".arashi/config.json";
  const barePath = options.bareRepoPath;

  if (!barePath) {
    throw new ConfigNotFoundError(localPath);
  }

  try {
    const text = await readTrackedFileFromDefaultBranch(barePath, repoConfigPath);
    return {
      config: parseAndValidateConfig(text, `${barePath}:${repoConfigPath}`),
      source: "repository-content",
      configPath: `${barePath}:${repoConfigPath}`,
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigNotFoundError(localPath);
  }
}

function normalizePersistedRepoConfig(repoConfig: RepoConfig): RepoConfig {
  const normalized: RepoConfig = {
    path: repoConfig.path,
  };

  if (repoConfig.gitUrl && repoConfig.gitUrl.trim().length > 0) {
    normalized.gitUrl = repoConfig.gitUrl;
  }

  if (repoConfig.hooks) {
    const hooks: HookConfig = {};

    if (repoConfig.hooks.preCreate && repoConfig.hooks.preCreate.trim().length > 0) {
      hooks.preCreate = repoConfig.hooks.preCreate;
    }

    if (repoConfig.hooks.postCreate && repoConfig.hooks.postCreate.trim().length > 0) {
      hooks.postCreate = repoConfig.hooks.postCreate;
    }

    if (repoConfig.hooks.setup && repoConfig.hooks.setup.trim().length > 0) {
      hooks.setup = repoConfig.hooks.setup;
    }

    if (Object.keys(hooks).length > 0) {
      normalized.hooks = hooks;
    }
  }

  return normalized;
}

function normalizePersistedConfig(config: Config): Config {
  const repos: Record<string, RepoConfig> = {};

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    repos[name] = normalizePersistedRepoConfig(repoConfig);
  }

  const persisted: Config = {
    $schema: config.$schema ?? DEFAULT_CONFIG_SCHEMA_URL,
    version: config.version,
    reposDir: config.reposDir,
    autoSetup: config.autoSetup,
    repos,
  };

  if (config.hooks) {
    persisted.hooks = config.hooks;
  }

  if (config.sync) {
    persisted.sync = config.sync;
  }

  return persisted;
}

/**
 * Save configuration to .arashi/config.json
 *
 * Creates the .arashi directory if it doesn't exist.
 * Writes JSON with pretty formatting (2-space indentation).
 *
 * @param repoPath - Path to the repository
 * @param config - Configuration object to save
 * @throws {ConfigError} If file system operations fail (permissions, disk full, etc.)
 *
 * @example
 * ```typescript
 * const config = await loadConfig('/path/to/repo');
 * config.autoSetup = false;
 * await saveConfig('/path/to/repo', config);
 * ```
 */
export async function saveConfig(repoPath: string, config: Config): Promise<void> {
  const configPath = getConfigPath(repoPath);
  const configDir = dirname(configPath);

  try {
    const normalized = normalizeConfig(config);
    const persistedConfig = normalizePersistedConfig(normalized);

    // Ensure .arashi directory exists
    await mkdir(configDir, { recursive: true });

    // Write pretty-printed JSON (2-space indentation)
    const json = JSON.stringify(persistedConfig, null, 2);
    await Bun.write(configPath, json);
  } catch (error) {
    throw new ConfigError(
      `Failed to save configuration to ${configPath}: ${(error as Error).message}`,
      error as Error,
      { path: configPath },
    );
  }
}

/**
 * Add a repository to the configuration
 *
 * @param repoPath - Path to the repository containing the config
 * @param name - Unique name for the repository
 * @param repoConfig - Repository configuration
 * @throws {ConfigError} If repository name already exists
 *
 * @example
 * ```typescript
 * await addRepo('/path/to/main-repo', 'my-app', {
 *   path: './repos/my-app',
 *   gitUrl: 'git@github.com:team/my-app.git'
 * });
 * ```
 */
export async function addRepo(
  repoPath: string,
  name: string,
  repoConfig: RepoConfig,
): Promise<void> {
  const config = await loadConfig(repoPath);

  // Check if repository name already exists
  if (config.repos[name] !== undefined) {
    throw new ConfigError(
      `Repository "${name}" already exists in configuration. Use "arashi clone" to materialize missing local repositories.`,
      undefined,
      { name, existingConfig: config.repos[name] },
    );
  }

  // Add repository
  config.repos[name] = repoConfig;

  // Save updated configuration
  await saveConfig(repoPath, config);
}

/**
 * Remove a repository from the configuration
 *
 * @param repoPath - Path to the repository containing the config
 * @param name - Name of the repository to remove
 *
 * @example
 * ```typescript
 * await removeRepo('/path/to/main-repo', 'my-app');
 * ```
 */
export async function removeRepo(repoPath: string, name: string): Promise<void> {
  const config = await loadConfig(repoPath);

  // Remove repository (idempotent - no error if doesn't exist)
  delete config.repos[name];

  // Save updated configuration
  await saveConfig(repoPath, config);
}

/**
 * Load workspace configuration and build absolute repository list.
 *
 * Includes the workspace root repository plus discovered repositories.
 */
export async function loadWorkspaceRepositories(
  workspaceRoot: string,
): Promise<{ config: Config; repositories: WorkspaceRepository[] }> {
  const config = await loadConfig(workspaceRoot);
  const repositories: WorkspaceRepository[] = [];
  const mainName = basename(workspaceRoot);

  repositories.push({
    name: mainName,
    path: resolve(workspaceRoot),
  });

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    repositories.push({
      name,
      path: resolve(workspaceRoot, repoConfig.path),
      gitUrl: repoConfig.gitUrl,
    });
  }

  return { config, repositories };
}

export interface GitUrlRepairResult {
  updated: boolean;
  repaired: string[];
  unresolved: string[];
}

/**
 * Attempt to fill missing repository git URLs from local clone remotes.
 *
 * This provides backward-compatible repair behavior for existing workspaces
 * where `repos` entries were created before `gitUrl` tracking.
 */
export async function repairRepositoryGitUrls(
  workspaceRoot: string,
  config: Config,
): Promise<GitUrlRepairResult> {
  const repaired: string[] = [];
  const unresolved: string[] = [];

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    if (repoConfig.gitUrl && repoConfig.gitUrl.trim().length > 0) {
      continue;
    }

    const repoPath = resolve(workspaceRoot, repoConfig.path);
    const gitUrl = await resolveOriginRemoteUrl(repoPath);
    if (gitUrl) {
      repoConfig.gitUrl = gitUrl;
      repaired.push(name);
    } else {
      unresolved.push(name);
    }
  }

  return {
    updated: repaired.length > 0,
    repaired,
    unresolved,
  };
}

async function resolveOriginRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const result = await exec(["remote", "get-url", "origin"], repoPath);
    const remoteUrl = result.stdout.trim();
    return remoteUrl.length > 0 ? remoteUrl : null;
  } catch {
    return null;
  }
}
