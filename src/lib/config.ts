import { runtime } from "./runtime.ts";
/**
 * Configuration Management Module
 *
 * Handles loading, validation, and persistence of Arashi configuration files.
 * Configuration is stored in `.arashi/config.json` at the repository root.
 *
 * @module config
 */

import {
  DEFAULT_WORKTREES_DIR,
  WorktreeLocationValidationError,
  normalizeWorktreesDir,
} from "./worktree-location.ts";
import { basename, dirname, join, resolve } from "path";
import { exec, readTrackedFileFromDefaultBranch } from "./git.ts";
import { mkdir, realpath } from "fs/promises";
import { warn } from "./logger.ts";
import { isValidRequestedBaseBranch } from "./git-branch-name.ts";
import { normalizeMaterializationPath } from "./materialization.ts";

const ZERO = 0;
const TWO = 2;

// ============================================================================
// Data Types
// ============================================================================

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
  /** Repository-relative paths copied into new worktrees in declaration order */
  copy?: string[];
  /** Repository-relative paths symlinked into new worktrees in declaration order */
  symlink?: string[];
  /** Canonical git URL for cloning the repository */
  gitUrl?: string;
  /** Optional semantic groups this repository belongs to */
  groups?: string[];
  /** Optional repository-targeted inline lifecycle hooks */
  hooks?: InlineHookScripts;
}

export type InlineHookLifecycle = "pre-create" | "post-create" | "pre-remove" | "post-remove";
export type InlineHookInterpreter = "bash" | "powershell" | "cmd";

/**
 * Non-empty inline hook snippet.
 * @minLength 1
 * @pattern \S
 */
export type InlineHookSnippet = string;

/**
 * Interpreter-specific alternatives for one inline lifecycle hook.
 * @minProperties 1
 */
export interface InlineHookInterpreterMap {
  bash?: InlineHookSnippet;
  powershell?: InlineHookSnippet;
  cmd?: InlineHookSnippet;
}

/** Bash shorthand or interpreter-specific alternatives for one inline hook. */
export type InlineHookValue = InlineHookInterpreter | InlineHookSnippet | InlineHookInterpreterMap;

/** Closed set of supported inline lifecycle hooks. */
export interface InlineHookScripts {
  "pre-create"?: InlineHookValue;
  "post-create"?: InlineHookValue;
  "pre-remove"?: InlineHookValue;
  "post-remove"?: InlineHookValue;
}

export const CURRENT_CONFIG_VERSION = "1.0.0" as const;
export type ConfigVersion = typeof CURRENT_CONFIG_VERSION;

/**
 * Root configuration object for Arashi
 */
