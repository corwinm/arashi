/**
 * CLI Command: Create Worktree
 *
 * Creates coordinated worktrees across multiple repositories with a single command.
 * Supports repository filtering, conflict resolution, progress tracking, and automatic rollback.
 */

import { Command, Option } from "commander";
import { ConfigNotFoundError, findWorkspaceRoot, loadConfigWithFallback } from "../lib/config.ts";
import {
  ConflictAbortedError,
  InvalidBranchNameError,
  RepositoryValidationError,
  UserAbortedError,
  applyRepositoryFilter,
  createCoordinatedWorktrees,
} from "../core/worktree.ts";
import { basename, dirname, join, resolve } from "path";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  buildDirtyGuidance,
  buildMovePlan,
  buildRepositoryTargets,
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
import { error, info, success, warn } from "../lib/logger.ts";
import type { SwitchCandidate } from "../core/switch.ts";
import { discoverRepositories } from "../core/repository.ts";
import { exec } from "../lib/git.ts";
import {
  EmptyRepositoryFiltersError,
  filterRepositories as filterWorkspaceRepositories,
  findEmptyRepositoryFilters,
} from "../lib/repo-filter.ts";
import { launchSwitchTarget } from "../lib/switch-launcher.ts";
import { resolveDefaultWithPrecedence } from "../lib/default-resolution.ts";
import {
  reconcileManagedIgnore,
  restoreManagedIgnore,
  type ManagedIgnoreReconciliation,
} from "../lib/managed-ignore.ts";
import { DEFAULT_WORKTREES_DIR } from "../lib/worktree-location.ts";

type LoadedConfig = Awaited<ReturnType<typeof loadConfigWithFallback>>;
type Config = LoadedConfig["config"];
type MoveSummary = Awaited<ReturnType<typeof executeMovePlan>>;
type WorkspaceSelection = Awaited<ReturnType<typeof resolveWorkspaceReference>>;
type ConflictResolutionStrategy = "ABORT" | "REUSE_EXISTING" | "CREATE_ALTERNATE";
type HookOutcomeRecord = Awaited<
  ReturnType<typeof createCoordinatedWorktrees>
>["hookOutcomes"][number];
type LaunchMode = "auto" | "sesh";
type LaunchSwitchResult = Awaited<ReturnType<typeof launchSwitchTarget>>;
type OperationSummary = Awaited<ReturnType<typeof createCoordinatedWorktrees>>;
type RepositoryResult = OperationSummary["repositoryResults"][number];

const temporaryManagedIgnoreWorktrees = new Map<string, string>();
type SwitchProcessRunner = NonNullable<
  NonNullable<Parameters<typeof launchSwitchTarget>[2]>["runProcess"]
>;
type WorktreeOperationOptions = Parameters<typeof createCoordinatedWorktrees>[2];

interface RepositoryFilter {
  mode: "all" | "explicit" | "interactive";
  explicitList: string[];
  selectedRepositories: Parameters<typeof createCoordinatedWorktrees>[1] | null;
  requiredRepositories?: Parameters<typeof createCoordinatedWorktrees>[1];
}

interface ApplyPostCreateDefaultsOptions {
  context: CreateInvocationContext;
  defaults: ResolvedCreateDefaults;
  deps: CreateCommandDependencies;
  summary: OperationSummary;
}

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const ERROR_EXIT_CODE = 1;
const CANCELLED_EXIT_CODE = 2;
const MILLISECONDS_PER_SECOND = 1000;
const AUTO_LAUNCH_MODE: LaunchMode = "auto";
const SESH_LAUNCH_MODE: LaunchMode = "sesh";

const describeConflictScope = (existsLocally: boolean, existsRemotely: boolean): string => {
  if (existsLocally && existsRemotely) {
    return "local and remote";
  }

  if (existsLocally) {
    return "local";
  }

  return "remote";
};

const formatDurationSeconds = (durationMs: number): string =>
  `${(durationMs / MILLISECONDS_PER_SECOND).toFixed(TWO)}s`;

const createCommandErrorCode = (createError: unknown): string => {
  if (createError instanceof InvalidBranchNameError) {
    return "INVALID_BRANCH_NAME";
  }
  if (createError instanceof RepositoryValidationError) {
    return "REPOSITORY_VALIDATION_ERROR";
  }
  if (createError instanceof CreateSetupError) {
    return "WORKSPACE_CONFIG_NOT_FOUND";
  }
  if (createError instanceof ConflictAbortedError) {
    return "BRANCH_CONFLICT";
  }
  if (createError instanceof UserAbortedError) {
    return "USER_ABORTED";
  }
  if (createError instanceof Error && createError.message.includes("not a git repository")) {
    return "NOT_IN_REPOSITORY";
  }

  return "UNKNOWN_ERROR";
};

