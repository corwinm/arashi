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
import { readTrackedFileFromDefaultBranch } from "./git.ts";

// ============================================================================
// Data Types
// ============================================================================

/**
 * Hook configuration for lifecycle events
 */
export interface HookConfig {
  /** Path to script executed before worktree creation */
  pre_create?: string;
  /** Path to script executed after worktree creation */
  post_create?: string;
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
  created_at: string;
  /** Optional user-defined metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for a single repository
 */
export interface RepoConfig {
  /** Path to the repository (relative or absolute) */
  path: string;
  /** Name of the default branch (auto-detected if omitted) */
  default_branch?: string;
  /** Whether the repository is bare (auto-detected if omitted) */
  is_bare?: boolean;
  /** List of active worktrees for this repository */
  worktrees?: WorktreeInfo[];
  /** Custom hook configuration for this repository */
  hooks?: HookConfig;
}

/**
 * Root configuration object for Arashi
 */
export interface Config {
  /** Configuration schema version for migrations */
  version: string;
  /** Directory where repositories are located */
  repos_dir: string;
  /** Whether to automatically run setup hooks */
  auto_setup: boolean;
  /** Optional workspace-level hooks settings */
  hooks?: {
    /** Timeout in milliseconds for long-running operations */
    timeout?: number;
  };
  /** Map of repository names to their configurations */
  discovered_repos: Record<string, RepoConfig>;
}

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
  /** Default branch from config, if present */
  defaultBranch?: string;
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
 * - version: "1.0.0"
 * - repos_dir: "./repos"
 * - auto_setup: true
 * - discovered_repos: {}
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
    version: "1.0.0",
    repos_dir: "./repos",
    auto_setup: true,
    discovered_repos: {},
  };
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate configuration structure and required fields
 *
 * Checks:
 * - All required fields present (version, repos_dir, auto_setup, discovered_repos)
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
  const errors: string[] = [];
  const cfg = config as Record<string, unknown>;

  // Validate root level fields
  if (typeof config !== "object" || config === null) {
    throw new ConfigValidationError(["Config must be an object"]);
  }

  if (typeof cfg.version !== "string" || cfg.version === "") {
    errors.push("version: must be a non-empty string");
  }

  if (typeof cfg.repos_dir !== "string" || cfg.repos_dir === "") {
    errors.push("repos_dir: must be a non-empty string");
  }

  if (typeof cfg.auto_setup !== "boolean") {
    errors.push("auto_setup: must be a boolean");
  }

  if (
    typeof cfg.discovered_repos !== "object" ||
    cfg.discovered_repos === null ||
    Array.isArray(cfg.discovered_repos)
  ) {
    errors.push("discovered_repos: must be an object");
  } else {
    // Validate each repository configuration
    for (const [repoName, repoConfig] of Object.entries(
      cfg.discovered_repos as Record<string, unknown>,
    )) {
      validateRepoConfig(repoName, repoConfig, errors);
    }
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }
}

/**
 * Validate a single repository configuration
 *
 * @param repoName - Name of the repository (for error messages)
 * @param repoConfig - Repository configuration to validate
 * @param errors - Array to accumulate validation errors
 */
function validateRepoConfig(repoName: string, repoConfig: unknown, errors: string[]): void {
  const prefix = `discovered_repos.${repoName}`;
  const repo = repoConfig as Record<string, unknown>;

  if (typeof repoConfig !== "object" || repoConfig === null) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  // Required field: path
  if (typeof repo.path !== "string" || repo.path === "") {
    errors.push(`${prefix}.path: must be a non-empty string`);
  }

  // Optional field: default_branch
  if (repo.default_branch !== undefined) {
    if (typeof repo.default_branch !== "string" || repo.default_branch === "") {
      errors.push(`${prefix}.default_branch: must be a non-empty string if present`);
    }
  }

  // Optional field: is_bare
  if (repo.is_bare !== undefined) {
    if (typeof repo.is_bare !== "boolean") {
      errors.push(`${prefix}.is_bare: must be a boolean if present`);
    }
  }

  // Optional field: worktrees
  if (repo.worktrees !== undefined) {
    if (!Array.isArray(repo.worktrees)) {
      errors.push(`${prefix}.worktrees: must be an array if present`);
    } else {
      repo.worktrees.forEach((worktree, index: number) => {
        validateWorktreeInfo(`${prefix}.worktrees[${index}]`, worktree, errors);
      });
    }
  }

  // Optional field: hooks
  if (repo.hooks !== undefined) {
    validateHookConfig(`${prefix}.hooks`, repo.hooks, errors);
  }
}

