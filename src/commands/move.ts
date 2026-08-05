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
} from "../core/move.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  unsupportedJsonModeError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { resolveWorkspaceContext, requireAvailableWorkspace } from "../lib/workspace-context.ts";
import { info, error as logError, success, warn } from "../lib/logger.ts";
import { Command } from "commander";
import { select as promptSelect } from "../lib/prompts.ts";
import { join, resolve } from "path";

interface MoveCommandOptions {
  from?: string;
  to?: string;
  json?: boolean;
}

type MoveSummary = Awaited<ReturnType<typeof executeMovePlan>>;
type WorkspaceSelection = Awaited<ReturnType<typeof resolveWorkspaceReference>>;

interface Choice<Value> {
  description?: string;
  name: string;
  value: Value;
}

type PromptOutcome<Value> = Awaited<ReturnType<typeof promptSelect<Value>>>;

interface MovePromptHandlers {
  select: (
    message: string,
    choices: Choice<WorkspaceSelection>[],
  ) => Promise<PromptOutcome<WorkspaceSelection>>;
}

const ZERO = 0;
const ONE = 1;

const toPromptOutcome = promptSelect;
const DEFAULT_PROMPT_HANDLERS: MovePromptHandlers = { select: toPromptOutcome };

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
    let prefix = "!";
    if (result.status === "moved") {
      prefix = "✓";
    } else if (result.status === "skipped") {
      prefix = "-";
    }
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
    .option("-j, --json", "Return structured JSON output")
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
  promptHandlers: MovePromptHandlers = DEFAULT_PROMPT_HANDLERS,
): Promise<number> {
  const invocationPath = resolve(".");
  const context = await resolveWorkspaceContext(invocationPath);
  requireAvailableWorkspace(context);
  const workspaceRoot = context.workspaceRoot;
  const config = context.config;
  const repositories = buildRepositoryTargets(workspaceRoot, config.repos);
  const currentWorkspace = await findWorkspaceByPath(repositories, invocationPath);
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
  const data =
    context.mode === "standalone"
      ? {
          ...summary,
          mode: "standalone" as const,
          repositoryPath: context.mainRoot,
          workspaceRoot: context.mainRoot,
          worktreesBase: join(context.mainRoot, ".worktrees"),
        }
      : { ...summary, mode: "configured" as const, workspaceRoot };

  if (options.json) {
    writeJsonEnvelope(
      createJsonSuccessEnvelope("move", data as unknown as Record<string, unknown>),
    );
  } else {
    if (context.mode === "standalone") {
      info(`Workspace mode: standalone`);
      info(`Main repository: ${context.mainRoot}`);
    }
    printSummary(summary);
  }

  return summary.failedCount > ZERO ? ONE : ZERO;
}
