import { basename, dirname, isAbsolute, parse, resolve } from "path";
import { stat } from "fs/promises";
import {
  ConfigNotFoundError,
  ConfigParseError,
  CURRENT_CONFIG_VERSION,
  findWorkspaceRoot,
  loadConfig,
} from "./config.ts";
import type { Config, WorkspaceRepository, WorkspaceRepositoryRoots } from "./config.ts";
import { exec } from "./git.ts";
import { createJsonErrorEnvelope, writeJsonEnvelope } from "./json-output.ts";
import { error as logError } from "./logger.ts";
import { DEFAULT_WORKTREES_DIR } from "./worktree-location.ts";

export { ConfigParseError } from "./config.ts";

interface WorkspaceContextBase {
  invocationPath: string;
  workspaceRoot: string;
}

export interface ConfiguredWorkspaceContext extends WorkspaceContextBase {
  config: Config;
  mode: "configured";
}

export interface StandaloneWorkspaceContext extends WorkspaceContextBase {
  config: Config;
  mainRoot: string;
  mode: "standalone";
  repository: WorkspaceRepository;
}

export interface UnavailableWorkspaceContext {
  invocationPath: string;
  mode: "unavailable";
  reason: "bare-repository" | "not-git-repository" | "missing-worktrees-directory";
}

export type WorkspaceContext =
  | ConfiguredWorkspaceContext
  | StandaloneWorkspaceContext
  | UnavailableWorkspaceContext;

export interface WorkspaceJsonMetadata extends Record<string, unknown> {
  mode: "configured" | "standalone";
  repositoriesBase: string;
  workspaceRoot: string;
  worktreesBase: string;
}

export const workspaceJsonMetadata = (
  context: ConfiguredWorkspaceContext | StandaloneWorkspaceContext,
): WorkspaceJsonMetadata => ({
  mode: context.mode,
  repositoriesBase:
    context.mode === "standalone"
      ? context.mainRoot
      : resolve(context.workspaceRoot, context.config.reposDir),
  workspaceRoot: context.workspaceRoot,
  worktreesBase:
    context.mode === "standalone"
      ? resolve(context.mainRoot, ".worktrees")
      : resolve(context.workspaceRoot, context.config.worktreesDir ?? DEFAULT_WORKTREES_DIR),
});

const standaloneConfig = (): Config => ({
  repos: {},
  reposDir: "./repos",
  version: CURRENT_CONFIG_VERSION,
  worktreesDir: ".worktrees",
});

