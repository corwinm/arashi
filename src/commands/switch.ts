import { Command } from "commander";
import { basename, resolve, sep } from "path";
import type { Config, LaunchMode, WorkspaceRepository } from "../lib/config.ts";
import { findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import * as logger from "../lib/logger.ts";
import * as git from "../lib/git.ts";
import {
  discoverSwitchCandidates,
  filterSwitchCandidates,
  selectSwitchCandidate,
  type SwitchCandidate,
  type SwitchCandidateDiscoveryResult,
} from "../core/switch.ts";
import {
  launchSwitchTarget,
  type LaunchSwitchResult,
  type SwitchProcessRunner,
} from "../lib/switch-launcher.ts";
import {
  SwitchCommandError,
  SwitchCommandErrorCode,
  type SwitchLaunchMode,
} from "../types/switch.ts";
import { resolveDefaultWithPrecedence } from "../lib/default-resolution.ts";

export interface SwitchCommandOptions {
  sesh?: boolean;
  repos?: boolean;
  all?: boolean;
  defaultLaunch?: boolean;
}

type SwitchRepositoryScope = "parent" | "repos" | "all";

export interface SwitchCommandDependencies {
  findWorkspaceRoot?: () => Promise<string>;
  loadWorkspaceRepositories?: (
    workspaceRoot: string,
  ) => Promise<{ repositories: WorkspaceRepository[]; config?: Config }>;
  discoverSwitchCandidates?: (
    repositories: WorkspaceRepository[],
  ) => Promise<SwitchCandidateDiscoveryResult>;
  selectSwitchCandidate?: (
    candidates: SwitchCandidate[],
    options: { interactive: boolean; workspaceRepoName?: string },
  ) => Promise<SwitchCandidate>;
  augmentAllScopeCandidates?: (
    candidates: SwitchCandidate[],
    options: {
      workspaceRoot: string;
      reposDir: string;
      repositories: WorkspaceRepository[];
    },
  ) => Promise<SwitchCandidate[]>;
  launchSwitchTarget?: (
    candidate: SwitchCandidate,
    options: { sesh?: boolean },
    deps: {
      env: Record<string, string | undefined>;
      platform: NodeJS.Platform;
      runProcess?: SwitchProcessRunner;
    },
  ) => Promise<LaunchSwitchResult>;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  runProcess?: SwitchProcessRunner;
}

export interface SwitchExecutionResult {
  selected: SwitchCandidate;
  launchMode: SwitchLaunchMode;
  totalCandidates: number;
  matchedCandidates: number;
  skippedCandidates: number;
}

export function createCommand(): Command {
  return new Command("switch")
    .description("Open a terminal context for an existing worktree")
    .argument("[filter]", "Filter targets by branch name or worktree path")
    .option("--sesh", "Use sesh in tmux mode")
    .option("--no-default-launch", "Ignore configured default launch mode for this invocation")
    .option("--repos", "Use child repositories only")
    .option("--all", "Use both parent and child repositories")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi switch
  $ arashi switch --repos
  $ arashi switch --no-default-launch
  $ arashi switch --all feature-auth
  $ arashi switch feature-auth
  $ arashi switch repo-a --sesh
`,
    )
    .action(async (filter: string | undefined, options: SwitchCommandOptions) => {
      try {
        await executeSwitch(filter, options);
        process.exit(0);
      } catch (error) {
        handleSwitchError(error);
      }
    });
}

export async function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions,
  deps: SwitchCommandDependencies = {},
): Promise<SwitchExecutionResult> {
  const resolveWorkspaceRoot = deps.findWorkspaceRoot ?? findWorkspaceRoot;
  const resolveWorkspaceRepositories = deps.loadWorkspaceRepositories ?? loadWorkspaceRepositories;
  const discoverCandidates = deps.discoverSwitchCandidates ?? discoverSwitchCandidates;
  const chooseCandidate = deps.selectSwitchCandidate ?? selectSwitchCandidate;
  const augmentAllCandidates = deps.augmentAllScopeCandidates ?? augmentAllScopeCandidates;
  const launchCandidate = deps.launchSwitchTarget ?? launchSwitchTarget;

  const workspaceRoot = await resolveWorkspaceRoot();
  const workspace = await resolveWorkspaceRepositories(workspaceRoot);
  const scope = resolveSwitchScope(options);
  const targetRepositories = filterRepositoriesByScope(
    scope,
    workspaceRoot,
    workspace.repositories,
  );
  const discovery = await discoverCandidates(targetRepositories);
  let scopedCandidates = filterCandidatesByScope(scope, workspaceRoot, discovery.candidates);

  if (scope === "all") {
    scopedCandidates = await augmentAllCandidates(scopedCandidates, {
      workspaceRoot,
      reposDir: workspace.config?.reposDir ?? "./repos",
      repositories: workspace.repositories,
    });
  }

  if (scopedCandidates.length === 0) {
    throw new SwitchCommandError(getNoTargetsMessage(scope), SwitchCommandErrorCode.NO_TARGETS, {
      workspaceRoot,
      scope,
    });
  }

  const matchedCandidates =
    scope === "repos"
      ? filterRepoScopedCandidates(scopedCandidates, filter)
      : filterSwitchCandidates(scopedCandidates, filter);
  if (matchedCandidates.length === 0) {
    if (scope === "repos") {
      throw new SwitchCommandError(
        buildRepoNoMatchMessage(scopedCandidates, filter),
        SwitchCommandErrorCode.NO_MATCHES,
        {
          filter,
          scope,
        },
      );
    }

    throw new SwitchCommandError(
      `No worktrees matched filter \`${filter}\`. Run \`arashi switch\` to choose interactively or provide a broader filter.`,
      SwitchCommandErrorCode.NO_MATCHES,
      {
        filter,
        scope,
      },
    );
  }

  const interactive = Boolean(
    (deps.stdinIsTTY ?? process.stdin.isTTY) && (deps.stdoutIsTTY ?? process.stdout.isTTY),
  );
  const selected = await chooseCandidate(matchedCandidates, {
    interactive,
    workspaceRepoName: scope === "all" ? basename(resolve(workspaceRoot)) : undefined,
  });

  const resolvedLaunchMode = resolveDefaultWithPrecedence<LaunchMode>({
    explicitValue: "sesh",
    hasExplicitValue: options.sesh === true,
    optOut: options.defaultLaunch === false,
    configValue: workspace.config?.defaults?.switch?.launchMode,
    builtInValue: "auto",
  });

  const launchResult = await launchCandidate(
    selected,
    {
      sesh: resolvedLaunchMode.value === "sesh",
    },
    {
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      runProcess: deps.runProcess,
    },
  );

  logger.success(
    `Opened ${launchResult.mode} context for ${selected.repoName} (${selected.branchName}) at ${selected.worktreePath}`,
  );

  return {
    selected,
    launchMode: launchResult.mode,
    totalCandidates: scopedCandidates.length,
    matchedCandidates: matchedCandidates.length,
    skippedCandidates: discovery.skippedCount,
  };
}

