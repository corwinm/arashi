/**
 * CLI Command: Handoff
 *
 * Generates a non-mutating Markdown or JSON handoff report for the current
 * coordinated Arashi workspace.
 */

import {
  checkAllRepos,
  checkRepoStatus,
  collectStatusWarnings,
  shouldIncludeWorkspaceRootInRepositoryChecks,
  summarizeStatuses,
} from "./status.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { loadWorkspaceRepositories } from "../lib/config.ts";
import { exec as gitExec } from "../lib/git.ts";
import { findConfiguredWorkspaceRoots, resolveWorkspaceContext } from "../lib/workspace-context.ts";
import { standaloneWorktrees } from "../lib/standalone.ts";
import { info, error as logError, warn } from "../lib/logger.ts";
import { basename, join, relative, resolve } from "path";
import { realpath } from "fs/promises";
import { Command, Option } from "commander";

type JsonWarning = NonNullable<Parameters<typeof createJsonSuccessEnvelope>[2]>[number];
type RepoStatus = Awaited<ReturnType<typeof checkAllRepos>>[number];

const ZERO = 0;
const USAGE_EXIT_CODE = 2;
const ERROR_EXIT_CODE = 1;

export interface HandoffOptions {
  json?: boolean;
  link?: string[];
  nextCommand?: string[];
  risk?: string[];
  todo?: string[];
  validation?: string[];
  markdown?: boolean;
}

interface HandoffContext {
  links: string[];
  nextCommands: string[];
  risks: string[];
  todos: string[];
  validations: string[];
}

interface HandoffRepositorySummary {
  branch: RepoStatus["branch"];
  changeCount: number;
  defaultBranch: RepoStatus["defaultBranch"];
  error: string | null;
  files: RepoStatus["files"];
  name: string;
  path: string;
  refreshWarning: RepoStatus["refreshWarning"];
  state: "clean" | "dirty" | "error";
}

interface HandoffData {
  callerWorktree?: string;
  context: HandoffContext;
  currentRepository: { name: string; path: string } | null;
  effectiveOptions: {
    format: "json" | "markdown";
  };
  generatedNextCommands: string[];
  mode: "configured" | "standalone";
  repositoryPath?: string;
  repositories: HandoffRepositorySummary[];
  summary: ReturnType<typeof summarizeStatuses> & {
    touchedCount: number;
  };
  workspace: {
    branch: string;
    path: string;
  };
  workspaceRoot?: string;
  worktreesBase?: string;
}

interface BuildHandoffDataInput {
  cwd: string;
  options: HandoffOptions;
  statuses: RepoStatus[];
  workspaceBranch: string;
  workspaceRoot: string;
}

const normalizeArray = (value: string[] | undefined): string[] => value ?? [];

const isInsidePath = (candidate: string, parent: string): boolean => {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
};

const detectCurrentRepository = (
  cwd: string,
  statuses: RepoStatus[],
): { name: string; path: string } | null => {
  const current = statuses.reduce<RepoStatus | null>((best, status) => {
    if (!isInsidePath(cwd, status.path)) {
      return best;
    }
    if (!best || status.path.length > best.path.length) {
      return status;
    }
    return best;
  }, null);
  if (!current) {
    return null;
  }

  return { name: current.name, path: current.path };
};

const formatBranch = (status: RepoStatus): string => {
  if (status.branch.isDetached) {
    return "detached HEAD";
  }

  let value = status.branch.localBranch || "unknown";
  if (status.refreshWarning?.kind === "missing-remote-ref") {
    return `${value} (${status.refreshWarning.message})`;
  }
  if (status.branch.remoteBranch) {
    value += ` → ${status.branch.remoteBranch}`;
  }

  const drift: string[] = [];
  if (status.branch.ahead > ZERO) {
    drift.push(`ahead ${status.branch.ahead}`);
  }
  if (status.branch.behind > ZERO) {
    drift.push(`behind ${status.branch.behind}`);
  }
  if (drift.length > ZERO) {
    value += ` (${drift.join(", ")})`;
  }

  return value;
};

