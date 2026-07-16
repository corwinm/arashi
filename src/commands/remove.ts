/**
 * Remove Command
 *
 * Removes worktrees and deletes branches across multiple repositories.
 */

import {
  GLOBAL_HOOKS,
  buildRemoveHookOperationData,
  executeHook,
  mapHookExecutionResult,
  mapHookSkippedOutcome,
  resolveScopedLifecycleHooks,
  validateHook,
} from "../lib/hooks.ts";
import type {
  RemovalOperation,
  RemoveCommandOptions,
  RemoveHookPreview,
  WorktreeEntry,
  WorktreeGrouping,
} from "../types/remove.ts";
import { RemoveCommandError, RemoveCommandErrorCode } from "../lib/errors.ts";
import { basename, resolve } from "path";
import {
  branchExists,
  createRemovalSummary,
  deleteBranch,
  detachWorktree,
  discoverAllWorktrees,
  discoverWorktreesByBranch,
  discoverWorktreesByPath,
  formatRemovalSummaryHuman,
  formatRemovalSummaryJson,
  getCurrentBranch,
  groupWorktreesByParent,
  refreshRemainingChildStatuses,
  removeWorktree,
} from "../core/remove.ts";
import { buildWorktreeEntries, resolveWorktreeStatuses } from "../core/worktree.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  unsupportedJsonModeError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { findWorkspaceRoot, loadConfig } from "../lib/config.ts";
import { resolveWorkspaceContext, workspaceJsonMetadata } from "../lib/workspace-context.ts";
import { runStandaloneGlobalHooks, standaloneWorktrees } from "../lib/standalone.ts";
import { exec as standaloneGitExec, getDefaultBranch } from "../lib/git.ts";
import { info, error as logError, spinner, warn } from "../lib/logger.ts";
import {
  confirm as promptConfirm,
  multiSelect as promptMultiSelect,
  select as promptSelect,
} from "../lib/prompts.ts";
import { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "fs";

interface Choice<T> {
  value: T;
  name: string;
  description?: string;
}

type Config = Awaited<ReturnType<typeof loadConfig>>;
type HookOutcomeReasonCode =
  | "none"
  | "not_found"
  | "disabled"
  | "timeout"
  | "exit_non_zero"
  | "not_applicable";

interface HookOutcomeMapping {
  hookStatus: "success" | "failure" | "skipped";
  reasonCode: HookOutcomeReasonCode;
  message: string;
  durationMs?: number;
}

interface HookTargetRepository {
  name: string;
  path: string;
}

type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason: "exit" | "abort" };
type RepositoryTarget = Parameters<typeof discoverAllWorktrees>[0][number];

const ZERO = 0;
const ONE = 1;
const JSON_INDENT = 2;

interface CliOptions {
  checkDirty?: boolean;
  keepWorktrees?: boolean;
  keepBranches?: boolean;
  force?: boolean;
  path?: boolean;
  json?: boolean;
  dryRun?: boolean;
}

class StandaloneRemovePartialFailure extends Error {
  readonly code = "STANDALONE_REMOVE_PARTIAL_FAILURE";
  readonly details: {
    finalState: { branchExists: boolean; worktreeExists: boolean };
    hookFailures: { hookName: string; message: string }[];
    operationFailures: { message: string; operation: string }[];
  };

  constructor(details: StandaloneRemovePartialFailure["details"]) {
    super("Standalone remove completed with one or more operation or finalization failures");
    this.details = details;
    this.name = "StandaloneRemovePartialFailure";
  }
}

const loadWorkspaceConfig = async (workspaceRoot: string): Promise<Config> => {
  try {
    return await loadConfig(workspaceRoot);
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      ({ message } = error);
    }

    throw new RemoveCommandError(
      "Failed to load workspace configuration",
      RemoveCommandErrorCode.CONFIG_ERROR,
      { error: message },
    );
  }
};

const formatPrunableTargetMessage = (target: string): string =>
  `Target '${target}' is stale/prunable worktree metadata. Run 'arashi prune' to clean it up.`;

const formatDirtyDetailsText = (worktree: WorktreeEntry): string => {
  const details = worktree.dirtyDetails;
  if (!details) {
    return "";
  }

  const parts: string[] = [];
  if (details.modifiedFiles > ZERO) {
    parts.push(`${details.modifiedFiles} modified files`);
  }
  if (details.untrackedFiles > ZERO) {
    parts.push(`${details.untrackedFiles} untracked files`);
  }
  if (details.stagedFiles > ZERO) {
    parts.push(`${details.stagedFiles} staged files`);
  }
  if (parts.length === ZERO) {
    return "";
  }

  return ` (${parts.join(", ")})`;
};

const removalJsonData = (
  summary: Parameters<typeof formatRemovalSummaryJson>[0],
  extras: NonNullable<Parameters<typeof formatRemovalSummaryJson>[1]>,
  metadata?: Record<string, unknown>,
): Record<string, unknown> => ({
  ...JSON.parse(formatRemovalSummaryJson(summary, extras)),
  ...metadata,
});

interface SelectionExpansionOptions {
  entries: WorktreeEntry[];
  grouping: WorktreeGrouping;
  selectablePaths: Set<string>;
  selectedPaths: string[];
}

interface ConfirmationOptions {
  branchPresence: Record<string, string[]>;
  checkDirty: boolean;
  confirm: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;
  worktrees: WorktreeEntry[];
}

