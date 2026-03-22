/**
 * Remove Command
 *
 * Removes worktrees and deletes branches across multiple repositories.
 */

import { Command } from "commander";
import { existsSync } from "fs";
import { basename, resolve } from "path";
import chalk from "chalk";
import {
  branchExists,
  createRemovalSummary,
  deleteBranch,
  discoverAllWorktrees,
  discoverWorktreesByBranch,
  discoverWorktreesByPath,
  detachWorktree,
  formatRemovalSummaryHuman,
  formatRemovalSummaryJson,
  getCurrentBranch,
  groupWorktreesByParent,
  removeWorktree,
  refreshRemainingChildStatuses,
} from "../core/remove.ts";
import type { RepositoryTarget } from "../core/remove.ts";
import { buildWorktreeEntries, resolveWorktreeStatuses } from "../core/worktree.ts";
import { findWorkspaceRoot, loadConfig } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";
import { RemoveCommandError, RemoveCommandErrorCode } from "../lib/errors.ts";
import { getDefaultBranch } from "../lib/git.ts";
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
  HookOutcomeMapping,
  HookOutcomeReasonCode,
  HookTargetRepository,
} from "../lib/hooks.ts";
import { error as logError, info, spinner, warn } from "../lib/logger.ts";
import { confirm as promptConfirm, multiSelect as promptMultiSelect } from "../lib/prompts.ts";
import type { Choice, PromptOutcome } from "../lib/prompts.ts";
import type {
  RemovalOperation,
  RemoveCommandOptions,
  WorktreeEntry,
  WorktreeGrouping,
} from "../types/remove.ts";

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
}

const createCommand = (): Command => {
  return new Command("remove")
    .description("Remove worktrees and delete branches")
    .argument("[target]", "Branch name or worktree path to remove (optional - prompts if omitted)")
    .option("--no-check-dirty", "Skip uncommitted changes check")
    .option("--keep-worktrees", "Delete branches but keep worktree directories")
    .option("--keep-branches", "Remove worktrees but keep git branches")
    .option("-f, --force", "Skip confirmation prompts")
    .option("--path", "Treat argument as worktree path")
    .option("--json", "Output results as JSON")
    .action(async (branch?: string, options?: CliOptions) => {
      try {
        const exitCode = await executeRemove(branch, options || {});
        process.exit(exitCode);
      } catch (error) {
        handleError(error, options || {});
      }
    });
};

