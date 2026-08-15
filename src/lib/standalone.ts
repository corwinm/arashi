import { access, realpath, rmdir } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { exec } from "./git.ts";
import { parseGitIgnoreVerbose } from "./git-ignore.ts";
import {
  executeHook,
  buildRemoveHookOperationData,
  mapHookExecutionResult,
  mapHookSkippedOutcome,
  resolveScopedLifecycleHookLocations,
  validateHook,
} from "./hooks.ts";
import type { HookInputMode, LifecycleHookOutcome } from "./hooks.ts";
import type { StandaloneWorkspaceContext } from "./workspace-context.ts";
import type { CreateBaseResolutionPlan } from "./create-base.ts";

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
  readonly details: { hookName: string; hookOutcomes: LifecycleHookOutcome[]; scriptPath: string };

  constructor(hookName: string, scriptPath: string, hookOutcomes: LifecycleHookOutcome[]) {
    super(`Standalone ${hookName} hook failed: ${scriptPath}`);
    this.details = { hookName, hookOutcomes, scriptPath };
    this.name = "StandaloneHookError";
  }
}

export async function runStandaloneGlobalHooks(
  context: StandaloneWorkspaceContext,
  hookName: string,
  branch: string | null,
  worktreePath: string,
  skipHooks: boolean,
  quiet = false,
  continueOnFailure = false,
  hookInputMode: HookInputMode = "unavailable",
): Promise<LifecycleHookOutcome[]> {
  if (skipHooks) return [];
  const outcomes: LifecycleHookOutcome[] = [];
  const locations = await resolveScopedLifecycleHookLocations({
    globalOnly: true,
    hookName,
    targetRepositories: [context.repository],
    workspaceRoot: context.mainRoot,
  });
  for (const hook of locations.filter((candidate) => candidate.scope.startsWith("global-"))) {
    if (!hook.scriptPath) {
      const mapping = mapHookSkippedOutcome("not_found", "Hook script not found");
      outcomes.push({
        executionPath: hook.executionPath,
        hookName,
        hookStatus: mapping.hookStatus,
        message: mapping.message,
        reasonCode: mapping.reasonCode,
        repositoryId: context.repository.name,
        scope: hook.scope,
        sourceScriptPath: null,
        targetRepositoryName: context.repository.name,
        targetRepositoryPath: context.mainRoot,
        targetWorktreePath: worktreePath,
        workspaceMode: "standalone",
      });
      continue;
    }

    const validation = await validateHook(hook.scriptPath);
    if (!validation.valid) {
      const outcome: LifecycleHookOutcome = {
        executionPath: hook.executionPath,
        hookName,
        hookStatus: "failure",
        message: validation.error ?? "Hook validation failed",
        reasonCode: validation.reasonCode ?? "validation_failed",
        repositoryId: context.repository.name,
        scope: hook.scope,
        sourceScriptPath: hook.scriptPath,
        targetRepositoryName: context.repository.name,
        targetRepositoryPath: context.mainRoot,
        targetWorktreePath: worktreePath,
        workspaceMode: "standalone",
      };
      outcomes.push(outcome);
      if (!continueOnFailure) throw new StandaloneHookError(hookName, hook.scriptPath, outcomes);
      continue;
    }

    const operationData = hookName.endsWith("-remove")
      ? buildRemoveHookOperationData({
          mainRepoPath: context.mainRoot,
          targets: [
            {
              branchName: branch,
              repository: context.repository.name,
              worktreePath,
            },
          ],
        })
      : {
          BRANCH_NAME: branch ?? "",
          REPO_NAME: context.repository.name,
          WORKSPACE_MODE: "standalone",
          WORKTREE_PATH: worktreePath,
        };
    if (branch === null) delete operationData.BRANCH_NAME;
    operationData.REPO_NAME = context.repository.name;
    operationData.REPO_PATH = context.mainRoot;
    operationData.WORKTREE_PATH = worktreePath;
    const result = await executeHook({
      context: {
        hookName,
        hookScope: hook.scope,
        operationData,
        repoPath: context.mainRoot,
        sourceScriptPath: hook.scriptPath,
        mainRepoPath: context.mainRoot,
        targetRepoName: context.repository.name,
        targetRepoPath: context.mainRoot,
        targetWorktreePath: worktreePath,
        workspaceMode: "standalone",
      },
      hookName,
      hookInputMode,
      quiet,
      scriptPath: hook.scriptPath,
    });
    const mapping = mapHookExecutionResult(result);
    outcomes.push({
      durationMs: mapping.durationMs,
      executionPath: hook.executionPath,
      hookName,
      hookStatus: mapping.hookStatus,
      message:
        mapping.hookStatus === "failure" && result.stderr.trim()
          ? result.stderr.trim()
          : mapping.message,
      reasonCode: mapping.reasonCode,
      repositoryId: context.repository.name,
      scope: hook.scope,
      sourceScriptPath: hook.scriptPath,
      targetRepositoryName: context.repository.name,
      targetRepositoryPath: context.mainRoot,
      targetWorktreePath: worktreePath,
      workspaceMode: "standalone",
    });
    if (!result.success && (!continueOnFailure || result.signalCode === "SIGINT")) {
      throw new StandaloneHookError(hookName, hook.scriptPath, outcomes);
    }
  }
  return outcomes;
}

