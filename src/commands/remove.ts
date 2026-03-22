/**
 * Remove Command
 *
 * Removes worktrees and deletes branches across multiple repositories.
 */

import { Command } from "commander";
import { basename, resolve } from "path";
import chalk from "chalk";
import { confirm as promptConfirm, multiSelect as promptMultiSelect } from "../lib/prompts.ts";
import type { Choice, PromptOutcome } from "../lib/prompts.ts";
import * as logger from "../lib/logger.ts";
import { loadConfig, findWorkspaceRoot } from "../lib/config.ts";
import type { Config } from "../lib/config.ts";
import { RemoveCommandError, RemoveCommandErrorCode } from "../lib/errors.ts";
import { getDefaultBranch } from "../lib/git.ts";
import { existsSync } from "fs";
import type {
  RemovalOperation,
  RemoveCommandOptions,
  WorktreeEntry,
  WorktreeGrouping,
} from "../types/remove.ts";
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
import * as hooks from "../lib/hooks.ts";

interface CliOptions {
  checkDirty?: boolean;
  keepWorktrees?: boolean;
  keepBranches?: boolean;
  force?: boolean;
  path?: boolean;
  json?: boolean;
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
  },
): Promise<number> {
  const startTime = Date.now();

  if (options.keepBranches && options.keepWorktrees) {
    const summary = createRemovalSummary(0, 0);
    summary.duration = Date.now() - startTime;
    if (options.json) {
      console.log(formatRemovalSummaryJson(summary, {}));
    } else {
      logger.warn("Both --keep-worktrees and --keep-branches specified");
      logger.info("No operations will be performed. At least one removal type must be enabled.");
    }
    return 0;
  }

  const workspaceRoot = await getWorkspaceRoot();
  let config: Config;
  try {
    config = await loadConfig(workspaceRoot);
  } catch (error) {
    throw new RemoveCommandError(
      "Failed to load workspace configuration",
      RemoveCommandErrorCode.CONFIG_ERROR,
      { error: error instanceof Error ? error.message : String(error) },
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
    if (matchingByPath.length > 0) {
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
      logger.info("No worktrees found to remove");
      return 0;
    }

    ensureInteractive(allowNonInteractive);
    const grouping = groupWorktreesByParent(entries);
    const selectablePaths = new Set(selectable.map((wt) => wt.path));
    const choices = buildWorktreeChoices(grouping, selectablePaths, defaultBranches);
    const selection = await prompt.multiSelect("Select worktrees to remove:", choices);
    if (selection.status === "cancelled") {
      logger.info("Selection cancelled");
      return 0;
    }
    const selected = expandSelectedWorktrees(selection.value, grouping, selectablePaths, entries);
    usedPathMode.value = true;
    pathWorktrees.push(...selected);
    targetBranches = [...new Set(selected.map((wt) => wt.branch).filter(Boolean))];

    if (targetBranches.length === 0) {
      logger.info("No worktrees selected to remove");
      return 0;
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
      logger.info("Selected worktree is main and cannot be removed");
    } else {
      logger.info("No removable worktrees found for the provided path");
    }
    return 0;
  }

  if (options.checkDirty !== false && worktreesToRemove.length > 0) {
    const s = logger.spinner("Checking for uncommitted changes...").start();
    await resolveWorktreeStatuses(worktreesToRemove, true);
    s.succeed("Dirty check complete");
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
      logger.info("Operation cancelled");
      return 0;
    }
    if (confirmation === "declined") {
      logger.info("Operation cancelled by user");
      return 0;
    }
  }

  const totalWorktrees = options.keepWorktrees ? 0 : worktreesToRemove.length;
  const totalBranches = options.keepBranches
    ? 0
    : Object.values(branchPresence).reduce((sum, repos) => sum + repos.length, 0);

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
  const targetRepositoryNames = [...targetRepositories].toSorted((a, b) => a.localeCompare(b));
  const removeHookTargets = targetRepositoryNames.map((repoName) => ({
    name: repoName,
    path: getRepoPath(repositories, repoName),
  }));

  const removeHookOperationData = hooks.buildRemoveHookOperationData({
    branchNames: targetBranches,
    mainRepoPath: workspaceRoot,
    repositoryNames: targetRepositoryNames,
    worktreePaths: worktreesToRemove.map((worktree) => worktree.path),
  });

  const preRemoveOutcome = await runRemoveLifecycleHook({
    hookName: hooks.GLOBAL_HOOKS.preRemove,
    operationData: removeHookOperationData,
    stopOnFailure: true,
    targetRepositories: removeHookTargets,
    timeoutMs: config.hooks?.timeout,
    workspaceRoot,
  });
  if (preRemoveOutcome.hookStatus === "failure") {
    summary.errors.push(formatHookFailure(hooks.GLOBAL_HOOKS.preRemove, preRemoveOutcome));
    summary.duration = Date.now() - startTime;
    if (options.json) {
      console.log(formatRemovalSummaryJson(summary, { missingBranches, skippedMain }));
    } else {
      console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
    }
    return 1;
  }

  if (options.keepWorktrees && worktreesToRemove.length > 0) {
    for (const worktree of worktreesToRemove) {
      try {
        await detachWorktree(worktree.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
    hookName: hooks.GLOBAL_HOOKS.postRemove,
    operationData: removeHookOperationData,
    stopOnFailure: false,
    targetRepositories: removeHookTargets,
    timeoutMs: config.hooks?.timeout,
    workspaceRoot,
  });
  if (postRemoveOutcome.hookStatus === "failure") {
    summary.errors.push(formatHookFailure(hooks.GLOBAL_HOOKS.postRemove, postRemoveOutcome));
  }

  summary.duration = Date.now() - startTime;

  if (options.json) {
    console.log(formatRemovalSummaryJson(summary, { missingBranches, skippedMain }));
  } else {
    console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
  }

  return summary.errors.length > 0 ? 1 : 0;
}

function buildRepositoryTargets(
  workspaceRoot: string,
  repos: Record<string, { path: string }>,
): RepositoryTarget[] {
  const targets: RepositoryTarget[] = [];
  const mainName = basename(workspaceRoot);
  targets.push({ name: mainName, path: workspaceRoot });

  for (const [name, repo] of Object.entries(repos)) {
    targets.push({ name, path: resolve(workspaceRoot, repo.path) });
  }

  return targets;
}

function getRepoPath(repositories: RepositoryTarget[], repoName: string): string {
  const repo = repositories.find((r) => r.name === repoName);
  if (!repo) {
    return repoName;
  }
  return repo.path;
}

function formatWorktreeStatusLabel(worktree: WorktreeEntry): string {
  if (worktree.status === "prunable") {
    return chalk.gray("prunable");
  }
  if (worktree.status === "dirty") {
    return chalk.yellow("dirty");
  }
  return chalk.green("clean");
}

function formatChildSummary(children: WorktreeEntry[]): string | null {
  if (children.length === 0) {
    return null;
  }

  const sortedChildren = [...children];
  sortedChildren.sort((a: WorktreeEntry, b: WorktreeEntry) =>
    a.repository.localeCompare(b.repository),
  );

  const parts = sortedChildren.map((child: WorktreeEntry) => {
    const branchLabel = child.branch || "detached";
    const status =
      child.status === "prunable" ? "prunable" : child.status === "dirty" ? "dirty" : null;
    return status
      ? `${child.repository}=${branchLabel} (${status})`
      : `${child.repository}=${branchLabel}`;
  });

  return parts.join(", ");
}

function buildWorktreeChoices(
  grouping: WorktreeGrouping,
  selectablePaths: Set<string>,
  defaultBranches: Record<string, string | null>,
): Choice<string>[] {
  const choices: Choice<string>[] = [];

  const pushEntry = (entry: WorktreeEntry, childSummary?: string | null) => {
    if (!selectablePaths.has(entry.path)) {
      return;
    }
    const status = formatWorktreeStatusLabel(entry);
    const branchLabel = entry.branch || "detached";
    const defaultTag =
      defaultBranches[entry.repository] === entry.branch ? chalk.cyan("default") : null;
    const suffix = childSummary ? ` (${childSummary})` : "";
    const label = `${branchLabel} - ${status}${defaultTag ? `, ${defaultTag}` : ""}${suffix}`;
    choices.push({ name: label, value: entry.path });
  };

  const groups = [...grouping.groups].toSorted((a, b) =>
    a.parent.path.localeCompare(b.parent.path),
  );
  for (const group of groups) {
    const summary = formatChildSummary(group.children);
    pushEntry(group.parent, summary);
  }

  const orphans = [...grouping.orphans].toSorted((a, b) => a.path.localeCompare(b.path));
  for (const orphan of orphans) {
    pushEntry(orphan, null);
  }

  return choices;
}

function expandSelectedWorktrees(
  selectedPaths: string[],
  grouping: WorktreeGrouping,
  selectablePaths: Set<string>,
  entries: WorktreeEntry[],
): WorktreeEntry[] {
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
}

async function getDefaultBranchMap(
  workspaceRoot: string,
  repos: Record<string, { path: string }>,
): Promise<Record<string, string | null>> {
  const map: Record<string, string | null> = {};
  const mainName = basename(workspaceRoot);
  map[mainName] = await resolveDefaultBranch(workspaceRoot);

  for (const [name, repo] of Object.entries(repos)) {
    const repoPath = resolve(workspaceRoot, repo.path);
    map[name] = await resolveDefaultBranch(repoPath);
  }

  return map;
}

async function resolveDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    return await getDefaultBranch(repoPath);
  } catch {
    return null;
  }
}