export interface Config {
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
    /**
     * Lifecycle-hook timeout in milliseconds (default: 300000)
     * @minimum 1
     * @maximum 2147483647
     * @multipleOf 1
     */
    timeout?: number;
    /** Workspace inline lifecycle hooks */
    scripts?: InlineHookScripts;
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

export type LaunchMode = "auto" | "sesh" | "herdr";
export type CreateLaunchMode = "none" | "auto" | "sesh" | "herdr";
export type SwitchMode = "auto" | "cd" | "launch" | "sesh" | "herdr";
export type CreateDefaultsEditorHost = "vscode" | "cursor" | "kiro";

export interface CreateCommandDefaults {
  /**
   * Default base branch for configured create invocations
   * @minLength 1
   * @pattern ^(?!HEAD$)(?!origin/(?:HEAD$|-))(?![-/.])(?!.*(?:/\.|//|\.\.|@\{))(?!.*\.lock(?:/|$))(?!.*[/.]$)[^\u0000-\u0020\u007F~^:?*\[\\]+$
   */
  baseBranch?: string;
  /** Default to switching to the new worktree after create */
  switch?: boolean;
  /** Post-create launch choice; omitted preserves built-in no-launch behavior */
  launch?: CreateLaunchMode;
}

export interface EditorCreateCommandDefaults {
  /** Default to switching to the new worktree after create */
  switch?: boolean;
  /** Post-create launch choice; omitted preserves built-in no-launch behavior */
  launch?: CreateLaunchMode;
}

export interface SwitchCommandDefaults {
  /** Preferred switch behavior and launcher when running switch */
  mode?: SwitchMode;
}

export interface EditorCommandDefaults {
  /** Editor-scoped create defaults */
  create?: EditorCreateCommandDefaults;
}

export interface EditorDefaultsConfig {
  vscode?: EditorCommandDefaults;
  cursor?: EditorCommandDefaults;
  kiro?: EditorCommandDefaults;
}

export interface CommandDefaultsConfig {
  create?: CreateCommandDefaults;
  editors?: EditorDefaultsConfig;
  switch?: SwitchCommandDefaults;
}

export const DEFAULT_CONFIG_SCHEMA_URL = "https://unpkg.com/arashi/schema/config.schema.json";

interface ConfigErrorContext {
  errors: string[];
  [key: string]: unknown;
}

/**
 * Resolved repository information from workspace configuration.
 */
export interface WorkspaceRepository {
  /** Repository identifier from config or workspace name */
  name: string;
  /** Absolute path to repository root */
  path: string;
  /** Git-primary non-bare checkout used as the materialization source */
  sourcePath?: string;
  /** Ordered repository-relative copy policy */
  copy?: string[];
  /** Ordered repository-relative symbolic-link policy */
  symlink?: string[];
  /** Canonical git URL from configuration, if available */
  gitUrl?: string;
  /** Optional semantic groups this repository belongs to */
  groups?: string[];
}

/** Separate the canonical configuration location from the active repository tree. */
export interface WorkspaceRepositoryRoots {
  /** Root containing .arashi/config.json */
  configurationRoot: string;
  /** Parent repository whose managed repositories should be operated on */
  executionRoot: string;
}

export type ConfigSourceType = "local-file" | "repository-content";

export interface LoadedConfig {
  config: Config;
  source: ConfigSourceType;
  configPath: string;
}

export interface DeprecatedSwitchLaunchModeDiagnostic {
  code: "DEPRECATED_SWITCH_LAUNCH_MODE";
  fields: string[];
  message: string;
  replacementMode: SwitchMode;
}

export interface DeprecatedCreateLaunchFieldsDiagnostic {
  code: "DEPRECATED_CREATE_LAUNCH_FIELDS";
  fields: string[];
  message: string;
  replacementLaunch: CreateLaunchMode;
  scope: string;
}

export type ConfigDiagnostic =
  | DeprecatedCreateLaunchFieldsDiagnostic
  | DeprecatedSwitchLaunchModeDiagnostic;

export interface ConfigNormalizationResult {
  config: Config;
  diagnostics: ConfigDiagnostic[];
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
export class UnsupportedConfigVersionError extends ConfigError {
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
export const getConfigPath = (repoPath: string): string => join(repoPath, ".arashi", "config.json");

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
export const configExists = async (repoPath: string): Promise<boolean> => {
  const configPath = getConfigPath(repoPath);
  const file = runtime.file(configPath);
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
export const findWorkspaceRoot = async (startPath: string = process.cwd()): Promise<string> => {
  const { dirname, isAbsolute, resolve, parse } = await import("path");

  let currentPath = resolve(startPath);
  const rootPath = parse(currentPath).root;

  // Walk up the directory tree
  while (true) {
    // Check if .arashi/config.json exists in current directory
    if (await configExists(currentPath)) {
      // Validate the local configuration before probing Git topology. Commands use
      // this discovery path before any hook or mutation preflight, so malformed
      // configuration must fail without starting even a read-only Git process.
      await loadConfig(currentPath);
      try {
        const common = await exec(["rev-parse", "--git-common-dir"], currentPath);
        const rawCommonDirectory = common.stdout.trim();
        const commonDirectory = isAbsolute(rawCommonDirectory)
          ? resolve(rawCommonDirectory)
          : resolve(currentPath, rawCommonDirectory);
        if (commonDirectory !== currentPath && (await configExists(commonDirectory))) {
          const bare = await exec(["rev-parse", "--is-bare-repository"], commonDirectory);
          if (bare.stdout.trim() === "true") {
            return commonDirectory;
          }
        }
      } catch {
        // A normal configured checkout remains authoritative when no bare common root applies.
      }
      return currentPath;
    }

    // Check if we've reached the filesystem root before trying Git topology fallback.
    if (currentPath === rootPath) {
      break;
    }

    // Move to parent directory
    const parentPath = dirname(currentPath);

    // Additional safety check for infinite loops
    if (parentPath === currentPath) {
      throw new ConfigNotFoundError(getConfigPath(startPath));
    }

    currentPath = parentPath;
  }

  // Linked worktrees from configured bare repositories are commonly siblings
  // of those repositories, so filesystem ancestors cannot expose the configuration.
  // Probe every ancestor because the invocation path may be a nested child repository
  // with a different Git common directory.
  currentPath = resolve(startPath);
  const checkedCommonDirectories = new Set<string>();
  while (true) {
    try {
      const common = await exec(["rev-parse", "--git-common-dir"], currentPath);
      const rawCommonDirectory = common.stdout.trim();
      const commonDirectory = isAbsolute(rawCommonDirectory)
        ? resolve(rawCommonDirectory)
        : resolve(currentPath, rawCommonDirectory);
      if (!checkedCommonDirectories.has(commonDirectory)) {
        checkedCommonDirectories.add(commonDirectory);
        if (await configExists(commonDirectory)) {
          return commonDirectory;
        }
      }
    } catch {
      // Keep walking: an enclosing ancestor may belong to the configured parent worktree.
    }

    if (currentPath === rootPath) {
      break;
    }
    currentPath = dirname(currentPath);
  }

  throw new ConfigNotFoundError(getConfigPath(startPath));
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
export const generateDefaultConfig = (): Config => ({
  $schema: DEFAULT_CONFIG_SCHEMA_URL,
  repos: {},
  reposDir: "./repos",
  version: CURRENT_CONFIG_VERSION,
  worktreesDir: DEFAULT_WORKTREES_DIR,
});

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

const ROOT_HOOKS_ALLOWED_KEYS = new Set(["timeout", "scripts"]);
const ROOT_SYNC_ALLOWED_KEYS = new Set(["timeoutSeconds", "timeout_seconds"]);
const CREATE_DEFAULTS_ALLOWED_KEYS = new Set([
  "baseBranch",
  "launch",
  "launchMode",
  "launch_mode",
  "switch",
]);
const EDITOR_CREATE_DEFAULTS_ALLOWED_KEYS = new Set([
  "launch",
  "launchMode",
  "launch_mode",
  "switch",
]);
const VERSION_ALIASES = new Map<string, ConfigVersion>([["1", CURRENT_CONFIG_VERSION]]);

const REPO_ALLOWED_KEYS = new Set([
  "path",
  "copy",
  "symlink",
  "gitUrl",
  "git_url",
  "defaultBranch",
  "default_branch",
  "isBare",
  "is_bare",
  "worktrees",
  "groups",
  "hooks",
]);

const INLINE_HOOK_LIFECYCLES = new Set<InlineHookLifecycle>([
  "pre-create",
  "post-create",
  "pre-remove",
  "post-remove",
]);
const INLINE_HOOK_INTERPRETERS = new Set<InlineHookInterpreter>(["bash", "powershell", "cmd"]);

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

interface ValidateNoUnknownKeysOptions {
  allowedKeys: Set<string>;
  errors: string[];
  prefix: string;
  value: Record<string, unknown>;
}

const validateNoUnknownKeys = ({
  allowedKeys,
  errors,
  prefix,
  value,
}: ValidateNoUnknownKeysOptions): void => {
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

const normalizeInlineHookValue = (
  value: unknown,
  prefix: string,
  errors: string[],
): InlineHookInterpreterMap | undefined => {
  if (typeof value === "string") {
    if (value.trim() === "") {
      errors.push(`${prefix}: must be a non-empty string or non-empty interpreter map`);
      return undefined;
    }
    return { bash: value };
  }

  if (!isRecord(value)) {
    errors.push(`${prefix}: must be a non-empty string or non-empty interpreter map`);
    return undefined;
  }

  if (Object.keys(value).length === ZERO) {
    errors.push(`${prefix}: must be a non-empty interpreter map`);
    return undefined;
  }

  const normalized: InlineHookInterpreterMap = {};
  for (const [interpreter, snippet] of Object.entries(value)) {
    const memberPath = `${prefix}.${interpreter}`;
    if (!INLINE_HOOK_INTERPRETERS.has(interpreter as InlineHookInterpreter)) {
      errors.push(`${memberPath}: unknown property`);
      continue;
    }
    if (typeof snippet !== "string" || snippet.trim() === "") {
      errors.push(`${memberPath}: must be a non-empty string`);
      continue;
    }
    normalized[interpreter as InlineHookInterpreter] = snippet;
  }

  return Object.keys(normalized).length > ZERO ? normalized : undefined;
};

const normalizeInlineHookScripts = (
  value: unknown,
  prefix: string,
  errors: string[],
): InlineHookScripts | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push(`${prefix}: must be an object if present`);
    return undefined;
  }

  const normalized: InlineHookScripts = {};
  for (const [lifecycle, hookValue] of Object.entries(value)) {
    const hookPath = `${prefix}.${lifecycle}`;
    if (!INLINE_HOOK_LIFECYCLES.has(lifecycle as InlineHookLifecycle)) {
      errors.push(`${hookPath}: unknown property`);
      continue;
    }
    const hook = normalizeInlineHookValue(hookValue, hookPath, errors);
    if (hook) {
      normalized[lifecycle as InlineHookLifecycle] = hook;
    }
  }

  return Object.keys(normalized).length > ZERO ? normalized : undefined;
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

  validateNoUnknownKeys({ allowedKeys: REPO_ALLOWED_KEYS, errors, prefix, value });

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

  const materializationPaths = new Map<
    string,
    { field: "copy" | "symlink"; index: number; path: string }
  >();
  const normalizeMaterializationArray = (field: "copy" | "symlink"): string[] | undefined => {
    const raw = value[field];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      errors.push(`${prefix}.${field}: must be an array of non-empty strings if present`);
      return undefined;
    }

    const entries: string[] = [];
    for (const [index, candidate] of raw.entries()) {
      const entryPath = `${prefix}.${field}[${index}]`;
      if (typeof candidate !== "string") {
        errors.push(`${entryPath}: must be a non-empty string`);
        continue;
      }
      try {
        const normalizedPath = normalizeMaterializationPath(candidate);
        const previous = materializationPaths.get(normalizedPath.collisionKey);
        if (previous) {
          if (previous.field !== field) {
            errors.push(
              `${entryPath}: portable collision with ${prefix}.${previous.field}[${previous.index}] after normalization`,
            );
          } else if (previous.path === normalizedPath.path) {
            errors.push(`${entryPath}: duplicate normalized path`);
          } else {
            errors.push(`${entryPath}: portable collision`);
          }
          continue;
        }
        materializationPaths.set(normalizedPath.collisionKey, {
          field,
          index,
          path: normalizedPath.path,
        });
        entries.push(normalizedPath.path);
      } catch (error) {
        errors.push(`${entryPath}: ${(error as Error).message}`);
      }
    }
    return entries;
  };

  const copy = normalizeMaterializationArray("copy");
  const symlink = normalizeMaterializationArray("symlink");
  if (copy) normalized.copy = copy;
  if (symlink) normalized.symlink = symlink;

  if (gitUrl !== undefined) {
    if (typeof gitUrl !== "string" || gitUrl.trim() === "") {
      errors.push(`${prefix}.gitUrl: must be a non-empty string if present`);
    } else {
      normalized.gitUrl = gitUrl;
    }
  }

  if (value.groups !== undefined) {
    if (Array.isArray(value.groups)) {
      const seenGroups = new Set<string>();
      const groups: string[] = [];
      for (const [index, rawGroup] of value.groups.entries()) {
        if (typeof rawGroup !== "string" || rawGroup.trim() === "") {
          errors.push(`${prefix}.groups[${index}]: must be a non-empty string`);
          continue;
        }
        const group = rawGroup.trim();
        const normalizedGroup = group.toLowerCase();
        if (seenGroups.has(normalizedGroup)) {
          errors.push(`${prefix}.groups[${index}]: duplicate group "${group}"`);
          continue;
        }
        seenGroups.add(normalizedGroup);
        groups.push(group);
      }
      normalized.groups = groups;
    } else {
      errors.push(`${prefix}.groups: must be an array of non-empty strings if present`);
    }
  }

  const hooks = normalizeInlineHookScripts(value.hooks, `${prefix}.hooks`, errors);
  if (hooks) {
    normalized.hooks = hooks;
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

  validateNoUnknownKeys({ allowedKeys: ROOT_HOOKS_ALLOWED_KEYS, errors, prefix, value });

  const { timeout } = value;
  const scripts = normalizeInlineHookScripts(value.scripts, `${prefix}.scripts`, errors);
  const normalized: NonNullable<Config["hooks"]> = {};

  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 2_147_483_647)
  ) {
    errors.push(`${prefix}.timeout: must be an integer from 1 through 2147483647 if present`);
  } else if (timeout !== undefined) {
    normalized.timeout = timeout;
  }