const createCommandErrorDetails = (createError: unknown): Record<string, unknown> | undefined => {
  if (createError instanceof InvalidBranchNameError) {
    return { branchName: createError.branchName, reason: createError.reason };
  }
  if (createError instanceof ConflictAbortedError) {
    return {
      conflicts: createError.conflicts.map((conflict) => ({
        branchName: conflict.branchName,
        existsLocally: conflict.existsLocally,
        existsRemotely: conflict.existsRemotely,
        repositoryName: conflict.repository.name,
      })),
    };
  }

  return undefined;
};

const writeCreateJsonError = (createError: unknown): void => {
  const jsonError = unknownErrorToJsonError(createError, createCommandErrorCode(createError));
  const details = createCommandErrorDetails(createError);
  writeJsonEnvelope(
    createJsonErrorEnvelope("create", {
      ...jsonError,
      ...(details ? { details } : {}),
    }),
  );
};

interface CreateSummaryJsonOptions {
  branchName: string;
  dirtyWorkspaceGuidance?: ReturnType<typeof buildDirtyGuidance>;
  moveSummary?: MoveSummary | null;
  managedIgnore?: ManagedIgnoreReconciliation;
  summary: OperationSummary;
}

const createSummaryJsonData = ({
  branchName,
  dirtyWorkspaceGuidance,
  managedIgnore,
  moveSummary,
  summary,
}: CreateSummaryJsonOptions) => ({
  branchName,
  dirtyWorkspaceGuidance,
  dryRun: summary.isDryRun === true,
  errorSummary: summary.errorSummary,
  failureCount: summary.failureCount,
  hookOutcomes: summary.hookOutcomes,
  managedIgnore,
  moveSummary,
  nextSteps: summary.nextSteps,
  repositories: summary.repositoryResults.map((result) => ({
    branchName: result.branchName,
    duration: result.duration,
    error: result.error ? result.error.message : null,
    hookOutcomes: result.hookOutcomes,
    repositoryName: result.repository.name,
    repositoryPath: result.repository.path,
    status: result.status,
    warnings: result.warnings,
    worktreePath: result.worktreePath,
  })),
  rolledBack: summary.rolledBack,
  skippedCount: summary.skippedCount,
  successCount: summary.successCount,
  totalDuration: summary.totalDuration,
  totalRepositories: summary.totalRepositories,
});

interface CreateCommandOptions {
  /** Only create worktrees in specified repositories (comma-separated) */
  only?: string;

  /** Only create worktrees in repositories belonging to requested groups */
  group?: string;

  /** Interactively select repositories */
  interactive?: boolean;

  /** Pre-select conflict resolution strategy */
  conflict?: ConflictResolutionStrategy;

  /** Disable hook execution */
  noHooks?: boolean;
  hooks?: boolean;

  /** Hide progress indicators */
  noProgress?: boolean;
  progress?: boolean;

  /** Auto-switch to newly created parent worktree */
  switch?: boolean;

  /** Launch terminal/editor context for newly created parent worktree */
  json?: boolean;
  launch?: boolean;

  /** Force sesh launch mode when launching */
  sesh?: boolean;

  /** Internal editor-host context for create default resolution */
  editorHost?: CreateDefaultsEditorHost;

  /** Move compatible uncommitted changes from the current workspace after create */
  moveChanges?: boolean;

  /** Dry run - show what would be done without making changes */
  dryRun?: boolean;
}

const CREATE_DEFAULT_EDITOR_HOSTS = ["vscode", "cursor", "kiro"] as const;
type CreateDefaultsEditorHost = (typeof CREATE_DEFAULT_EDITOR_HOSTS)[number];

const resolveConfiguredCreateDefaults = (
  options: CreateCommandOptions,
  workspaceConfig: Config,
) => {
  if (options.editorHost) {
    return workspaceConfig.defaults?.editors?.[options.editorHost]?.create;
  }

  return workspaceConfig.defaults?.create;
};

export interface ResolvedCreateDefaults {
  shouldSwitch: boolean;
  shouldLaunch: boolean;
  launchMode: LaunchMode;
}

