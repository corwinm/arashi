import { runtime } from "../lib/runtime.ts";
import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { basename, resolve, sep } from "path";
import {
  discoverSwitchCandidates,
  filterSwitchCandidates,
  selectSwitchCandidate,
} from "../core/switch.ts";
import { type SwitchMode, findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import { getDirectiveContext, writeCdDirective } from "../lib/shell-directives.ts";
import { info, error as logError, success, warn } from "../lib/logger.ts";
import { unsupportedJsonModeError, writeJsonEnvelope } from "../lib/json-output.ts";
import { Command } from "commander";
import { exec } from "../lib/git.ts";
import { detectManagedSwitchContext, launchSwitchTarget } from "../lib/switch-launcher.ts";
import { resolveDefaultWithPrecedence } from "../lib/default-resolution.ts";
import { resolveWorkspaceContext } from "../lib/workspace-context.ts";

type LoadWorkspaceRepositoriesResult = Awaited<ReturnType<typeof loadWorkspaceRepositories>>;
type Config = NonNullable<LoadWorkspaceRepositoriesResult["config"]>;
type LaunchMode = "auto" | "sesh" | "herdr";
type SwitchBehaviorMode = "launch" | "cd" | "auto";
type LaunchSwitchResult = Awaited<ReturnType<typeof launchSwitchTarget>>;
type SwitchCandidateDiscoveryResult = Awaited<ReturnType<typeof discoverSwitchCandidates>>;
type SwitchCandidate = SwitchCandidateDiscoveryResult["candidates"][number];
type SwitchLaunchMode = "cd" | LaunchSwitchResult["mode"];
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
const AUTO_SWITCH_MODE: SwitchBehaviorMode = "auto";
const CD_SWITCH_MODE: SwitchBehaviorMode = "cd";
const LAUNCH_SWITCH_MODE: SwitchBehaviorMode = "launch";
const SESH_LAUNCH_MODE = "sesh" as const;
const HERDR_LAUNCH_MODE = "herdr" as const;
const DETACHED_HEAD = "HEAD";
const KEY_SEPARATOR = "\u0000";

export interface SwitchCommandOptions {
  herdr?: boolean;
  sesh?: boolean;
  tmux?: boolean;
  cd?: boolean;
  vscode?: boolean;
  cursor?: boolean;
  kiro?: boolean;
  path?: boolean;
  repos?: boolean;
  all?: boolean;
  defaultLaunch?: boolean;
  json?: boolean;
}

interface LaunchResolution {
  herdr?: boolean;
  preferredIde?: SupportedIde;
  requirePreferredIde?: boolean;
  sesh?: boolean;
  tmux?: boolean;
}

interface SwitchBehaviorResolution {
  mode: SwitchBehaviorMode;
  skipLaunchWhenUnavailable: boolean;
  warnOnMissingIntegration: boolean;
}

interface SwitchResolution {
  behavior: SwitchBehaviorResolution;
  launch: LaunchResolution;
}

interface SwitchResolutionInput {
  configMode?: SwitchMode;
  managedContextActive: boolean;
  options: SwitchCommandOptions;
  shellIntegrationActive: boolean;
}

interface SwitchBehaviorInput {
  configMode?: SwitchBehaviorMode;
  hasExplicitLaunchOverride: boolean;
  managedContextActive: boolean;
  options: SwitchCommandOptions;
  shellIntegrationActive: boolean;
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
    options: {
      herdr?: boolean;
      preferredIde?: SupportedIde;
      requirePreferredIde?: boolean;
      sesh?: boolean;
      tmux?: boolean;
    },
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
    .description("Switch to an existing worktree using explicit, configured, or contextual modes")
    .argument("[filter]", "Filter targets by branch name or worktree path")
    .option("--path", "Treat argument as exact worktree path")
    .option("--sesh", "Use sesh in tmux mode")
    .option("--tmux", "Force launch in a new plain tmux window")
    .option("--herdr", "Open or focus the selected worktree in Herdr")
    .option("--cd", "Change the current shell directory when shell integration is active")
    .option("--no-cd", "Disable parent-shell directory switching for this invocation")
    .option("--vscode", "Open the selected worktree in VS Code")
    .option("--cursor", "Open the selected worktree in Cursor")
    .option("--kiro", "Open the selected worktree in Kiro")
    .option("--no-default-launch", "Bypass a configured sesh or Herdr mode for this invocation")
    .option("--repos", "Use child repositories only")
    .option("--all", "Use both parent and child repositories")
    .option(
      "--json",
      "Return a structured unsupported-mode error instead of launching or switching",
    )
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

Configured modes: auto | cd | launch | sesh | herdr
Precedence: explicit launcher flags, --cd/--no-cd, configured mode, then automatic context detection.
`,
    )
    .action(async (filter: string | undefined, options: SwitchCommandOptions) => {
      try {
        if (options.json) {
          writeJsonEnvelope(unsupportedJsonModeError("switch", "launch"));
          process.exit(USAGE_EXIT_CODE);
        }
        await executeSwitch(filter, options);
        process.exit(SUCCESS_EXIT_CODE);
      } catch (error) {
        handleSwitchError(error);
      }
    });
}

export function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions & { json: true },
  deps?: SwitchCommandDependencies,
): Promise<number>;
export function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions & { json?: false },
  deps?: SwitchCommandDependencies,
): Promise<SwitchExecutionResult>;
export function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions,
  deps?: SwitchCommandDependencies,
): Promise<SwitchExecutionResult | number>;
export async function executeSwitch(
  filter: string | undefined,
  options: SwitchCommandOptions,
  deps: SwitchCommandDependencies = {},
): Promise<SwitchExecutionResult | number> {
  if (options.json) {
    writeJsonEnvelope(unsupportedJsonModeError("switch", "launch"));
    return USAGE_EXIT_CODE;
  }
  const resolveWorkspaceRoot = deps.findWorkspaceRoot ?? findWorkspaceRoot;
  const resolveWorkspaceRepositories = deps.loadWorkspaceRepositories ?? loadWorkspaceRepositories;
  const discoverCandidates = deps.discoverSwitchCandidates ?? discoverSwitchCandidates;
  const chooseCandidate = deps.selectSwitchCandidate ?? selectSwitchCandidate;
  const augmentAllCandidates = deps.augmentAllScopeCandidates ?? augmentAllScopeCandidates;
  const launchCandidate = deps.launchSwitchTarget ?? launchSwitchTarget;

  const context = await resolveWorkspaceContext();
  if (context.mode === "standalone" && (options.repos || options.all)) {
    throw new SwitchCommandError(
      "--repos and --all are not meaningful in standalone mode; switch already uses this repository's worktrees.",
      SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS,
      { mode: "standalone" },
    );
  }
  if (context.mode === "standalone") {
    info(`Workspace mode: standalone`);
    info(`Main repository: ${context.mainRoot}`);
  }
  const workspaceRoot =
    context.mode === "standalone" ? context.mainRoot : await resolveWorkspaceRoot();
  const workspace =
    context.mode === "standalone"
      ? { config: context.config, repositories: [context.repository] }
      : await resolveWorkspaceRepositories(workspaceRoot);
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

  const commandEnv = deps.env ?? process.env;
  const directiveContext = getDirectiveContext(commandEnv);
  const resolution = resolveSwitchResolution({
    configMode: workspace.config?.defaults?.switch?.mode,
    managedContextActive: detectManagedSwitchContext(commandEnv) !== null,
    options,
    shellIntegrationActive: directiveContext !== null,
  });
  const { behavior: resolvedBehavior, launch: resolvedLaunch } = resolution;

  if (resolvedBehavior.mode === CD_SWITCH_MODE && directiveContext) {
    await writeCdDirective(directiveContext, selected.worktreePath);
    success(
      `Prepared shell directory switch for ${selected.repoName} (${selected.branchName}) to ${selected.worktreePath}`,
    );

    return {
      launchMode: "cd",
      matchedCandidates: matchedCandidates.length,
      selected,
      skippedCandidates: discovery.skippedCount,
      totalCandidates: scopedCandidates.length,
    };
  }

  if (resolvedBehavior.warnOnMissingIntegration && !directiveContext) {
    warn(
      "Shell integration is not active, so `arashi switch` cannot change the current shell directory for this invocation.",
    );
    info(
      "Hint: run `arashi shell install`, restart your shell, and invoke `arashi` through the installed wrapper.",
    );

    if (resolvedBehavior.skipLaunchWhenUnavailable) {
      return {
        launchMode: "cd",
        matchedCandidates: matchedCandidates.length,
        selected,
        skippedCandidates: discovery.skippedCount,
        totalCandidates: scopedCandidates.length,
      };
    }
  }

  const launchResult = await launchCandidate(
    selected,
    {
      herdr: resolvedLaunch.herdr,
      preferredIde: resolvedLaunch.preferredIde,
      requirePreferredIde: resolvedLaunch.requirePreferredIde,
      sesh: resolvedLaunch.sesh,
      tmux: resolvedLaunch.tmux,
    },
    {
      env: commandEnv,
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
      error.code === SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS ||
      error.code === SwitchCommandErrorCode.TMUX_CONTEXT_REQUIRED ||
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

      if (!(await runtime.file(resolve(childWorktreePath, ".git")).exists())) {
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

export const resolveSwitchResolution = ({
  configMode,
  managedContextActive,
  options,
  shellIntegrationActive,
}: SwitchResolutionInput): SwitchResolution => {
  const explicitLauncher = resolveExplicitLauncher(options);
  if (options.cd === true && explicitLauncher) {
    throw new SwitchCommandError(
      "Conflicting switch behavior overrides provided (--cd with an explicit launch override). Choose either parent-shell switching or a launch target.",
      SwitchCommandErrorCode.CONFLICTING_SWITCH_OPTIONS,
    );
  }

  const configLaunchMode: LaunchMode | undefined =
    configMode === SESH_LAUNCH_MODE || configMode === HERDR_LAUNCH_MODE ? configMode : undefined;
  const configBehaviorMode: SwitchBehaviorMode | undefined =
    configMode === SESH_LAUNCH_MODE || configMode === HERDR_LAUNCH_MODE
      ? LAUNCH_SWITCH_MODE
      : configMode;

  return {
    behavior: resolveSwitchBehavior({
      configMode: configBehaviorMode,
      hasExplicitLaunchOverride: explicitLauncher !== undefined,
      managedContextActive,
      options,
      shellIntegrationActive,
    }),
    launch: resolveLaunchOptions(options, configLaunchMode, explicitLauncher),
  };
};

const resolveLaunchOptions = (
  options: SwitchCommandOptions,
  configLaunchMode: LaunchMode | undefined,
  explicitLauncher: SupportedIde | "tmux" | "sesh" | "herdr" | undefined,
): LaunchResolution => {
  if (explicitLauncher === "tmux") {
    return { tmux: true };
  }
  if (explicitLauncher === HERDR_LAUNCH_MODE) {
    return { herdr: true, sesh: false };
  }
  if (explicitLauncher && explicitLauncher !== SESH_LAUNCH_MODE) {
    return {
      preferredIde: explicitLauncher,
      requirePreferredIde: true,
      sesh: false,
    };
  }

  const resolvedLaunchMode = resolveDefaultWithPrecedence<LaunchMode>({
    builtInValue: AUTO_LAUNCH_MODE,
    configValue: configLaunchMode,
    explicitValue: SESH_LAUNCH_MODE,
    hasExplicitValue: explicitLauncher === SESH_LAUNCH_MODE,
    optOut: options.defaultLaunch === false,
  });

  if (resolvedLaunchMode.value === HERDR_LAUNCH_MODE) {
    return { herdr: true, sesh: false };
  }

  return { sesh: resolvedLaunchMode.value === SESH_LAUNCH_MODE };
};

const resolveSwitchBehavior = ({
  configMode,
  hasExplicitLaunchOverride,
  managedContextActive,
  options,
  shellIntegrationActive,
}: SwitchBehaviorInput): SwitchBehaviorResolution => {
  if (hasExplicitLaunchOverride) {
    return {
      mode: LAUNCH_SWITCH_MODE,
      skipLaunchWhenUnavailable: false,
      warnOnMissingIntegration: false,
    };
  }

  if (options.cd === true) {
    return {
      mode: CD_SWITCH_MODE,
      skipLaunchWhenUnavailable: true,
      warnOnMissingIntegration: true,
    };
  }

  if (options.cd === false) {
    return {
      mode: LAUNCH_SWITCH_MODE,
      skipLaunchWhenUnavailable: false,
      warnOnMissingIntegration: false,
    };
  }

  const mode = configMode ?? LAUNCH_SWITCH_MODE;
  if (mode === AUTO_SWITCH_MODE) {
    return {
      mode: managedContextActive || !shellIntegrationActive ? LAUNCH_SWITCH_MODE : CD_SWITCH_MODE,
      skipLaunchWhenUnavailable: false,
      warnOnMissingIntegration: false,
    };
  }

  return {
    mode,
    skipLaunchWhenUnavailable: false,
    warnOnMissingIntegration: mode === CD_SWITCH_MODE,
  };
};

const resolveExplicitLauncher = (
  options: SwitchCommandOptions,
): SupportedIde | "tmux" | "sesh" | "herdr" | undefined => {
  const launchOverrides = [
    options.tmux === true ? "tmux" : null,
    options.herdr === true ? "herdr" : null,
    options.sesh === true ? "sesh" : null,
    options.vscode === true ? "vscode" : null,
    options.cursor === true ? "cursor" : null,
    options.kiro === true ? "kiro" : null,
  ].filter((value): value is "tmux" | "sesh" | "herdr" | SupportedIde => value !== null);

  if (launchOverrides.length > ONE) {
    throw new SwitchCommandError(
      `Conflicting launch overrides provided (${launchOverrides.map((value) => `--${value}`).join(", ")}). Choose exactly one explicit switch mode.`,
      SwitchCommandErrorCode.CONFLICTING_LAUNCH_OPTIONS,
      { launchOverrides },
    );
  }

  return launchOverrides[ZERO];
};
