import { access, lstat, mkdir, readFile, rmdir, unlink, writeFile } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";
import { configExists, CURRENT_CONFIG_VERSION } from "./config.ts";
import { exec } from "./git.ts";
import { parseGitIgnoreVerbose } from "./git-ignore.ts";
import { resolveGitMainWorktree } from "./workspace-context.ts";
import { resolveEffectivePersonalConfig } from "./user-config.ts";
import { standaloneIgnoreLayout } from "./worktree-location.ts";

export interface ZeroConfigBootstrapResult {
  attempted: { localExclude: boolean; worktreesDirectory: boolean };
  changed: boolean;
  dryRun: boolean;
  finalState: { localExcludeChanged: boolean; worktreesDirectoryChanged: boolean };
  localExclude: {
    changed: boolean;
    path: string;
    planned: boolean;
    rule: string;
    source?: string;
  };
  mode: "standalone";
  restored: boolean;
  workspaceRoot: string;
  worktreesDirectory: { changed: boolean; path: string; planned: boolean };
}

export class ZeroConfigBootstrapError extends Error {
  readonly code = "ZERO_CONFIG_BOOTSTRAP_FAILED";
  readonly details: ZeroConfigBootstrapErrorDetails;

  constructor(message: string, details: Partial<ZeroConfigBootstrapErrorDetails> = {}) {
    super(message);
    this.details = {
      attempted: details.attempted ?? { localExclude: false, worktreesDirectory: false },
      finalState: details.finalState ?? {
        localExcludeChanged: false,
        worktreesDirectoryChanged: false,
      },
      mode: "standalone",
      originalFailure: details.originalFailure ?? message,
      restorationWarnings: details.restorationWarnings ?? [],
      restored: details.restored ?? { localExclude: false, worktreesDirectory: false },
      ...(details.workspaceRoot ? { workspaceRoot: details.workspaceRoot } : {}),
    };
    this.name = "ZeroConfigBootstrapError";
  }
}

export interface ZeroConfigBootstrapErrorDetails {
  attempted: { localExclude: boolean; worktreesDirectory: boolean };
  finalState: { localExcludeChanged: boolean; worktreesDirectoryChanged: boolean };
  mode: "standalone";
  originalFailure: string;
  restorationWarnings: string[];
  restored: { localExclude: boolean; worktreesDirectory: boolean };
  workspaceRoot?: string;
}