export async function preflightStandaloneGlobalHooks(
  context: StandaloneWorkspaceContext,
  hookNames: string[],
  branch: string | null,
  worktreePath: string,
): Promise<void> {
  for (const hookName of hookNames) {
    let locations;
    try {
      locations = await resolveScopedLifecycleHookLocations({
        globalOnly: true,
        hookName,
        targetRepositories: [context.repository],
        workspaceRoot: context.mainRoot,
      });
    } catch (error) {
      const outcome: LifecycleHookOutcome = {
        executionPath: context.mainRoot,
        hookName,
        hookStatus: "failure",
        message: error instanceof Error ? error.message : String(error),
        reasonCode: "validation_failed",
        repositoryId: context.repository.name,
        scope: "global-shared",
        sourceScriptPath: null,
        targetRepositoryName: context.repository.name,
        targetRepositoryPath: context.mainRoot,
        targetWorktreePath: worktreePath,
        workspaceMode: "standalone",
      };
      throw new StandaloneHookError(hookName, "", [outcome]);
    }
    for (const location of locations.filter((candidate) => candidate.scope.startsWith("global-"))) {
      if (!location.scriptPath) continue;
      const validation = await validateHook(location.scriptPath);
      if (validation.valid) continue;
      const outcome: LifecycleHookOutcome = {
        executionPath: location.executionPath,
        hookName,
        hookStatus: "failure",
        message: validation.error ?? "Hook validation failed",
        reasonCode: validation.reasonCode ?? "validation_failed",
        repositoryId: context.repository.name,
        scope: location.scope,
        sourceScriptPath: location.scriptPath,
        targetRepositoryName: context.repository.name,
        targetRepositoryPath: context.mainRoot,
        targetWorktreePath: worktreePath,
        workspaceMode: "standalone",
      };
      throw new StandaloneHookError(hookName, location.scriptPath, [outcome]);
    }
  }
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
  options: {
    createBasePlan?: CreateBaseResolutionPlan;
    hookInputMode?: HookInputMode;
    quiet?: boolean;
    skipHooks?: boolean;
  } = {},
) {
  await exec(["check-ref-format", "--branch", branch], context.mainRoot);
  const canonicalRepositoryPath = options.createBasePlan
    ? await realpath(context.mainRoot)
    : undefined;
  const baseResolution = canonicalRepositoryPath
    ? options.createBasePlan?.byCanonicalPath.get(canonicalRepositoryPath)
    : undefined;
  if (options.createBasePlan && !baseResolution) {
    throw new Error(
      `Standalone repository is missing immutable create-base plan entry for '${context.mainRoot}'`,
    );
  }
  const destination = join(context.mainRoot, ".worktrees", ...branch.split("/"));
  const effectiveIgnore = await inspectStandaloneIgnore(context, destination);
  if (!effectiveIgnore.ignored) throw new StandaloneDestinationNotIgnoredError(destination);
  let localBranchExists = true;
  try {
    await exec(["show-ref", "--verify", `refs/heads/${branch}`], context.mainRoot);
  } catch {
    localBranchExists = false;
  }
  let branchSource: string | null = localBranchExists ? branch : null;
  let reusedRemoteBranch = false;
  if (!localBranchExists) {
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
  const hookOutcomes: LifecycleHookOutcome[] = [];
  if (!dryRun) {
    if (options.skipHooks !== true) {
      await preflightStandaloneGlobalHooks(
        context,
        ["pre-create", "post-create"],
        branch,
        destination,
      );
    }
    try {
      hookOutcomes.push(
        ...(await runStandaloneGlobalHooks(
          context,
          "pre-create",
          branch,
          destination,
          options.skipHooks === true,
          options.quiet === true,
          false,
          options.hookInputMode,
        )),
      );
    } catch (error) {
      if (error instanceof StandaloneHookError) {
        error.details.hookOutcomes = [...hookOutcomes, ...error.details.hookOutcomes];
      }
      throw error;
    }
    try {
      await exec(
        localBranchExists
          ? ["worktree", "add", destination, branch]
          : branchSource
            ? ["worktree", "add", "-b", branch, destination, branchSource]
            : baseResolution
              ? ["worktree", "add", "-b", branch, destination, baseResolution.resolvedOid]
              : ["worktree", "add", "-b", branch, destination],
        context.mainRoot,
      );
      hookOutcomes.push(
        ...(await runStandaloneGlobalHooks(
          context,
          "post-create",
          branch,
          destination,
          options.skipHooks === true,
          options.quiet === true,
          false,
          options.hookInputMode,
        )),
      );
    } catch (error) {
      try {
        await exec(["worktree", "remove", "--force", destination], context.mainRoot);
      } catch {
        // The worktree may not have been created.
      }
      if (!localBranchExists) {
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
      if (error instanceof StandaloneHookError) {
        error.details.hookOutcomes = [...hookOutcomes, ...error.details.hookOutcomes];
      }
      throw error;
    }
  }
  return {
    branchName: branch,
    branchSource,
    targetAction: localBranchExists ? ("reused" as const) : ("created" as const),
    dryRun,
    mode: "standalone" as const,
    repositoryPath: context.mainRoot,
    reusedRemoteBranch,
    workspaceRoot: context.mainRoot,
    worktreePath: destination,
    effectiveIgnore,
    hookOutcomes,
  };
}