function warnOnDefaultMainRemoval(
  skippedMain: WorktreeEntry[],
  defaultBranches: Record<string, string | null>,
): void {
  const warnings = skippedMain.filter((wt) => defaultBranches[wt.repository] === wt.branch);
  if (warnings.length === 0) {
    return;
  }

  logger.warn("Default branch main worktree selected; main worktrees cannot be removed:");
  for (const wt of warnings) {
    logger.info(`  • ${wt.repository}: ${wt.branch} (${wt.path})`);
  }
}

async function promptConfirmation(
  worktrees: WorktreeEntry[],
  branchPresence: Record<string, string[]>,
  checkDirty: boolean,
  confirm: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>,
): Promise<"confirmed" | "declined" | "cancelled"> {
  if (checkDirty) {
    const dirty = worktrees.filter((wt) => wt.isDirty);
    if (dirty.length > 0) {
      logger.warn(`Uncommitted changes detected in ${dirty.length} worktrees:`);
      for (const wt of dirty) {
        const details = wt.dirtyDetails;
        const parts: string[] = [];
        if (details) {
          if (details.modifiedFiles > 0) {
            parts.push(`${details.modifiedFiles} modified files`);
          }
          if (details.untrackedFiles > 0) {
            parts.push(`${details.untrackedFiles} untracked files`);
          }
          if (details.stagedFiles > 0) {
            parts.push(`${details.stagedFiles} staged files`);
          }
        }
        const detailText = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        logger.info(`  • ${wt.repository}: ${wt.path}${detailText}`);
      }

      const outcome = await confirm(
        "Are you sure you want to remove these worktrees? This will discard all uncommitted changes.",
        false,
      );
      return resolveConfirmation(outcome);
    }
  }

  const worktreeCount = worktrees.length;
  const branchCount = Object.values(branchPresence).reduce((sum, repos) => sum + repos.length, 0);

  const outcome = await confirm(
    `Remove ${worktreeCount} ${worktreeCount === 1 ? "worktree" : "worktrees"} and delete ${branchCount} ${branchCount === 1 ? "branch" : "branches"}?`,
    false,
  );
  return resolveConfirmation(outcome);
}

