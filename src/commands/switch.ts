import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { basename, resolve, sep } from "path";
import {
  discoverSwitchCandidates,
  filterSwitchCandidates,
  selectSwitchCandidate,
} from "../core/switch.ts";
import { findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import { info, error as logError, success } from "../lib/logger.ts";
import { Command } from "commander";
import { exec } from "../lib/git.ts";
import { launchSwitchTarget } from "../lib/switch-launcher.ts";
import { resolveDefaultWithPrecedence } from "../lib/default-resolution.ts";

type LoadWorkspaceRepositoriesResult = Awaited<ReturnType<typeof loadWorkspaceRepositories>>;
type Config = NonNullable<LoadWorkspaceRepositoriesResult["config"]>;
type LaunchMode = "auto" | "sesh";
type LaunchSwitchResult = Awaited<ReturnType<typeof launchSwitchTarget>>;
type SwitchCandidateDiscoveryResult = Awaited<ReturnType<typeof discoverSwitchCandidates>>;
type SwitchCandidate = SwitchCandidateDiscoveryResult["candidates"][number];
type SwitchLaunchMode = "sesh" | "tmux" | "vscode" | "cursor" | "kiro" | "fallback";
type SupportedIde = "vscode" | "cursor" | "kiro";
type SwitchProcessRunner = NonNullable<
  NonNullable<Parameters<typeof launchSwitchTarget>[2]>["runProcess"]
>;
type WorkspaceRepository = LoadWorkspaceRepositoriesResult["repositories"][number];

const ZERO = 0;
const ONE = 1;
const SUCCESS_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const AUTO_LAUNCH_MODE: LaunchMode = "auto";
const SESH_LAUNCH_MODE: LaunchMode = "sesh";
const DETACHED_HEAD = "HEAD";
const KEY_SEPARATOR = "\u0000";

export interface SwitchCommandOptions {
  sesh?: boolean;
  vscode?: boolean;
  cursor?: boolean;
  kiro?: boolean;
  path?: boolean;
  repos?: boolean;
  all?: boolean;
  defaultLaunch?: boolean;
}

interface LaunchResolution {
  preferredIde?: SupportedIde;
  requirePreferredIde?: boolean;
  sesh?: boolean;
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
    .option("--path", "Treat argument as exact worktree path")
    .option("--sesh", "Use sesh in tmux mode")
    .option("--vscode", "Open the selected worktree in VS Code")
    .option("--cursor", "Open the selected worktree in Cursor")
    .option("--kiro", "Open the selected worktree in Kiro")
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
  $ arashi switch --cursor feature-auth
  $ arashi switch --path /path/to/worktree
  $ arashi switch feature-auth
  $ arashi switch repo-a --sesh
`,
    )
    .action(async (filter: string | undefined, options: SwitchCommandOptions) => {
      try {
        await executeSwitch(filter, options);
        process.exit(SUCCESS_EXIT_CODE);
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
      reposDir: workspace.config?.reposDir ?? "./repos",
      repositories: workspace.repositories,
      workspaceRoot,
    });
  }

  if (scopedCandidates.length === 0) {
    throw new SwitchCommandError(getNoTargetsMessage(scope), SwitchCommandErrorCode.NO_TARGETS, {
      scope,
      workspaceRoot,
    });
  }

  let matchedCandidates = filterSwitchCandidates(scopedCandidates, filter);
  if (options.path) {
    matchedCandidates = filterSwitchCandidatesByExactPath(scopedCandidates, filter);
  } else if (scope === "repos") {
    matchedCandidates = filterRepoScopedCandidates(scopedCandidates, filter);
  }

  if (matchedCandidates.length === ZERO) {
    if (options.path) {
      throw new SwitchCommandError(
        buildPathNoMatchMessage(filter),
        SwitchCommandErrorCode.NO_MATCHES,
        {
          filter,
          pathMode: true,
          scope,
        },
      );
    }

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

  const resolvedLaunch = resolveLaunchOptions(
    options,
    workspace.config?.defaults?.switch?.launchMode,
  );

  const launchResult = await launchCandidate(
    selected,
    {
      preferredIde: resolvedLaunch.preferredIde,
      requirePreferredIde: resolvedLaunch.requirePreferredIde,
      sesh: resolvedLaunch.sesh,
    },
    {
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      runProcess: deps.runProcess,
    },
  );

  success(
    `Opened ${launchResult.mode} context for ${selected.repoName} (${selected.branchName}) at ${selected.worktreePath}`,
  );

  return {
    launchMode: launchResult.mode,
    matchedCandidates: matchedCandidates.length,
    selected,
    skippedCandidates: discovery.skippedCount,
    totalCandidates: scopedCandidates.length,
  };
}

const handleSwitchError = (error: unknown): never => {
  if (error instanceof SwitchCommandError) {
    if (error.code === SwitchCommandErrorCode.USER_CANCELLED) {
      info("Switch cancelled.");
      process.exit(SUCCESS_EXIT_CODE);
    }

    logError(error.message);

    if (error.code === SwitchCommandErrorCode.AMBIGUOUS_NON_INTERACTIVE) {
      info("Hint: provide a more specific filter, e.g. `arashi switch feature-auth`.");
      process.exit(USAGE_EXIT_CODE);
    }

    if (error.code === SwitchCommandErrorCode.NO_TARGETS) {
      info("Hint: create a worktree first with `arashi create <branch>`.");
      process.exit(USAGE_EXIT_CODE);
    }

    if (error.code === SwitchCommandErrorCode.NO_MATCHES) {
      info("Hint: run `arashi list` to see available worktree paths and branches.");
      process.exit(USAGE_EXIT_CODE);
    }

    if (
      error.code === SwitchCommandErrorCode.CONFLICTING_LAUNCH_OPTIONS ||
      error.code === SwitchCommandErrorCode.SESH_REQUIRES_TMUX ||
      error.code === SwitchCommandErrorCode.SESH_NOT_FOUND ||
      error.code === SwitchCommandErrorCode.IDE_NOT_FOUND
    ) {
      process.exit(USAGE_EXIT_CODE);
    }

    process.exit(ERROR_EXIT_CODE);
  }

  logError(error instanceof Error ? error.message : String(error));
  process.exit(ERROR_EXIT_CODE);
};

const resolveSwitchScope = (options: SwitchCommandOptions): SwitchRepositoryScope => {
  if (options.all) {
    return "all";
  }

  if (options.repos) {
    return "repos";
  }

  return "parent";
};

const filterRepositoriesByScope = (
  scope: SwitchRepositoryScope,
  workspaceRoot: string,
  repositories: WorkspaceRepository[],
): WorkspaceRepository[] => {
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

  if (parentRepositories.length > ZERO) {
    return parentRepositories;
  }

  if (repositories.length > ZERO) {
    return [repositories[ZERO]];
  }

  return [];
};

const getNoTargetsMessage = (scope: SwitchRepositoryScope): string => {
  if (scope === "repos") {
    return "No switch targets were found for child repositories in the current workspace. Try `arashi switch --all` to include all worktrees.";
  }

  if (scope === "parent") {
    return "No switch targets were found in the parent repository. Use `arashi switch --repos` or `arashi switch --all` to broaden the search.";
  }

  return "No switch targets were found in this workspace.";
};

const filterCandidatesByScope = (
  scope: SwitchRepositoryScope,
  workspaceRoot: string,
  candidates: SwitchCandidate[],
): SwitchCandidate[] => {
  if (scope !== "repos") {
    return candidates;
  }

  const normalizedWorkspaceRoot = resolve(workspaceRoot);
  const workspacePrefix = `${normalizedWorkspaceRoot}${sep}`;

  return candidates.filter((candidate) => {
    const candidatePath = resolve(candidate.worktreePath);
    return candidatePath === normalizedWorkspaceRoot || candidatePath.startsWith(workspacePrefix);
  });
};

const augmentAllScopeCandidates = async (
  candidates: SwitchCandidate[],
  options: {
    workspaceRoot: string;
    reposDir: string;
    repositories: WorkspaceRepository[];
  },
): Promise<SwitchCandidate[]> => {
  const normalizedWorkspaceRoot = resolve(options.workspaceRoot);
  const parentRepoName = basename(normalizedWorkspaceRoot);
  const parentCandidates = candidates.filter((candidate) => candidate.repoName === parentRepoName);
  const childRepositories = options.repositories.filter(
    (repo) => resolve(repo.path) !== normalizedWorkspaceRoot,
  );

  if (parentCandidates.length === ZERO || childRepositories.length === ZERO) {
    return candidates;
  }

  const merged = [...candidates];
  const seen = new Set<string>(
    candidates.map((candidate) => `${candidate.repoName}${KEY_SEPARATOR}${candidate.worktreePath}`),
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
        branchName,
        repoName: childRepository.name,
        worktreePath: childWorktreePath,
      };
      const key = `${candidate.repoName}${KEY_SEPARATOR}${candidate.worktreePath}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(candidate);
    }
  }

  return merged;
};