async function discoverConfigured(startPath: string): Promise<ConfiguredWorkspaceContext | null> {
  try {
    const workspaceRoot = await findWorkspaceRoot(startPath);
    return {
      config: await loadConfig(workspaceRoot),
      invocationPath: startPath,
      mode: "configured",
      workspaceRoot,
    };
  } catch (error) {
    if (error instanceof ConfigNotFoundError) return null;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the primary, non-bare worktree recorded by Git for an invocation repository. */
export async function resolveGitMainWorktree(invocationPath: string): Promise<string | null> {
  const absoluteInvocationPath = resolve(invocationPath);
  try {
    const bare = await exec(["rev-parse", "--is-bare-repository"], absoluteInvocationPath);
    if (bare.stdout.trim() === "true") return null;

    // Resolve the common directory as an absolute path as part of validating that
    // this is a shared non-bare repository. This also handles relative output and
    // repositories created with --separate-git-dir.
    const common = await exec(["rev-parse", "--git-common-dir"], absoluteInvocationPath);
    const commonDir = common.stdout.trim();
    const absoluteCommonDir = isAbsolute(commonDir)
      ? commonDir
      : resolve(absoluteInvocationPath, commonDir);
    await stat(absoluteCommonDir);

    const gitDirectory = await exec(["rev-parse", "--git-dir"], absoluteInvocationPath);
    const rawGitDirectory = gitDirectory.stdout.trim();
    const absoluteGitDirectory = isAbsolute(rawGitDirectory)
      ? rawGitDirectory
      : resolve(absoluteInvocationPath, rawGitDirectory);
    if (resolve(absoluteGitDirectory) === resolve(absoluteCommonDir)) {
      const topLevel = await exec(["rev-parse", "--show-toplevel"], absoluteInvocationPath);
      return resolve(topLevel.stdout.trim());
    }

    const listing = await exec(
      ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
      absoluteInvocationPath,
    );
    const firstWorktree = listing.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (!firstWorktree) return null;
    const listedRoot = resolve(firstWorktree);
    if (listedRoot === resolve(absoluteCommonDir)) {
      return null;
    }
    return listedRoot;
  } catch {
    return null;
  }
}

/**
 * Resolve configured, implicit standalone, or unavailable workspace state.
 * Existing configuration is always loaded (and any error propagated) before
 * the zero-config convention is considered.
 */
export async function resolveWorkspaceContext(
  invocationPath: string = process.cwd(),
): Promise<WorkspaceContext> {
  const absoluteInvocationPath = resolve(invocationPath);
  const invocationConfigured = await discoverConfigured(absoluteInvocationPath);
  if (invocationConfigured) return invocationConfigured;

  const mainRoot = await resolveGitMainWorktree(absoluteInvocationPath);
  if (!mainRoot) {
    let reason: UnavailableWorkspaceContext["reason"] = "not-git-repository";
    try {
      const bare = await exec(["rev-parse", "--is-bare-repository"], absoluteInvocationPath);
      if (bare.stdout.trim() === "true") reason = "bare-repository";
    } catch {
      // The default reason is correct when Git cannot inspect the invocation.
    }
    return { invocationPath: absoluteInvocationPath, mode: "unavailable", reason };
  }

  const mainConfigured = await discoverConfigured(mainRoot);
  if (mainConfigured) return { ...mainConfigured, invocationPath: absoluteInvocationPath };

  if (!(await isDirectory(resolve(mainRoot, ".worktrees")))) {
    return {
      invocationPath: absoluteInvocationPath,
      mode: "unavailable",
      reason: "missing-worktrees-directory",
    };
  }

  return {
    config: standaloneConfig(),
    invocationPath: absoluteInvocationPath,
    mainRoot,
    mode: "standalone",
    repository: { name: basename(mainRoot), path: mainRoot },
    workspaceRoot: mainRoot,
  };
}

export class ConfiguredWorkspaceRequiredError extends Error {
  readonly code = "CONFIGURED_WORKSPACE_REQUIRED";
  readonly details: { command: string; mode: "standalone" };

  constructor(commandName: string) {
    super(
      `arashi ${commandName} requires a configured workspace. Run "arashi init" (without --zero-config) to enable repository coordination.`,
    );
    this.details = { command: commandName, mode: "standalone" };
    this.name = "ConfiguredWorkspaceRequiredError";
  }
}

export async function assertConfiguredWorkspaceForCommand(
  commandName: string,
  invocationPath: string = process.cwd(),
): Promise<ConfiguredWorkspaceContext> {
  const context = await resolveWorkspaceContext(invocationPath);
  requireConfiguredWorkspace(context, commandName);
  return context;
}

/** Preserve configured discovery cost while enriching only its failure path for standalone mode. */
export async function findConfiguredWorkspaceRoot(
  commandName: string,
  invocationPath: string = process.cwd(),
): Promise<string> {
  try {
    return await findWorkspaceRoot(invocationPath);
  } catch (error) {
    const context = await resolveWorkspaceContext(invocationPath);
    if (context.mode === "standalone") throw new ConfiguredWorkspaceRequiredError(commandName);
    throw error;
  }
}

/**
 * Resolve where configured state is stored and which coordinated parent tree
 * lifecycle commands should operate on. Direct bare-root invocations keep both
 * roots at the configured bare repository.
 */
export async function findConfiguredWorkspaceRoots(
  commandName: string,
  invocationPath: string = process.cwd(),
): Promise<WorkspaceRepositoryRoots> {
  const configurationRoot = await findConfiguredWorkspaceRoot(commandName, invocationPath);
  const absoluteInvocationPath = resolve(invocationPath);
  const filesystemRoot = parse(absoluteInvocationPath).root;
  let currentPath = absoluteInvocationPath;

  while (true) {
    try {
      const common = await exec(["rev-parse", "--git-common-dir"], currentPath);
      const rawCommonDirectory = common.stdout.trim();
      const commonDirectory = isAbsolute(rawCommonDirectory)
        ? resolve(rawCommonDirectory)
        : resolve(currentPath, rawCommonDirectory);

      if (commonDirectory === resolve(configurationRoot)) {
        const bare = await exec(["rev-parse", "--is-bare-repository"], currentPath);
        if (bare.stdout.trim() === "true") {
          return { configurationRoot, executionRoot: configurationRoot };
        }

        const topLevel = await exec(["rev-parse", "--show-toplevel"], currentPath);
        return { configurationRoot, executionRoot: resolve(topLevel.stdout.trim()) };
      }
    } catch {
      // A nested child may have unrelated Git metadata; continue into its parent.
    }

    if (currentPath === filesystemRoot) {
      break;
    }
    currentPath = dirname(currentPath);
  }

  return { configurationRoot, executionRoot: configurationRoot };
}

export async function throwIfStandaloneWorkspace(
  commandName: string,
  invocationPath: string = process.cwd(),
): Promise<void> {
  const context = await resolveWorkspaceContext(invocationPath);
  if (context.mode === "standalone") throw new ConfiguredWorkspaceRequiredError(commandName);
}

export function requireAvailableWorkspace(
  context: WorkspaceContext,
): asserts context is Exclude<WorkspaceContext, UnavailableWorkspaceContext> {
  if (context.mode === "unavailable") {
    throw new ConfigNotFoundError(`${context.invocationPath}/.arashi/config.json`);
  }
}

export function requireConfiguredWorkspace(
  context: WorkspaceContext,
  commandName: string,
): asserts context is ConfiguredWorkspaceContext {
  requireAvailableWorkspace(context);
  if (context.mode !== "configured") throw new ConfiguredWorkspaceRequiredError(commandName);
}

/** Reject a coordination-only command when the implicit standalone trigger is active. */
export async function rejectStandaloneForConfiguredCommand(
  commandName: string,
  json = false,
): Promise<boolean> {
  const context = await resolveWorkspaceContext();
  if (context.mode !== "standalone") return false;
  const configuredError = new ConfiguredWorkspaceRequiredError(commandName);
  if (json) {
    writeJsonEnvelope(
      createJsonErrorEnvelope(commandName, {
        code: configuredError.code,
        details: { mode: "standalone", workspaceRoot: context.mainRoot },
        message: configuredError.message,
      }),
    );
  } else logError(configuredError.message);
  return true;
}