const statusState = (status: RepoStatus): HandoffRepositorySummary["state"] => {
  if (status.error) {
    return "error";
  }
  if (status.files.length > ZERO) {
    return "dirty";
  }
  return "clean";
};

const summarizeRepo = (status: RepoStatus): HandoffRepositorySummary => ({
  branch: status.branch,
  changeCount: status.files.length,
  defaultBranch: status.defaultBranch,
  error: status.error,
  files: status.files,
  name: status.name,
  path: status.path,
  refreshWarning: status.refreshWarning,
  state: statusState(status),
});

const collectGeneratedNextCommands = (statuses: RepoStatus[]): string[] => {
  const commands = ["arashi status"];
  if (
    statuses.some(
      (status) =>
        status.error ||
        status.files.length > ZERO ||
        status.branch.ahead > ZERO ||
        status.branch.behind > ZERO ||
        status.refreshWarning,
    )
  ) {
    commands.push("arashi status --verbose");
  }
  return commands;
};

const resolveConfiguredWorkspaceBranch = async (
  statuses: RepoStatus[],
  configurationRoot: string,
): Promise<string> => {
  const mainRepository = statuses.find((status) => status.name === "Main Repository");
  if (mainRepository) {
    return mainRepository.branch.localBranch || "unknown";
  }

  try {
    const result = await gitExec(["symbolic-ref", "--short", "HEAD"], configurationRoot);
    const branch = result.stdout.trim();
    if (!branch) {
      return "unknown";
    }
    await gitExec(["show-ref", "--verify", `refs/heads/${branch}`], configurationRoot);
    return branch;
  } catch {
    return "unknown";
  }
};

const buildHandoffData = ({
  cwd,
  options,
  statuses,
  workspaceBranch,
  workspaceRoot,
}: BuildHandoffDataInput): HandoffData => {
  const summary = summarizeStatuses(statuses);
  const touchedCount = statuses.filter(
    (status) => status.files.length > ZERO || status.error,
  ).length;

  return {
    context: {
      links: normalizeArray(options.link),
      nextCommands: normalizeArray(options.nextCommand),
      risks: normalizeArray(options.risk),
      todos: normalizeArray(options.todo),
      validations: normalizeArray(options.validation),
    },
    currentRepository: detectCurrentRepository(cwd, statuses),
    effectiveOptions: {
      format: options.json ? "json" : "markdown",
    },
    generatedNextCommands: collectGeneratedNextCommands(statuses),
    mode: "configured",
    repositories: statuses.map((status) => summarizeRepo(status)),
    summary: {
      ...summary,
      touchedCount,
    },
    workspace: {
      branch: workspaceBranch,
      path: workspaceRoot,
    },
    workspaceRoot,
  };
};

const markdownList = (items: string[], emptyText: string): string => {
  if (items.length === ZERO) {
    return `- ${emptyText}\n`;
  }
  return `${items.map((item) => `- ${item}`).join("\n")}\n`;
};

const markdownChecklist = (items: string[], emptyText: string): string => {
  if (items.length === ZERO) {
    return `- [ ] ${emptyText}\n`;
  }
  return `${items.map((item) => `- [ ] ${item}`).join("\n")}\n`;
};

const formatRepositoryLine = (repo: HandoffRepositorySummary): string => {
  const stateLabel = repo.state === "clean" ? "clean" : repo.state;
  const parts = [`${repo.name}: ${stateLabel}`, `branch ${formatBranch(repo as RepoStatus)}`];
  if (repo.changeCount > ZERO) {
    parts.push(`${repo.changeCount} changed file${repo.changeCount === 1 ? "" : "s"}`);
  }
  if (repo.error) {
    parts.push(repo.error);
  }
  if (repo.refreshWarning && repo.refreshWarning.kind !== "missing-remote-ref") {
    parts.push(repo.refreshWarning.message);
  }
  if (repo.defaultBranch?.state === "available" && repo.defaultBranch.behind > ZERO) {
    parts.push(`default ${repo.defaultBranch.branch} behind by ${repo.defaultBranch.behind}`);
  }
  if (repo.defaultBranch?.state === "unavailable") {
    parts.push(`default ${repo.defaultBranch.branch} unavailable`);
  }
  return `- ${parts.join("; ")}`;
};