export interface CreateCommandDependencies {
  resolveCreateInvocationContext?: (invocationPath?: string) => Promise<CreateInvocationContext>;
  resolveManagedIgnoreWorkspaceRoot?: (context: CreateInvocationContext) => Promise<string>;
  loadConfigWithFallback?: typeof loadConfigWithFallback;
  discoverRepositories?: typeof discoverRepositories;
  isGitRepository?: (path: string) => Promise<boolean>;
  resolveCurrentBranch?: (path: string) => Promise<string>;
  applyRepositoryFilter?: typeof applyRepositoryFilter;
  createCoordinatedWorktrees?: typeof createCoordinatedWorktrees;
  reconcileManagedIgnore?: typeof reconcileManagedIgnore;
  restoreManagedIgnore?: typeof restoreManagedIgnore;
  pathExists?: (path: string) => boolean;
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
  runProcess?: SwitchProcessRunner;
}

export interface CreateInvocationContext {
  invocationPath: string;
  workspaceRoot: string;
  executionPath: string;
  repositoryType: "bare" | "non-bare";
}

export class CreateSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateSetupError";
  }
}

export async function resolveCreateInvocationContext(
  invocationPath: string = resolve("."),
): Promise<CreateInvocationContext> {
  const absoluteInvocationPath = resolve(invocationPath);
  const bareProbe = await exec(["rev-parse", "--is-bare-repository"], absoluteInvocationPath);
  const isBare = bareProbe.stdout.trim() === "true";

  if (isBare) {
    return {
      executionPath: absoluteInvocationPath,
      invocationPath: absoluteInvocationPath,
      repositoryType: "bare",
      workspaceRoot: absoluteInvocationPath,
    };
  }

  const workspaceRoot = await findWorkspaceRoot(absoluteInvocationPath);
  return {
    executionPath: workspaceRoot,
    invocationPath: absoluteInvocationPath,
    repositoryType: "non-bare",
    workspaceRoot,
  };
}

export async function resolveManagedIgnoreWorkspaceRoot(
  context: CreateInvocationContext,
): Promise<string> {
  if (context.repositoryType !== "bare") {
    return context.workspaceRoot;
  }

  const result = await exec(["worktree", "list", "--porcelain"], context.executionPath);
  const worktreePaths = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
  for (const path of worktreePaths) {
    try {
      const repositoryType = await exec(["rev-parse", "--is-bare-repository"], path);
      if (repositoryType.stdout.trim() === "false") {
        return path;
      }
    } catch {
      // Ignore stale worktree-list entries and continue looking for a usable work tree.
    }
  }
  const temporaryParent = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-worktree-"));
  const temporaryWorktree = join(temporaryParent, "worktree");
  try {
    await exec(["worktree", "add", "--detach", temporaryWorktree, "HEAD"], context.executionPath);
  } catch (error) {
    await rm(temporaryParent, { force: true, recursive: true });
    throw error;
  }
  temporaryManagedIgnoreWorktrees.set(temporaryWorktree, context.executionPath);
  return temporaryWorktree;
}

const releaseManagedIgnoreWorkspaceRoot = async (workspaceRoot: string): Promise<boolean> => {
  const bareRepository = temporaryManagedIgnoreWorktrees.get(workspaceRoot);
  if (!bareRepository) {
    return false;
  }
  temporaryManagedIgnoreWorktrees.delete(workspaceRoot);
  try {
    await exec(["worktree", "remove", "--force", workspaceRoot], bareRepository);
  } finally {
    await rm(dirname(workspaceRoot), { force: true, recursive: true });
  }
  return true;
};

const isGitRepository = async (path: string): Promise<boolean> => {
  try {
    await exec(["rev-parse", "--git-dir"], path);
    return true;
  } catch {
    return false;
  }
};

const printHookResults = (hookOutcomes: HookOutcomeRecord[]): void => {
  if (hookOutcomes.length === ZERO) {
    return;
  }

  info("Hook results:");
  for (const outcome of hookOutcomes) {
    let reason = "";
    if (outcome.reasonCode !== "none") {
      reason = ` (${outcome.reasonCode})`;
    }
    console.log(
      `  - ${outcome.repositoryId}: ${outcome.hookName} -> ${outcome.hookStatus}${reason}`,
    );
  }
};

const printNextSteps = (nextSteps: string[]): void => {
  if (nextSteps.length === ZERO) {
    return;
  }

  info("Next steps:");
  for (const step of nextSteps) {
    console.log(`  - ${step}`);
  }
};

const resolveEnabledFlag = (options: { positive?: boolean; negative?: boolean }): boolean => {
  if (options.positive === true) {
    return true;
  }

  if (options.positive === false) {
    return false;
  }

  if (options.negative === true) {
    return false;
  }

  if (options.negative === false) {
    return true;
  }

  return true;
};