async function getWorkspaceRoot(): Promise<string> {
  try {
    return await findWorkspaceRoot();
  } catch (error) {
    throw new RemoveCommandError(
      'Arashi configuration not found. Run "arashi init" to create configuration.',
      RemoveCommandErrorCode.CONFIG_ERROR,
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function handleError(error: unknown, options: RemoveCommandOptions): void {
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
          2,
        ),
      );
    } else {
      logger.error(error.message);
      if (error.code === RemoveCommandErrorCode.BRANCH_NOT_FOUND) {
        logger.info('Hint: Run "arashi list" to see all worktrees');
      }
      if (error.code === RemoveCommandErrorCode.NON_INTERACTIVE) {
        logger.info("Hint: Run this command in an interactive terminal");
      }
    }

    const exitCode =
      error.code === RemoveCommandErrorCode.BRANCH_NOT_FOUND ||
      error.code === RemoveCommandErrorCode.NON_INTERACTIVE
        ? 2
        : 1;
    process.exit(exitCode);
  }

  const message = error instanceof Error ? error.message : "Unknown error";
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
        2,
      ),
    );
  } else {
    logger.error(`Unexpected error: ${message}`);
  }
  process.exit(1);
}

function ensureInteractive(allowNonInteractive: boolean): void {
  if (!allowNonInteractive && !process.stdin.isTTY) {
    throw new RemoveCommandError(
      "Non-interactive terminal detected. Run this command in an interactive TTY.",
      RemoveCommandErrorCode.NON_INTERACTIVE,
    );
  }
}