export interface ZeroConfigBootstrapDependencies {
  effectiveIgnore: typeof effectiveIgnore;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rmdir: typeof rmdir;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function effectiveIgnore(
  root: string,
  path: string,
): Promise<{ ignored: boolean; source?: string }> {
  try {
    const result = await exec(["check-ignore", "--no-index", "-v", path], root);
    const evidence = parseGitIgnoreVerbose(result.stdout);
    return {
      ignored: evidence.ignored,
      ...(evidence.metadata ? { source: evidence.metadata } : {}),
    };
  } catch {
    return { ignored: false };
  }
}

async function localExcludePath(root: string): Promise<string> {
  const result = await exec(["rev-parse", "--git-path", "info/exclude"], root);
  const path = result.stdout.trim();
  return isAbsolute(path) ? path : resolve(root, path);
}

function appendRule(original: Buffer, rule: string): Buffer {
  const text = original.toString("utf8");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const boundary = text.length > 0 && !text.endsWith("\n") ? newline : "";
  return Buffer.from(`${text}${boundary}${rule}${newline}`);
}

export async function bootstrapZeroConfig(
  invocationPath: string,
  options: {
    dependencies?: Partial<ZeroConfigBootstrapDependencies>;
    dryRun?: boolean;
  } = {},
): Promise<ZeroConfigBootstrapResult> {
  const dependencies: ZeroConfigBootstrapDependencies = {
    effectiveIgnore,
    lstat,
    mkdir,
    readFile,
    rmdir,
    unlink,
    writeFile,
    ...options.dependencies,
  };
  const mainRoot = await resolveGitMainWorktree(invocationPath);
  if (!mainRoot) {
    throw new ZeroConfigBootstrapError(
      "Zero-config initialization requires an existing non-bare Git repository.",
    );
  }
  if (await configExists(mainRoot)) {
    throw new ZeroConfigBootstrapError(
      "A configured Arashi workspace already exists; zero-config standalone mode cannot replace it.",
    );
  }

  const effective = await resolveEffectivePersonalConfig({
    builtInWorktreesDir: ".worktrees",
    mainRoot,
    workspaceConfig: {
      repos: {},
      reposDir: "./repos",
      version: CURRENT_CONFIG_VERSION,
      worktreesDir: ".worktrees",
    },
    workspaceConfigPath: null,
    workspaceWorktreesDirAuthored: false,
  });
  const worktreesPath = effective.worktreesBase;
  const {
    applicable: baseIsInsideRepository,
    probe,
    rule,
  } = standaloneIgnoreLayout(mainRoot, worktreesPath);
  const excludePath = await localExcludePath(mainRoot);
  const directoryExists = await exists(worktreesPath);
  const initialIgnore = baseIsInsideRepository
    ? await dependencies.effectiveIgnore(mainRoot, probe)
    : { ignored: true };
  const needsRule = baseIsInsideRepository && !initialIgnore.ignored;
  const result: ZeroConfigBootstrapResult = {
    attempted: { localExclude: false, worktreesDirectory: false },
    changed: !options.dryRun && (!directoryExists || needsRule),
    dryRun: options.dryRun === true,
    finalState: {
      localExcludeChanged: !options.dryRun && needsRule,
      worktreesDirectoryChanged: !options.dryRun && !directoryExists,
    },
    localExclude: {
      changed: !options.dryRun && needsRule,
      path: excludePath,
      planned: needsRule,
      rule,
      ...(initialIgnore.source ? { source: initialIgnore.source } : {}),
    },
    mode: "standalone",
    restored: false,
    workspaceRoot: mainRoot,
    worktreesDirectory: {
      changed: !options.dryRun && !directoryExists,
      path: worktreesPath,
      planned: !directoryExists,
    },
  };
  if (options.dryRun) {
    return result;
  }

  let originalExclude: Buffer | null = null;
  let excludeExisted = false;
  const createdDirectories: string[] = [];
  let excludeWritten = false;
  try {
    if (!directoryExists) {
      result.attempted.worktreesDirectory = true;
      const missing: string[] = [];
      let ancestor = worktreesPath;
      while (!(await exists(ancestor))) {
        missing.push(ancestor);
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      for (const directory of missing.toReversed()) {
        await dependencies.mkdir(directory);
        createdDirectories.push(directory);
      }
    }
    if (needsRule) {
      result.attempted.localExclude = true;
      try {
        const metadata = await dependencies.lstat(excludePath);
        if (metadata.isSymbolicLink()) {
          throw new ZeroConfigBootstrapError(
            `Refusing to modify symlinked repository-local exclude file: ${excludePath}`,
          );
        }
        originalExclude = await dependencies.readFile(excludePath);
        excludeExisted = true;
      } catch (error) {
        if (error instanceof ZeroConfigBootstrapError) {
          throw error;
        }
        originalExclude = Buffer.alloc(0);
      }
      await dependencies.mkdir(dirname(excludePath), { recursive: true });
      await dependencies.writeFile(excludePath, appendRule(originalExclude, rule));
      excludeWritten = true;
      const verified = await dependencies.effectiveIgnore(mainRoot, probe);
      if (!verified.ignored) {
        throw new ZeroConfigBootstrapError(
          `The repository-local ${rule} exclude is defeated by a higher-precedence Git ignore rule; restore ignore safety manually.`,
        );
      }
      result.localExclude.source = verified.source;
    }
    return result;
  } catch (error) {
    const restorationFailures: string[] = [];
    const restored = { localExclude: false, worktreesDirectory: false };
    if (excludeWritten && originalExclude !== null) {
      try {
        if (excludeExisted) {
          await dependencies.writeFile(excludePath, originalExclude);
        } else {
          await dependencies.unlink(excludePath);
        }
        result.restored = true;
        restored.localExclude = true;
      } catch (restoreError) {
        restorationFailures.push(`exclude restoration failed: ${(restoreError as Error).message}`);
      }
    }
    if (createdDirectories.length > 0) {
      restored.worktreesDirectory = true;
      for (const directory of createdDirectories.toReversed()) {
        try {
          await dependencies.rmdir(directory);
        } catch (restoreError) {
          restored.worktreesDirectory = false;
          restorationFailures.push(
            `directory restoration failed at ${directory}: ${(restoreError as Error).message}`,
          );
        }
      }
    }
    let localExcludeChanged = false;
    try {
      if (!result.attempted.localExclude) {
        localExcludeChanged = false;
      } else if (excludeExisted && originalExclude) {
        localExcludeChanged = !(await dependencies.readFile(excludePath)).equals(originalExclude);
      } else {
        localExcludeChanged = await exists(excludePath);
      }
    } catch {
      localExcludeChanged = excludeExisted;
    }
    const worktreesDirectoryChanged = (await Promise.all(createdDirectories.map(exists))).some(
      Boolean,
    );
    const originalFailure = error instanceof Error ? error.message : String(error);
    const suffix = restorationFailures.length > 0 ? ` (${restorationFailures.join("; ")})` : "";
    throw new ZeroConfigBootstrapError(`${originalFailure}${suffix}`, {
      attempted: result.attempted,
      finalState: { localExcludeChanged, worktreesDirectoryChanged },
      originalFailure,
      restorationWarnings: restorationFailures,
      restored,
      workspaceRoot: mainRoot,
    });
  }
}