export function resolveCreateDefaults(
  options: CreateCommandOptions,
  workspaceConfig: Config,
): ResolvedCreateDefaults {
  const createDefaults = resolveConfiguredCreateDefaults(options, workspaceConfig);

  const switchResolution = resolveDefaultWithPrecedence<boolean>({
    builtInValue: false,
    configValue: createDefaults?.switch,
    explicitValue: true,
    hasExplicitValue: options.switch === true,
    optOut: options.switch === false,
  });

  const launchResolution = resolveDefaultWithPrecedence<boolean>({
    builtInValue: false,
    configValue: createDefaults?.launch,
    explicitValue: true,
    hasExplicitValue: options.launch === true || options.sesh === true,
    optOut: options.launch === false,
  });

  const launchModeResolution = resolveDefaultWithPrecedence<LaunchMode>({
    builtInValue: AUTO_LAUNCH_MODE,
    configValue: createDefaults?.launchMode,
    explicitValue: SESH_LAUNCH_MODE,
    hasExplicitValue: options.sesh === true,
    optOut: options.launch === false,
  });

  const shouldLaunch = launchResolution.value;
  const shouldSwitch = shouldLaunch || switchResolution.value;

  return {
    launchMode: shouldLaunch ? launchModeResolution.value : AUTO_LAUNCH_MODE,
    shouldLaunch,
    shouldSwitch,
  };
}

const selectPrimaryCreateResult = (
  repositoryResults: RepositoryResult[],
  context: CreateInvocationContext,
): RepositoryResult | null => {
  const successfulResults = repositoryResults.filter(
    (result) => result.status === "success" && result.worktreePath,
  );

  if (successfulResults.length === ZERO) {
    return null;
  }

  const executionRepoName = basename(resolve(context.executionPath));
  const primary = successfulResults.find((result) => result.repository.name === executionRepoName);
  return primary ?? successfulResults[0] ?? null;
};

interface DirtyGuidanceContext {
  guidance: ReturnType<typeof buildDirtyGuidance>;
  source: WorkspaceSelection;
  target: WorkspaceSelection;
}

const resolvePostCreateDirtyGuidance = async (
  context: CreateInvocationContext,
  config: Config,
  branchName: string,
): Promise<DirtyGuidanceContext | null> => {
  const repositories = buildRepositoryTargets(context.workspaceRoot, config.repos);
  const source = await findWorkspaceByPath(repositories, context.executionPath);
  if (!source || source.dirtyRepositories.length === ZERO) {
    return null;
  }

  try {
    const target = await resolveWorkspaceReference(repositories, branchName);
    return { guidance: buildDirtyGuidance(source, target), source, target };
  } catch {
    return null;
  }
};

const applyPostCreateDefaults = async ({
  context,
  defaults,
  deps,
  summary,
}: ApplyPostCreateDefaultsOptions): Promise<void> => {
  if (!defaults.shouldSwitch) {
    return;
  }

  const primaryResult = selectPrimaryCreateResult(summary.repositoryResults, context);
  if (!primaryResult || !primaryResult.worktreePath) {
    warn(
      "Could not resolve the primary worktree for post-create defaults. Skipping switch/launch defaults.",
    );
    return;
  }

  info(`Default switch target: ${primaryResult.worktreePath}`);

  if (!defaults.shouldLaunch) {
    info("Launch skipped (resolved defaults disabled launch for this invocation).");
    return;
  }

  const launchCandidate = deps.launchSwitchTarget ?? launchSwitchTarget;
  const launchResult = await launchCandidate(
    {
      branchName: primaryResult.branchName,
      repoName: primaryResult.repository.name,
      worktreePath: primaryResult.worktreePath,
    },
    {
      sesh: defaults.launchMode === SESH_LAUNCH_MODE,
    },
    {
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      runProcess: deps.runProcess,
    },
  );

  success(
    `Opened ${launchResult.mode} context for ${primaryResult.repository.name} at ${primaryResult.worktreePath}`,
  );
};

