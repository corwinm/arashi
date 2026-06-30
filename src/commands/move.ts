/**
 * Move Command
 *
 * Moves uncommitted changes between coordinated Arashi workspaces.
 */

import {
  MovePlanningError,
  buildMovePlan,
  buildRepositoryTargets,
  discoverWorkspaces,
  executeMovePlan,
  findWorkspaceByPath,
  resolveWorkspaceReference,
  type MoveSummary,
  type WorkspaceSelection,
} from "../core/move.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  unsupportedJsonModeError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { Command } from "commander";
import { findWorkspaceRoot, loadConfig } from "../lib/config.ts";
import { info, success, warn, error as logError } from "../lib/logger.ts";
import { select as promptSelect, type Choice, type PromptOutcome } from "../lib/prompts.ts";
import { resolve } from "path";

interface MoveCommandOptions {
  from?: string;
  to?: string;
  json?: boolean;
}

interface MovePromptHandlers {
  select: (
    message: string,
    choices: Choice<WorkspaceSelection>[],
  ) => Promise<PromptOutcome<WorkspaceSelection>>;
}

const ZERO = 0;
const ONE = 1;

const toPromptOutcome = promptSelect;

const formatWorkspaceDescription = (workspace: WorkspaceSelection): string => {
  const dirtyCount = workspace.dirtyRepositories.length;
  const dirtyLabel = dirtyCount > ZERO ? `${dirtyCount} dirty repos` : "clean";
  return `${dirtyLabel} · ${workspace.primaryPath}`;
};

const buildWorkspaceChoices = (workspaces: WorkspaceSelection[]): Choice<WorkspaceSelection>[] =>
  workspaces.map((workspace) => ({
    description: formatWorkspaceDescription(workspace),
    name: workspace.label,
    value: workspace,
  }));

const createMoveErrorCode = (error: unknown): string => {
  if (error instanceof MovePlanningError) {
    return error.code;
  }
  return "MOVE_FAILED";
};

const writeMoveJsonError = (error: unknown): void => {
  const jsonError = unknownErrorToJsonError(error, createMoveErrorCode(error));
  writeJsonEnvelope(
    createJsonErrorEnvelope("move", {
      ...jsonError,
      ...(error instanceof MovePlanningError && error.details ? { details: error.details } : {}),
    }),
  );
};

const printSummary = (summary: MoveSummary): void => {
  if (summary.failedCount > ZERO) {
    warn(`Moved ${summary.movedCount} repositories with ${summary.failedCount} failures`);
  } else {
    success(`Moved changes in ${summary.movedCount} repositories`);
  }

  info(`Source: ${summary.source.label} (${summary.source.primaryPath})`);
  info(`Target: ${summary.target.label} (${summary.target.primaryPath})`);

  for (const result of summary.results) {
    const prefix = result.status === "moved" ? "✓" : result.status === "skipped" ? "-" : "!";
    console.log(`  ${prefix} ${result.repositoryName}: ${result.message}`);
    if (result.recoveryCommand) {
      console.log(`    recovery: ${result.recoveryCommand}`);
    }
  }
};

export function createCommand(): Command {
  return new Command("move")
    .description("Move uncommitted changes between coordinated worktrees")
    .option("--from <workspace>", "Source branch, worktree name, or path")
    .option("--to <workspace>", "Target branch, worktree name, or path")
    .option("--json", "Return structured JSON output")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi move --to feature-branch
  $ arashi move --from main --to feature-branch
  $ arashi move --from feature-branch
`,
    )
    .action(async (options: MoveCommandOptions) => {
      try {
        const exitCode = await executeMove(options);
        process.exit(exitCode);
      } catch (error) {
        if (options.json) {
          writeMoveJsonError(error);
        } else if (error instanceof MovePlanningError) {
          logError(error.message);
        } else if (error instanceof Error) {
          logError(error.message);
        } else {
          logError(String(error));
        }
        process.exit(ONE);
      }
    });
}

export async function executeMove(
  options: MoveCommandOptions,
  promptHandlers: MovePromptHandlers = { select: toPromptOutcome },
): Promise<number> {
  const invocationPath = resolve(".");
  const workspaceRoot = await findWorkspaceRoot(invocationPath);
  const config = await loadConfig(workspaceRoot);
  const repositories = buildRepositoryTargets(workspaceRoot, config.repos);
  const currentWorkspace = await findWorkspaceByPath(repositories, workspaceRoot);
  const workspaces = await discoverWorkspaces(repositories);

  let source: WorkspaceSelection | null = options.from
    ? await resolveWorkspaceReference(repositories, options.from)
    : null;
  let target: WorkspaceSelection | null = options.to
    ? await resolveWorkspaceReference(repositories, options.to)
    : null;

  if (options.json && ((!source && !currentWorkspace?.dirtyRepositories.length) || !target)) {
    writeJsonEnvelope(unsupportedJsonModeError("move", "interactive-selection"));
    return ONE;
  }

  if (!source) {
    if (currentWorkspace && currentWorkspace.dirtyRepositories.length > ZERO) {
      source = currentWorkspace;
    } else {
      const dirtyWorkspaces = workspaces.filter(
        (workspace) => workspace.dirtyRepositories.length > ZERO,
      );
      const selection = await promptHandlers.select(
        "Select workspace to move changes from:",
        buildWorkspaceChoices(dirtyWorkspaces),
      );
      if (selection.status !== "ok") {
        throw new MovePlanningError("Move cancelled", "USER_ABORTED");
      }
      source = selection.value;
    }
  }

  if (!target) {
    const choices = workspaces.filter((workspace) => workspace.primaryPath !== source.primaryPath);
    const selection = await promptHandlers.select(
      "Select workspace to move changes to:",
      buildWorkspaceChoices(choices),
    );
    if (selection.status !== "ok") {
      throw new MovePlanningError("Move cancelled", "USER_ABORTED");
    }
    target = selection.value;
  }

  const plan = buildMovePlan(source, target);
  const summary = await executeMovePlan(plan);

  if (options.json) {
    writeJsonEnvelope(
      createJsonSuccessEnvelope("move", summary as unknown as Record<string, unknown>),
    );
  } else {
    printSummary(summary);
  }

  return summary.failedCount > ZERO ? ONE : ZERO;
}