export const renderMarkdownReport = (data: HandoffData): string => {
  const touchedRepos = data.repositories.filter((repo) => repo.state !== "clean");
  const repoLines = data.repositories.map(formatRepositoryLine).join("\n");
  const touchedLines =
    touchedRepos.length > ZERO
      ? `${touchedRepos.map((repo) => formatRepositoryLine(repo)).join("\n")}\n`
      : "- All managed repositories are clean.\n";
  const userNextCommands = data.context.nextCommands;
  const generatedNextCommands = data.generatedNextCommands.filter(
    (command) => !userNextCommands.includes(command),
  );
  const commandBlock = [...userNextCommands, ...generatedNextCommands]
    .map((command) => `\`${command}\``)
    .join("\n");

  return `# Arashi Handoff Report

## Workspace

- Workspace mode: ${data.mode}
- Path: ${data.workspace.path}
- Branch: ${data.workspace.branch}
- Caller worktree: ${data.callerWorktree ?? "not applicable"}
- Current repository: ${data.currentRepository ? `${data.currentRepository.name} (${data.currentRepository.path})` : "not resolved"}

## Summary

- Repositories: ${data.summary.total} total, ${data.summary.cleanCount} clean, ${data.summary.dirtyCount} dirty/error
- Touched repositories: ${data.summary.touchedCount}

## Repository Status

${repoLines}

## Repositories Needing Attention

${touchedLines}
## Related Links

${markdownList(data.context.links, "No related links supplied.")}
## Validation Evidence

${markdownList(data.context.validations, "No validation evidence supplied. Add commands/results before relying on this report for merge readiness.")}
## Remaining Work

${markdownChecklist(data.context.todos, "No remaining work supplied.")}
## Risks / Blockers

${markdownList(data.context.risks, "No risks or blockers supplied.")}
## Suggested Next Commands

${commandBlock ? `${commandBlock}\n` : "- No next commands suggested.\n"}
`;
};

