/**
 * Remove Command
 *
 * Removes worktrees and deletes branches across multiple repositories.
 */

import {
  GLOBAL_HOOKS,
  buildRemoveHookOperationData,
  discoverLifecycleHookCandidatesInDirectory,
  executeHook,
  executeInlineHook,
  mapHookExecutionResult,
  mapHookSkippedOutcome,
  normalizeLifecyclePath,
  prepareLifecycleHookSources,
  releaseHookInterruptGuards,
  resolveScopedLifecycleHooks,
  resolveHookInputMode,
  validateHook,
} from "../lib/hooks.ts";
import type {
  HookInputMode,
  HookOutcomeMapping as SharedHookOutcomeMapping,
  LifecycleHookPreparationCandidate,
  LifecycleHookOutcome,
  PlannedLifecycleHookSource,
  PreparedLifecycleHookEntry,
  RemoveHookTarget,
} from "../lib/hooks.ts";
import type {
  RemovalOperation,
  RemoveCommandOptions,
  RemoveHookPreview,
  WorktreeEntry,
  WorktreeGrouping,
} from "../types/remove.ts";
import { ArashiError, RemoveCommandError, RemoveCommandErrorCode } from "../lib/errors.ts";
import { basename, join, resolve } from "path";
import { homedir } from "os";
import {
  branchExists,
  canonicalPhysicalPath,
  createConfiguredWorktreeRemovalPlan,
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
  isDescendantWorktreePath,
  pathExistsFailClosed,
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
import { ConfigValidationError, findWorkspaceRoot, loadConfig } from "../lib/config.ts";

import { resolveWorkspaceContext, workspaceJsonMetadata } from "../lib/workspace-context.ts";
import {
  preflightStandaloneGlobalHooks,
  runStandaloneGlobalHooks,
  standaloneWorktrees,
} from "../lib/standalone.ts";
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
import { access } from "fs/promises";

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
  | "validation_failed"
  | "interpreter_unavailable"
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

type PreparedRemoveHooks = Readonly<
  Record<"post-remove" | "pre-remove", readonly PreparedLifecycleHookEntry[]>
>;

type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason: "exit" | "abort" };
type RepositoryTarget = Parameters<typeof discoverAllWorktrees>[0][number];

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const JSON_INDENT = 2;

interface CliOptions {
  checkDirty?: boolean;
  keepWorktrees?: boolean;
  keepBranches?: boolean;
  force?: boolean;
  path?: boolean;
  json?: boolean;
  dryRun?: boolean;
  hookInput?: boolean;
}

export interface StandaloneRemovePartialFailureDetails {
  finalState: { branchExists: boolean | null; worktreeExists: boolean | null };
  hookOutcomes: LifecycleHookOutcome[];
  hookFailures: { hookName: string; message: string }[];
  operationFailures: { message: string; operation: string }[];
}

export const branchStateAfterShowRefExistsFailure = (error: unknown): false | null =>
  error instanceof ArashiError && error.context.exitCode === TWO ? false : null;

export const pathStateAfterInspectionFailure = (error: unknown): false | null =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    ? false
    : null;

const inspectPathExists = async (path: string): Promise<boolean | null> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    return pathStateAfterInspectionFailure(error);
  }
};

type StandaloneBranchAction = "keep" | "none" | "remove";

class StandaloneRemovePartialFailure extends Error {
  readonly code = "STANDALONE_REMOVE_PARTIAL_FAILURE";
  readonly details: StandaloneRemovePartialFailureDetails;
  readonly branchAction: StandaloneBranchAction;

  constructor(
    details: StandaloneRemovePartialFailureDetails,
    branchAction: StandaloneBranchAction,
  ) {
    super("Standalone remove completed with one or more operation or finalization failures");
    this.details = details;
    this.branchAction = branchAction;
    this.name = "StandaloneRemovePartialFailure";
  }
}

export const formatStandaloneRemovePartialFailureHuman = (
  details: Pick<
    StandaloneRemovePartialFailureDetails,
    "finalState" | "hookFailures" | "operationFailures"
  >,
  branchAction: StandaloneBranchAction = details.finalState.branchExists === null
    ? "none"
    : "remove",
): string => {
  const branchDeletionFailed = details.operationFailures.some(
    (failure) => failure.operation === "delete-branch",
  );
  let branchState =
    branchAction === "none"
      ? "No branch was associated with this worktree"
      : "Could not determine whether the branch still exists";
  if (details.finalState.branchExists === true) {
    branchState = "Branch still exists";
  } else if (details.finalState.branchExists === false) {
    branchState =
      branchAction === "remove" && !branchDeletionFailed
        ? "Branch was deleted"
        : "Branch does not exist";
  }
  let worktreeState = "Could not determine whether the worktree directory remains";
  if (details.finalState.worktreeExists === true) {
    worktreeState = "Worktree directory remains";
  } else if (details.finalState.worktreeExists === false) {
    worktreeState = "Worktree directory was removed";
  }
  const lines = [
    "Standalone removal completed with incomplete cleanup.",
    "",
    "Final state:",
    `  • ${worktreeState}`,
    `  • ${branchState}`,
  ];

  if (details.operationFailures.length > ZERO) {
    lines.push("", "Operation failures:");
    for (const failure of details.operationFailures) {
      lines.push(`  • ${failure.operation}: ${failure.message}`);
    }
  }

  if (details.hookFailures.length > ZERO) {
    lines.push("", "Hook failures:");
    for (const failure of details.hookFailures) {
      lines.push(`  • ${failure.hookName}: ${failure.message}`);
    }
  }

  const worktreeRemovalFailed = details.operationFailures.some(
    (failure) => failure.operation === "remove-worktree",
  );
  if (details.finalState.worktreeExists === true && worktreeRemovalFailed) {
    lines.push(
      "",
      "Close terminals or editors using the worktree directory.",
      "If Git still lists the worktree, retry removal after releasing the directory.",
      "Otherwise, remove the leftover directory only after Git no longer lists it.",
    );
  }

  return lines.join("\n");
};