export function createCommand(): Command {
  return new Command("remove")
    .description("Remove worktrees and delete branches")
    .argument("[target]", "Branch name or worktree path to remove (optional - prompts if omitted)")
    .option("--no-check-dirty", "Skip uncommitted changes check")
    .option("--keep-worktrees", "Delete branches but keep worktree directories")
    .option("--keep-branches", "Remove worktrees but keep git branches")
    .option("-f, --force", "Skip confirmation prompts")
    .option("--path", "Treat argument as worktree path")
    .option("--json", "Output results as JSON")
    .option("--dry-run", "Preview planned removals without mutating worktrees or branches")
    .action(async (branch?: string, options?: CliOptions) => {
      try {
        const exitCode = await executeRemove(branch, options || {});
        process.exit(exitCode);
      } catch (error) {
        handleError(error, options || {});
      }
    });
}

export async function executeRemove(
  branchArg: string | undefined,
  options: RemoveCommandOptions,
  promptHandlers?: {
    confirm: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;
    multiSelect: (message: string, choices: Choice<string>[]) => Promise<PromptOutcome<string[]>>;
    select?: (message: string, choices: Choice<string>[]) => Promise<PromptOutcome<string>>;
  },
): Promise<number> {
  const startTime = Date.now();

  const workspaceContext = await resolveWorkspaceContext();
  if (workspaceContext.mode === "standalone") {
    const prompt = promptHandlers || {
      confirm: promptConfirm,
      multiSelect: promptMultiSelect,
      select: promptSelect,
    };
    const allowNonInteractive = Boolean(promptHandlers);
    const worktrees = await standaloneWorktrees(workspaceContext);
    let selectedTargetPath: string | undefined = undefined;
    if (!branchArg) {
      if (options.json) {
        writeJsonEnvelope(unsupportedJsonModeError("remove", "interactive-selection"));
        return ONE;
      }

      const selectable = worktrees.filter(
        (entry) => resolve(entry.path) !== resolve(workspaceContext.mainRoot),
      );
      if (selectable.length === ZERO) {
        info("No worktrees found to remove");
        return ZERO;
      }

      ensureInteractive(allowNonInteractive);
      const selection = await (prompt.select ?? promptSelect)(
        "Select a worktree to remove:",
        selectable.map((entry) => ({
          description: entry.path,
          name: entry.branch || basename(entry.path),
          value: entry.path,
        })),
      );
      if (selection.status === "cancelled") {
        info("Selection cancelled");
        return ZERO;
      }
      selectedTargetPath = selection.value;
    }
    const target = worktrees.find((entry) => {
      if (selectedTargetPath) {
        return resolve(entry.path) === resolve(selectedTargetPath);
      }
      return options.path
        ? resolve(entry.path) === resolve(branchArg!)
        : entry.branch === branchArg;
    });
    if (!target || resolve(target.path) === resolve(workspaceContext.mainRoot)) {
      throw new RemoveCommandError(
        `Standalone worktree not found: ${branchArg ?? selectedTargetPath}`,
        RemoveCommandErrorCode.BRANCH_NOT_FOUND,
      );
    }
    const targetLabel = target.branch ?? branchArg ?? selectedTargetPath ?? target.path;
    const repositoryName = workspaceContext.repository.name;
    const targetEntry: WorktreeEntry = {
      branch: target.branch ?? "",
      childrenPaths: [],
      isMain: false,
      parentPath: null,
      path: target.path,
      repository: repositoryName,
      status: "present",
    };
    if (options.checkDirty !== false) {
      await resolveWorktreeStatuses([targetEntry], true);
    }

    const branchPresence: Record<string, string[]> = target.branch
      ? { [target.branch]: [repositoryName] }
      : {};
    if (!options.force && !options.dryRun && !(options.keepBranches && options.keepWorktrees)) {
      ensureInteractive(allowNonInteractive);
      const confirmation = await promptConfirmation({
        branchPresence,
        checkDirty: options.checkDirty !== false,
        confirm: prompt.confirm,
        worktrees: [targetEntry],
      });
      if (confirmation === "cancelled") {
        info("Operation cancelled");
        return ZERO;
      }
      if (confirmation === "declined") {
        info("Operation cancelled by user");
        return ZERO;
      }
    }

    const totalWorktrees = options.keepWorktrees ? ZERO : ONE;
    const totalBranches = options.keepBranches || !target.branch ? ZERO : ONE;
    const summary = createRemovalSummary(totalWorktrees, totalBranches);
    const metadata = {
      ...workspaceJsonMetadata(workspaceContext),
      repositoryPath: workspaceContext.mainRoot,
    };
    const hookTargets = [{ name: repositoryName, path: workspaceContext.mainRoot }];

    if (options.dryRun) {
      summary.dryRun = true;
      summary.effectiveOptions = {
        checkDirty: options.checkDirty !== false,
        force: options.force === true,
        keepBranches: options.keepBranches === true,
        keepWorktrees: options.keepWorktrees === true,
      };
      summary.dirtyWorktrees = targetEntry.isDirty ? [targetEntry] : [];
      if (!options.keepWorktrees) {
        summary.operations.push({
          branchName: targetEntry.branch,
          repository: repositoryName,
          status: "pending",
          type: "worktree_remove",
          worktreePath: targetEntry.path,
        });
      } else if (!options.keepBranches && target.branch) {
        summary.operations.push({
          branchName: target.branch,
          repository: repositoryName,
          status: "pending",
          type: "worktree_detach",
          worktreePath: targetEntry.path,
        });
      }
      if (!options.keepBranches && target.branch) {
        summary.operations.push({
          branchName: target.branch,
          repository: repositoryName,
          status: "pending",
          type: "branch_delete",
        });
      }
      summary.hookPreviews = await previewRemoveLifecycleHooks({
        globalOnly: true,
        targetRepositories: hookTargets,
        workspaceRoot: workspaceContext.mainRoot,
      });
      summary.duration = Date.now() - startTime;
      const data = removalJsonData(summary, {}, metadata);
      if (options.json) {
        writeJsonEnvelope(createJsonSuccessEnvelope("remove", data));
      } else {
        info("Workspace mode: standalone");
        console.log(formatRemovalSummaryHuman(summary, {}));
      }
      return ZERO;
    }

    if (options.keepBranches && options.keepWorktrees) {
      summary.duration = Date.now() - startTime;
      const data = removalJsonData(summary, {}, metadata);
      if (options.json) {
        writeJsonEnvelope(createJsonSuccessEnvelope("remove", data));
      } else {
        warn("Both --keep-worktrees and --keep-branches specified");
        info("No operations will be performed. At least one removal type must be enabled.");
      }
      return ZERO;
    }

    await runStandaloneGlobalHooks(
      workspaceContext,
      "pre-remove",
      targetLabel,
      target.path,
      false,
      options.json === true,
    );
    const operationFailures: { message: string; operation: string }[] = [];
    const hookFailures: { hookName: string; message: string }[] = [];
    if (options.keepWorktrees) {
      try {
        await detachWorktree(target.path);
      } catch (error) {
        operationFailures.push({
          message: error instanceof Error ? error.message : String(error),
          operation: "detach-worktree",
        });
      }
    } else {
      const operation: RemovalOperation = {
        branchName: targetEntry.branch,
        repository: repositoryName,
        status: "pending",
        type: "worktree_remove",
        worktreePath: target.path,
      };
      try {
        await removeWorktree(
          targetEntry,
          workspaceContext.mainRoot,
          options.force === true || options.checkDirty === false || targetEntry.isDirty === true,
        );
        operation.status = "success";
        summary.successfulWorktrees = ONE;
      } catch (error) {
        operation.status = "failed";
        operation.error = formatWorktreeRemovalError(error);
        operationFailures.push({ message: operation.error, operation: "remove-worktree" });
      }
      summary.operations.push(operation);
    }
    if (!options.keepBranches && target.branch) {
      const operation: RemovalOperation = {
        branchName: target.branch,
        repository: repositoryName,
        status: "pending",
        type: "branch_delete",
      };
      try {
        await standaloneGitExec(["branch", "-D", target.branch], workspaceContext.mainRoot);
        operation.status = "success";
        summary.successfulBranches = ONE;
      } catch (error) {
        operation.status = "failed";
        operation.error = formatBranchDeletionError(error);
        operationFailures.push({ message: operation.error, operation: "delete-branch" });
      }
      summary.operations.push(operation);
    }
    try {
      const postHookFailures = await runStandaloneGlobalHooks(
        workspaceContext,
        "post-remove",
        targetLabel,
        target.path,
        false,
        options.json === true,
        true,
      );
      hookFailures.push(...postHookFailures);
    } catch (error) {
      hookFailures.push({
        hookName: "post-remove",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (operationFailures.length > ZERO || hookFailures.length > ZERO) {
      let finalBranchExists = false;
      if (target.branch) {
        try {
          await standaloneGitExec(
            ["show-ref", "--verify", `refs/heads/${target.branch}`],
            workspaceContext.mainRoot,
          );
          finalBranchExists = true;
        } catch {
          finalBranchExists = false;
        }
      }
      throw new StandaloneRemovePartialFailure({
        finalState: {
          branchExists: finalBranchExists,
          worktreeExists: existsSync(target.path),
        },
        hookFailures,
        operationFailures,
      });
    }
    summary.duration = Date.now() - startTime;
    const data = removalJsonData(summary, {}, metadata);
    if (options.json) {
      writeJsonEnvelope(createJsonSuccessEnvelope("remove", data));
    } else {
      info("Workspace mode: standalone");
      console.log(formatRemovalSummaryHuman(summary, {}));
    }
    return ZERO;
  }

  const configuredMetadata =
    workspaceContext.mode === "configured" ? workspaceJsonMetadata(workspaceContext) : undefined;

  if (options.json && !branchArg) {
    writeJsonEnvelope(unsupportedJsonModeError("remove", "interactive-selection"));
    return ONE;
  }

  if (options.keepBranches && options.keepWorktrees) {
    const summary = createRemovalSummary(ZERO, ZERO);
    summary.duration = Date.now() - startTime;
    summary.dryRun = options.dryRun === true;
    summary.effectiveOptions = {
      checkDirty: options.checkDirty !== false,
      force: options.force === true,
      keepBranches: options.keepBranches === true,
      keepWorktrees: options.keepWorktrees === true,
    };
    if (options.json) {
      writeJsonEnvelope(
        createJsonSuccessEnvelope("remove", removalJsonData(summary, {}, configuredMetadata)),
      );
    } else if (options.dryRun) {
      console.log(formatRemovalSummaryHuman(summary, {}));
    } else {
      warn("Both --keep-worktrees and --keep-branches specified");
      info("No operations will be performed. At least one removal type must be enabled.");
    }
    return ZERO;
  }

  const workspaceRoot =
    workspaceContext.mode === "configured"
      ? workspaceContext.workspaceRoot
      : await getWorkspaceRoot();
  const config =
    workspaceContext.mode === "configured"
      ? workspaceContext.config
      : await loadWorkspaceConfig(workspaceRoot);
  const reposDirName = basename(config.reposDir);
  const childRepoNames = new Set(Object.keys(config.repos));
  const repositories = buildRepositoryTargets(workspaceRoot, config.repos);

  if (repositories.length === 0) {
    throw new RemoveCommandError(
      "No repositories found in workspace",
      RemoveCommandErrorCode.NO_REPOSITORIES,
    );
  }

  const prompt = promptHandlers || { confirm: promptConfirm, multiSelect: promptMultiSelect };
  const allowNonInteractive = Boolean(promptHandlers);
  const defaultBranches = await getDefaultBranchMap(workspaceRoot, config.repos);
  const usedPathMode = { value: false };
  const pathWorktrees: WorktreeEntry[] = [];
  let targetBranches: string[] = [];
  if (branchArg) {
    const inputPath = resolveInputPath(branchArg);
    const matchingByPath = await discoverWorktreesByPath(inputPath, repositories);
    if (matchingByPath.length > ZERO) {
      usedPathMode.value = true;
      const enriched = await buildWorktreeEntries(matchingByPath, {
        childRepoNames,
        includeDirtyDetails: options.checkDirty !== false,
        reposDirName,
      });
      const prunable = enriched.filter((wt) => wt.status === "prunable");
      const normal = enriched.filter((wt) => wt.status !== "prunable");
      if (normal.length === ZERO && prunable.length > ZERO) {
        throw new RemoveCommandError(
          formatPrunableTargetMessage(branchArg),
          RemoveCommandErrorCode.BRANCH_NOT_FOUND,
          { path: branchArg, prunable: prunable.map((wt) => wt.path) },
        );
      }
      pathWorktrees.push(...normal);
    } else if (options.path) {
      throw new RemoveCommandError(
        `Worktree path not found: ${branchArg}`,
        RemoveCommandErrorCode.BRANCH_NOT_FOUND,
        { path: branchArg },
      );
    } else {
      targetBranches = [branchArg];
    }
  } else {
    const allWorktrees = await discoverAllWorktrees(repositories);
    const discoveredEntries = await buildWorktreeEntries(allWorktrees, {
      childRepoNames,
      includeDirtyDetails: options.checkDirty !== false,
      reposDirName,
    });
    const prunableEntries = discoveredEntries.filter((wt) => wt.status === "prunable");
    const entries = discoveredEntries.filter((wt) => wt.status !== "prunable");
    const selectable = entries.filter((wt) => !wt.isMain && wt.branch);

    if (selectable.length === 0) {
      info("No worktrees found to remove");
      if (prunableEntries.length > ZERO) {
        info("Stale worktree metadata found; run 'arashi prune' to clean it up");
      }
      return ZERO;
    }

    ensureInteractive(allowNonInteractive);
    const grouping = groupWorktreesByParent(entries);
    const selectablePaths = new Set(selectable.map((wt) => wt.path));
    const choices = buildWorktreeChoices(grouping, selectablePaths, defaultBranches);
    const selection = await prompt.multiSelect("Select worktrees to remove:", choices);
    if (selection.status === "cancelled") {
      info("Selection cancelled");
      return ZERO;
    }
    const selected = expandSelectedWorktrees({
      entries,
      grouping,
      selectablePaths,
      selectedPaths: selection.value,
    });
    usedPathMode.value = true;
    pathWorktrees.push(...selected);
    targetBranches = [...new Set(selected.map((wt) => wt.branch).filter(Boolean))];

    if (targetBranches.length === 0) {
      info("No worktrees selected to remove");
      return ZERO;
    }
  }

  const worktreesToRemove: WorktreeEntry[] = [];
  const skippedMain: WorktreeEntry[] = [];
  const worktreeCounts: Record<string, number> = {};

  const branchPresence: Record<string, string[]> = {};
  const missingBranches: Record<string, string[]> = {};

  if (usedPathMode.value) {
    const mainWorktrees = pathWorktrees.filter((wt) => wt.isMain);
    const removable = pathWorktrees.filter((wt) => !wt.isMain);
    if (mainWorktrees.length > 0) {
      skippedMain.push(...mainWorktrees);
    }
    worktreesToRemove.push(...removable);
    targetBranches = [...new Set(removable.map((wt) => wt.branch).filter(Boolean))];
    for (const wt of removable) {
      if (wt.branch) {
        branchPresence[wt.branch] = branchPresence[wt.branch] || [];
        if (!branchPresence[wt.branch].includes(wt.repository)) {
          branchPresence[wt.branch].push(wt.repository);
        }
      }
    }
  } else {
    for (const branch of targetBranches) {
      const worktrees = await discoverWorktreesByBranch(branch, repositories);
      const enriched = await buildWorktreeEntries(worktrees, {
        childRepoNames,
        includeDirtyDetails: options.checkDirty !== false,
        reposDirName,
      });
      const prunable = enriched.filter((wt) => wt.status === "prunable");
      const normal = enriched.filter((wt) => wt.status !== "prunable");
      const mainWorktrees = normal.filter((wt) => wt.isMain);
      const removable = normal.filter((wt) => !wt.isMain);
      if (removable.length === ZERO && mainWorktrees.length === ZERO && prunable.length > ZERO) {
        throw new RemoveCommandError(
          formatPrunableTargetMessage(branch),
          RemoveCommandErrorCode.BRANCH_NOT_FOUND,
          { branch, prunable: prunable.map((wt) => wt.path) },
        );
      }

      if (mainWorktrees.length > 0) {
        skippedMain.push(...mainWorktrees);
      }

      worktreesToRemove.push(...removable);
      worktreeCounts[branch] = removable.length;
    }

    for (const branch of targetBranches) {
      branchPresence[branch] = [];
      missingBranches[branch] = [];

      for (const repo of repositories) {
        const exists = await branchExists(repo.path, branch);
        if (exists) {
          branchPresence[branch].push(repo.name);
        } else {
          missingBranches[branch].push(repo.name);
        }
      }

      if (branchPresence[branch].length === 0 && worktreeCounts[branch] === 0) {
        throw new RemoveCommandError(
          `Branch '${branch}' not found in any repository`,
          RemoveCommandErrorCode.BRANCH_NOT_FOUND,
          { branch },
        );
      }
    }
  }

  if (!options.json) {
    warnOnDefaultMainRemoval(skippedMain, defaultBranches);
  }
  if (usedPathMode.value && worktreesToRemove.length === 0) {
    if (skippedMain.length > 0) {
      info("Selected worktree is main and cannot be removed");
    } else {
      info("No removable worktrees found for the provided path");
    }
    return ZERO;
  }

  if (options.checkDirty !== false && worktreesToRemove.length > 0) {
    const dirtyCheckSpinner = options.json
      ? undefined
      : spinner("Checking for uncommitted changes...").start();
    await resolveWorktreeStatuses(worktreesToRemove, true);
    dirtyCheckSpinner?.succeed("Dirty check complete");
  }

  if (!options.force && !options.dryRun) {
    ensureInteractive(allowNonInteractive);
    const confirmation = await promptConfirmation({
      branchPresence,
      checkDirty: options.checkDirty !== false,
      confirm: prompt.confirm,
      worktrees: worktreesToRemove,
    });
    if (confirmation === "cancelled") {
      info("Operation cancelled");
      return ZERO;
    }
    if (confirmation === "declined") {
      info("Operation cancelled by user");
      return ZERO;
    }
  }

  let totalWorktrees = worktreesToRemove.length;
  if (options.keepWorktrees) {
    totalWorktrees = ZERO;
  }

  let totalBranches = ZERO;
  if (!options.keepBranches) {
    totalBranches = Object.values(branchPresence).reduce((sum, repos) => sum + repos.length, ZERO);
  }

  const summary = createRemovalSummary(totalWorktrees, totalBranches);

  const targetRepositories = new Set<string>();
  for (const worktree of worktreesToRemove) {
    targetRepositories.add(worktree.repository);
  }
  for (const repoNames of Object.values(branchPresence)) {
    for (const repoName of repoNames) {
      targetRepositories.add(repoName);
    }
  }
  const targetRepositoryNames = [...targetRepositories];
  targetRepositoryNames.sort((left: string, right: string) => left.localeCompare(right));
  const removeHookTargets = targetRepositoryNames.map((repoName) => ({
    name: repoName,
    path: getRepoPath(repositories, repoName),
  }));

  const removeHookOperationData = buildRemoveHookOperationData({
    branchNames: targetBranches,
    mainRepoPath: workspaceRoot,
    repositoryNames: targetRepositoryNames,
    worktreePaths: worktreesToRemove.map((worktree) => worktree.path),
  });

  if (options.dryRun) {
    summary.dryRun = true;
    summary.effectiveOptions = {
      checkDirty: options.checkDirty !== false,
      force: options.force === true,
      keepBranches: options.keepBranches === true,
      keepWorktrees: options.keepWorktrees === true,
    };
    summary.dirtyWorktrees = worktreesToRemove.filter((worktree) => worktree.isDirty === true);

    if (!options.keepWorktrees) {
      for (const worktree of worktreesToRemove) {
        summary.operations.push({
          branchName: worktree.branch,
          repository: worktree.repository,
          status: "pending",
          type: "worktree_remove",
          worktreePath: worktree.path,
        });
      }
    }

    if (!options.keepBranches && targetBranches.length > ZERO) {
      for (const branch of targetBranches) {
        for (const repoName of branchPresence[branch] ?? []) {
          summary.operations.push({
            branchName: branch,
            repository: repoName,
            status: "pending",
            type: "branch_delete",
          });
        }
      }
    }

    summary.hookPreviews = await previewRemoveLifecycleHooks({
      targetRepositories: removeHookTargets,
      workspaceRoot,
    });
    summary.duration = Date.now() - startTime;

    if (options.json) {
      writeJsonEnvelope(
        createJsonSuccessEnvelope(
          "remove",
          removalJsonData(summary, { missingBranches, skippedMain }, configuredMetadata),
        ),
      );
    } else {
      console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
    }

    return ZERO;
  }

  const preRemoveOutcome = await runRemoveLifecycleHook({
    hookName: GLOBAL_HOOKS.preRemove,
    operationData: removeHookOperationData,
    quiet: options.json === true,
    stopOnFailure: true,
    targetRepositories: removeHookTargets,
    timeoutMs: config.hooks?.timeout,
    workspaceRoot,
  });
  if (preRemoveOutcome.hookStatus === "failure") {
    summary.errors.push(formatHookFailure(GLOBAL_HOOKS.preRemove, preRemoveOutcome));
    summary.duration = Date.now() - startTime;
    if (options.json) {
      writeJsonEnvelope(
        createJsonSuccessEnvelope(
          "remove",
          removalJsonData(summary, { missingBranches, skippedMain }, configuredMetadata),
        ),
      );
    } else {
      console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
    }
    return ONE;
  }

  if (options.keepWorktrees && worktreesToRemove.length > 0) {
    for (const worktree of worktreesToRemove) {
      try {
        await detachWorktree(worktree.path);
      } catch (error) {
        let message = String(error);
        if (error instanceof Error) {
          ({ message } = error);
        }
        summary.errors.push(`${worktree.repository}: Failed to detach worktree (${message})`);
      }
    }
  }

  if (!options.keepWorktrees) {
    for (let index = 0; index < worktreesToRemove.length; index += 1) {
      const worktree = worktreesToRemove[index];
      const operation: RemovalOperation = {
        branchName: worktree.branch,
        repository: worktree.repository,
        status: "pending",
        type: "worktree_remove",
        worktreePath: worktree.path,
      };

      try {
        const forceRemove = options.checkDirty === false || worktree.isDirty === true;
        await removeWorktree(
          worktree,
          getRepoPath(repositories, worktree.repository),
          forceRemove || false,
        );
        operation.status = "success";
        const remaining = worktreesToRemove.slice(index + 1);
        await refreshRemainingChildStatuses(worktree, remaining, options.checkDirty !== false);
      } catch (error) {
        operation.status = "failed";
        operation.error = formatWorktreeRemovalError(error);
      }

      summary.operations.push(operation);
      if (operation.status === "success") {
        summary.successfulWorktrees += 1;
      }
      if (operation.status === "failed" && operation.error) {
        summary.errors.push(`${operation.repository}: ${operation.error}`);
      }
    }
  }

  if (!options.keepBranches && targetBranches.length > 0) {
    for (const branch of targetBranches) {
      for (const repoName of branchPresence[branch]) {
        const repoPath = getRepoPath(repositories, repoName);
        const operation: RemovalOperation = {
          branchName: branch,
          repository: repoName,
          status: "pending",
          type: "branch_delete",
        };

        const currentBranch = await getCurrentBranch(repoPath);
        if (currentBranch === branch) {
          operation.status = "failed";
          operation.error = "Branch is currently checked out";
        } else if (
          await deleteBranch(repoPath, branch)
            .then(() => true)
            .catch((error) => {
              operation.status = "failed";
              operation.error = formatBranchDeletionError(error);
              return false;
            })
        ) {
          operation.status = "success";
        }

        summary.operations.push(operation);
        if (operation.status === "success") {
          summary.successfulBranches += 1;
        }
        if (operation.status === "failed" && operation.error) {
          summary.errors.push(`${operation.repository}: ${operation.error}`);
        }
      }
    }
  }

  const postRemoveOutcome = await runRemoveLifecycleHook({
    hookName: GLOBAL_HOOKS.postRemove,
    operationData: removeHookOperationData,
    quiet: options.json === true,
    stopOnFailure: false,
    targetRepositories: removeHookTargets,
    timeoutMs: config.hooks?.timeout,
    workspaceRoot,
  });
  if (postRemoveOutcome.hookStatus === "failure") {
    summary.errors.push(formatHookFailure(GLOBAL_HOOKS.postRemove, postRemoveOutcome));
  }

  summary.duration = Date.now() - startTime;

  if (options.json) {
    writeJsonEnvelope(
      createJsonSuccessEnvelope(
        "remove",
        removalJsonData(summary, { missingBranches, skippedMain }, configuredMetadata),
      ),
    );
  } else {
    console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
  }

  if (summary.errors.length > ZERO) {
    return ONE;
  }

  return ZERO;
}

const buildRepositoryTargets = (
  workspaceRoot: string,
  repos: Record<string, { path: string }>,
): RepositoryTarget[] => {
  const targets: RepositoryTarget[] = [];
  const mainName = basename(workspaceRoot);
  targets.push({ name: mainName, path: workspaceRoot });

  for (const [name, repo] of Object.entries(repos)) {
    targets.push({ name, path: resolve(workspaceRoot, repo.path) });
  }

  return targets;
};

const getRepoPath = (repositories: RepositoryTarget[], repoName: string): string => {
  const repo = repositories.find((repository) => repository.name === repoName);
  if (!repo) {
    return repoName;
  }
  return repo.path;
};

const formatWorktreeStatusLabel = (worktree: WorktreeEntry): string => {
  if (worktree.status === "prunable") {
    return chalk.gray("prunable");
  }
  if (worktree.status === "dirty") {
    return chalk.yellow("dirty");
  }
  return chalk.green("clean");
};

const formatChildSummary = (children: WorktreeEntry[]): string | null => {
  if (children.length === ZERO) {
    return null;
  }

  const sortedChildren = [...children];
  sortedChildren.sort((left: WorktreeEntry, right: WorktreeEntry) =>
    left.repository.localeCompare(right.repository),
  );

  const parts = sortedChildren.map((child: WorktreeEntry) => {
    const branchLabel = child.branch || "detached";
    let status: string | null = null;
    if (child.status === "prunable") {
      status = "prunable";
    } else if (child.status === "dirty") {
      status = "dirty";
    }

    if (status) {
      return `${child.repository}=${branchLabel} (${status})`;
    }

    return `${child.repository}=${branchLabel}`;
  });

  return parts.join(", ");
};

const buildWorktreeChoices = (
  grouping: WorktreeGrouping,
  selectablePaths: Set<string>,
  defaultBranches: Record<string, string | null>,
): Choice<string>[] => {
  const choices: Choice<string>[] = [];

  const pushEntry = (entry: WorktreeEntry, childSummary?: string | null) => {
    if (!selectablePaths.has(entry.path)) {
      return;
    }
    const status = formatWorktreeStatusLabel(entry);
    const branchLabel = entry.branch || "detached";
    let defaultTag: string | null = null;
    if (defaultBranches[entry.repository] === entry.branch) {
      defaultTag = chalk.cyan("default");
    }

    let suffix = "";
    if (childSummary) {
      suffix = ` (${childSummary})`;
    }

    let label = `${branchLabel} - ${status}`;
    if (defaultTag) {
      label += `, ${defaultTag}`;
    }
    label += suffix;

    choices.push({ name: label, value: entry.path });
  };

  const groups = [...grouping.groups];
  groups.sort((left, right) => left.parent.path.localeCompare(right.parent.path));
  for (const group of groups) {
    const summary = formatChildSummary(group.children);
    pushEntry(group.parent, summary);
  }

  const orphans = [...grouping.orphans];
  orphans.sort((left: WorktreeEntry, right: WorktreeEntry) => left.path.localeCompare(right.path));
  for (const orphan of orphans) {
    pushEntry(orphan, null);
  }

  return choices;
};

const expandSelectedWorktrees = ({
  entries,
  grouping,
  selectablePaths,
  selectedPaths,
}: SelectionExpansionOptions): WorktreeEntry[] => {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const selected = new Map<string, WorktreeEntry>();
  const groupByParentPath = new Map(grouping.groups.map((group) => [group.parent.path, group]));

  for (const path of selectedPaths) {
    if (selectablePaths.has(path)) {
      const group = groupByParentPath.get(path);
      if (group) {
        selected.set(group.parent.path, group.parent);
        for (const child of group.children) {
          selected.set(child.path, child);
        }
      } else {
        const entry = entryByPath.get(path);
        if (entry) {
          selected.set(entry.path, entry);
        }
      }
    }
  }

  return [...selected.values()];
};

const getDefaultBranchMap = async (
  workspaceRoot: string,
  repos: Record<string, { path: string }>,
): Promise<Record<string, string | null>> => {
  const map: Record<string, string | null> = {};
  const mainName = basename(workspaceRoot);
  map[mainName] = await resolveDefaultBranch(workspaceRoot);

  for (const [name, repo] of Object.entries(repos)) {
    const repoPath = resolve(workspaceRoot, repo.path);
    map[name] = await resolveDefaultBranch(repoPath);
  }

  return map;
};

const resolveDefaultBranch = async (repoPath: string): Promise<string | null> => {
  try {
    return await getDefaultBranch(repoPath);
  } catch {
    return null;
  }
};

const warnOnDefaultMainRemoval = (
  skippedMain: WorktreeEntry[],
  defaultBranches: Record<string, string | null>,
): void => {
  const warnings = skippedMain.filter((wt) => defaultBranches[wt.repository] === wt.branch);
  if (warnings.length === ZERO) {
    return;
  }

  warn("Default branch main worktree selected; main worktrees cannot be removed:");
  for (const wt of warnings) {
    info(`  • ${wt.repository}: ${wt.branch} (${wt.path})`);
  }
};

const promptConfirmation = async ({
  branchPresence,
  checkDirty,
  confirm,
  worktrees,
}: ConfirmationOptions): Promise<"confirmed" | "declined" | "cancelled"> => {
  if (checkDirty) {
    const dirty = worktrees.filter((wt) => wt.isDirty);
    if (dirty.length > ZERO) {
      warn(`Uncommitted changes detected in ${dirty.length} worktrees:`);
      for (const wt of dirty) {
        const detailText = formatDirtyDetailsText(wt);
        info(`  • ${wt.repository}: ${wt.path}${detailText}`);
      }

      const outcome = await confirm(
        "Are you sure you want to remove these worktrees? This will discard all uncommitted changes.",
        false,
      );
      return resolveConfirmation(outcome);
    }
  }

  const worktreeCount = worktrees.length;
  const branchCount = Object.values(branchPresence).reduce(
    (sum, repos) => sum + repos.length,
    ZERO,
  );

  let worktreeLabel = "worktrees";
  if (worktreeCount === ONE) {
    worktreeLabel = "worktree";
  }

  let branchLabel = "branches";
  if (branchCount === ONE) {
    branchLabel = "branch";
  }

  const outcome = await confirm(
    `Remove ${worktreeCount} ${worktreeLabel} and delete ${branchCount} ${branchLabel}?`,
    false,
  );
  return resolveConfirmation(outcome);
};

const getWorkspaceRoot = async (): Promise<string> => {
  try {
    return await findWorkspaceRoot();
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      ({ message } = error);
    }

    throw new RemoveCommandError(
      'Arashi configuration not found. Run "arashi init" to create configuration.',
      RemoveCommandErrorCode.CONFIG_ERROR,
      { error: message },
    );
  }
};

const handleError = (error: unknown, options: RemoveCommandOptions): void => {
  if (error instanceof RemoveCommandError) {
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("remove", {
          code: error.code,
          details: error.context,
          message: error.message,
        }),
      );
    } else {
      logError(error.message);
      if (error.code === RemoveCommandErrorCode.BRANCH_NOT_FOUND) {
        info('Hint: Run "arashi list" to see all worktrees');
      }
      if (error.code === RemoveCommandErrorCode.NON_INTERACTIVE) {
        info("Hint: Run this command in an interactive terminal");
      }
    }

    let exitCode = ONE;
    if (
      error.code === RemoveCommandErrorCode.BRANCH_NOT_FOUND ||
      error.code === RemoveCommandErrorCode.NON_INTERACTIVE
    ) {
      exitCode = JSON_INDENT;
    }

    process.exit(exitCode);
  }

  let message = "Unknown error";
  if (error instanceof Error) {
    ({ message } = error);
  }

  if (options.json) {
    writeJsonEnvelope(createJsonErrorEnvelope("remove", unknownErrorToJsonError(error)));
  } else {
    logError(`Unexpected error: ${message}`);
  }
  process.exit(ONE);
};