const runHandoff = async (options: HandoffOptions): Promise<void> => {
  if (!options.json && options.markdown) {
    warn("--markdown is deprecated; omit --markdown and use the default Markdown output.");
  }
  let context;
  try {
    context = await resolveWorkspaceContext();
  } catch (error) {
    if (options.json)
      writeJsonEnvelope(createJsonErrorEnvelope("handoff", unknownErrorToJsonError(error)));
    else logError(error instanceof Error ? error.message : String(error));
    process.exit(ERROR_EXIT_CODE);
  }
  if (context.mode === "standalone") {
    try {
      const worktrees = await standaloneWorktrees(context);
      const statuses = await Promise.all(
        worktrees.map((worktree) =>
          checkRepoStatus(worktree.branch ?? basename(worktree.path), worktree.path),
        ),
      );
      const callerWorktree = process.cwd();
      const canonicalCaller = await realpath(callerWorktree);
      const canonicalStatusPaths = await Promise.all(
        statuses.map(async (status) => await realpath(status.path)),
      );
      const callerStatus = statuses[canonicalStatusPaths.indexOf(canonicalCaller)];
      const selectedCallerStatus =
        callerStatus ??
        statuses.find((status) => resolve(status.path) === resolve(callerWorktree)) ??
        statuses[ZERO];
      const data: HandoffData = {
        ...buildHandoffData({
          cwd: canonicalCaller,
          options,
          statuses,
          workspaceBranch: selectedCallerStatus?.branch.localBranch || "unknown",
          workspaceRoot: context.mainRoot,
        }),
        callerWorktree,
        currentRepository: selectedCallerStatus
          ? { name: selectedCallerStatus.name, path: selectedCallerStatus.path }
          : null,
        mode: "standalone",
        repositoryPath: context.mainRoot,
        workspace: {
          branch: selectedCallerStatus?.branch.localBranch || "unknown",
          path: context.mainRoot,
        },
        worktreesBase: join(context.mainRoot, ".worktrees"),
      };
      if (options.json)
        writeJsonEnvelope(
          createJsonSuccessEnvelope(
            "handoff",
            data as unknown as Record<string, unknown>,
            collectStatusWarnings(statuses),
          ),
        );
      else process.stdout.write(renderMarkdownReport(data));
      if (statuses.some((status) => status.error !== null)) process.exit(ERROR_EXIT_CODE);
      return;
    } catch (error) {
      if (options.json)
        writeJsonEnvelope(createJsonErrorEnvelope("handoff", unknownErrorToJsonError(error)));
      else logError(error instanceof Error ? error.message : String(error));
      process.exit(ERROR_EXIT_CODE);
    }
  }
  let workspaceRoots;
  try {
    workspaceRoots = await findConfiguredWorkspaceRoots("handoff");
  } catch {
    const message = "Not in an arashi workspace";
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("handoff", {
          code: "NOT_IN_WORKSPACE",
          message,
        }),
      );
    } else {
      logError(message);
      info("Run 'arashi init' to initialize a workspace before creating a handoff report");
    }
    process.exit(USAGE_EXIT_CODE);
  }

  try {
    const { config } = await loadWorkspaceRepositories(workspaceRoots);
    const includeWorkspaceRoot = await shouldIncludeWorkspaceRootInRepositoryChecks(
      workspaceRoots.executionRoot,
    );
    const statuses = await checkAllRepos(
      workspaceRoots.executionRoot,
      config,
      false,
      includeWorkspaceRoot,
    );
    const workspaceBranch = await resolveConfiguredWorkspaceBranch(
      statuses,
      workspaceRoots.configurationRoot,
    );
    const data = buildHandoffData({
      cwd: process.cwd(),
      options,
      statuses,
      workspaceBranch,
      workspaceRoot: workspaceRoots.configurationRoot,
    });
    data.worktreesBase = resolve(
      workspaceRoots.configurationRoot,
      config.worktreesDir ?? "../.worktrees",
    );
    const warnings: JsonWarning[] = collectStatusWarnings(statuses);

    if (options.json) {
      writeJsonEnvelope(
        createJsonSuccessEnvelope<Record<string, unknown>>(
          "handoff",
          data as unknown as Record<string, unknown>,
          warnings,
        ),
      );
    } else {
      process.stdout.write(renderMarkdownReport(data));
    }

    if (statuses.some((status) => status.error !== null)) {
      process.exit(ERROR_EXIT_CODE);
    }
  } catch (error) {
    if (options.json) {
      writeJsonEnvelope(createJsonErrorEnvelope("handoff", unknownErrorToJsonError(error)));
    } else {
      logError(error instanceof Error ? error.message : String(error));
    }
    process.exit(ERROR_EXIT_CODE);
  }
};

const collectRepeated = (value: string, previous: string[] = []): string[] => [...previous, value];

export const createCommand = (): Command => {
  const deprecatedMarkdown = new Option(
    "--markdown",
    "Deprecated compatibility spelling for the default Markdown output",
  ).hideHelp();
  (deprecatedMarkdown as Option & { deprecated?: boolean }).deprecated = true;

  return new Command("handoff")
    .description("Generate a Markdown or JSON handoff report for the current workspace")
    .option("-j, --json", "Output a structured JSON envelope instead of Markdown")
    .addOption(deprecatedMarkdown)
    .option(
      "--link <link>",
      "Related issue, PR, spec, or reference link (repeatable)",
      collectRepeated,
    )
    .option(
      "--validation <entry>",
      "Validation command and result evidence, e.g. 'pnpm run test — passed' (repeatable)",
      collectRepeated,
    )
    .option(
      "--todo <item>",
      "Remaining work item to include as a checklist entry (repeatable)",
      collectRepeated,
    )
    .option(
      "--risk <item>",
      "Known risk or blocker to include in the report (repeatable)",
      collectRepeated,
    )
    .option(
      "--next-command <command>",
      "Suggested next command, not executed (repeatable)",
      collectRepeated,
    )
    .addHelpText(
      "after",
      `
Examples:
  $ arashi handoff --link https://github.com/corwinm/arashi-arashi/issues/186
  $ arashi handoff --validation "pnpm run test — passed" --todo "watch CI"
  $ arashi handoff --json --next-command "arashi status --verbose"
      `,
    )
    .action(runHandoff);
};