function resolveConfirmation(
  outcome: PromptOutcome<boolean>,
): "confirmed" | "declined" | "cancelled" {
  if (outcome.status === "cancelled") {
    return "cancelled";
  }
  return outcome.value ? "confirmed" : "declined";
}

function resolveInputPath(input: string): string {
  if (existsSync(input)) {
    return input;
  }
  const resolved = resolve(input);
  if (existsSync(resolved)) {
    return resolved;
  }
  return input;
}

function formatWorktreeRemovalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("in use") || lower.includes("busy")) {
    return "Worktree is in use by another process";
  }

  if (lower.includes("locked")) {
    return "Worktree is locked (use --force to override)";
  }

  return message;
}

function formatBranchDeletionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes("checked out")) {
    return "Branch is currently checked out";
  }

  return message;
}

async function runRemoveLifecycleHook(options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: hooks.HookTargetRepository[];
  operationData: Record<string, string>;
  timeoutMs?: number;
  stopOnFailure: boolean;
}): Promise<hooks.HookOutcomeMapping> {
  const spinner = logger.spinner(`Running ${options.hookName} hooks...`).start();
  const resolvedHooks = await hooks.resolveScopedLifecycleHooks({
    hookName: options.hookName,
    targetRepositories: options.targetRepositories,
    workspaceRoot: options.workspaceRoot,
  });

  if (resolvedHooks.length === 0) {
    const skipped = hooks.mapHookSkippedOutcome("not_found", "Hook script not found");
    spinner.stop();
    logger.info(`Skipping ${options.hookName} hooks: ${skipped.message}`);
    return skipped;
  }

  const failures: string[] = [];
  let failureReason: hooks.HookOutcomeReasonCode = "exit_non_zero";
  let executedCount = 0;

  for (const resolvedHook of resolvedHooks) {
    spinner.text = `Running ${options.hookName} (${resolvedHook.scope}:${resolvedHook.targetRepositoryName})...`;

    const validation = await hooks.validateHook(resolvedHook.scriptPath);
    if (!validation.valid) {
      failures.push(
        `[${resolvedHook.scope}:${resolvedHook.targetRepositoryName}] ${validation.error ?? "Hook validation failed"}`,
      );
      if (options.stopOnFailure) {
        break;
      }
      continue;
    }

    const result = await hooks.executeHook({
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

    const mapping = hooks.mapHookExecutionResult(result);
    if (mapping.hookStatus === "failure") {
      failureReason = mapping.reasonCode;
      const stderr = result.stderr.trim();
      failures.push(
        `[${resolvedHook.scope}:${resolvedHook.targetRepositoryName}] ${stderr.length > 0 ? stderr : mapping.message}`,
      );
      if (options.stopOnFailure) {
        break;
      }
    }
  }

  if (failures.length === 0) {
    spinner.succeed(`${options.hookName} hooks completed (${executedCount})`);
    return {
      hookStatus: "success",
      message: `Executed ${executedCount} hook script${executedCount === 1 ? "" : "s"}`,
      reasonCode: "none",
    };
  }

  spinner.fail(`${options.hookName} hooks failed`);
  return {
    hookStatus: "failure",
    message: failures.join("; "),
    reasonCode: failureReason === "timeout" ? "timeout" : "exit_non_zero",
  };
}

function formatHookFailure(hookName: string, outcome: hooks.HookOutcomeMapping): string {
  return `${hookName} hook failed: ${outcome.message}`;
}