const ensureInteractive = (allowNonInteractive: boolean): void => {
  if (!allowNonInteractive && !process.stdin.isTTY) {
    throw new RemoveCommandError(
      "Non-interactive terminal detected. Run this command in an interactive TTY.",
      RemoveCommandErrorCode.NON_INTERACTIVE,
    );
  }
};

const resolveConfirmation = (
  outcome: PromptOutcome<boolean>,
): "confirmed" | "declined" | "cancelled" => {
  if (outcome.status === "cancelled") {
    return "cancelled";
  }
  if (outcome.value) {
    return "confirmed";
  }

  return "declined";
};

const resolveInputPath = (input: string): string => {
  if (existsSync(input)) {
    return input;
  }
  const resolved = resolve(input);
  if (existsSync(resolved)) {
    return resolved;
  }
  return input;
};

const formatWorktreeRemovalError = (error: unknown): string => {
  let message = String(error);
  if (error instanceof Error) {
    ({ message } = error);
  }

  const lower = message.toLowerCase();

  if (lower.includes("in use") || lower.includes("busy")) {
    return "Worktree is in use by another process";
  }

  if (lower.includes("locked")) {
    return "Worktree is locked (use --force to override)";
  }

  return message;
};

const formatBranchDeletionError = (error: unknown): string => {
  let message = String(error);
  if (error instanceof Error) {
    ({ message } = error);
  }

  const lower = message.toLowerCase();

  if (lower.includes("checked out")) {
    return "Branch is currently checked out";
  }

  return message;
};