const getBranchName = async (repoPath: string): Promise<string | null> => {
  try {
    const result = await exec(["rev-parse", "--abbrev-ref", DETACHED_HEAD], repoPath);
    const branchName = result.stdout.trim();
    if (!branchName || branchName === DETACHED_HEAD) {
      return null;
    }
    return branchName;
  } catch {
    return null;
  }
};

const filterRepoScopedCandidates = (
  candidates: SwitchCandidate[],
  filter: string | undefined,
): SwitchCandidate[] => {
  if (!filter || filter.trim().length === ZERO) {
    return [...candidates];
  }

  const query = filter.trim().toLowerCase();

  const exactMatches = candidates.filter((candidate) => candidate.repoName.toLowerCase() === query);
  if (exactMatches.length > ZERO) {
    return exactMatches;
  }

  const partialRepoNames = [
    ...new Set(
      candidates
        .map((candidate) => candidate.repoName)
        .filter((repoName) => repoName.toLowerCase().includes(query)),
    ),
  ];

  if (partialRepoNames.length === ONE) {
    const partialRepoName = partialRepoNames[ZERO];
    return candidates.filter((candidate) => candidate.repoName === partialRepoName);
  }

  if (partialRepoNames.length > ONE) {
    const partialRepoSet = new Set(partialRepoNames);
    return candidates.filter((candidate) => partialRepoSet.has(candidate.repoName));
  }

  return [];
};