const loadWorkspaceConfig = async (workspaceRoot: string): Promise<Config> => {
  try {
    return await loadConfig(workspaceRoot);
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
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
  quiet: boolean;
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
    .option("-j, --json", "Output results as JSON")
    .option("--no-hook-input", "Execute hooks with input disabled and immediate EOF")
    .option("-n, --dry-run", "Preview planned removals without mutating worktrees or branches")
    .action(async (branch?: string, options?: CliOptions) => {
      try {
        const exitCode = await executeRemove(branch, options || {}).finally(
          releaseHookInterruptGuards,
        );
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
  const hookInputMode = resolveHookInputMode({
    hookInput: options.hookInput,
    json: options.json,
    stdinIsTTY: options.stdinIsTTY ?? process.stdin.isTTY === true,
  });

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

      const prunable = worktrees.filter((entry) => entry.pruneReason || !existsSync(entry.path));
      const selectable = worktrees.filter(
        (entry) =>
          !entry.pruneReason &&
          existsSync(entry.path) &&
          resolve(entry.path) !== resolve(workspaceContext.mainRoot),
      );
      if (selectable.length === ZERO) {
        info("No worktrees found to remove");
        if (prunable.length > ZERO) {
          info("Stale worktree metadata found; run 'arashi prune' to clean it up");
        }
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
        quiet: options.json === true,
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

    await preflightStandaloneGlobalHooks(
      workspaceContext,
      ["pre-remove", "post-remove"],
      target.branch,
      target.path,
    );

    summary.hookOutcomes.push(
      ...(await runStandaloneGlobalHooks(
        workspaceContext,
        "pre-remove",
        target.branch,
        target.path,
        false,
        options.json === true,
        false,
        hookInputMode,
      )),
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
      const postHookOutcomes = await runStandaloneGlobalHooks(
        workspaceContext,
        "post-remove",
        target.branch,
        target.path,
        false,
        options.json === true,
        true,
        hookInputMode,
      );
      summary.hookOutcomes.push(...postHookOutcomes);
      hookFailures.push(
        ...postHookOutcomes
          .filter((outcome) => outcome.hookStatus === "failure")
          .map((outcome) => ({ hookName: outcome.hookName, message: outcome.message })),
      );
    } catch (error) {
      hookFailures.push({
        hookName: "post-remove",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (operationFailures.length > ZERO || hookFailures.length > ZERO) {
      let finalBranchExists: boolean | null = target.branch ? false : null;
      if (target.branch) {
        try {
          await standaloneGitExec(
            ["show-ref", "--exists", `refs/heads/${target.branch}`],
            workspaceContext.mainRoot,
          );
          finalBranchExists = true;
        } catch (error) {
          finalBranchExists = branchStateAfterShowRefExistsFailure(error);
        }
      }
      let branchAction: StandaloneBranchAction = "none";
      if (target.branch !== null) {
        branchAction = options.keepBranches ? "keep" : "remove";
      }
      throw new StandaloneRemovePartialFailure(
        {
          finalState: {
            branchExists: finalBranchExists,
            worktreeExists: await inspectPathExists(target.path),
          },
          hookFailures,
          hookOutcomes: summary.hookOutcomes,
          operationFailures,
        },
        branchAction,
      );
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
  const configuredChildPaths = new Map(
    Object.entries(config.repos).map(([name, repository]) => [name, repository.path]),
  );
  const childRepoNames = new Set(configuredChildPaths.keys());
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

  if (!options.keepWorktrees && worktreesToRemove.length > ZERO) {
    const configuredRepositories = repositories.filter((repo) => childRepoNames.has(repo.name));
    const physicalHierarchy = worktreesToRemove.map((worktree) => worktree.path);
    const inspectedHierarchyPaths = new Set<string>();

    while (physicalHierarchy.length > ZERO) {
      const parentPath = physicalHierarchy.shift();
      if (!parentPath) {
        continue;
      }
      const parentIdentity = canonicalPhysicalPath(parentPath);
      if (inspectedHierarchyPaths.has(parentIdentity)) {
        continue;
      }
      inspectedHierarchyPaths.add(parentIdentity);

      for (const repo of configuredRepositories) {
        const configuredChildPath = configuredChildPaths.get(repo.name);
        if (!configuredChildPath) {
          continue;
        }
        const nestedPath = resolve(parentPath, configuredChildPath);
        if (!pathExistsFailClosed(nestedPath)) {
          continue;
        }
        if (!pathExistsFailClosed(repo.path)) {
          throw new Error(
            `Failed to inspect worktrees for ${repo.name} (${repo.path}): repository is missing while a configured descendant exists at ${nestedPath}`,
          );
        }
        physicalHierarchy.push(nestedPath);
      }
    }

    const discoveredInventory = await discoverAllWorktrees(repositories, {
      strict: true,
    });
    const configuredInventory = await buildWorktreeEntries(discoveredInventory, {
      childRepoNames,
      includeDirtyDetails: false,
      reposDirName,
    });
    const plan = createConfiguredWorktreeRemovalPlan(worktreesToRemove, configuredInventory);
    worktreesToRemove.splice(ZERO, worktreesToRemove.length, ...plan.worktrees);
    const unsafePlannedDescendant =
      findUnplannedRegisteredDescendant(worktreesToRemove, discoveredInventory, repositories) ??
      findUnplannedConfiguredDescendant(worktreesToRemove, repositories, configuredChildPaths);
    if (unsafePlannedDescendant) {
      throw new Error(
        `Removal of ${unsafePlannedDescendant.blockingWorktree.path} blocked because configured descendant ${unsafePlannedDescendant.repository.name}: ${unsafePlannedDescendant.path} exists outside the authoritative plan`,
      );
    }

    for (const worktree of plan.worktrees) {
      if (!worktree.branch) {
        continue;
      }
      if (!targetBranches.includes(worktree.branch)) {
        targetBranches.push(worktree.branch);
      }
      branchPresence[worktree.branch] = branchPresence[worktree.branch] ?? [];
      if (!branchPresence[worktree.branch].includes(worktree.repository)) {
        branchPresence[worktree.branch].push(worktree.repository);
      }
      missingBranches[worktree.branch] = missingBranches[worktree.branch] ?? [];
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
  const removeHookTargets = targetRepositoryNames.map((repoName) => ({
    name: repoName,
    path: getRepoPath(repositories, repoName),
  }));

  const targetByTriple = new Map<string, RemoveHookTarget>();
  const repositoryBranchesWithWorktrees = new Set<string>();
  for (const worktree of worktreesToRemove) {
    const target: RemoveHookTarget = {
      branchName: worktree.branch || null,
      repository: worktree.repository,
      worktreePath: worktree.path ? normalizeLifecyclePath(worktree.path) : null,
    };
    targetByTriple.set(JSON.stringify(target), target);
    repositoryBranchesWithWorktrees.add(`${target.repository}\0${target.branchName ?? ""}`);
  }
  for (const branchName of targetBranches) {
    for (const repository of branchPresence[branchName] ?? []) {
      if (repositoryBranchesWithWorktrees.has(`${repository}\0${branchName}`)) continue;
      const target: RemoveHookTarget = {
        branchName,
        repository,
        worktreePath: null,
      };
      targetByTriple.set(JSON.stringify(target), target);
    }
  }
  const removeTargets = [...targetByTriple.values()];
  const removeHookOperationData = buildRemoveHookOperationData({
    mainRepoPath: workspaceRoot,
    targets: removeTargets,
  });

  let preparedRemoveHooks: PreparedRemoveHooks | null = null;
  let preflightFailure: LifecycleHookOutcome | null = null;
  let unavailableHookPreviews: RemoveHookPreview[] = [];
  try {
    const preflight = await preflightRemoveLifecycleHooks({
      config,
      dryRun: options.dryRun === true,
      removeTargets,
      targetRepositories: removeHookTargets,
      workspaceRoot,
    });
    preparedRemoveHooks = preflight.preparedHooks;
    preflightFailure = preflight.failure;
    unavailableHookPreviews = preflight.unavailablePreviews;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.errors.push(message);
    summary.duration = Date.now() - startTime;
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("remove", {
          code: "HOOK_CONFIGURATION_INVALID",
          details: removalJsonData(summary, { missingBranches, skippedMain }, configuredMetadata),
          message,
        }),
      );
    } else {
      console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
    }
    return ONE;
  }
  if (preflightFailure && (!options.dryRun || unavailableHookPreviews.length === ZERO)) {
    summary.hookOutcomes.push(preflightFailure);
    summary.errors.push(preflightFailure.message);
    summary.duration = Date.now() - startTime;
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("remove", {
          code: "HOOK_CONFIGURATION_INVALID",
          details: removalJsonData(summary, { missingBranches, skippedMain }, configuredMetadata),
          message: preflightFailure.message,
        }),
      );
    } else {
      console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
    }
    return ONE;
  }

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
      preparedLocations: preparedRemoveHooks ?? undefined,
      targetRepositories: removeHookTargets,
      unavailablePreviews: unavailableHookPreviews,
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

  if (!options.force) {
    ensureInteractive(allowNonInteractive);
    const confirmation = await promptConfirmation({
      branchPresence,
      checkDirty: options.checkDirty !== false,
      confirm: prompt.confirm,
      quiet: options.json === true,
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

  const preRemoveResult = await runRemoveLifecycleHook({
    hookName: GLOBAL_HOOKS.preRemove,
    hookInputMode,
    operationData: removeHookOperationData,
    preparedLocations: preparedRemoveHooks?.["pre-remove"],
    removeTargets,
    quiet: options.json === true,
    stopOnFailure: true,
    targetRepositories: removeHookTargets,
    timeoutMs: config.hooks?.timeout,
    workspaceRoot,
  });
  summary.hookOutcomes.push(...preRemoveResult.outcomes);
  if (preRemoveResult.summary.hookStatus === "failure") {
    summary.errors.push(formatHookFailure(GLOBAL_HOOKS.preRemove, preRemoveResult.summary));
    summary.duration = Date.now() - startTime;
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("remove", {
          code: "REMOVE_HOOK_FAILED",
          details: removalJsonData(summary, { missingBranches, skippedMain }, configuredMetadata),
          message: summary.errors.join("; "),
        }),
      );
    } else {
      console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
    }
    return ONE;
  }

  let invalidatedRemovalPlan: UnplannedConfiguredDescendant | undefined;
  if (!options.keepWorktrees) {
    const refreshedInventory = await discoverAllWorktrees(repositories, {
      strict: true,
    });
    invalidatedRemovalPlan =
      findUnplannedRegisteredDescendant(worktreesToRemove, refreshedInventory, repositories) ??
      findUnplannedConfiguredDescendant(worktreesToRemove, repositories, configuredChildPaths);
    if (invalidatedRemovalPlan) {
      const message = `Removal of ${invalidatedRemovalPlan.blockingWorktree.path} blocked because unplanned configured descendant ${invalidatedRemovalPlan.repository.name}: ${invalidatedRemovalPlan.path} appeared after planning`;
      summary.operations.push({
        branchName: invalidatedRemovalPlan.blockingWorktree.branch,
        error: message,
        repository: invalidatedRemovalPlan.blockingWorktree.repository,
        status: "failed",
        type: "worktree_remove",
        worktreePath: invalidatedRemovalPlan.blockingWorktree.path,
      });
      summary.errors.push(message);
    }
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

  if (!options.keepWorktrees && !invalidatedRemovalPlan) {
    const failedWorktrees: WorktreeEntry[] = [];
    for (let index = 0; index < worktreesToRemove.length; index += 1) {
      const worktree = worktreesToRemove[index];
      const operation: RemovalOperation = {
        branchName: worktree.branch,
        repository: worktree.repository,
        status: "pending",
        type: "worktree_remove",
        worktreePath: worktree.path,
      };

      const failedDescendant = failedWorktrees.find((failed) =>
        isDescendantWorktreePath(worktree.path, failed.path),
      );
      if (failedDescendant) {
        operation.status = "failed";
        operation.error = `Removal of ${worktree.path} blocked because descendant ${failedDescendant.repository}: ${failedDescendant.path} failed`;
      } else {
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
      }

      summary.operations.push(operation);
      if (operation.status === "success") {
        summary.successfulWorktrees += 1;
      }
      if (operation.status === "failed" && operation.error) {
        failedWorktrees.push(worktree);
        summary.errors.push(`${operation.repository}: ${operation.error}`);
      }
    }
  }

  if (!options.keepBranches && !invalidatedRemovalPlan && targetBranches.length > 0) {
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

  const postRemoveResult = await runRemoveLifecycleHook({
    hookName: GLOBAL_HOOKS.postRemove,
    hookInputMode,
    operationData: removeHookOperationData,
    preparedLocations: preparedRemoveHooks?.["post-remove"],
    removeTargets,
    quiet: options.json === true,
    stopOnFailure: false,
    targetRepositories: removeHookTargets,
    timeoutMs: config.hooks?.timeout,
    workspaceRoot,
  });
  summary.hookOutcomes.push(...postRemoveResult.outcomes);
  if (postRemoveResult.summary.hookStatus === "failure") {
    summary.errors.push(formatHookFailure(GLOBAL_HOOKS.postRemove, postRemoveResult.summary));
  }

  summary.duration = Date.now() - startTime;

  if (options.json) {
    const data = removalJsonData(summary, { missingBranches, skippedMain }, configuredMetadata);
    writeJsonEnvelope(
      summary.errors.length > ZERO
        ? createJsonErrorEnvelope("remove", {
            code: "REMOVE_FAILED",
            details: data,
            message: summary.errors.join("; "),
          })
        : createJsonSuccessEnvelope("remove", data),
    );
  } else {
    console.log(formatRemovalSummaryHuman(summary, { missingBranches, skippedMain }));
  }

  if (summary.errors.length > ZERO) {
    return ONE;
  }

  return ZERO;
}

interface UnplannedConfiguredDescendant {
  blockingWorktree: WorktreeEntry;
  path: string;
  repository: RepositoryTarget;
}

const findUnplannedRegisteredDescendant = (
  worktrees: WorktreeEntry[],
  refreshedInventory: ReadonlyArray<Pick<WorktreeEntry, "path" | "repository">>,
  repositories: RepositoryTarget[],
): UnplannedConfiguredDescendant | undefined => {
  const plannedPaths = new Set(worktrees.map((worktree) => canonicalPhysicalPath(worktree.path)));

  for (const candidate of refreshedInventory) {
    if (!pathExistsFailClosed(candidate.path)) {
      continue;
    }
    const candidatePath = canonicalPhysicalPath(candidate.path);
    if (plannedPaths.has(candidatePath)) {
      continue;
    }
    const blockingWorktree = worktrees.find((worktree) =>
      isDescendantWorktreePath(canonicalPhysicalPath(worktree.path), candidatePath),
    );
    if (!blockingWorktree) {
      continue;
    }
    const repository = repositories.find((target) => target.name === candidate.repository);
    if (repository) {
      return { blockingWorktree, path: candidate.path, repository };
    }
  }

  return undefined;
};

const findUnplannedConfiguredDescendant = (
  worktrees: WorktreeEntry[],
  repositories: RepositoryTarget[],
  configuredChildPaths: ReadonlyMap<string, string>,
): UnplannedConfiguredDescendant | undefined => {
  const plannedPaths = new Set(worktrees.map((worktree) => canonicalPhysicalPath(worktree.path)));
  const configuredRepositories = repositories.filter((repo) => configuredChildPaths.has(repo.name));

  for (const blockingWorktree of worktrees) {
    const hierarchy = [blockingWorktree.path];
    const inspectedPaths = new Set<string>();
    while (hierarchy.length > ZERO) {
      const parentPath = hierarchy.shift();
      if (!parentPath) {
        continue;
      }
      const parentIdentity = canonicalPhysicalPath(parentPath);
      if (inspectedPaths.has(parentIdentity)) {
        continue;
      }
      inspectedPaths.add(parentIdentity);

      for (const repository of configuredRepositories) {
        const configuredChildPath = configuredChildPaths.get(repository.name);
        if (!configuredChildPath) {
          continue;
        }
        const nestedPath = resolve(parentPath, configuredChildPath);
        if (!pathExistsFailClosed(nestedPath)) {
          continue;
        }
        if (!plannedPaths.has(canonicalPhysicalPath(nestedPath))) {
          return { blockingWorktree, path: nestedPath, repository };
        }
        hierarchy.push(nestedPath);
      }
    }
  }

  return undefined;
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
  quiet,
  worktrees,
}: ConfirmationOptions): Promise<"confirmed" | "declined" | "cancelled"> => {
  if (checkDirty) {
    const dirty = worktrees.filter((wt) => wt.isDirty);
    if (dirty.length > ZERO) {
      if (!quiet) {
        warn(`Uncommitted changes detected in ${dirty.length} worktrees:`);
        for (const wt of dirty) {
          const detailText = formatDirtyDetailsText(wt);
          info(`  • ${wt.repository}: ${wt.path}${detailText}`);
        }
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
    writeJsonEnvelope(
      createJsonErrorEnvelope(
        "remove",
        error instanceof ConfigValidationError
          ? {
              code: "CONFIG_VALIDATION_ERROR",
              details: error.context,
              message: error.message,
            }
          : unknownErrorToJsonError(error),
      ),
    );
  } else if (error instanceof StandaloneRemovePartialFailure) {
    logError(formatStandaloneRemovePartialFailureHuman(error.details, error.branchAction));
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

const sortRemoveHookPreviews = (
  previews: RemoveHookPreview[],
  targetRepositories: readonly HookTargetRepository[],
): RemoveHookPreview[] => {
  const lifecycleOrder = new Map([
    [GLOBAL_HOOKS.preRemove, ZERO],
    [GLOBAL_HOOKS.postRemove, ONE],
  ]);
  const scopeOrder = new Map([
    ["repository", ZERO],
    ["workspace", ONE],
    ["global-repository", 2],
    ["global-shared", 3],
  ]);
  const repositoryOrder = new Map(
    targetRepositories.map((repository, index) => [repository.name, index]),
  );
  return previews.toSorted(
    (left, right) =>
      (lifecycleOrder.get(left.hookName) ?? Number.MAX_SAFE_INTEGER) -
        (lifecycleOrder.get(right.hookName) ?? Number.MAX_SAFE_INTEGER) ||
      (repositoryOrder.get(left.repository) ?? Number.MAX_SAFE_INTEGER) -
        (repositoryOrder.get(right.repository) ?? Number.MAX_SAFE_INTEGER) ||
      (scopeOrder.get(left.scope) ?? Number.MAX_SAFE_INTEGER) -
        (scopeOrder.get(right.scope) ?? Number.MAX_SAFE_INTEGER),
  );
};

const previewRemoveLifecycleHooks = async (options: {
  globalOnly?: boolean;
  preparedLocations?: PreparedRemoveHooks;
  targetRepositories: HookTargetRepository[];
  unavailablePreviews?: readonly RemoveHookPreview[];
  workspaceRoot: string;
}): Promise<RemoveHookPreview[]> => {
  const previews: RemoveHookPreview[] = [...(options.unavailablePreviews ?? [])];
  if (options.preparedLocations) {
    for (const hookName of [GLOBAL_HOOKS.preRemove, GLOBAL_HOOKS.postRemove] as const) {
      for (const prepared of options.preparedLocations[hookName]) {
        if (prepared.kind === "absent") continue;
        previews.push({
          availability: "available",
          hookName,
          reasonCode: null,
          repository: prepared.plan.context.repositoryName ?? "workspace",
          scope: prepared.plan.scope,
          scriptPath: prepared.kind === "file" ? prepared.scriptPath : null,
          sourceKind: prepared.plan.sourceKind,
          sourceOwnerKind:
            prepared.plan.sourceOwnerKind === "global"
              ? "user-global"
              : prepared.plan.sourceOwnerKind,
          sourceOwnerName: prepared.plan.sourceOwnerName,
          sourceScriptPath: prepared.kind === "file" ? prepared.scriptPath : null,
          selectedInterpreter:
            prepared.kind === "inline-config" ? prepared.resolution.interpreter : null,
          valid: true,
        });
      }
    }
    return sortRemoveHookPreviews(previews, options.targetRepositories);
  }
  for (const hookName of [GLOBAL_HOOKS.preRemove, GLOBAL_HOOKS.postRemove] as const) {
    const resolvedHooks = await resolveScopedLifecycleHooks({
      globalOnly: options.globalOnly,
      hookName,
      targetRepositories: options.targetRepositories,
      workspaceRoot: options.workspaceRoot,
    });
    for (const resolvedHook of resolvedHooks.filter(
      (candidate) => !options.globalOnly || candidate.scope.startsWith("global-"),
    )) {
      const validation = await validateHook(resolvedHook.scriptPath);
      previews.push({
        availability: validation.valid ? "available" : "unavailable",
        error: validation.error,
        hookName,
        reasonCode: validation.reasonCode ?? null,
        repository: resolvedHook.targetRepositoryName,
        scope: resolvedHook.scope,
        scriptPath: resolvedHook.scriptPath,
        sourceKind: "file",
        sourceOwnerKind: "user-global",
        sourceOwnerName: null,
        sourceScriptPath: resolvedHook.scriptPath,
        selectedInterpreter: null,
        valid: validation.valid,
      });
    }
  }
  return sortRemoveHookPreviews(previews, options.targetRepositories);
};

const runRemoveLifecycleHook = async (options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
  operationData: Record<string, string>;
  removeTargets: RemoveHookTarget[];
  hookInputMode: HookInputMode;
  quiet?: boolean;
  timeoutMs?: number;
  stopOnFailure: boolean;
  preparedLocations: readonly PreparedLifecycleHookEntry[];
}): Promise<{ outcomes: LifecycleHookOutcome[]; summary: SharedHookOutcomeMapping }> => {
  const hookSpinner = options.quiet
    ? null
    : spinner(`Running ${options.hookName} hooks...`).start();
  const hookLocations = options.preparedLocations;

  if (hookLocations.length === 0) {
    const skipped = mapHookSkippedOutcome("not_found", "Hook script not found");
    hookSpinner?.stop();
    if (!options.quiet) {
      info(`Skipping ${options.hookName} hooks: ${skipped.message}`);
    }
    return { outcomes: [], summary: skipped };
  }

  const failures: string[] = [];
  let failureReason: HookOutcomeReasonCode = "exit_non_zero";
  let executedCount = 0;
  const outcomes: LifecycleHookOutcome[] = [];

  for (const preparedHook of hookLocations) {
    const publicSource = {
      sourceKind: preparedHook.plan.sourceKind,
      sourceOwnerKind:
        preparedHook.plan.sourceOwnerKind === "global"
          ? ("user-global" as const)
          : preparedHook.plan.sourceOwnerKind,
      sourceOwnerName: preparedHook.plan.sourceOwnerName,
    };
    const targetRepositoryName = preparedHook.plan.context.repositoryName;
    const targetRepositoryPath = preparedHook.plan.context.repositoryPath;
    if (!targetRepositoryName || !targetRepositoryPath) {
      throw new Error(
        `Prepared remove hook '${preparedHook.plan.hookName}' is missing target context`,
      );
    }
    const resolvedHook = {
      executionPath: preparedHook.plan.executionPath,
      inline:
        preparedHook.kind === "inline-config"
          ? {
              interpreters: {
                [preparedHook.resolution.interpreter]: preparedHook.snippet,
              },
              resolution: preparedHook.resolution,
              sourceOwnerKind:
                preparedHook.plan.scope === "repository"
                  ? ("repository" as const)
                  : ("workspace" as const),
              sourceOwnerName: preparedHook.plan.sourceOwnerName,
            }
          : undefined,
      scope: preparedHook.plan.scope,
      scriptPath: preparedHook.kind === "file" ? preparedHook.scriptPath : null,
      targetRepositoryName,
      targetRepositoryPath,
    };
    if (hookSpinner) {
      hookSpinner.text = `Running ${options.hookName} (${resolvedHook.scope}:${resolvedHook.targetRepositoryName})...`;
    }

    const targetData = buildRemoveHookOperationData({
      mainRepoPath: options.workspaceRoot,
      targets: options.removeTargets.filter(
        (target) => target.repository === resolvedHook.targetRepositoryName,
      ),
    });
    const perTargetOperationData = { ...options.operationData };
    delete perTargetOperationData.BRANCH_NAME;
    delete perTargetOperationData.WORKTREE_PATH;
    delete perTargetOperationData.REPO_NAME;
    delete perTargetOperationData.REPO_PATH;
    if (targetData.BRANCH_NAME) perTargetOperationData.BRANCH_NAME = targetData.BRANCH_NAME;
    if (targetData.WORKTREE_PATH) perTargetOperationData.WORKTREE_PATH = targetData.WORKTREE_PATH;
    perTargetOperationData.REPO_NAME = resolvedHook.targetRepositoryName;
    perTargetOperationData.REPO_PATH = resolvedHook.targetRepositoryPath;
    const targetWorktreePath = targetData.WORKTREE_PATH;
    if (preparedHook.kind === "absent") {
      const mapping = mapHookSkippedOutcome("not_found", "Hook script not found");
      outcomes.push({
        executionPath: resolvedHook.executionPath,
        hookName: options.hookName,
        hookStatus: mapping.hookStatus,
        message: mapping.message,
        reasonCode: mapping.reasonCode,
        repositoryId: resolvedHook.targetRepositoryName,
        scope: resolvedHook.scope,
        ...publicSource,
        sourceScriptPath: null,
        targetRepositoryName: resolvedHook.targetRepositoryName,
        targetRepositoryPath: resolvedHook.targetRepositoryPath,
        targetWorktreePath: targetWorktreePath ?? null,
        workspaceMode: "configured",
      });
      continue;
    }
    if (resolvedHook.inline) {
      const snippet = resolvedHook.inline.interpreters[resolvedHook.inline.resolution.interpreter];
      if (!snippet) {
        throw new Error(`Prepared inline hook '${options.hookName}' has no selected snippet`);
      }
      const { result } = await executeInlineHook({
        context: {
          hookName: options.hookName,
          hookScope: resolvedHook.scope,
          mainRepoPath: options.workspaceRoot,
          operationData: perTargetOperationData,
          repoPath: resolvedHook.executionPath,
          targetRepoName: resolvedHook.targetRepositoryName,
          targetRepoPath: resolvedHook.targetRepositoryPath,
          targetWorktreePath,
          workspaceMode: "configured",
        },
        hookInputMode: options.hookInputMode,
        hookName: options.hookName,
        outputSpinner: hookSpinner,
        quiet: options.quiet,
        resolution: resolvedHook.inline.resolution,
        snippet,
        source: {
          sourceKind: "inline-config",
          sourceOwnerKind: resolvedHook.inline.sourceOwnerKind,
          sourceOwnerName: resolvedHook.inline.sourceOwnerName,
          sourceScriptPath: null,
        },
        timeout: options.timeoutMs,
      });
      executedCount += ONE;
      const mapping = mapHookExecutionResult(result);
      outcomes.push({
        durationMs: mapping.durationMs,
        executionPath: resolvedHook.executionPath,
        hookName: options.hookName,
        hookStatus: mapping.hookStatus,
        message:
          mapping.hookStatus === "failure" && result.stderr.trim()
            ? result.stderr.trim()
            : mapping.message,
        reasonCode: mapping.reasonCode,
        repositoryId: resolvedHook.targetRepositoryName,
        scope: resolvedHook.scope,
        ...publicSource,
        sourceScriptPath: null,
        targetRepositoryName: resolvedHook.targetRepositoryName,
        targetRepositoryPath: resolvedHook.targetRepositoryPath,
        targetWorktreePath: targetWorktreePath ?? null,
        workspaceMode: "configured",
      });
      if (mapping.hookStatus === "failure") {
        failureReason = mapping.reasonCode;
        failures.push(
          `[${resolvedHook.scope}:${resolvedHook.targetRepositoryName}] ${result.stderr.trim() || mapping.message}`,
        );
        if (options.stopOnFailure || result.signalCode === "SIGINT") break;
      }
      continue;
    }
    if (!resolvedHook.scriptPath) {
      const mapping = mapHookSkippedOutcome("not_found", "Hook script not found");
      outcomes.push({
        executionPath: resolvedHook.executionPath,
        hookName: options.hookName,
        hookStatus: mapping.hookStatus,
        message: mapping.message,
        reasonCode: mapping.reasonCode,
        repositoryId: resolvedHook.targetRepositoryName,
        scope: resolvedHook.scope,
        ...publicSource,
        sourceScriptPath: null,
        targetRepositoryName: resolvedHook.targetRepositoryName,
        targetRepositoryPath: resolvedHook.targetRepositoryPath,
        targetWorktreePath: targetWorktreePath ?? null,
        workspaceMode: "configured",
      });
      continue;
    }

    const scriptPath = resolvedHook.scriptPath;
    const validation = await validateHook(scriptPath);
    if (validation.valid) {
      const result = await executeHook({
        context: {
          hookName: options.hookName,
          hookScope: resolvedHook.scope,
          mainRepoPath: options.workspaceRoot,
          operationData: perTargetOperationData,
          repoPath: resolvedHook.executionPath,
          sourceScriptPath: scriptPath,
          targetRepoName: resolvedHook.targetRepositoryName,
          targetRepoPath: resolvedHook.targetRepositoryPath,
          targetWorktreePath,
          workspaceMode: "configured",
        },
        hookInputMode: options.hookInputMode,
        hookName: `${options.hookName}.${resolvedHook.targetRepositoryName}`,
        outputSpinner: hookSpinner,
        quiet: options.quiet,
        scriptPath,
        timeout: options.timeoutMs,
      });
      executedCount += 1;

      const mapping = mapHookExecutionResult(result);
      outcomes.push({
        durationMs: mapping.durationMs,
        executionPath: resolvedHook.executionPath,
        hookName: options.hookName,
        hookStatus: mapping.hookStatus,
        message:
          mapping.hookStatus === "failure" && result.stderr.trim()
            ? result.stderr.trim()
            : mapping.message,
        reasonCode: mapping.reasonCode,
        repositoryId: resolvedHook.targetRepositoryName,
        scope: resolvedHook.scope,
        ...publicSource,
        sourceScriptPath: resolvedHook.scriptPath,
        targetRepositoryName: resolvedHook.targetRepositoryName,
        targetRepositoryPath: resolvedHook.targetRepositoryPath,
        targetWorktreePath: targetWorktreePath ?? null,
        workspaceMode: "configured",
      });
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
        if (options.stopOnFailure || result.signalCode === "SIGINT") {
          break;
        }
      }
    } else {
      outcomes.push({
        executionPath: resolvedHook.executionPath,
        hookName: options.hookName,
        hookStatus: "failure",
        message: validation.error ?? "Hook validation failed",
        reasonCode: validation.reasonCode ?? "validation_failed",
        repositoryId: resolvedHook.targetRepositoryName,
        scope: resolvedHook.scope,
        ...publicSource,
        sourceScriptPath: resolvedHook.scriptPath,
        targetRepositoryName: resolvedHook.targetRepositoryName,
        targetRepositoryPath: resolvedHook.targetRepositoryPath,
        targetWorktreePath: targetWorktreePath ?? null,
        workspaceMode: "configured",
      });
      failureReason = validation.reasonCode ?? "validation_failed";
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
      outcomes,
      summary: {
        hookStatus: "success",
        message: `Executed ${executedCount} hook ${hookScriptLabel}`,
        reasonCode: "none",
      },
    };
  }

  hookSpinner?.fail(`${options.hookName} hooks failed`);
  let reasonCode: HookOutcomeReasonCode = failureReason;
  if (outcomes.some((outcome) => outcome.reasonCode === "timeout")) reasonCode = "timeout";

  return {
    outcomes,
    summary: {
      hookStatus: "failure",
      message: failures.join("; "),
      reasonCode,
    },
  };
};

const unavailableRemovePreviews = (
  preparation: Extract<
    Awaited<ReturnType<typeof prepareLifecycleHookSources>>,
    { classification: "file-invalid" | "interpreter-unavailable" }
  >,
  hookName: RemoveHookPreview["hookName"],
): RemoveHookPreview[] => {
  const failed = preparation.plannedEntry;
  const reasonCode =
    preparation.classification === "file-invalid"
      ? (preparation.validation.reasonCode ?? "validation_failed")
      : "interpreter_unavailable";
  const message =
    preparation.classification === "file-invalid"
      ? (preparation.validation.error ?? "Hook validation failed")
      : `No configured interpreter is available for ${failed.lifecycle}`;
  return preparation.plan.entries
    .filter(
      (entry) =>
        entry.configuredField === failed.configuredField &&
        entry.executionPath === failed.executionPath &&
        entry.lifecycle === failed.lifecycle &&
        entry.scope === failed.scope &&
        entry.sourceKind === failed.sourceKind &&
        entry.sourceOwnerKind === failed.sourceOwnerKind &&
        entry.sourceOwnerName === failed.sourceOwnerName &&
        entry.sourceScriptPath === failed.sourceScriptPath &&
        entry.targetRepositoryName === failed.targetRepositoryName,
    )
    .map((entry) => ({
      availability: "unavailable",
      error: message,
      hookName,
      reasonCode,
      repository: entry.context.repositoryName ?? "workspace",
      scope: entry.scope,
      scriptPath: entry.sourceKind === "file" ? entry.sourceScriptPath : null,
      selectedInterpreter: null,
      sourceKind: entry.sourceKind,
      sourceOwnerKind: entry.sourceOwnerKind === "global" ? "user-global" : entry.sourceOwnerKind,
      sourceOwnerName: entry.sourceOwnerName,
      sourceScriptPath: entry.sourceKind === "file" ? entry.sourceScriptPath : null,
      valid: false,
    }));
};

const plannedRemoveEntryIdentity = (entry: PlannedLifecycleHookSource): string =>
  JSON.stringify([
    entry.configuredField,
    entry.context.branchName,
    entry.context.repositoryName,
    entry.context.repositoryPath,
    entry.context.worktreePath,
    entry.executionPath,
    entry.lifecycle,
    entry.scope,
    entry.sourceKind,
    entry.sourceOwnerKind,
    entry.sourceOwnerName,
    entry.sourceScriptPath,
    entry.targetRepositoryName,
  ]);

const preflightRemoveLifecycleHooks = async (options: {
  config: Config;
  dryRun: boolean;
  removeTargets: RemoveHookTarget[];
  targetRepositories: HookTargetRepository[];
  workspaceRoot: string;
}): Promise<{
  failure: LifecycleHookOutcome | null;
  preparedHooks: PreparedRemoveHooks;
  unavailablePreviews: RemoveHookPreview[];
}> => {
  const preparedHooks: Record<"post-remove" | "pre-remove", PreparedLifecycleHookEntry[]> = {
    "post-remove": [],
    "pre-remove": [],
  };
  let failure: LifecycleHookOutcome | null = null;
  const unavailablePreviews: RemoveHookPreview[] = [];
  const targets = options.targetRepositories.map((repository) => {
    const removeTarget = options.removeTargets.find(
      (target) => target.repository === repository.name,
    );
    return {
      branchName: removeTarget?.branchName ?? "",
      repositoryName: repository.name,
      repositoryPath: repository.path,
      worktreePath: removeTarget?.worktreePath ?? repository.path,
    };
  });
  const outcomeFor = (
    hookName: "post-remove" | "pre-remove",
    source: {
      executionPath: string;
      scope: LifecycleHookOutcome["scope"];
      sourceKind: LifecycleHookOutcome["sourceKind"];
      sourceOwnerKind: "global" | LifecycleHookOutcome["sourceOwnerKind"];
      sourceOwnerName: string | null;
      sourceScriptPath: string | null;
      targetRepositoryName?: string;
    },
    mapping: Pick<LifecycleHookOutcome, "hookStatus" | "message" | "reasonCode">,
  ): LifecycleHookOutcome => {
    const repositoryName =
      source.targetRepositoryName ??
      source.sourceOwnerName ??
      options.targetRepositories[ZERO]?.name ??
      "workspace";
    const repositoryPath =
      options.targetRepositories.find((target) => target.name === repositoryName)?.path ??
      options.workspaceRoot;
    const targetData = buildRemoveHookOperationData({
      mainRepoPath: options.workspaceRoot,
      targets: options.removeTargets.filter((target) => target.repository === repositoryName),
    });
    return {
      executionPath: source.executionPath,
      hookName,
      ...mapping,
      repositoryId: repositoryName,
      scope: source.scope,
      sourceKind: source.sourceKind,
      sourceOwnerKind: source.sourceOwnerKind === "global" ? "user-global" : source.sourceOwnerKind,
      sourceOwnerName: source.sourceOwnerName,
      sourceScriptPath: source.sourceScriptPath,
      targetRepositoryName: repositoryName,
      targetRepositoryPath: repositoryPath,
      targetWorktreePath: targetData.WORKTREE_PATH ?? null,
      workspaceMode: "configured",
    };
  };

  const prepareCandidates = (candidates: readonly LifecycleHookPreparationCandidate[]) =>
    prepareLifecycleHookSources({
      candidates,
      consumer: "remove",
      env: process.env,
      platform: process.platform,
      targets,
      workspaceRoot: options.workspaceRoot,
    });

  const retainDryRunCandidates = async (
    candidates: readonly LifecycleHookPreparationCandidate[],
    canonicalEntries: readonly PlannedLifecycleHookSource[],
    hookName: RemoveHookPreview["hookName"],
  ): Promise<void> => {
    const recovered: PreparedLifecycleHookEntry[] = [];
    for (const candidate of candidates) {
      const candidatePreparation = await prepareCandidates([candidate]);
      if (candidatePreparation.classification === "ready") {
        recovered.push(...candidatePreparation.entries);
        continue;
      }
      if (
        candidatePreparation.classification === "file-invalid" ||
        candidatePreparation.classification === "interpreter-unavailable"
      ) {
        unavailablePreviews.push(...unavailableRemovePreviews(candidatePreparation, hookName));
        continue;
      }
      throw new Error(`Unexpected ambiguous single-source ${hookName} hook plan`);
    }
    const canonicalOrder = new Map(
      canonicalEntries.map((entry, index) => [plannedRemoveEntryIdentity(entry), index]),
    );
    recovered.sort(
      (left, right) =>
        (canonicalOrder.get(plannedRemoveEntryIdentity(left.plan)) ?? Number.MAX_SAFE_INTEGER) -
        (canonicalOrder.get(plannedRemoveEntryIdentity(right.plan)) ?? Number.MAX_SAFE_INTEGER),
    );
    preparedHooks[hookName].push(...recovered);
  };

  for (const hookName of [GLOBAL_HOOKS.preRemove, GLOBAL_HOOKS.postRemove] as const) {
    const candidates: LifecycleHookPreparationCandidate[] = [];
    const addFiles = async (optionsForSource: {
      executionPath: string;
      hooksDirectory: string;
      scope: LifecycleHookOutcome["scope"];
      sourceOwnerKind: "global" | "repository" | "workspace";
      sourceOwnerName: string | null;
      targetRepositoryName?: string;
    }): Promise<void> => {
      const scriptPaths = await discoverLifecycleHookCandidatesInDirectory(
        hookName,
        optionsForSource.hooksDirectory,
      );
      for (const scriptPath of scriptPaths) {
        candidates.push({
          kind: "file",
          source: {
            executionPath: optionsForSource.executionPath,
            lifecycle: hookName,
            scope: optionsForSource.scope,
            sourceKind: "file",
            sourceOwnerKind: optionsForSource.sourceOwnerKind,
            sourceOwnerName: optionsForSource.sourceOwnerName,
            sourceScriptPath: scriptPath,
            targetRepositoryName: optionsForSource.targetRepositoryName,
          },
        });
      }
      const hasInlineAtLocation =
        optionsForSource.scope === "workspace"
          ? Boolean(options.config.hooks?.scripts?.[hookName])
          : optionsForSource.scope === "repository" && optionsForSource.sourceOwnerName
            ? Boolean(options.config.repos[optionsForSource.sourceOwnerName]?.hooks?.[hookName])
            : false;
      if (scriptPaths.length === ZERO && !hasInlineAtLocation) {
        candidates.push({
          kind: "absent",
          source: {
            executionPath: optionsForSource.executionPath,
            lifecycle: hookName,
            scope: optionsForSource.scope,
            sourceKind: "file",
            sourceOwnerKind: optionsForSource.sourceOwnerKind,
            sourceOwnerName: optionsForSource.sourceOwnerName,
            sourceScriptPath: null,
            targetRepositoryName: optionsForSource.targetRepositoryName,
          },
        });
      }
    };

    for (const repository of options.targetRepositories) {
      if (
        normalizeLifecyclePath(repository.path) !== normalizeLifecyclePath(options.workspaceRoot)
      ) {
        await addFiles({
          executionPath: repository.path,
          hooksDirectory: join(repository.path, ".arashi", "hooks"),
          scope: "repository",
          sourceOwnerKind: "repository",
          sourceOwnerName: repository.name,
        });
      }
      const inline = options.config.repos[repository.name]?.hooks?.[hookName];
      if (inline) {
        candidates.push({
          interpreters: typeof inline === "string" ? { bash: inline } : inline,
          kind: "inline-config",
          source: {
            configuredField: `repos.${repository.name}.hooks.${hookName}`,
            executionPath: repository.path,
            lifecycle: hookName,
            scope: "repository",
            sourceKind: "inline-config",
            sourceOwnerKind: "repository",
            sourceOwnerName: repository.name,
            sourceScriptPath: null,
          },
        });
      }
      await addFiles({
        executionPath: repository.path,
        hooksDirectory: join(homedir(), ".arashi", "hooks", repository.name),
        scope: "global-repository",
        sourceOwnerKind: "global",
        sourceOwnerName: null,
        targetRepositoryName: repository.name,
      });
      await addFiles({
        executionPath: repository.path,
        hooksDirectory: join(homedir(), ".arashi", "hooks"),
        scope: "global-shared",
        sourceOwnerKind: "global",
        sourceOwnerName: null,
        targetRepositoryName: repository.name,
      });
    }

    await addFiles({
      executionPath: options.workspaceRoot,
      hooksDirectory: join(options.workspaceRoot, ".arashi", "hooks"),
      scope: "workspace",
      sourceOwnerKind: "workspace",
      sourceOwnerName: null,
    });
    const workspaceInline = options.config.hooks?.scripts?.[hookName];
    if (workspaceInline) {
      candidates.push({
        interpreters:
          typeof workspaceInline === "string" ? { bash: workspaceInline } : workspaceInline,
        kind: "inline-config",
        source: {
          configuredField: `hooks.scripts.${hookName}`,
          executionPath: options.workspaceRoot,
          lifecycle: hookName,
          scope: "workspace",
          sourceKind: "inline-config",
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
          sourceScriptPath: null,
        },
      });
    }
    const preparation = await prepareCandidates(candidates);
    if (preparation.classification === "ambiguous") {
      const failure = preparation.plan.failure;
      return {
        failure: outcomeFor(
          hookName,
          {
            executionPath:
              candidates.find(
                (candidate) =>
                  candidate.source.scope === failure.scope &&
                  candidate.source.sourceOwnerName === failure.sourceOwnerName,
              )?.source.executionPath ?? options.workspaceRoot,
            scope: failure.scope,
            sourceKind: "inline-config",
            sourceOwnerKind: failure.sourceOwnerKind,
            sourceOwnerName: failure.sourceOwnerName,
            sourceScriptPath: failure.sourceScriptPath,
          },
          {
            hookStatus: "failure",
            message: `Hook source is ambiguous for ${hookName}: ${failure.sourceKinds.join(" and ")} are both configured${failure.sourceScriptPath ? ` (${failure.sourceScriptPath})` : ""}`,
            reasonCode: "validation_failed",
          },
        ),
        preparedHooks,
        unavailablePreviews: [],
      };
    }
    if (preparation.classification === "file-invalid") {
      const lifecycleFailure = outcomeFor(hookName, preparation.plannedEntry, {
        hookStatus: "failure",
        message: preparation.validation.error ?? "Hook validation failed",
        reasonCode: preparation.validation.reasonCode ?? "validation_failed",
      });
      if (!options.dryRun) {
        return {
          failure: lifecycleFailure,
          preparedHooks,
          unavailablePreviews: unavailableRemovePreviews(preparation, hookName),
        };
      }
      failure ??= lifecycleFailure;
      await retainDryRunCandidates(candidates, preparation.plan.entries, hookName);
      continue;
    }
    if (preparation.classification === "interpreter-unavailable") {
      const lifecycleFailure = outcomeFor(hookName, preparation.plannedEntry, {
        hookStatus: "failure",
        message: `No configured interpreter is available for ${hookName}`,
        reasonCode: "interpreter_unavailable",
      });
      if (!options.dryRun) {
        return {
          failure: lifecycleFailure,
          preparedHooks,
          unavailablePreviews: unavailableRemovePreviews(preparation, hookName),
        };
      }
      failure ??= lifecycleFailure;
      await retainDryRunCandidates(candidates, preparation.plan.entries, hookName);
      continue;
    }
    preparedHooks[hookName].push(...preparation.entries);
  }

  return {
    failure,
    preparedHooks: Object.freeze({
      "post-remove": Object.freeze([...preparedHooks["post-remove"]]),
      "pre-remove": Object.freeze([...preparedHooks["pre-remove"]]),
    }),
    unavailablePreviews,
  };
};

const formatHookFailure = (hookName: string, outcome: HookOutcomeMapping): string =>
  `${hookName} hook failed: ${outcome.message}`;
