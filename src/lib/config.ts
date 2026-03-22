/**
 * Configuration Management Module
 *
 * Handles loading, validation, and persistence of Arashi configuration files.
 * Configuration is stored in `.arashi/config.json` at the repository root.
 *
 * @module config
 */

import { mkdir } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { exec, readTrackedFileFromDefaultBranch } from "./git.ts";
import {
  DEFAULT_WORKTREES_DIR,
  WorktreeLocationValidationError,
  normalizeWorktreesDir,
} from "./worktree-location.ts";

const ZERO = 0;
const TWO = 2;

// ============================================================================
// Data Types
// ============================================================================

/**
 * Information about a single git worktree
 */
interface WorktreeInfo {
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
interface RepoConfig {
  /** Path to the repository (relative or absolute) */
  path: string;
  /** Canonical git URL for cloning the repository */
  gitUrl?: string;
}

const CURRENT_CONFIG_VERSION = "1.0.0" as const;
type ConfigVersion = typeof CURRENT_CONFIG_VERSION;

/**
 * Root configuration object for Arashi
 */
interface Config {
  /** JSON Schema URL for editor validation/autocomplete */
  $schema?: string;
  /** Configuration schema version for migrations */
  version: ConfigVersion;
  /** Directory where repositories are located */
  reposDir: string;
  /** Base directory where worktrees are created (workspace-relative) */
  worktreesDir?: string;
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
  /** Optional command-scoped defaults for create and switch */
  defaults?: CommandDefaultsConfig;
  /** Map of repository names to their configurations */
  repos: Record<string, RepoConfig>;
}

type LaunchMode = "auto" | "sesh";

interface CreateCommandDefaults {
  /** Default to switching to the new worktree after create */
  switch?: boolean;
  /** Default to launching a terminal/editor context after create */
  launch?: boolean;
  /** Preferred launch mode for create-triggered launch */
  launchMode?: LaunchMode;
}

interface SwitchCommandDefaults {
  /** Preferred launch mode when running switch */
  launchMode?: LaunchMode;
}

interface CommandDefaultsConfig {
  create?: CreateCommandDefaults;
  switch?: SwitchCommandDefaults;
}

const DEFAULT_CONFIG_SCHEMA_URL = "https://unpkg.com/arashi/schema/config.schema.json";

interface ConfigErrorContext {
  errors: string[];
  [key: string]: unknown;
}

/**
 * Resolved repository information from workspace configuration.
 */
interface WorkspaceRepository {
  /** Repository identifier from config or workspace name */
  name: string;
  /** Absolute path to repository root */
  path: string;
  /** Canonical git URL from configuration, if available */
  gitUrl?: string;
}

type ConfigSourceType = "local-file" | "repository-content";

interface LoadedConfig {
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
class ConfigError extends Error {
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
class ConfigNotFoundError extends ConfigError {
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
class ConfigParseError extends ConfigError {
  constructor(path: string, cause: Error) {
    super(`Failed to parse configuration file at ${path}: ${cause.message}`, cause, { path });
    this.name = "ConfigParseError";
  }
}

/**
 * Error thrown when configuration fails validation
 */
class ConfigValidationError extends ConfigError {
  constructor(errors: string[]) {
    super(
      `Configuration validation failed:\n${errors.map((errorMessage) => `  - ${errorMessage}`).join("\n")}`,
      undefined,
      { errors },
    );
    this.name = "ConfigValidationError";
  }
}

/**
 * Error thrown when configuration version is not supported by this CLI release.
 */
class UnsupportedConfigVersionError extends ConfigError {
  constructor(version: string, supportedVersion: ConfigVersion) {
    super(
      `Unsupported configuration version "${version}". This version of arashi supports "${supportedVersion}".`,
      undefined,
      { supportedVersion, version },
    );
    this.name = "UnsupportedConfigVersionError";
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
const getConfigPath = (repoPath: string): string => join(repoPath, ".arashi", "config.json");

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
const configExists = async (repoPath: string): Promise<boolean> => {
  const configPath = getConfigPath(repoPath);
  const file = Bun.file(configPath);
  return await file.exists();
};

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
const findWorkspaceRoot = async (startPath: string = process.cwd()): Promise<string> => {
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
};

/**
 * Generate default configuration
 *
 * Creates a minimal valid configuration with sensible defaults:
 * - $schema: "https://unpkg.com/arashi/schema/config.schema.json"
 * - version: CURRENT_CONFIG_VERSION
 * - reposDir: "./repos"
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
const generateDefaultConfig = (): Config => {
  return {
    $schema: DEFAULT_CONFIG_SCHEMA_URL,
    repos: {},
    reposDir: "./repos",
    version: CURRENT_CONFIG_VERSION,
    worktreesDir: DEFAULT_WORKTREES_DIR,
  };
};

// ============================================================================
// Validation Functions
// ============================================================================

const ROOT_ALLOWED_KEYS = new Set([
  "$schema",
  "version",
  "reposDir",
  "repos_dir",
  "worktreesDir",
  "worktrees_dir",
  "repos",
  "discoveredRepos",
  "discovered_repos",
  "hooks",
  "sync",
  "defaults",
]);

const ROOT_HOOKS_ALLOWED_KEYS = new Set(["timeout"]);
const ROOT_SYNC_ALLOWED_KEYS = new Set(["timeoutSeconds", "timeout_seconds"]);
const VERSION_ALIASES = new Map<string, ConfigVersion>([["1", CURRENT_CONFIG_VERSION]]);

const REPO_ALLOWED_KEYS = new Set([
  "path",
  "gitUrl",
  "git_url",
  "defaultBranch",
  "default_branch",
  "isBare",
  "is_bare",
  "worktrees",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && Boolean(value) && !Array.isArray(value);

const getFirstDefined = <ValueType>(
  ...values: (ValueType | undefined)[]
): ValueType | undefined => {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
};

const validateNoUnknownKeys = (
  value: Record<string, unknown>,
  allowedKeys: Set<string>,
  prefix: string,
  errors: string[],
): void => {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      let label = key;
      if (prefix) {
        label = `${prefix}.${key}`;
      }
      errors.push(`${label}: unknown property`);
    }
  }
};

const resolveConfigVersion = (
  rawVersion: unknown,
  errors: string[],
): {
  version: ConfigVersion;
  migratedFromVersion?: string;
} => {
  if (typeof rawVersion !== "string" || rawVersion.trim() === "") {
    errors.push("version: must be a non-empty string");
    return { version: CURRENT_CONFIG_VERSION };
  }

  const version = rawVersion.trim();
  const canonicalVersion = VERSION_ALIASES.get(version) ?? version;

  if (canonicalVersion !== CURRENT_CONFIG_VERSION) {
    throw new UnsupportedConfigVersionError(version, CURRENT_CONFIG_VERSION);
  }

  if (canonicalVersion !== version) {
    return {
      migratedFromVersion: version,
      version: canonicalVersion,
    };
  }

  return {
    version: CURRENT_CONFIG_VERSION,
  };
};

const normalizeRepoConfig = (
  repoName: string,
  value: unknown,
  errors: string[],
): RepoConfig | undefined => {
  const prefix = `repos.${repoName}`;

  if (!isRecord(value)) {
    errors.push(`${prefix}: must be an object`);
    return undefined;
  }

  validateNoUnknownKeys(value, REPO_ALLOWED_KEYS, prefix, errors);

  const { path } = value;
  const gitUrl = getFirstDefined(
    value.gitUrl as string | undefined,
    value.git_url as string | undefined,
  );

  if (typeof path !== "string" || path.trim() === "") {
    errors.push(`${prefix}.path: must be a non-empty string`);
    return undefined;
  }

  const normalized: RepoConfig = { path };

  if (gitUrl !== undefined) {
    if (typeof gitUrl !== "string" || gitUrl.trim() === "") {
      errors.push(`${prefix}.gitUrl: must be a non-empty string if present`);
    } else {
      normalized.gitUrl = gitUrl;
    }
  }

  return normalized;
};

const normalizeWorkspaceHooks = (
  value: unknown,
  prefix: string,
  errors: string[],
): Config["hooks"] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`${prefix}: must be an object if present`);
    return undefined;
  }

  validateNoUnknownKeys(value, ROOT_HOOKS_ALLOWED_KEYS, prefix, errors);

  const { timeout } = value;
  if (timeout === undefined) {
    return undefined;
  }

  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    errors.push(`${prefix}.timeout: must be a positive number if present`);
    return undefined;
  }

  return { timeout };
};

const normalizeSyncConfig = (
  value: unknown,
  prefix: string,
  errors: string[],
): Config["sync"] | undefined => {
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
};

const normalizeLaunchMode = (value: unknown): LaunchMode | undefined => {
  if (value === "auto" || value === "sesh") {
    return value;
  }

  return undefined;
};

const normalizeCreateCommandDefaults = (value: unknown): CreateCommandDefaults | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: CreateCommandDefaults = {};

  if (typeof value.switch === "boolean") {
    normalized.switch = value.switch;
  }

  if (typeof value.launch === "boolean") {
    normalized.launch = value.launch;
  }

  const launchMode = normalizeLaunchMode(
    getFirstDefined(value.launchMode as unknown, value.launch_mode as unknown),
  );
  if (launchMode !== undefined) {
    normalized.launchMode = launchMode;
    if (normalized.launch === undefined) {
      normalized.launch = true;
    }
  }

  if (normalized.launch === false) {
    delete normalized.launchMode;
  }

  if (Object.keys(normalized).length > ZERO) {
    return normalized;
  }

  return undefined;
};

const normalizeSwitchCommandDefaults = (value: unknown): SwitchCommandDefaults | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const launchMode = normalizeLaunchMode(
    getFirstDefined(value.launchMode as unknown, value.launch_mode as unknown),
  );

  if (launchMode === undefined) {
    return undefined;
  }

  return {
    launchMode,
  };
};

const normalizeCommandDefaults = (value: unknown): CommandDefaultsConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const createDefaults = normalizeCreateCommandDefaults(value.create);
  const switchDefaults = normalizeSwitchCommandDefaults(value.switch);

  const normalized: CommandDefaultsConfig = {};

  if (createDefaults) {
    normalized.create = createDefaults;
  }

  if (switchDefaults) {
    normalized.switch = switchDefaults;
  }

  if (Object.keys(normalized).length > ZERO) {
    return normalized;
  }

  return undefined;
};

const normalizeWorktreesDirConfig = (value: unknown, errors: string[]): string => {
  if (value === undefined) {
    return DEFAULT_WORKTREES_DIR;
  }

  if (typeof value !== "string") {
    errors.push("worktreesDir: must be a string if present");
    return DEFAULT_WORKTREES_DIR;
  }

  try {
    return normalizeWorktreesDir(value);
  } catch (error) {
    if (error instanceof WorktreeLocationValidationError) {
      errors.push(`worktreesDir: ${error.message}`);
      return DEFAULT_WORKTREES_DIR;
    }

    throw error;
  }
};

/**
 * Normalize legacy/snake_case config keys to canonical camelCase format.
 *
 * Accepted legacy aliases:
 * - repos_dir -> reposDir
 * - discovered_repos / discoveredRepos -> repos
 * - git_url -> gitUrl
 *
 * Legacy repository metadata keys (`defaultBranch`, `isBare`, `worktrees`) are
 * accepted for backward compatibility but intentionally dropped from the
 * normalized result.
 */
const normalizeConfigInternal = (
  config: unknown,
): {
  config: Config;
  migratedFromVersion?: string;
} => {
  const errors: string[] = [];

  if (!isRecord(config)) {
    throw new ConfigValidationError(["Config must be an object"]);
  }

  validateNoUnknownKeys(config, ROOT_ALLOWED_KEYS, "", errors);

  const schema = config.$schema;
  const versionInfo = resolveConfigVersion(config.version, errors);
  const reposDir = getFirstDefined(
    config.reposDir as string | undefined,
    config.repos_dir as string | undefined,
  );
  const worktreesDirRaw = getFirstDefined(
    config.worktreesDir as string | undefined,
    config.worktrees_dir as string | undefined,
  );
  const reposRaw = getFirstDefined(
    config.repos as Record<string, unknown> | undefined,
    config.discoveredRepos as Record<string, unknown> | undefined,
    config.discovered_repos as Record<string, unknown> | undefined,
  );
  const worktreesDir = normalizeWorktreesDirConfig(worktreesDirRaw, errors);
  const hooks = normalizeWorkspaceHooks(config.hooks, "hooks", errors);
  const sync = normalizeSyncConfig(config.sync, "sync", errors);
  const defaults = normalizeCommandDefaults(config.defaults);

  if (schema !== undefined && (typeof schema !== "string" || schema.trim() === "")) {
    errors.push("$schema: must be a non-empty string if present");
  }

  if (typeof reposDir !== "string" || reposDir.trim() === "") {
    errors.push("reposDir: must be a non-empty string");
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

  const normalizedVersion = versionInfo.version;
  const normalizedReposDir = reposDir as string;

  const normalizedConfig: Config = {
    repos: normalizedRepos,
    reposDir: normalizedReposDir,
    version: normalizedVersion,
    worktreesDir,
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

  if (defaults) {
    normalizedConfig.defaults = defaults;
  }

  return {
    config: normalizedConfig,
    migratedFromVersion: versionInfo.migratedFromVersion,
  };
};

const normalizeConfig = (config: unknown): Config => {
  return normalizeConfigInternal(config).config;
};

/**
 * Validate configuration structure and required fields
 *
 * Checks:
 * - All required fields present (version, reposDir, repos)
 * - Field types are correct
 * - Nested structures valid (RepoConfig and workspace-level hooks/sync objects)
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
const validateConfig = (config: unknown): asserts config is Config => {
  normalizeConfig(config);
};

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
const loadConfig = async (repoPath: string): Promise<Config> => {
  const configPath = getConfigPath(repoPath);

  // Check if file exists
  const hasConfig = await configExists(repoPath);
  if (!hasConfig) {
    throw new ConfigNotFoundError(configPath);
  }

  // Read file
  let text = "";
  try {
    const file = Bun.file(configPath);
    text = await file.text();
  } catch (error) {
    throw new ConfigError(`Failed to read configuration file at ${configPath}`, error as Error, {
      path: configPath,
    });
  }

  // Parse JSON
  let data: unknown = undefined;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError(configPath, error as Error);
  }

  const normalized = normalizeConfigInternal(data);

  if (normalized.migratedFromVersion) {
    await saveConfig(repoPath, normalized.config);
  }

  return normalized.config;
};

const parseAndValidateConfig = (text: string, configPath: string): Config => {
  let data: unknown = undefined;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError(configPath, error as Error);
  }

  return normalizeConfigInternal(data).config;
};

/**
 * Load configuration from local filesystem first, then optionally from tracked
 * repository content in the default branch.
 */
const loadConfigWithFallback = async (
  workspaceRoot: string,
  options: {
    bareRepoPath?: string;
  } = {},
): Promise<LoadedConfig> => {
  const localPath = getConfigPath(workspaceRoot);

  try {
    return {
      config: await loadConfig(workspaceRoot),
      configPath: localPath,
      source: "local-file",
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
      configPath: `${barePath}:${repoConfigPath}`,
      source: "repository-content",
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigNotFoundError(localPath);
  }
};

const normalizePersistedRepoConfig = (repoConfig: RepoConfig): RepoConfig => {
  const normalized: RepoConfig = {
    path: repoConfig.path,
  };

  if (repoConfig.gitUrl && repoConfig.gitUrl.trim().length > 0) {
    normalized.gitUrl = repoConfig.gitUrl;
  }

  return normalized;
};

const normalizePersistedConfig = (config: Config): Config => {
  const repos: Record<string, RepoConfig> = {};

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    repos[name] = normalizePersistedRepoConfig(repoConfig);
  }

  const persisted: Config = {
    $schema: config.$schema ?? DEFAULT_CONFIG_SCHEMA_URL,
    repos,
    reposDir: config.reposDir,
    version: config.version,
    worktreesDir: config.worktreesDir ?? DEFAULT_WORKTREES_DIR,
  };

  if (config.hooks) {
    persisted.hooks = config.hooks;
  }

  if (config.sync) {
    persisted.sync = config.sync;
  }

  if (config.defaults) {
    persisted.defaults = config.defaults;
  }

  return persisted;
};

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
 * config.reposDir = "./repos";
 * await saveConfig('/path/to/repo', config);
 * ```
 */
const saveConfig = async (repoPath: string, config: Config): Promise<void> => {
  const configPath = getConfigPath(repoPath);
  const configDir = dirname(configPath);

  try {
    const normalized = normalizeConfig(config);
    const persistedConfig = normalizePersistedConfig(normalized);

    // Ensure .arashi directory exists
    await mkdir(configDir, { recursive: true });

    // Write pretty-printed JSON (2-space indentation)
    const json = JSON.stringify(persistedConfig, null, TWO);
    await Bun.write(configPath, json);
  } catch (error) {
    throw new ConfigError(
      `Failed to save configuration to ${configPath}: ${(error as Error).message}`,
      error as Error,
      { path: configPath },
    );
  }
};

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
const addRepo = async (repoPath: string, name: string, repoConfig: RepoConfig): Promise<void> => {
  const config = await loadConfig(repoPath);

  // Check if repository name already exists
  if (config.repos[name] !== undefined) {
    throw new ConfigError(
      `Repository "${name}" already exists in configuration. Use "arashi clone" to materialize missing local repositories.`,
      undefined,
      { existingConfig: config.repos[name], name },
    );
  }

  // Add repository
  config.repos[name] = repoConfig;

  // Save updated configuration
  await saveConfig(repoPath, config);
};

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
const removeRepo = async (repoPath: string, name: string): Promise<void> => {
  const config = await loadConfig(repoPath);

  // Remove repository (idempotent - no error if doesn't exist)
  delete config.repos[name];

  // Save updated configuration
  await saveConfig(repoPath, config);
};

/**
 * Load workspace configuration and build absolute repository list.
 *
 * Includes the workspace root repository plus discovered repositories.
 */
const loadWorkspaceRepositories = async (
  workspaceRoot: string,
): Promise<{ config: Config; repositories: WorkspaceRepository[] }> => {
  const config = await loadConfig(workspaceRoot);
  const repositories: WorkspaceRepository[] = [];
  const mainName = basename(workspaceRoot);

  repositories.push({
    name: mainName,
    path: resolve(workspaceRoot),
  });

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    repositories.push({
      gitUrl: repoConfig.gitUrl,
      name,
      path: resolve(workspaceRoot, repoConfig.path),
    });
  }

  return { config, repositories };
};

interface GitUrlRepairResult {
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
const repairRepositoryGitUrls = async (
  workspaceRoot: string,
  config: Config,
): Promise<GitUrlRepairResult> => {
  const repaired: string[] = [];
  const unresolved: string[] = [];

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    if (!repoConfig.gitUrl || repoConfig.gitUrl.trim().length === ZERO) {
      const repoPath = resolve(workspaceRoot, repoConfig.path);
      const gitUrl = await resolveOriginRemoteUrl(repoPath);
      if (gitUrl) {
        repoConfig.gitUrl = gitUrl;
        repaired.push(name);
      } else {
        unresolved.push(name);
      }
    }
  }

  let updated = false;
  if (repaired.length > ZERO) {
    updated = true;
  }

  return {
    repaired,
    unresolved,
    updated,
  };
};

const resolveOriginRemoteUrl = async (repoPath: string): Promise<string | undefined> => {
  try {
    const result = await exec(["remote", "get-url", "origin"], repoPath);
    const remoteUrl = result.stdout.trim();
    if (remoteUrl.length > ZERO) {
      return remoteUrl;
    }

    return undefined;
  } catch {
    return undefined;
  }
};

export {
  CURRENT_CONFIG_VERSION,
  DEFAULT_CONFIG_SCHEMA_URL,
  Config,
  ConfigError,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSourceType,
  ConfigValidationError,
  ConfigVersion,
  CommandDefaultsConfig,
  CreateCommandDefaults,
  GitUrlRepairResult,
  LaunchMode,
  LoadedConfig,
  RepoConfig,
  SwitchCommandDefaults,
  UnsupportedConfigVersionError,
  WorkspaceRepository,
  WorktreeInfo,
  addRepo,
  configExists,
  findWorkspaceRoot,
  generateDefaultConfig,
  getConfigPath,
  loadConfig,
  loadConfigWithFallback,
  loadWorkspaceRepositories,
  normalizeConfig,
  removeRepo,
  repairRepositoryGitUrls,
  saveConfig,
  validateConfig,
};