/**
 * Validate a single worktree configuration
 *
 * @param prefix - Path prefix for error messages
 * @param worktree - Worktree info to validate
 * @param errors - Array to accumulate validation errors
 */
function validateWorktreeInfo(prefix: string, worktree: unknown, errors: string[]): void {
  const wt = worktree as Record<string, unknown>;
  if (typeof worktree !== "object" || worktree === null) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  // Required field: branch
  if (typeof wt.branch !== "string" || wt.branch === "") {
    errors.push(`${prefix}.branch: must be a non-empty string`);
  }

  // Required field: path
  if (typeof wt.path !== "string" || wt.path === "") {
    errors.push(`${prefix}.path: must be a non-empty string`);
  }

  // Required field: created_at
  if (typeof wt.created_at !== "string" || wt.created_at === "") {
    errors.push(`${prefix}.created_at: must be a non-empty string`);
  } else {
    // Validate ISO 8601 format
    const date = new Date(wt.created_at);
    if (isNaN(date.getTime())) {
      errors.push(`${prefix}.created_at: must be a valid ISO 8601 date string`);
    }
  }

  // Optional field: metadata
  if (wt.metadata !== undefined) {
    if (typeof wt.metadata !== "object" || wt.metadata === null || Array.isArray(wt.metadata)) {
      errors.push(`${prefix}.metadata: must be an object if present`);
    }
  }
}

/**
 * Validate hook configuration
 *
 * @param prefix - Path prefix for error messages
 * @param hooks - Hook config to validate
 * @param errors - Array to accumulate validation errors
 */
function validateHookConfig(prefix: string, hooks: unknown, errors: string[]): void {
  const hookConfig = hooks as Record<string, unknown>;
  if (typeof hooks !== "object" || hooks === null) {
    errors.push(`${prefix}: must be an object`);
    return;
  }

  // Optional field: pre_create
  if (hookConfig.pre_create !== undefined) {
    if (typeof hookConfig.pre_create !== "string" || hookConfig.pre_create === "") {
      errors.push(`${prefix}.pre_create: must be a non-empty string if present`);
    }
  }

  // Optional field: post_create
  if (hookConfig.post_create !== undefined) {
    if (typeof hookConfig.post_create !== "string" || hookConfig.post_create === "") {
      errors.push(`${prefix}.post_create: must be a non-empty string if present`);
    }
  }

  // Optional field: setup
  if (hookConfig.setup !== undefined) {
    if (typeof hookConfig.setup !== "string" || hookConfig.setup === "") {
      errors.push(`${prefix}.setup: must be a non-empty string if present`);
    }
  }
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
 * console.log(config.repos_dir); // "./repos"
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
  validateConfig(data);

  return data;
}

function parseAndValidateConfig(text: string, configPath: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError(configPath, error as Error);
  }

  validateConfig(data);
  return data;
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
 * config.auto_setup = false;
 * await saveConfig('/path/to/repo', config);
 * ```
 */
export async function saveConfig(repoPath: string, config: Config): Promise<void> {
  const configPath = getConfigPath(repoPath);
  const configDir = dirname(configPath);

  try {
    // Ensure .arashi directory exists
    await mkdir(configDir, { recursive: true });

    // Write pretty-printed JSON (2-space indentation)
    const json = JSON.stringify(config, null, 2);
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
 *   default_branch: 'main',
 *   is_bare: false
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
  if (config.discovered_repos[name] !== undefined) {
    throw new ConfigError(
      `Repository "${name}" already exists in configuration. Use a different name or remove the existing repository first.`,
      undefined,
      { name, existingConfig: config.discovered_repos[name] },
    );
  }

  // Add repository
  config.discovered_repos[name] = repoConfig;

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
  delete config.discovered_repos[name];

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

  for (const [name, repoConfig] of Object.entries(config.discovered_repos)) {
    repositories.push({
      name,
      path: resolve(workspaceRoot, repoConfig.path),
      defaultBranch: repoConfig.default_branch,
    });
  }

  return { config, repositories };
}