export function createCommand(): Command {
  const editorHostOption = new Option(
    "--editor-host <host>",
    "Internal editor host context for create default resolution",
  )
    .choices([...CREATE_DEFAULT_EDITOR_HOSTS])
    .hideHelp();

  return new Command("create")
    .description("Create coordinated worktrees across multiple repositories")
    .argument("<branch>", "Branch name to create across repositories")
    .option("--only <repos>", "Only create in specified repositories (comma-separated)")
    .option("--group <groups>", "Only create in repositories in requested groups (comma-separated)")
    .option("-i, --interactive", "Interactively select repositories")
    .option("--switch", "Switch to the created parent worktree after create")
    .option("--no-switch", "Disable configured create switch defaults for this invocation")
    .option("--launch", "Launch terminal/editor context after create")
    .option("--no-launch", "Disable configured create launch defaults for this invocation")
    .option("--sesh", "Launch using sesh mode (implies --launch)")
    .option(
      "--conflict <strategy>",
      "Pre-select conflict resolution strategy (ABORT, REUSE_EXISTING)",
    )
    .option("--no-hooks", "Disable hook execution")
    .option("--no-progress", "Hide progress indicators")
    .option("--dry-run", "Show what would be done without making changes")
    .option(
      "--move-changes",
      "Move compatible uncommitted changes from the current workspace after create",
    )
    .option("--json", "Return structured JSON output for non-interactive create operations")
    .addOption(editorHostOption)
    .addHelpText(
      "after",
      `
Examples:
  $ arashi create feature-branch
  $ arashi create feature-branch --group docs
  $ arashi create feature-branch --only repo1,repo2
  $ arashi create feature-branch --conflict REUSE_EXISTING
  $ arashi create feature-branch --dry-run
  $ arashi create feature-branch --no-launch --no-switch --json
`,
    )
    .action(async (branchName: string, options: CreateCommandOptions) => {
      if (
        options.json &&
        (options.interactive || options.launch || options.sesh || options.switch)
      ) {
        writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
        process.exit(ERROR_EXIT_CODE);
      }

      try {
        const exitCode = await executeCreate(branchName, options);
        process.exit(exitCode);
      } catch (createError) {
        if (options.json) {
          writeCreateJsonError(createError);
          if (createError instanceof EmptyRepositoryFiltersError) {
            process.exit(CANCELLED_EXIT_CODE);
          }
          if (
            createError instanceof ConflictAbortedError ||
            createError instanceof UserAbortedError
          ) {
            process.exit(CANCELLED_EXIT_CODE);
          }
          process.exit(ERROR_EXIT_CODE);
        }

        if (createError instanceof EmptyRepositoryFiltersError) {
          error(createError.message);
          process.exit(CANCELLED_EXIT_CODE);
        } else if (createError instanceof InvalidBranchNameError) {
          error(`Invalid branch name: ${createError.branchName}`);
          error(createError.reason);
          process.exit(ERROR_EXIT_CODE);
        } else if (createError instanceof RepositoryValidationError) {
          error(`Repository validation error: ${createError.message}`);
          process.exit(ERROR_EXIT_CODE);
        } else if (createError instanceof CreateSetupError) {
          error(createError.message);
          process.exit(ERROR_EXIT_CODE);
        } else if (createError instanceof ConflictAbortedError) {
          warn("Create aborted due to branch/worktree conflicts.");
          for (const conflict of createError.conflicts) {
            const scope = describeConflictScope(conflict.existsLocally, conflict.existsRemotely);
            info(
              `Conflict: ${conflict.repository.name} already has branch "${conflict.branchName}" (${scope}).`,
            );
          }
          info(
            "Next step: retry with --conflict REUSE_EXISTING or choose a different branch name.",
          );
          process.exit(CANCELLED_EXIT_CODE);
        } else if (createError instanceof UserAbortedError) {
          warn("Operation cancelled by user");
          process.exit(CANCELLED_EXIT_CODE);
        } else if (createError instanceof Error) {
          error(`Unexpected error: ${createError.message}`);
          console.error(createError.stack);
          process.exit(ERROR_EXIT_CODE);
        } else {
          error("An unknown error occurred");
          process.exit(ERROR_EXIT_CODE);
        }
      }
    });
}