function handleSwitchError(error: unknown): never {
  if (error instanceof SwitchCommandError) {
    if (error.code === SwitchCommandErrorCode.USER_CANCELLED) {
      logger.info("Switch cancelled.");
      process.exit(0);
    }

    logger.error(error.message);

    if (error.code === SwitchCommandErrorCode.AMBIGUOUS_NON_INTERACTIVE) {
      logger.info("Hint: provide a more specific filter, e.g. `arashi switch feature-auth`.");
      process.exit(2);
    }

    if (error.code === SwitchCommandErrorCode.NO_TARGETS) {
      logger.info("Hint: create a worktree first with `arashi create <branch>`.");
      process.exit(2);
    }

    if (error.code === SwitchCommandErrorCode.NO_MATCHES) {
      logger.info("Hint: run `arashi list` to see available worktree paths and branches.");
      process.exit(2);
    }

    if (
      error.code === SwitchCommandErrorCode.SESH_REQUIRES_TMUX ||
      error.code === SwitchCommandErrorCode.SESH_NOT_FOUND
    ) {
      process.exit(2);
    }

    process.exit(1);
  }

  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function resolveSwitchScope(options: SwitchCommandOptions): SwitchRepositoryScope {
  if (options.all) {
    return "all";
  }

  if (options.repos) {
    return "repos";
  }

  return "parent";
}

function filterRepositoriesByScope(
  scope: SwitchRepositoryScope,
  workspaceRoot: string,
  repositories: WorkspaceRepository[],
): WorkspaceRepository[] {
  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  const parentRepositories = repositories.filter(
    (repo) => resolve(repo.path) === normalizedWorkspaceRoot,
  );
  const childRepositories = repositories.filter(
    (repo) => resolve(repo.path) !== normalizedWorkspaceRoot,
  );

  if (scope === "all") {
    return [...repositories];
  }

  if (scope === "repos") {
    return childRepositories;
  }

  if (parentRepositories.length > 0) {
    return parentRepositories;
  }

  return repositories.length > 0 ? [repositories[0]] : [];
}

function getNoTargetsMessage(scope: SwitchRepositoryScope): string {
  if (scope === "repos") {
    return "No switch targets were found for child repositories in the current workspace. Try `arashi switch --all` to include all worktrees.";
  }

  if (scope === "parent") {
    return "No switch targets were found in the parent repository. Use `arashi switch --repos` or `arashi switch --all` to broaden the search.";
  }

  return "No switch targets were found in this workspace.";
}

function filterCandidatesByScope(
  scope: SwitchRepositoryScope,
  workspaceRoot: string,
  candidates: SwitchCandidate[],
): SwitchCandidate[] {
  if (scope !== "repos") {
    return candidates;
  }

  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  const workspacePrefix = `${normalizedWorkspaceRoot}${sep}`;

  return candidates.filter((candidate) => {
    const candidatePath = resolve(candidate.worktreePath);
    return candidatePath === normalizedWorkspaceRoot || candidatePath.startsWith(workspacePrefix);
  });
}

async function augmentAllScopeCandidates(
  candidates: SwitchCandidate[],
  options: {
    workspaceRoot: string;
    reposDir: string;
    repositories: WorkspaceRepository[];
  },
): Promise<SwitchCandidate[]> {
  const normalizedWorkspaceRoot = resolve(options.workspaceRoot);
  const parentRepoName = basename(normalizedWorkspaceRoot);
  const parentCandidates = candidates.filter((candidate) => candidate.repoName === parentRepoName);
  const childRepositories = options.repositories.filter(
    (repo) => resolve(repo.path) !== normalizedWorkspaceRoot,
  );

  if (parentCandidates.length === 0 || childRepositories.length === 0) {
    return candidates;
  }

  const merged = [...candidates];
  const seen = new Set<string>(
    candidates.map((candidate) => `${candidate.repoName}\u0000${candidate.worktreePath}`),
  );

  for (const parentCandidate of parentCandidates) {
    for (const childRepository of childRepositories) {
      const childWorktreePath = resolve(
        parentCandidate.worktreePath,
        options.reposDir,
        childRepository.name,
      );

      if (!(await Bun.file(resolve(childWorktreePath, ".git")).exists())) {
        continue;
      }

      const branchName = await getBranchName(childWorktreePath);
      if (!branchName) {
        continue;
      }

      const candidate: SwitchCandidate = {
        repoName: childRepository.name,
        branchName,
        worktreePath: childWorktreePath,
      };
      const key = `${candidate.repoName}\u0000${candidate.worktreePath}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(candidate);
    }
  }

  return merged;
}

async function getBranchName(repoPath: string): Promise<string | null> {
  try {
    const result = await git.exec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
    const branchName = result.stdout.trim();
    if (!branchName || branchName === "HEAD") {
      return null;
    }
    return branchName;
  } catch {
    return null;
  }
}

function filterRepoScopedCandidates(
  candidates: SwitchCandidate[],
  filter: string | undefined,
): SwitchCandidate[] {
  if (!filter || filter.trim().length === 0) {
    return [...candidates];
  }

  const query = filter.trim().toLowerCase();

  const exactMatches = candidates.filter((candidate) => candidate.repoName.toLowerCase() === query);
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  const partialRepoNames = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate.repoName)
        .filter((repoName) => repoName.toLowerCase().includes(query)),
    ),
  );

  if (partialRepoNames.length === 1) {
    const partialRepoName = partialRepoNames[0];
    return candidates.filter((candidate) => candidate.repoName === partialRepoName);
  }

  if (partialRepoNames.length > 1) {
    const partialRepoSet = new Set(partialRepoNames);
    return candidates.filter((candidate) => partialRepoSet.has(candidate.repoName));
  }

  return [];
}

function buildRepoNoMatchMessage(
  candidates: SwitchCandidate[],
  filter: string | undefined,
): string {
  const availableRepos = Array.from(
    new Set(candidates.map((candidate) => candidate.repoName)),
  ).sort();
  const availableReposText =
    availableRepos.length > 0 ? availableRepos.join(", ") : "(no child repositories found)";

  if (!filter || filter.trim().length === 0) {
    return `No child repository matches were found. Available repositories: ${availableReposText}`;
  }

  return `No child repository matched \`${filter}\`. Available repositories: ${availableReposText}`;
}