const previewRemoveLifecycleHooks = async (options: {
  globalOnly?: boolean;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
}): Promise<RemoveHookPreview[]> => {
  const previews: RemoveHookPreview[] = [];
  for (const hookName of [GLOBAL_HOOKS.preRemove, GLOBAL_HOOKS.postRemove] as const) {
    const resolvedHooks = await resolveScopedLifecycleHooks({
      hookName,
      targetRepositories: options.targetRepositories,
      workspaceRoot: options.workspaceRoot,
    });
    for (const resolvedHook of resolvedHooks.filter(
      (candidate) => !options.globalOnly || candidate.scope.startsWith("global-"),
    )) {
      const validation = await validateHook(resolvedHook.scriptPath);
      previews.push({
        error: validation.error,
        hookName,
        repository: resolvedHook.targetRepositoryName,
        scope: resolvedHook.scope,
        scriptPath: resolvedHook.scriptPath,
        valid: validation.valid,
      });
    }
  }
  return previews;
};

const runRemoveLifecycleHook = async (options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
  operationData: Record<string, string>;
  quiet?: boolean;
  timeoutMs?: number;
  stopOnFailure: boolean;
}): Promise<HookOutcomeMapping> => {
  const hookSpinner = options.quiet
    ? null
    : spinner(`Running ${options.hookName} hooks...`).start();
  const resolvedHooks = await resolveScopedLifecycleHooks({
    hookName: options.hookName,
    targetRepositories: options.targetRepositories,
    workspaceRoot: options.workspaceRoot,
  });

  if (resolvedHooks.length === 0) {
    const skipped = mapHookSkippedOutcome("not_found", "Hook script not found");
    hookSpinner?.stop();
    if (!options.quiet) {
      info(`Skipping ${options.hookName} hooks: ${skipped.message}`);
    }
    return skipped;
  }

  const failures: string[] = [];
  let failureReason: HookOutcomeReasonCode = "exit_non_zero";
  let executedCount = 0;

  for (const resolvedHook of resolvedHooks) {
    if (hookSpinner) {
      hookSpinner.text = `Running ${options.hookName} (${resolvedHook.scope}:${resolvedHook.targetRepositoryName})...`;
    }

    const validation = await validateHook(resolvedHook.scriptPath);
    if (validation.valid) {
      const result = await executeHook({
        context: {
          hookName: options.hookName,
          hookScope: resolvedHook.scope,
          operationData: {
            ...options.operationData,
            REPO_NAME: resolvedHook.targetRepositoryName,
            REPO_PATH: resolvedHook.targetRepositoryPath,
          },
          repoPath: resolvedHook.executionPath,
          sourceScriptPath: resolvedHook.sourceScriptPath,
          targetRepoName: resolvedHook.targetRepositoryName,
          targetRepoPath: resolvedHook.targetRepositoryPath,
        },
        hookName: `${options.hookName}.${resolvedHook.targetRepositoryName}`,
        scriptPath: resolvedHook.scriptPath,
        timeout: options.timeoutMs,
      });
      executedCount += 1;

      const mapping = mapHookExecutionResult(result);
      if (mapping.hookStatus === "failure") {
        failureReason = mapping.reasonCode;
        const stderr = result.stderr.trim();
        let failureMessage = mapping.message;
        if (stderr.length > ZERO) {
          failureMessage = stderr;
        }

        failures.push(
          `[${resolvedHook.scope}:${resolvedHook.targetRepositoryName}] ${failureMessage}`,
        );
        if (options.stopOnFailure) {
          break;
        }
      }
    } else {
      failures.push(
        `[${resolvedHook.scope}:${resolvedHook.targetRepositoryName}] ${validation.error ?? "Hook validation failed"}`,
      );
      if (options.stopOnFailure) {
        break;
      }
    }
  }

  if (failures.length === 0) {
    hookSpinner?.succeed(`${options.hookName} hooks completed (${executedCount})`);
    let hookScriptLabel = "scripts";
    if (executedCount === ONE) {
      hookScriptLabel = "script";
    }

    return {
      hookStatus: "success",
      message: `Executed ${executedCount} hook ${hookScriptLabel}`,
      reasonCode: "none",
    };
  }

  hookSpinner?.fail(`${options.hookName} hooks failed`);
  let reasonCode: HookOutcomeReasonCode = "exit_non_zero";
  if (failureReason === "timeout") {
    reasonCode = "timeout";
  }

  return {
    hookStatus: "failure",
    message: failures.join("; "),
    reasonCode,
  };
};

const formatHookFailure = (hookName: string, outcome: HookOutcomeMapping): string =>
  `${hookName} hook failed: ${outcome.message}`;