export async function executeCreate(
  branchName: string,
  options: CreateCommandOptions,
  deps: CreateCommandDependencies = {},
): Promise<number> {
  const emptyFilters = findEmptyRepositoryFilters(options.only, options.group);
  if (emptyFilters.length > ZERO) {
    throw new EmptyRepositoryFiltersError(emptyFilters);
  }

  const resolveInvocationContext =
    deps.resolveCreateInvocationContext ?? resolveCreateInvocationContext;
  const resolveIgnoreWorkspaceRoot =
    deps.resolveManagedIgnoreWorkspaceRoot ?? resolveManagedIgnoreWorkspaceRoot;
  const loadWorkspaceConfig = deps.loadConfigWithFallback ?? loadConfigWithFallback;
  const discoverWorkspaceRepositories = deps.discoverRepositories ?? discoverRepositories;
  const detectGitRepository = deps.isGitRepository ?? isGitRepository;
  const resolveCurrentBranch =
    deps.resolveCurrentBranch ??
    (async (path: string): Promise<string> => {
      const result = await exec(["symbolic-ref", "--short", "HEAD"], path);
      return result.stdout.trim();
    });
  const filterRepositories = deps.applyRepositoryFilter ?? applyRepositoryFilter;
  const runCreate = deps.createCoordinatedWorktrees ?? createCoordinatedWorktrees;
  const reconcileIgnore = deps.reconcileManagedIgnore ?? reconcileManagedIgnore;
  const restoreIgnore = deps.restoreManagedIgnore ?? restoreManagedIgnore;
  const pathExists = deps.pathExists ?? existsSync;

  // 1. Resolve invocation context and load configuration
  const context = await resolveInvocationContext();

  const loadedConfig = await loadWorkspaceConfig(context.workspaceRoot, {
    bareRepoPath: context.repositoryType === "bare" ? context.executionPath : undefined,
  }).catch((loadError): never => {
    if (loadError instanceof ConfigNotFoundError) {
      throw new CreateSetupError(
        'Workspace configuration not found. Run "arashi init" from a checked-out worktree and retry.',
      );
    }

    throw loadError;
  });

  const arashiConfig = loadedConfig.config;

  // 2. Discover repositories (child repos in reposDir)
  // Convert reposDir to absolute path since it may be relative (e.g., "./repos")
  const currentDir = context.executionPath;
  const createDefaults = resolveCreateDefaults(options, arashiConfig);
  const reposDirAbsolute = resolve(currentDir, arashiConfig.reposDir);
  const discoveryResult = await discoverWorkspaceRepositories(reposDirAbsolute);

  // 3. Include the meta-repo itself in the repository list
  // The meta-repo needs to have its worktree created first, then child repos are nested inside it
  const allRepositories = [...discoveryResult.repositories];
  let parentRepository: (typeof allRepositories)[number] | null = null;

  // Check if current directory is a git repository (meta-repo)
  if (await detectGitRepository(currentDir)) {
    // Meta-repo detected - add it at the beginning so it's processed first

    // Detect default branch
    let defaultBranch = "main";
    try {
      defaultBranch = await resolveCurrentBranch(currentDir);
    } catch {
      // Fallback to 'main' if detection fails
    }

    const metaRepo = {
      defaultBranch,
      groups: arashiConfig.repos[basename(currentDir)]?.groups,
      hasSetupScript: false,
      name: basename(currentDir),
      path: currentDir,
    };

    parentRepository = metaRepo;
    allRepositories.unshift(metaRepo);
  }

  for (const repository of allRepositories) {
    const configuredRepo = arashiConfig.repos[repository.name];
    if (configuredRepo?.groups) {
      repository.groups = configuredRepo.groups;
    }
  }

  if (allRepositories.length === 0) {
    error("No repositories found in configuration");
    info('Run "arashi add <path>" to add repositories');
    process.exit(ERROR_EXIT_CODE);
  }

  if (
    context.repositoryType === "bare" &&
    loadedConfig.source === "repository-content" &&
    !options.json
  ) {
    info("Loaded workspace configuration from repository content");
  }

  let repositoryLabel = "repositories";
  if (allRepositories.length === ONE) {
    repositoryLabel = "repository";
  }
  if (!options.json) {
    info(`Found ${allRepositories.length} ${repositoryLabel}`);
  }

  // 4. Apply repository filters. Group filters are shared with other repo-selecting commands;
  // Interactive mode then prompts from the narrowed repository set.
  const groupFilterResult = filterWorkspaceRepositories(
    allRepositories,
    options.only,
    options.group,
  );
  if (groupFilterResult.emptyFilters.length > ZERO) {
    throw new EmptyRepositoryFiltersError(groupFilterResult.emptyFilters);
  }
  if (groupFilterResult.missing.length > ZERO) {
    throw new RepositoryValidationError(
      `Unknown repositories in --only filter: ${groupFilterResult.missing.join(", ")}`,
      groupFilterResult.missing[ZERO] ?? "",
    );
  }
  if (groupFilterResult.unknownGroups.length > ZERO) {
    throw new RepositoryValidationError(
      `Unknown repository groups in --group filter: ${groupFilterResult.unknownGroups.join(", ")}`,
      groupFilterResult.unknownGroups[ZERO] ?? "",
    );
  }
  if (groupFilterResult.emptyIntersection) {
    throw new RepositoryValidationError(
      "No repositories matched the combined --only/--group filters",
      "",
    );
  }

  const filteredRepositories = groupFilterResult.selected;
  let filterMode: RepositoryFilter["mode"] = "all";
  if (options.interactive) {
    filterMode = "interactive";
  }

  const filter: RepositoryFilter = {
    explicitList: [],
    mode: filterMode,
    requiredRepositories: options.interactive && parentRepository ? [parentRepository] : undefined,
    selectedRepositories: null,
  };

  const selectedRepos = await filterRepositories(filter, filteredRepositories);

  if (selectedRepos.length === ZERO) {
    if (options.json) {
      writeJsonEnvelope(
        createJsonSuccessEnvelope("create", {
          branchName,
          dryRun: options.dryRun === true,
          failureCount: ZERO,
          repositories: [],
          skippedCount: ZERO,
          successCount: ZERO,
          totalRepositories: ZERO,
        }),
      );
      return ZERO;
    }
    warn("No repositories selected for worktree creation");
    return ZERO;
  }

  const actionLabel = options.dryRun ? "Planning" : "Creating";
  let selectedRepositoryLabel = "repositories";
  if (selectedRepos.length === ONE) {
    selectedRepositoryLabel = "repository";
  }
  if (!options.json) {
    info(`${actionLabel} worktrees in ${selectedRepos.length} ${selectedRepositoryLabel}...`);
  }

  const hooksEnabled = resolveEnabledFlag({
    negative: options.noHooks,
    positive: options.hooks,
  });
  const progressEnabled = resolveEnabledFlag({
    negative: options.noProgress,
    positive: options.progress,
  });

  // 5. Build options for worktree orchestration
  const worktreeOptions: WorktreeOperationOptions = {
    conflictResolution: options.conflict || null,
    dryRun: options.dryRun || false,
    executeHooks: hooksEnabled,
    hookTimeout: arashiConfig.hooks?.timeout,
    interactive: options.interactive || false,
    resolvedConfig: arashiConfig,
    showProgress: options.json ? false : progressEnabled,
    workspaceRoot: context.workspaceRoot,
  };

  const managedIgnoreWorkspaceRoot = await resolveIgnoreWorkspaceRoot(context);
  const temporaryIgnoreWorkspace = temporaryManagedIgnoreWorktrees.has(managedIgnoreWorkspaceRoot);
  let managedIgnore: ManagedIgnoreReconciliation;
  try {
    managedIgnore = await reconcileIgnore({
      dryRun: options.dryRun,
      reposDir: arashiConfig.reposDir,
      workspaceRoot: managedIgnoreWorkspaceRoot,
      worktreesDir: arashiConfig.worktreesDir ?? DEFAULT_WORKTREES_DIR,
    });
    if (
      temporaryIgnoreWorkspace &&
      managedIgnore.targetType === "tracked" &&
      managedIgnore.attempted
    ) {
      if (managedIgnore.changed) {
        await restoreIgnore(managedIgnore);
      }
      throw new CreateSetupError(
        "Tracked managed-ignore changes from a bare repository require an existing linked worktree. Run arashi init from a checked-out worktree first.",
      );
    }
  } finally {
    await releaseManagedIgnoreWorkspaceRoot(managedIgnoreWorkspaceRoot);
  }
  if (!options.json) {
    for (const warning of managedIgnore.warnings) {
      warn(warning);
    }
  }

  // 6. Execute coordinated worktree creation
  const summary = await runCreate(branchName, selectedRepos, worktreeOptions);
  const residualWorktrees = summary.repositoryResults.some(
    (result) => Boolean(result.worktreePath) && pathExists(result.worktreePath as string),
  );
  if (summary.rolledBack && !residualWorktrees && managedIgnore.changed) {
    await restoreIgnore(managedIgnore);
  }
  const dirtyGuidanceContext = options.dryRun
    ? null
    : await resolvePostCreateDirtyGuidance(context, arashiConfig, branchName);
  const moveSummary =
    options.moveChanges && dirtyGuidanceContext
      ? await executeMovePlan(
          buildMovePlan(dirtyGuidanceContext.source, dirtyGuidanceContext.target),
        )
      : null;
  const dirtyWorkspaceGuidance = moveSummary ? null : (dirtyGuidanceContext?.guidance ?? null);

  // 7. Display results
  if (options.json) {
    writeJsonEnvelope(
      createJsonSuccessEnvelope(
        "create",
        createSummaryJsonData({
          branchName,
          dirtyWorkspaceGuidance,
          managedIgnore,
          moveSummary,
          summary,
        }),
      ),
    );
    if (summary.rolledBack || summary.failureCount > ZERO) {
      return ERROR_EXIT_CODE;
    }
    return ZERO;
  }

  console.log("");
  if (options.dryRun) {
    if (!summary.dryRunOutcome) {
      error("Dry-run did not produce a plan");
      process.exit(ERROR_EXIT_CODE);
    }

    const { plannedWorktrees, conflicts, overallStatus, summaryCounts } = summary.dryRunOutcome;

    info("Dry-run plan:");
    for (const planned of plannedWorktrees) {
      const pathLabel = planned.worktreePath ?? "(unresolved)";
      const statusLabel = planned.planStatus === "blocked" ? "BLOCKED" : "OK";
      console.log(
        `  • ${planned.repositoryName}: ${planned.branchName} -> ${pathLabel} [${statusLabel}]`,
      );
    }

    if (conflicts.length > 0) {
      console.log("");
      warn("Conflicts:");
      for (const conflict of conflicts) {
        const blockingLabel = conflict.blocking ? "blocking" : "non-blocking";
        console.log(`  • ${conflict.repositoryName}: ${conflict.message} (${blockingLabel})`);
      }
    }

    console.log("");
    const statusLabel = overallStatus === "actionable" ? "ACTIONABLE" : "BLOCKED";
    const summaryLabel = `${summaryCounts.plannedTotal} planned, ${summaryCounts.conflictTotal} conflicts`;
    if (overallStatus === "actionable") {
      success(`Plan status: ${statusLabel} (${summaryLabel})`);
      info(`Total duration: ${formatDurationSeconds(summary.totalDuration)}`);
      process.exit(ZERO);
    }

    error(`Plan status: ${statusLabel} (${summaryLabel})`);
    info(`Total duration: ${formatDurationSeconds(summary.totalDuration)}`);
    process.exit(ERROR_EXIT_CODE);
  }

  if (summary.rolledBack) {
    if (summary.hookOutcomes.length > 0) {
      console.log("");
      printHookResults(summary.hookOutcomes);
    }

    const conflictError = summary.errorSummary?.toLowerCase().includes("branch conflict");
    if (conflictError) {
      error("Create aborted due to branch/worktree conflicts.");
      info("Next step: retry with --conflict REUSE_EXISTING or choose a different branch name.");
      process.exit(CANCELLED_EXIT_CODE);
    }

    error("Operation failed and was rolled back");
    error(summary.errorSummary || "Unknown error");
    if (summary.nextSteps.length > 0) {
      console.log("");
      printNextSteps(summary.nextSteps);
    }
    process.exit(ERROR_EXIT_CODE);
  }

  success(`Successfully created worktrees in ${summary.successCount} repositories`);

  if (summary.hookOutcomes.length > 0) {
    console.log("");
    printHookResults(summary.hookOutcomes);
  }

  // Display worktree paths
  console.log("");
  info("Worktree locations:");
  for (const result of summary.repositoryResults) {
    if (result.status === "success" && result.worktreePath) {
      console.log(`  • ${result.repository.name}: ${result.worktreePath}`);
    }
  }

  // Display warnings if any
  const warnings = summary.repositoryResults.flatMap((result) => result.warnings);
  if (warnings.length > 0) {
    console.log("");
    warn("Warnings:");
    for (const warning of warnings) {
      console.log(`  • ${warning}`);
    }
  }

  if (moveSummary) {
    console.log("");
    if (moveSummary.failedCount > ZERO) {
      warn(
        `Moved changes in ${moveSummary.movedCount} repositories with ${moveSummary.failedCount} failures`,
      );
    } else {
      success(`Moved changes in ${moveSummary.movedCount} repositories`);
    }
    for (const result of moveSummary.results) {
      console.log(`  • ${result.repositoryName}: ${result.message}`);
      if (result.recoveryCommand) {
        console.log(`    recovery: ${result.recoveryCommand}`);
      }
    }
  }

  if (dirtyWorkspaceGuidance) {
    console.log("");
    warn("Uncommitted changes remain in the source workspace.");
    info("Move them when ready:");
    console.log(`  ${dirtyWorkspaceGuidance.command}`);
    for (const repository of dirtyWorkspaceGuidance.changedRepositories) {
      console.log(`  • ${repository.repositoryName}: ${repository.summary}`);
    }
  }

  await applyPostCreateDefaults({ context, defaults: createDefaults, deps, summary });

  console.log("");
  info(`Total duration: ${formatDurationSeconds(summary.totalDuration)}`);
  return ZERO;
}