  if (scripts) {
    normalized.scripts = scripts;
  }

  return Object.keys(normalized).length > ZERO ? normalized : undefined;
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

  validateNoUnknownKeys({ allowedKeys: ROOT_SYNC_ALLOWED_KEYS, errors, prefix, value });

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
  if (value === "auto" || value === "sesh" || value === "herdr") {
    return value;
  }

  return undefined;
};

const normalizeSwitchMode = (value: unknown): SwitchMode | undefined => {
  if (
    value === "auto" ||
    value === "cd" ||
    value === "launch" ||
    value === "sesh" ||
    value === "herdr"
  ) {
    return value;
  }

  return undefined;
};

const normalizeCreateLaunchMode = (value: unknown): CreateLaunchMode | undefined => {
  if (value === "none") return value;
  return normalizeLaunchMode(value);
};

const normalizeCreateCommandDefaults = (
  value: unknown,
  scope: string,
  errors: string[],
  diagnostics: ConfigDiagnostic[],
  editorScoped = false,
): CreateCommandDefaults | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${scope}: must be an object if present`);
    return undefined;
  }

  validateNoUnknownKeys({
    allowedKeys: editorScoped ? EDITOR_CREATE_DEFAULTS_ALLOWED_KEYS : CREATE_DEFAULTS_ALLOWED_KEYS,
    errors,
    prefix: scope,
    value,
  });

  const normalized: CreateCommandDefaults = {};
  if (!editorScoped && value.baseBranch !== undefined) {
    if (typeof value.baseBranch === "string" && isValidRequestedBaseBranch(value.baseBranch)) {
      normalized.baseBranch = value.baseBranch;
    } else {
      errors.push(`${scope}.baseBranch: must be a valid Git branch name if present`);
    }
  }
  if (value.switch !== undefined) {
    if (typeof value.switch === "boolean") normalized.switch = value.switch;
    else errors.push(`${scope}.switch: must be a boolean if present`);
  }

  const rawLaunch = value.launch;
  const canonicalLaunch = normalizeCreateLaunchMode(rawLaunch);
  const legacyBoolean = typeof rawLaunch === "boolean" ? rawLaunch : undefined;
  if (rawLaunch !== undefined && canonicalLaunch === undefined && legacyBoolean === undefined) {
    errors.push(`${scope}.launch: must be one of "none", "auto", "sesh", or "herdr"`);
  }

  if (
    value.launchMode !== undefined &&
    value.launch_mode !== undefined &&
    value.launchMode !== value.launch_mode
  ) {
    errors.push(
      `${scope}.launchMode: ${JSON.stringify(value.launchMode)} conflicts with ${scope}.launch_mode: ${JSON.stringify(value.launch_mode)}; remove both legacy fields and set ${scope}.launch to one supported value`,
    );
    return Object.keys(normalized).length > ZERO ? normalized : undefined;
  }

  const camelLaunchMode = normalizeLaunchMode(value.launchMode);
  const snakeLaunchMode = normalizeLaunchMode(value.launch_mode);
  if (value.launchMode !== undefined && camelLaunchMode === undefined) {
    errors.push(`${scope}.launchMode: must be one of "auto", "sesh", or "herdr"`);
  }
  if (value.launch_mode !== undefined && snakeLaunchMode === undefined) {
    errors.push(`${scope}.launch_mode: must be one of "auto", "sesh", or "herdr"`);
  }
  const legacyLauncher = camelLaunchMode ?? snakeLaunchMode;
  let replacementLaunch = canonicalLaunch;
  let combinationValid = true;

  if (legacyBoolean === false) {
    if (legacyLauncher !== undefined) {
      const field = camelLaunchMode !== undefined ? "launchMode" : "launch_mode";
      errors.push(
        `${scope}.launch: false cannot be combined with legacy ${scope}.${field}: "${legacyLauncher}"; choose ${scope}.launch: "none" or "${legacyLauncher}"`,
      );
      combinationValid = false;
    } else replacementLaunch = "none";
  } else if (legacyBoolean === true) {
    replacementLaunch = legacyLauncher ?? "auto";
  } else if (canonicalLaunch === undefined) {
    replacementLaunch = legacyLauncher;
  } else if (legacyLauncher !== undefined) {
    const compatible =
      (canonicalLaunch === "auto" && legacyLauncher === "auto") ||
      ((canonicalLaunch === "sesh" || canonicalLaunch === "herdr") &&
        (legacyLauncher === "auto" || legacyLauncher === canonicalLaunch));
    if (!compatible) {
      const field = camelLaunchMode !== undefined ? "launchMode" : "launch_mode";
      errors.push(
        `${scope}.launch: "${canonicalLaunch}" conflicts with legacy ${scope}.${field}: "${legacyLauncher}"; choose ${scope}.launch: "${canonicalLaunch}" or "${legacyLauncher}"`,
      );
      combinationValid = false;
    }
  }

  if (replacementLaunch !== undefined && combinationValid) normalized.launch = replacementLaunch;

  const legacyFields: string[] = [];
  if (legacyBoolean !== undefined) legacyFields.push(`${scope}.launch`);
  if (camelLaunchMode !== undefined) legacyFields.push(`${scope}.launchMode`);
  if (snakeLaunchMode !== undefined) legacyFields.push(`${scope}.launch_mode`);
  if (legacyFields.length > ZERO && replacementLaunch !== undefined && combinationValid) {
    diagnostics.push({
      code: "DEPRECATED_CREATE_LAUNCH_FIELDS",
      fields: legacyFields,
      message: `${legacyFields.join(" and ")} ${legacyFields.length === 1 ? "is" : "are"} deprecated; use ${scope}.launch: "${replacementLaunch}" instead.`,
      replacementLaunch,
      scope,
    });
  }

  return Object.keys(normalized).length > ZERO ? normalized : undefined;
};

const normalizeSwitchCommandDefaults = (
  value: unknown,
  errors: string[],
  diagnostics: ConfigDiagnostic[],
): SwitchCommandDefaults | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const mode = normalizeSwitchMode(value.mode);
  if (value.mode !== undefined && mode === undefined) {
    errors.push('defaults.switch.mode: must be one of "auto", "cd", "launch", "sesh", or "herdr"');
  }

  if (
    value.launchMode !== undefined &&
    value.launch_mode !== undefined &&
    value.launchMode !== value.launch_mode
  ) {
    errors.push(
      `defaults.switch.launchMode: ${JSON.stringify(value.launchMode)} conflicts with defaults.switch.launch_mode: ${JSON.stringify(value.launch_mode)}; remove both legacy fields and set defaults.switch.mode to one supported value`,
    );
    return undefined;
  }

  const camelLaunchMode = normalizeLaunchMode(value.launchMode);
  const snakeLaunchMode = normalizeLaunchMode(value.launch_mode);
  if (value.launchMode !== undefined && camelLaunchMode === undefined) {
    errors.push('defaults.switch.launchMode: must be one of "auto", "sesh", or "herdr"');
  }
  if (value.launch_mode !== undefined && snakeLaunchMode === undefined) {
    errors.push('defaults.switch.launch_mode: must be one of "auto", "sesh", or "herdr"');
  }

  const launchMode = camelLaunchMode ?? snakeLaunchMode;
  const fields: string[] = [];
  if (camelLaunchMode !== undefined) {
    fields.push("defaults.switch.launchMode");
  }
  if (snakeLaunchMode !== undefined) {
    fields.push("defaults.switch.launch_mode");
  }

  if (launchMode === undefined) {
    return mode === undefined ? undefined : { mode };
  }

  let replacementMode = mode;
  if (launchMode === "auto") {
    replacementMode ??= "launch";
  } else if (mode === undefined || mode === "auto" || mode === "launch") {
    replacementMode = launchMode;
  } else if (mode === "cd" || mode !== launchMode) {
    const fieldLabel = fields.join(" and ");
    const legacyNoun = fields.length === TWO ? "fields" : "field";
    errors.push(
      `defaults.switch.mode: "${mode}" cannot be combined with legacy ${fieldLabel}: "${launchMode}"; remove the legacy ${legacyNoun} and choose defaults.switch.mode: "${mode}" or "${launchMode}"`,
    );
    return undefined;
  }

  if (replacementMode === undefined) {
    return undefined;
  }

  const fieldDescription = fields.length === TWO ? `${fields[0]} and ${fields[1]}` : fields[0];
  const verb = fields.length === TWO ? "are" : "is";
  diagnostics.push({
    code: "DEPRECATED_SWITCH_LAUNCH_MODE",
    fields,
    message: `${fieldDescription} ${verb} deprecated; use defaults.switch.mode: "${replacementMode}" instead.`,
    replacementMode,
  });

  return { mode: replacementMode };
};

const normalizeEditorCommandDefaults = (
  value: unknown,
  host: CreateDefaultsEditorHost,
  errors: string[],
  diagnostics: ConfigDiagnostic[],
): EditorCommandDefaults | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const createDefaults = normalizeCreateCommandDefaults(
    value.create,
    `defaults.editors.${host}.create`,
    errors,
    diagnostics,
    true,
  );
  if (!createDefaults) {
    return undefined;
  }

  return {
    create: createDefaults,
  };
};

const normalizeEditorDefaultsConfig = (
  value: unknown,
  errors: string[],
  diagnostics: ConfigDiagnostic[],
): EditorDefaultsConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: EditorDefaultsConfig = {};

  const vscodeDefaults = normalizeEditorCommandDefaults(
    value.vscode,
    "vscode",
    errors,
    diagnostics,
  );
  if (vscodeDefaults) {
    normalized.vscode = vscodeDefaults;
  }

  const cursorDefaults = normalizeEditorCommandDefaults(
    value.cursor,
    "cursor",
    errors,
    diagnostics,
  );
  if (cursorDefaults) {
    normalized.cursor = cursorDefaults;
  }

  const kiroDefaults = normalizeEditorCommandDefaults(value.kiro, "kiro", errors, diagnostics);
  if (kiroDefaults) {
    normalized.kiro = kiroDefaults;
  }

  if (Object.keys(normalized).length > ZERO) {
    return normalized;
  }

  return undefined;
};

const normalizeCommandDefaults = (
  value: unknown,
  errors: string[],
  diagnostics: ConfigDiagnostic[],
): CommandDefaultsConfig | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const createDefaults = normalizeCreateCommandDefaults(
    value.create,
    "defaults.create",
    errors,
    diagnostics,
  );
  const editorDefaults = normalizeEditorDefaultsConfig(value.editors, errors, diagnostics);
  const switchDefaults = normalizeSwitchCommandDefaults(value.switch, errors, diagnostics);

  const normalized: CommandDefaultsConfig = {};

  if (createDefaults) {
    normalized.create = createDefaults;
  }

  if (editorDefaults) {
    normalized.editors = editorDefaults;
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
  diagnostics: ConfigDiagnostic[];
  migratedFromVersion?: string;
} => {
  const errors: string[] = [];
  const diagnostics: ConfigDiagnostic[] = [];

  if (!isRecord(config)) {
    throw new ConfigValidationError(["Config must be an object"]);
  }

  validateNoUnknownKeys({ allowedKeys: ROOT_ALLOWED_KEYS, errors, prefix: "", value: config });

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
  const defaults = normalizeCommandDefaults(config.defaults, errors, diagnostics);

  if (schema !== undefined && (typeof schema !== "string" || schema.trim() === "")) {
    errors.push("$schema: must be a non-empty string if present");
  }

  if (typeof reposDir !== "string" || reposDir.trim() === "") {
    errors.push("reposDir: must be a non-empty string");
  }

  const normalizedRepos: Record<string, RepoConfig> = {};
  if (isRecord(reposRaw)) {
    for (const [repoName, repoConfig] of Object.entries(reposRaw)) {
      const normalized = normalizeRepoConfig(repoName, repoConfig, errors);
      if (normalized) {
        normalizedRepos[repoName] = normalized;
      }
    }
  } else {
    errors.push("repos: must be an object");
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
    diagnostics,
    migratedFromVersion: versionInfo.migratedFromVersion,
  };
};

export const normalizeConfig = (config: unknown): Config => normalizeConfigInternal(config).config;

export const normalizeConfigWithDiagnostics = (config: unknown): ConfigNormalizationResult => {
  const normalized = normalizeConfigInternal(config);
  return { config: normalized.config, diagnostics: normalized.diagnostics };
};

const emittedConfigDiagnostics = new Set<string>();

const emitConfigDiagnostics = (configPath: string, diagnostics: ConfigDiagnostic[]): void => {
  for (const diagnostic of diagnostics) {
    const key = `${configPath}\u0000${diagnostic.message}`;
    if (emittedConfigDiagnostics.has(key)) {
      continue;
    }
    emittedConfigDiagnostics.add(key);
    warn(diagnostic.message);
  }
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
export const validateConfig = (config: unknown): asserts config is Config => {
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
export const loadConfig = async (repoPath: string): Promise<Config> => {
  const configPath = getConfigPath(repoPath);

  // Check if file exists
  const hasConfig = await configExists(repoPath);
  if (!hasConfig) {
    throw new ConfigNotFoundError(configPath);
  }

  // Read file
  let text = "";
  try {
    const file = runtime.file(configPath);
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
  emitConfigDiagnostics(configPath, normalized.diagnostics);

  if (normalized.migratedFromVersion && normalized.diagnostics.length === ZERO) {
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

  const normalized = normalizeConfigInternal(data);
  emitConfigDiagnostics(configPath, normalized.diagnostics);
  return normalized.config;
};

/**
 * Load configuration from local filesystem first, then optionally from tracked
 * repository content in the default branch.
 */
export const loadConfigWithFallback = async (
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

  if (repoConfig.copy) {
    normalized.copy = repoConfig.copy;
  }

  if (repoConfig.symlink) {
    normalized.symlink = repoConfig.symlink;
  }

  if (repoConfig.groups) {
    normalized.groups = repoConfig.groups;
  }

  if (repoConfig.hooks) {
    normalized.hooks = repoConfig.hooks;
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
export const serializeConfig = (config: Config): string =>
  JSON.stringify(normalizePersistedConfig(normalizeConfig(config)), null, TWO);

export const saveConfig = async (repoPath: string, config: Config): Promise<void> => {
  const configPath = getConfigPath(repoPath);
  const configDir = dirname(configPath);

  try {
    await mkdir(configDir, { recursive: true });
    const json = serializeConfig(config);
    await runtime.write(configPath, json);
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
export const addRepo = async (
  repoPath: string,
  name: string,
  repoConfig: RepoConfig,
): Promise<void> => {
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
export const removeRepo = async (repoPath: string, name: string): Promise<void> => {
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
export const loadWorkspaceRepositories = async (
  workspaceRoots: string | WorkspaceRepositoryRoots,
  options: { allowUnavailableMaterializationSource?: boolean } = {},
): Promise<{ config: Config; repositories: WorkspaceRepository[] }> => {
  const { configurationRoot, executionRoot } =
    typeof workspaceRoots === "string"
      ? { configurationRoot: workspaceRoots, executionRoot: workspaceRoots }
      : workspaceRoots;
  const config = await loadConfig(configurationRoot);
  const repositories: WorkspaceRepository[] = [];
  const mainName = basename(configurationRoot);

  repositories.push({
    name: mainName,
    path: resolve(executionRoot),
  });

  for (const [name, repoConfig] of Object.entries(config.repos)) {
    const repositoryPath = resolve(executionRoot, repoConfig.path);
    const hasMaterialization =
      (repoConfig.copy?.length ?? ZERO) > ZERO || (repoConfig.symlink?.length ?? ZERO) > ZERO;
    let projectedPath = repositoryPath;
    let sourcePath: string | undefined;
    if (hasMaterialization) {
      let repositoryAvailable = false;
      try {
        projectedPath = await realpath(repositoryPath);
        repositoryAvailable = true;
      } catch (error) {
        const repositoryMissing =
          typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
        if (!repositoryMissing && !options.allowUnavailableMaterializationSource) throw error;
      }
      if (repositoryAvailable) {
        try {
          sourcePath = await resolveGitPrimarySourceCheckout(projectedPath, name);
        } catch (error) {
          if (!options.allowUnavailableMaterializationSource) throw error;
        }
      }
    }
    repositories.push({
      copy: repoConfig.copy,
      gitUrl: repoConfig.gitUrl,
      groups: repoConfig.groups,
      name,
      path: projectedPath,
      sourcePath,
      symlink: repoConfig.symlink,
    });
  }

  return { config, repositories };
};

export const resolveGitPrimarySourceCheckout = async (
  repositoryPath: string,
  repositoryName: string,
): Promise<string> => {
  let output: string;
  try {
    output = (await exec(["worktree", "list", "--porcelain"], repositoryPath)).stdout;
  } catch (error) {
    throw new ConfigError(
      `Repository '${repositoryName}' has no usable canonical source checkout for materialization.`,
      error as Error,
      { repositoryName, repositoryPath },
    );
  }

  const primaryRecord = output.split(/\r?\n\r?\n/).find((record) => record.trim().length > ZERO);
  if (primaryRecord) {
    const lines = primaryRecord.split(/\r?\n/);
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    if (!lines.includes("bare") && worktreeLine) {
      const candidate = worktreeLine.slice("worktree ".length);
      try {
        return await realpath(candidate);
      } catch {
        // The Git-primary checkout itself is unusable; linked worktrees are not substitutes.
      }
    }
  }

  throw new ConfigError(
    `Repository '${repositoryName}' has no usable canonical source checkout for materialization.`,
    undefined,
    { repositoryName, repositoryPath },
  );
};

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
export const repairRepositoryGitUrls = async (
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
