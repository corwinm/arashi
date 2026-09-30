import type { T3Settings } from "./t3-settings.ts";
import { createHash } from "crypto";
import { lstatSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "path";
import {
  ConfigError,
  ConfigParseError,
  ConfigValidationError,
  CURRENT_CONFIG_VERSION,
  normalizeConfig,
  type CommandDefaultsConfig,
  type Config,
  type ConfigVersion,
  type WorktreeNamingConfig,
} from "./config.ts";
import { runtime } from "./runtime.ts";
import { WorktreeLocationValidationError } from "./worktree-location.ts";

export const DEFAULT_USER_CONFIG_SCHEMA_URL =
  "https://unpkg.com/arashi/schema/user-config.schema.json";

export interface UserConfig {
  /** JSON Schema URL for editor validation/autocomplete */
  $schema?: string;
  /** User configuration schema version */
  version: ConfigVersion;
  /** Personal command and editor defaults */
  defaults?: CommandDefaultsConfig;
  /** Personal fallback worktree directory; absolute paths are repository-qualified */
  worktreesDir?: string;
  /** Personal fallback worktree naming policy */
  worktreeNaming?: WorktreeNamingConfig;
}

export type EffectiveConfigSource = "built-in" | "user" | "workspace" | "cli";

export interface EffectivePersonalConfig {
  config: Config;
  files: { user: string | null; workspace: string | null };
  mainRoot: string;
  sources: Record<string, EffectiveConfigSource>;
  userConfig: UserConfig | null;
  worktreesBase: string;
}

const USER_ROOT_KEYS = new Set([
  "$schema",
  "version",
  "defaults",
  "worktreesDir",
  "worktreeNaming",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getUserConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
  fallbackHome: () => string = homedir,
): string =>
  join(env.HOME?.trim() || env.USERPROFILE?.trim() || fallbackHome(), ".arashi", "config.json");

export const normalizeUserConfig = (value: unknown): UserConfig => {
  if (!isRecord(value)) throw new ConfigValidationError(["Config must be an object"]);
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!USER_ROOT_KEYS.has(key)) errors.push(`${key}: unknown property`);
  }
  if (value.version !== CURRENT_CONFIG_VERSION) {
    errors.push(`version: must be "${CURRENT_CONFIG_VERSION}"`);
  }
  if (value.$schema !== undefined && (typeof value.$schema !== "string" || !value.$schema.trim())) {
    errors.push("$schema: must be a non-empty string if present");
  }
  if (value.worktreesDir !== undefined) {
    if (typeof value.worktreesDir !== "string" || !value.worktreesDir.trim()) {
      errors.push("worktreesDir: must be a non-empty string if present");
    } else if (/^[a-z]:($|[^\\/])/i.test(value.worktreesDir.trim())) {
      errors.push(
        "worktreesDir: Windows drive-relative paths are not supported; use an absolute or repository-relative path",
      );
    } else if (
      process.platform !== "win32" &&
      win32.isAbsolute(value.worktreesDir.trim()) &&
      !isAbsolute(value.worktreesDir.trim())
    ) {
      errors.push("worktreesDir: Windows absolute paths are not valid on this platform");
    }
  }

  let normalized: Config | undefined;
  try {
    normalized = normalizeConfig({
      version: CURRENT_CONFIG_VERSION,
      reposDir: "./repos",
      repos: {},
      ...(value.defaults === undefined ? {} : { defaults: value.defaults }),
      ...(value.worktreeNaming === undefined ? {} : { worktreeNaming: value.worktreeNaming }),
    });
  } catch (error) {
    if (error instanceof ConfigValidationError) errors.push(...error.context.errors);
    else throw error;
  }
  if (errors.length > 0) throw new ConfigValidationError(errors);

  return {
    version: CURRENT_CONFIG_VERSION,
    ...(typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
    ...(normalized?.defaults ? { defaults: normalized.defaults } : {}),
    ...(typeof value.worktreesDir === "string" ? { worktreesDir: value.worktreesDir.trim() } : {}),
    ...(normalized?.worktreeNaming ? { worktreeNaming: normalized.worktreeNaming } : {}),
  };
};

export const loadUserConfig = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ config: UserConfig; path: string } | null> => {
  const path = getUserConfigPath(env);
  const file = runtime.file(path);
  if (!(await file.exists())) return null;
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    throw new ConfigError(`Failed to read user configuration file at ${path}`, error as Error, {
      path,
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigParseError(path, error as Error);
  }
  try {
    return { config: normalizeUserConfig(data), path };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw new ConfigError(
        `User configuration validation failed at ${path}:\n${error.context.errors.map((message) => `  - ${message}`).join("\n")}`,
        error,
        { errors: error.context.errors, path },
      );
    }
    throw error;
  }
};