const filterSwitchCandidatesByExactPath = (
  candidates: SwitchCandidate[],
  filter: string | undefined,
): SwitchCandidate[] => {
  if (!filter || filter.trim().length === ZERO) {
    return [];
  }

  const normalizedPath = resolve(filter.trim());
  return candidates.filter((candidate) => resolve(candidate.worktreePath) === normalizedPath);
};

const buildRepoNoMatchMessage = (
  candidates: SwitchCandidate[],
  filter: string | undefined,
): string => {
  const availableRepos = [...new Set(candidates.map((candidate) => candidate.repoName))];
  availableRepos.sort();

  let availableReposText = "(no child repositories found)";
  if (availableRepos.length > ZERO) {
    availableReposText = availableRepos.join(", ");
  }

  if (!filter || filter.trim().length === ZERO) {
    return `No child repository matches were found. Available repositories: ${availableReposText}`;
  }

  return `No child repository matched \`${filter}\`. Available repositories: ${availableReposText}`;
};

const buildPathNoMatchMessage = (filter: string | undefined): string => {
  if (!filter || filter.trim().length === ZERO) {
    return "Exact path mode requires a worktree path. Run `arashi switch --path <worktree-path>`.";
  }

  return `No worktree exists at exact path \`${resolve(filter.trim())}\`. Run \`arashi list\` to see available worktree paths.`;
};

const resolveLaunchOptions = (
  options: SwitchCommandOptions,
  configLaunchMode: LaunchMode | undefined,
): LaunchResolution => {
  const explicitIde = resolveExplicitIde(options);
  if (explicitIde) {
    return {
      preferredIde: explicitIde,
      requirePreferredIde: true,
      sesh: false,
    };
  }

  const resolvedLaunchMode = resolveDefaultWithPrecedence<LaunchMode>({
    builtInValue: AUTO_LAUNCH_MODE,
    configValue: configLaunchMode,
    explicitValue: SESH_LAUNCH_MODE,
    hasExplicitValue: options.sesh === true,
    optOut: options.defaultLaunch === false,
  });

  return {
    sesh: resolvedLaunchMode.value === SESH_LAUNCH_MODE,
  };
};

const resolveExplicitIde = (options: SwitchCommandOptions): SupportedIde | undefined => {
  const launchOverrides = [
    options.sesh === true ? "sesh" : null,
    options.vscode === true ? "vscode" : null,
    options.cursor === true ? "cursor" : null,
    options.kiro === true ? "kiro" : null,
  ].filter((value): value is "sesh" | SupportedIde => value !== null);

  if (launchOverrides.length > ONE) {
    throw new SwitchCommandError(
      `Conflicting launch overrides provided (${launchOverrides.map((value) => `--${value}`).join(", ")}). Choose exactly one explicit switch mode.`,
      SwitchCommandErrorCode.CONFLICTING_LAUNCH_OPTIONS,
      {
        launchOverrides,
      },
    );
  }

  if (launchOverrides[ZERO] === "sesh" || launchOverrides.length === ZERO) {
    return undefined;
  }

  return launchOverrides[ZERO];
};