const executeRemove = async (
  branchArg: string | undefined,
  options: RemoveCommandOptions,
  promptHandlers?: {
    confirm: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;
    multiSelect: (message: string, choices: Choice<string>[]) => Promise<PromptOutcome<string[]>>;
  },
): Promise<number> => {
  const startTime = Date.now();

  if (options.keepBranches && options.keepWorktrees) {
    const summary = createRemovalSummary(ZERO, ZERO);
    summary.duration = Date.now() - startTime;
    if (options.json) {
      console.log(formatRemovalSummaryJson(summary, {}));
    } else {
      warn("Both --keep-worktrees and --keep-branches specified");
      info("No operations will be performed. At least one removal type must be enabled.");
    }
    return ZERO;
  }

  const workspaceRoot = await getWorkspaceRoot();
  let config: Config;
  try {
    config = await loadConfig(workspaceRoot);
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }

    throw new RemoveCommandError(
      "Failed to load workspace configuration",
      RemoveCommandErrorCode.CONFIG_ERROR,
      { error: message },
    );
  }
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
      pathWorktrees.push(...enriched);
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
    const entries = await buildWorktreeEntries(allWorktrees, {
      childRepoNames,
      includeDirtyDetails: options.checkDirty !== false,
      reposDirName,
    });
    const selectable = entries.filter((wt) => !wt.isMain && wt.branch);

    if (selectable.length === 0) {
      info("No worktrees found to remove");
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
    const selected = expandSelectedWorktrees(selection.value, grouping, selectablePaths, entries);
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
      if (!wt.branch) {
        continue;
      }
      branchPresence[wt.branch] = branchPresence[wt.branch] || [];
      if (!branchPresence[wt.branch].includes(wt.repository)) {
        branchPresence[wt.branch].push(wt.repository);
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
      const mainWorktrees = enriched.filter((wt) => wt.isMain);
      const removable = enriched.filter((wt) => !wt.isMain);

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

  warnOnDefaultMainRemoval(skippedMain, defaultBranches);
  if (usedPathMode.value && worktreesToRemove.length === 0) {
    if (skippedMain.length > 0) {
      info("Selected worktree is main and cannot be removed");
    } else {
      info("No removable worktrees found for the provided path");
    }
    return ZERO;
  }

  if (options.checkDirty !== false && worktreesToRemove.length > 0) {
    const dirtyCheckSpinner = spinner("Checking for uncommitted changes...").start();
    await resolveWorktreeStatuses(worktreesToRemove, true);
    dirtyCheckSpinner.succeed("Dirty check complete");
  }

  if (!options.force) {
    ensureInteractive(allowNonInteractive);
    const confirmation = await promptConfirmation(
      worktreesToRemove,
      branchPresence,
      options.checkDirty !== false,
      prompt.confirm,
    );
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

  const preRemoveOutcome = await runRemoveLifecycleHook({
    hookName: GLOBAL_HOOKS.preRemove,
    operationData: removeHookOperationData,
    stopOnFailure: true,
    targetRepositories: removeHookTargets,
    timeoutMs: config.hooks?.timeout,
    workspaceRoot,
  });
  if (preRemoveOutcome.hookStatus === "failure") {
    summary.errors.push(formatHookFailure(GLOBAL_HOOKS.preRemove, preRemoveOutcome));
    summary.duration = Date.now() - startTime;
    if (options.json) {
      console.log(formatRemovalSummaryJson(summary, { missingBranches, skippedMain }));
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
          message = error.message;
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
        const forceRemove =
          options.checkDirty === false ||
          worktree.isDirty === true ||
          worktree.status === "prunable";
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
        } else {
          try {
            await deleteBranch(repoPath, branch);
            operation.status = "success";
          } catch (error) {
            operation.status = "failed";
            operation.error = formatBranchDeletionError(error);
          }
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
    console.log(formatRemovalSummaryJson(summary, { missingBranches, skippedMain }));
  } else {
    console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
  }

  if (summary.errors.length > ZERO) {
    return ONE;
  }

  return ZERO;
};

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

const expandSelectedWorktrees = (
  selectedPaths: string[],
  grouping: WorktreeGrouping,
  selectablePaths: Set<string>,
  entries: WorktreeEntry[],
): WorktreeEntry[] => {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const selected = new Map<string, WorktreeEntry>();
  const groupByParentPath = new Map(grouping.groups.map((group) => [group.parent.path, group]));

  for (const path of selectedPaths) {
    if (!selectablePaths.has(path)) {
      continue;
    }
    const group = groupByParentPath.get(path);
    if (group) {
      selected.set(group.parent.path, group.parent);
      for (const child of group.children) {
        selected.set(child.path, child);
      }
      continue;
    }
    const entry = entryByPath.get(path);
    if (entry) {
      selected.set(entry.path, entry);
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

const promptConfirmation = async (
  worktrees: WorktreeEntry[],
  branchPresence: Record<string, string[]>,
  checkDirty: boolean,
  confirm: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>,
): Promise<"confirmed" | "declined" | "cancelled"> => {
  if (checkDirty) {
    const dirty = worktrees.filter((wt) => wt.isDirty);
    if (dirty.length > ZERO) {
      warn(`Uncommitted changes detected in ${dirty.length} worktrees:`);
      for (const wt of dirty) {
        const details = wt.dirtyDetails;
        const parts: string[] = [];
        if (details) {
          if (details.modifiedFiles > ZERO) {
            parts.push(`${details.modifiedFiles} modified files`);
          }
          if (details.untrackedFiles > ZERO) {
            parts.push(`${details.untrackedFiles} untracked files`);
          }
          if (details.stagedFiles > ZERO) {
            parts.push(`${details.stagedFiles} staged files`);
          }
        }
        let detailText = "";
        if (parts.length > ZERO) {
          detailText = ` (${parts.join(", ")})`;
        }
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
      message = error.message;
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
      console.log(
        JSON.stringify(
          {
            error: {
              code: error.code,
              message: error.message,
              context: error.context,
            },
            success: false,
          },
          null,
          JSON_INDENT,
        ),
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
    message = error.message;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          error: {
            code: "UNKNOWN_ERROR",
            message,
          },
          success: false,
        },
        null,
        JSON_INDENT,
      ),
    );
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
    message = error.message;
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
    message = error.message;
  }

  const lower = message.toLowerCase();

  if (lower.includes("checked out")) {
    return "Branch is currently checked out";
  }

  return message;
};

const runRemoveLifecycleHook = async (options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
  operationData: Record<string, string>;
  timeoutMs?: number;
  stopOnFailure: boolean;
}): Promise<HookOutcomeMapping> => {
  const hookSpinner = spinner(`Running ${options.hookName} hooks...`).start();
  const resolvedHooks = await resolveScopedLifecycleHooks({
    hookName: options.hookName,
    targetRepositories: options.targetRepositories,
    workspaceRoot: options.workspaceRoot,
  });

  if (resolvedHooks.length === 0) {
    const skipped = mapHookSkippedOutcome("not_found", "Hook script not found");
    hookSpinner.stop();
    info(`Skipping ${options.hookName} hooks: ${skipped.message}`);
    return skipped;
  }

  const failures: string[] = [];
  let failureReason: HookOutcomeReasonCode = "exit_non_zero";
  let executedCount = 0;

  for (const resolvedHook of resolvedHooks) {
    hookSpinner.text = `Running ${options.hookName} (${resolvedHook.scope}:${resolvedHook.targetRepositoryName})...`;

    const validation = await validateHook(resolvedHook.scriptPath);
    if (!validation.valid) {
      failures.push(
        `[${resolvedHook.scope}:${resolvedHook.targetRepositoryName}] ${validation.error ?? "Hook validation failed"}`,
      );
      if (options.stopOnFailure) {
        break;
      }
      continue;
    }

    const result = await executeHook({
      context: {
        hookName: options.hookName,
        repoPath: resolvedHook.executionPath,
        hookScope: resolvedHook.scope,
        sourceScriptPath: resolvedHook.sourceScriptPath,
        targetRepoName: resolvedHook.targetRepositoryName,
        targetRepoPath: resolvedHook.targetRepositoryPath,
        operationData: {
          ...options.operationData,
          REPO_NAME: resolvedHook.targetRepositoryName,
          REPO_PATH: resolvedHook.targetRepositoryPath,
        },
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
  }

  if (failures.length === 0) {
    hookSpinner.succeed(`${options.hookName} hooks completed (${executedCount})`);
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

  hookSpinner.fail(`${options.hookName} hooks failed`);
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

export { createCommand, executeRemove };