const leaf = <T>(
  workspace: T | undefined,
  user: T | undefined,
  builtIn: T,
): [T, EffectiveConfigSource] =>
  workspace !== undefined
    ? [workspace, "workspace"]
    : user !== undefined
      ? [user, "user"]
      : [builtIn, "built-in"];

const optionalLeaf = <T>(
  workspace: T | undefined,
  user: T | undefined,
): [T | undefined, EffectiveConfigSource] =>
  workspace !== undefined
    ? [workspace, "workspace"]
    : user !== undefined
      ? [user, "user"]
      : [undefined, "built-in"];

const qualifyAbsoluteUserRoot = (configuredRoot: string, directory: string): string => {
  const canonical = resolve(configuredRoot);
  const name = basename(canonical).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repository";
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  return join(directory, `${name}-${digest}`);
};

const resolveExistingAncestors = (path: string): string => {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync.native(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          throw new WorktreeLocationValidationError(
            "User worktreesDir traverses an unresolved symbolic link.",
          );
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
};

export const resolveUserWorktreesBase = (mainRoot: string, directory: string): string => {
  const canonicalMain = resolveExistingAncestors(mainRoot);
  const base = isAbsolute(directory)
    ? qualifyAbsoluteUserRoot(canonicalMain, directory)
    : resolve(canonicalMain, directory);
  const canonicalBase = resolveExistingAncestors(base);
  if (canonicalBase === canonicalMain) {
    throw new WorktreeLocationValidationError(
      "User worktreesDir must not resolve to the primary repository root. Choose a subdirectory or an external directory.",
    );
  }
  return canonicalBase;
};

export const resolveEffectivePersonalConfig = async (options: {
  builtInWorktreesDir: string;
  mainRoot: string;
  workspaceConfig: Config;
  workspaceRoot?: string;
  workspaceConfigPath?: string | null;
  workspaceWorktreesDirAuthored?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<EffectivePersonalConfig> => {
  const loadedUser = await loadUserConfig(options.env);
  const user = loadedUser?.config;
  const workspace = options.workspaceConfig;
  const sources: Record<string, EffectiveConfigSource> = {};
  const [createSwitch, createSwitchSource] = optionalLeaf(
    workspace.defaults?.create?.switch,
    user?.defaults?.create?.switch,
  );
  const [createLaunch, createLaunchSource] = optionalLeaf(
    workspace.defaults?.create?.launch,
    user?.defaults?.create?.launch,
  );
  const [switchMode, switchModeSource] = optionalLeaf(
    workspace.defaults?.switch?.mode,
    user?.defaults?.switch?.mode,
  );
  sources["defaults.create.switch"] = createSwitchSource;
  sources["defaults.create.launch"] = createLaunchSource;
  sources["defaults.switch.mode"] = switchModeSource;

  const t3Defaults: T3Settings = {};
  for (const field of ["baseDir", "cli", "provider", "model", "effort"] as const) {
    const [value, source] = optionalLeaf(
      workspace.defaults?.t3?.[field],
      user?.defaults?.t3?.[field],
    );
    sources[`defaults.t3.${field}`] = source;
    if (value !== undefined) t3Defaults[field] = value;
  }

  const editorDefaults: NonNullable<CommandDefaultsConfig["editors"]> = {};
  for (const host of ["vscode", "cursor", "kiro"] as const) {
    const [editorSwitch, editorSwitchSource] = optionalLeaf(
      workspace.defaults?.editors?.[host]?.create?.switch,
      user?.defaults?.editors?.[host]?.create?.switch,
    );
    const [editorLaunch, editorLaunchSource] = optionalLeaf(
      workspace.defaults?.editors?.[host]?.create?.launch,
      user?.defaults?.editors?.[host]?.create?.launch,
    );
    sources[`defaults.editors.${host}.create.switch`] = editorSwitchSource;
    sources[`defaults.editors.${host}.create.launch`] = editorLaunchSource;
    if (editorSwitch !== undefined || editorLaunch !== undefined) {
      editorDefaults[host] = {
        create: {
          ...(editorSwitch === undefined ? {} : { switch: editorSwitch }),
          ...(editorLaunch === undefined ? {} : { launch: editorLaunch }),
        },
      };
    }
  }

  const [style, styleSource] = optionalLeaf(
    workspace.worktreeNaming?.style,
    user?.worktreeNaming?.style,
  );
  const [branchSlashes, branchSlashesSource] = optionalLeaf(
    workspace.worktreeNaming?.branchSlashes,
    user?.worktreeNaming?.branchSlashes,
  );
  const [maxPathLength, maxPathLengthSource] = optionalLeaf(
    workspace.worktreeNaming?.maxPathLength,
    user?.worktreeNaming?.maxPathLength,
  );
  sources["worktreeNaming.style"] = styleSource;
  sources["worktreeNaming.branchSlashes"] = branchSlashesSource;
  sources["worktreeNaming.maxPathLength"] = maxPathLengthSource;

  const workspaceDirectory = options.workspaceWorktreesDirAuthored
    ? workspace.worktreesDir
    : undefined;
  const [authoredDirectory, worktreesSource] = leaf(
    workspaceDirectory,
    user?.worktreesDir,
    options.builtInWorktreesDir,
  );
  sources.worktreesDir = worktreesSource;
  // Config provenance may identify tracked bare-repository content rather than
  // a filesystem path. Use the actual workspace root for workspace-owned paths.
  const workspaceRoot = options.workspaceRoot ?? options.mainRoot;
  const worktreesBase =
    worktreesSource === "user"
      ? resolveUserWorktreesBase(options.mainRoot, authoredDirectory)
      : resolve(workspaceRoot, authoredDirectory);

  const effective: Config = {
    ...workspace,
    defaults:
      createSwitch !== undefined ||
      createLaunch !== undefined ||
      switchMode !== undefined ||
      Object.keys(editorDefaults).length > 0 ||
      Object.keys(t3Defaults).length > 0
        ? {
            ...(createSwitch === undefined && createLaunch === undefined
              ? {}
              : {
                  create: {
                    ...(createLaunch === undefined ? {} : { launch: createLaunch }),
                    ...(createSwitch === undefined ? {} : { switch: createSwitch }),
                  },
                }),
            ...(Object.keys(editorDefaults).length > 0 ? { editors: editorDefaults } : {}),
            ...(Object.keys(t3Defaults).length > 0 ? { t3: t3Defaults } : {}),
            ...(switchMode === undefined ? {} : { switch: { mode: switchMode } }),
          }
        : undefined,
    worktreeNaming:
      style !== undefined || branchSlashes !== undefined || maxPathLength !== undefined
        ? {
            ...(style === undefined ? {} : { style }),
            ...(branchSlashes === undefined ? {} : { branchSlashes }),
            ...(maxPathLength === undefined ? {} : { maxPathLength }),
          }
        : undefined,
    worktreesDir: worktreesSource === "user" ? worktreesBase : authoredDirectory,
  };
  return {
    config: effective,
    files: {
      user: loadedUser?.path ?? null,
      workspace: options.workspaceConfigPath ?? null,
    },
    mainRoot: options.mainRoot,
    sources,
    userConfig: user ?? null,
    worktreesBase,
  };
};
