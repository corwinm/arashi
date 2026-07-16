import { access, rmdir } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { exec } from "./git.ts";
import { parseGitIgnoreVerbose } from "./git-ignore.ts";
import { executeHook, resolveScopedLifecycleHooks } from "./hooks.ts";
import type { StandaloneWorkspaceContext } from "./workspace-context.ts";

export class StandaloneDestinationNotIgnoredError extends Error {
  readonly code = "STANDALONE_DESTINATION_NOT_IGNORED";
  readonly destination: string;
  readonly details: {
    destination: string;
    effectiveIgnore: { ignored: false; pattern: null; source: null };
    mode: "standalone";
    mutation: { branch: false; config: false; ignore: false; worktree: false };
    repairCommands: string[];
  };
  constructor(destination: string) {
    super(
      `Standalone worktree destination is not ignored: ${destination}. Run "arashi init --zero-config" or add .worktrees/ to the repository-local exclude file.`,
    );
    this.destination = destination;
    this.details = {
      destination,
      effectiveIgnore: { ignored: false, pattern: null, source: null },
      mode: "standalone",
      mutation: { branch: false, config: false, ignore: false, worktree: false },
      repairCommands: [
        "arashi init --zero-config",
        "printf '.worktrees/\\n' >> \"$(git rev-parse --git-path info/exclude)\"",
      ],
    };
    this.name = "StandaloneDestinationNotIgnoredError";
  }
}

export class StandaloneHookError extends Error {
  readonly code = "STANDALONE_HOOK_FAILED";
  readonly details: { hookName: string; scriptPath: string };

  constructor(hookName: string, scriptPath: string) {
    super(`Standalone ${hookName} hook failed: ${scriptPath}`);
    this.details = { hookName, scriptPath };
    this.name = "StandaloneHookError";
  }
}

export async function runStandaloneGlobalHooks(
  context: StandaloneWorkspaceContext,
  hookName: string,
  branch: string,
  worktreePath: string,
  skipHooks: boolean,
  quiet = false,
  continueOnFailure = false,
): Promise<{ hookName: string; message: string }[]> {
  if (skipHooks) return [];
  const failures: { hookName: string; message: string }[] = [];
  const hooks = await resolveScopedLifecycleHooks({
    hookName,
    targetRepositories: [context.repository],
    workspaceRoot: context.mainRoot,
  });
  for (const hook of hooks.filter((candidate) => candidate.scope.startsWith("global-"))) {
    try {
      const result = await executeHook({
        context: {
          hookName,
          hookScope: hook.scope,
          operationData: {
            BRANCH_NAME: branch,
            REPO_NAME: context.repository.name,
            WORKSPACE_MODE: "standalone",
            WORKTREE_PATH: worktreePath,
          },
          repoPath: context.mainRoot,
          sourceScriptPath: hook.sourceScriptPath,
          targetRepoName: context.repository.name,
          targetRepoPath: context.mainRoot,
        },
        hookName,
        quiet,
        scriptPath: hook.scriptPath,
      });
      if (!result.success) throw new StandaloneHookError(hookName, hook.scriptPath);
    } catch (error) {
      if (!continueOnFailure) throw error;
      failures.push({
        hookName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

export async function standaloneWorktrees(context: StandaloneWorkspaceContext) {
  const result = await exec(
    ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"],
    context.mainRoot,
  );
  const records: Array<{
    branch: string | null;
    head: string;
    path: string;
    pruneReason?: string;
  }> = [];
  let current: (typeof records)[number] | null = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { branch: null, head: "", path: line.slice(9) };
      records.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch refs/heads/")) current.branch = line.slice(18);
    else if (current && line.startsWith("prunable")) {
      current.pruneReason = line.slice("prunable".length).trim() || "stale worktree metadata";
    }
  }
  return records;
}

export interface EffectiveIgnoreEvidence {
  ignored: boolean;
  line?: number;
  pattern: string | null;
  source: string | null;
}

export async function inspectStandaloneIgnore(
  context: StandaloneWorkspaceContext,
  destination: string,
): Promise<EffectiveIgnoreEvidence> {
  try {
    const result = await exec(
      ["check-ignore", "--no-index", "--verbose", destination],
      context.mainRoot,
    );
    const evidence = parseGitIgnoreVerbose(result.stdout);
    return {
      ignored: evidence.ignored,
      ...(evidence.line === undefined ? {} : { line: evidence.line }),
      pattern: evidence.pattern,
      source: evidence.source,
    };
  } catch {
    return { ignored: false, pattern: null, source: null };
  }
}

const missingDestinationParents = async (base: string, destination: string): Promise<string[]> => {
  const branchParent = dirname(destination);
  const branchRelative = relative(base, branchParent);
  if (!branchRelative || branchRelative.startsWith("..")) return [];
  const missing: string[] = [];
  let current = base;
  for (const segment of branchRelative.split(/[\\/]/)) {
    current = resolve(current, segment);
    try {
      await access(current);
    } catch {
      missing.push(current);
    }
  }
  return missing;
};

export async function createStandaloneWorktree(
  context: StandaloneWorkspaceContext,
  branch: string,
  dryRun = false,
  options: { quiet?: boolean; skipHooks?: boolean } = {},
) {
  await exec(["check-ref-format", "--branch", branch], context.mainRoot);
  const destination = join(context.mainRoot, ".worktrees", ...branch.split("/"));
  const effectiveIgnore = await inspectStandaloneIgnore(context, destination);
  if (!effectiveIgnore.ignored) throw new StandaloneDestinationNotIgnoredError(destination);
  let existing = true;
  try {
    await exec(["show-ref", "--verify", `refs/heads/${branch}`], context.mainRoot);
  } catch {
    existing = false;
  }
  let branchSource: string | null = existing ? branch : null;
  let reusedRemoteBranch = false;
  if (!existing) {
    const remotes = await exec(
      ["for-each-ref", "--format=%(refname:short)", `refs/remotes/*/${branch}`],
      context.mainRoot,
    );
    const remoteBranches = remotes.stdout.split(/\r?\n/).filter(Boolean);
    branchSource =
      remoteBranches.find((candidate) => candidate === `origin/${branch}`) ??
      remoteBranches[0] ??
      null;
    reusedRemoteBranch = branchSource !== null;
  }
  const ownedParents = await missingDestinationParents(
    join(context.mainRoot, ".worktrees"),
    destination,
  );
  if (!dryRun) {
    await runStandaloneGlobalHooks(
      context,
      "pre-create",
      branch,
      destination,
      options.skipHooks === true,
      options.quiet === true,
    );
    try {
      await exec(
        existing
          ? ["worktree", "add", destination, branch]
          : branchSource
            ? ["worktree", "add", "-b", branch, destination, branchSource]
            : ["worktree", "add", "-b", branch, destination],
        context.mainRoot,
      );
      await runStandaloneGlobalHooks(
        context,
        "post-create",
        branch,
        destination,
        options.skipHooks === true,
        options.quiet === true,
      );
    } catch (error) {
      try {
        await exec(["worktree", "remove", "--force", destination], context.mainRoot);
      } catch {
        // The worktree may not have been created.
      }
      if (!existing) {
        try {
          await exec(["branch", "-D", branch], context.mainRoot);
        } catch {
          // The branch may not have been created.
        }
      }
      for (const parent of ownedParents.toReversed()) {
        try {
          await rmdir(parent);
        } catch {
          // Preserve non-empty, pre-existing, or surviving-worktree parent paths.
        }
      }
      throw error;
    }
  }
  return {
    branchName: branch,
    branchSource,
    dryRun,
    mode: "standalone" as const,
    repositoryPath: context.mainRoot,
    reusedRemoteBranch,
    workspaceRoot: context.mainRoot,
    worktreePath: destination,
    effectiveIgnore,
  };
}
