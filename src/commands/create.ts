/**
 * CLI Command: Create Worktree
 *
 * Creates coordinated worktrees across multiple repositories with a single command.
 * Supports repository filtering, conflict resolution, progress tracking, and automatic rollback.
 */

import { Command } from "commander";
import * as config from "../lib/config.ts";
import * as logger from "../lib/logger.ts";
import { discoverRepositories } from "../core/repository.ts";
import * as git from "../lib/git.ts";
import { resolve, basename } from "path";
import {
  createCoordinatedWorktrees,
  applyRepositoryFilter,
  type OperationSummary,
  type RepositoryResult,
  type RepositoryFilter,
  type HookOutcomeRecord,
  type WorktreeOperationOptions,
  type ConflictResolutionStrategy,
  InvalidBranchNameError,
  RepositoryValidationError,
  ConflictAbortedError,
  UserAbortedError,
} from "../core/worktree.ts";
import type { SwitchCandidate } from "../core/switch.ts";
import {
  launchSwitchTarget,
  type LaunchSwitchResult,
  type SwitchProcessRunner,
} from "../lib/switch-launcher.ts";
import { resolveDefaultWithPrecedence } from "../lib/default-resolution.ts";

interface CreateCommandOptions {
  /** Only create worktrees in specified repositories (comma-separated) */
  only?: string;

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
  launch?: boolean;

  /** Force sesh launch mode when launching */
  sesh?: boolean;

  /** Dry run - show what would be done without making changes */
  dryRun?: boolean;
}

export interface ResolvedCreateDefaults {
  shouldSwitch: boolean;
  shouldLaunch: boolean;
  launchMode: config.LaunchMode;
}

export interface CreateCommandDependencies {
  resolveCreateInvocationContext?: (invocationPath?: string) => Promise<CreateInvocationContext>;
  loadConfigWithFallback?: typeof config.loadConfigWithFallback;
  discoverRepositories?: typeof discoverRepositories;
  isGitRepository?: (path: string) => Promise<boolean>;
  resolveCurrentBranch?: (path: string) => Promise<string>;
  applyRepositoryFilter?: typeof applyRepositoryFilter;
  createCoordinatedWorktrees?: typeof createCoordinatedWorktrees;
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
  const bareProbe = await git.exec(["rev-parse", "--is-bare-repository"], absoluteInvocationPath);
  const isBare = bareProbe.stdout.trim() === "true";

  if (isBare) {
    return {
      invocationPath: absoluteInvocationPath,
      workspaceRoot: absoluteInvocationPath,
      executionPath: absoluteInvocationPath,
      repositoryType: "bare",
    };
  }

  const workspaceRoot = await config.findWorkspaceRoot(absoluteInvocationPath);
  return {
    invocationPath: absoluteInvocationPath,
    workspaceRoot,
    executionPath: workspaceRoot,
    repositoryType: "non-bare",
  };
}

async function isGitRepository(path: string): Promise<boolean> {
  try {
    await git.exec(["rev-parse", "--git-dir"], path);
    return true;
  } catch {
    return false;
  }
}

function printHookResults(hookOutcomes: HookOutcomeRecord[]): void {
  if (hookOutcomes.length === 0) {
    return;
  }

  logger.info("Hook results:");
  for (const outcome of hookOutcomes) {
    const reason = outcome.reasonCode === "none" ? "" : ` (${outcome.reasonCode})`;
    console.log(
      `  - ${outcome.repositoryId}: ${outcome.hookName} -> ${outcome.hookStatus}${reason}`,
    );
  }
}

function printNextSteps(nextSteps: string[]): void {
  if (nextSteps.length === 0) {
    return;
  }

  logger.info("Next steps:");
  for (const step of nextSteps) {
    console.log(`  - ${step}`);
  }
}

function resolveEnabledFlag(options: { positive?: boolean; negative?: boolean }): boolean {
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
}

export function resolveCreateDefaults(
  options: CreateCommandOptions,
  workspaceConfig: config.Config,
): ResolvedCreateDefaults {
  const createDefaults = workspaceConfig.defaults?.create;

  const switchResolution = resolveDefaultWithPrecedence<boolean>({
    explicitValue: true,
    hasExplicitValue: options.switch === true,
    optOut: options.switch === false,
    configValue: createDefaults?.switch,
    builtInValue: false,
  });

  const launchResolution = resolveDefaultWithPrecedence<boolean>({
    explicitValue: true,
    hasExplicitValue: options.launch === true || options.sesh === true,
    optOut: options.launch === false,
    configValue: createDefaults?.launch,
    builtInValue: false,
  });

  const launchModeResolution = resolveDefaultWithPrecedence<config.LaunchMode>({
    explicitValue: "sesh",
    hasExplicitValue: options.sesh === true,
    optOut: options.launch === false,
    configValue: createDefaults?.launchMode,
    builtInValue: "auto",
  });

  const shouldLaunch = launchResolution.value;
  const shouldSwitch = shouldLaunch || switchResolution.value;

  return {
    shouldSwitch,
    shouldLaunch,
    launchMode: shouldLaunch ? launchModeResolution.value : "auto",
  };
}

function selectPrimaryCreateResult(
  repositoryResults: RepositoryResult[],
  context: CreateInvocationContext,
): RepositoryResult | null {
  const successfulResults = repositoryResults.filter(
    (result) => result.status === "success" && result.worktreePath,
  );

  if (successfulResults.length === 0) {
    return null;
  }

  const executionRepoName = basename(resolve(context.executionPath));
  const primary = successfulResults.find((result) => result.repository.name === executionRepoName);
  return primary ?? successfulResults[0] ?? null;
}

async function applyPostCreateDefaults(
  defaults: ResolvedCreateDefaults,
  summary: OperationSummary,
  context: CreateInvocationContext,
  deps: CreateCommandDependencies,
): Promise<void> {
  if (!defaults.shouldSwitch) {
    return;
  }

  const primaryResult = selectPrimaryCreateResult(summary.repositoryResults, context);
  if (!primaryResult || !primaryResult.worktreePath) {
    logger.warn(
      "Could not resolve the primary worktree for post-create defaults. Skipping switch/launch defaults.",
    );
    return;
  }

  logger.info(`Default switch target: ${primaryResult.worktreePath}`);

  if (!defaults.shouldLaunch) {
    logger.info("Launch skipped (resolved defaults disabled launch for this invocation).");
    return;
  }

  const launchCandidate = deps.launchSwitchTarget ?? launchSwitchTarget;
  const launchResult = await launchCandidate(
    {
      repoName: primaryResult.repository.name,
      branchName: primaryResult.branchName,
      worktreePath: primaryResult.worktreePath,
    },
    {
      sesh: defaults.launchMode === "sesh",
    },
    {
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      runProcess: deps.runProcess,
    },
  );

  logger.success(
    `Opened ${launchResult.mode} context for ${primaryResult.repository.name} at ${primaryResult.worktreePath}`,
  );
}

export function createCommand(): Command {
  return new Command("create")
    .description("Create coordinated worktrees across multiple repositories")
    .argument("<branch>", "Branch name to create across repositories")
    .option("--only <repos>", "Only create in specified repositories (comma-separated)")
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
    .addHelpText(
      "after",
      `
Examples:
  $ arashi create feature-auth
  $ arashi create feature-auth --switch
  $ arashi create feature-auth --launch
  $ arashi create feature-auth --sesh
  $ arashi create feature-auth --no-switch --no-launch
`,
    )
    .action(async (branchName: string, options: CreateCommandOptions) => {
      try {
        await executeCreate(branchName, options);
      } catch (error) {
        if (error instanceof InvalidBranchNameError) {
          logger.error(`Invalid branch name: ${error.branchName}`);
          logger.error(error.reason);
          process.exit(1);
        } else if (error instanceof RepositoryValidationError) {
          logger.error(`Repository validation error: ${error.message}`);
          process.exit(1);
        } else if (error instanceof CreateSetupError) {
          logger.error(error.message);
          process.exit(1);
        } else if (error instanceof ConflictAbortedError) {
          logger.warn("Create aborted due to branch/worktree conflicts.");
          for (const conflict of error.conflicts) {
            const scope =
              conflict.existsLocally && conflict.existsRemotely
                ? "local and remote"
                : conflict.existsLocally
                  ? "local"
                  : "remote";
            logger.info(
              `Conflict: ${conflict.repository.name} already has branch "${conflict.branchName}" (${scope}).`,
            );
          }
          logger.info(
            "Next step: retry with --conflict REUSE_EXISTING or choose a different branch name.",
          );
          process.exit(2);
        } else if (error instanceof UserAbortedError) {
          logger.warn("Operation cancelled by user");
          process.exit(2);
        } else if (error instanceof Error) {
          logger.error(`Unexpected error: ${error.message}`);
          console.error(error.stack);
          process.exit(1);
        } else {
          logger.error("An unknown error occurred");
          process.exit(1);
        }
      }
    });
}

export async function executeCreate(
  branchName: string,
  options: CreateCommandOptions,
  deps: CreateCommandDependencies = {},
): Promise<void> {
  const resolveInvocationContext =
    deps.resolveCreateInvocationContext ?? resolveCreateInvocationContext;
  const loadConfigWithFallback = deps.loadConfigWithFallback ?? config.loadConfigWithFallback;
  const discoverWorkspaceRepositories = deps.discoverRepositories ?? discoverRepositories;
  const detectGitRepository = deps.isGitRepository ?? isGitRepository;
  const resolveCurrentBranch =
    deps.resolveCurrentBranch ??
    (async (path: string): Promise<string> => {
      const result = await git.exec(["symbolic-ref", "--short", "HEAD"], path);
      return result.stdout.trim();
    });
  const filterRepositories = deps.applyRepositoryFilter ?? applyRepositoryFilter;
  const runCreate = deps.createCoordinatedWorktrees ?? createCoordinatedWorktrees;

  // 1. Resolve invocation context and load configuration
  const context = await resolveInvocationContext();

  let loadedConfig: config.LoadedConfig;
  try {
    loadedConfig = await loadConfigWithFallback(context.workspaceRoot, {
      bareRepoPath: context.repositoryType === "bare" ? context.executionPath : undefined,
    });
  } catch (error) {
    if (error instanceof config.ConfigNotFoundError) {
      throw new CreateSetupError(
        'Workspace configuration not found. Run "arashi init" from a checked-out worktree and retry.',
      );
    }
    throw error;
  }

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
      name: basename(currentDir),
      path: currentDir,
      defaultBranch,
      hasSetupScript: false,
    };

    allRepositories.unshift(metaRepo);
  }

  if (allRepositories.length === 0) {
    logger.error("No repositories found in configuration");
    logger.info('Run "arashi add <path>" to add repositories');
    process.exit(1);
  }

  if (context.repositoryType === "bare" && loadedConfig.source === "repository-content") {
    logger.info("Loaded workspace configuration from repository content");
  }

  logger.info(
    `Found ${allRepositories.length} ${allRepositories.length === 1 ? "repository" : "repositories"}`,
  );

  // 4. Apply repository filter
  const filter: RepositoryFilter = {
    mode: options.interactive ? "interactive" : options.only ? "explicit" : "all",
    explicitList: options.only ? options.only.split(",").map((s) => s.trim()) : [],
    selectedRepositories: null,
  };

  const selectedRepos = await filterRepositories(filter, allRepositories);

  if (selectedRepos.length === 0) {
    logger.warn("No repositories selected for worktree creation");
    process.exit(0);
  }

  const actionLabel = options.dryRun ? "Planning" : "Creating";
  logger.info(
    `${actionLabel} worktrees in ${selectedRepos.length} ${selectedRepos.length === 1 ? "repository" : "repositories"}...`,
  );

  const hooksEnabled = resolveEnabledFlag({
    positive: options.hooks,
    negative: options.noHooks,
  });
  const progressEnabled = resolveEnabledFlag({
    positive: options.progress,
    negative: options.noProgress,
  });

  // 5. Build options for worktree orchestration
  const worktreeOptions: WorktreeOperationOptions = {
    executeHooks: hooksEnabled,
    hookTimeout: arashiConfig.hooks?.timeout,
    showProgress: progressEnabled,
    interactive: options.interactive || false,
    conflictResolution: options.conflict || null,
    dryRun: options.dryRun || false,
    workspaceRoot: context.workspaceRoot,
    resolvedConfig: arashiConfig,
  };

  // 6. Execute coordinated worktree creation
  const summary = await runCreate(branchName, selectedRepos, worktreeOptions);

  // 7. Display results
  console.log("");
  if (options.dryRun) {
    if (!summary.dryRunOutcome) {
      logger.error("Dry-run did not produce a plan");
      process.exit(1);
    }

    const { plannedWorktrees, conflicts, overallStatus, summaryCounts } = summary.dryRunOutcome;

    logger.info("Dry-run plan:");
    for (const planned of plannedWorktrees) {
      const pathLabel = planned.worktreePath ?? "(unresolved)";
      const statusLabel = planned.planStatus === "blocked" ? "BLOCKED" : "OK";
      console.log(
        `  • ${planned.repositoryName}: ${planned.branchName} -> ${pathLabel} [${statusLabel}]`,
      );
    }

    if (conflicts.length > 0) {
      console.log("");
      logger.warn("Conflicts:");
      for (const conflict of conflicts) {
        const blockingLabel = conflict.blocking ? "blocking" : "non-blocking";
        console.log(`  • ${conflict.repositoryName}: ${conflict.message} (${blockingLabel})`);
      }
    }

    console.log("");
    const statusLabel = overallStatus === "actionable" ? "ACTIONABLE" : "BLOCKED";
    const summaryLabel = `${summaryCounts.plannedTotal} planned, ${summaryCounts.conflictTotal} conflicts`;
    if (overallStatus === "actionable") {
      logger.success(`Plan status: ${statusLabel} (${summaryLabel})`);
      logger.info(`Total duration: ${(summary.totalDuration / 1000).toFixed(2)}s`);
      process.exit(0);
    }

    logger.error(`Plan status: ${statusLabel} (${summaryLabel})`);
    logger.info(`Total duration: ${(summary.totalDuration / 1000).toFixed(2)}s`);
    process.exit(1);
  }

  if (summary.rolledBack) {
    if (summary.hookOutcomes.length > 0) {
      console.log("");
      printHookResults(summary.hookOutcomes);
    }

    const conflictError = summary.errorSummary?.toLowerCase().includes("branch conflict");
    if (conflictError) {
      logger.error("Create aborted due to branch/worktree conflicts.");
      logger.info(
        "Next step: retry with --conflict REUSE_EXISTING or choose a different branch name.",
      );
      process.exit(2);
    }

    logger.error("Operation failed and was rolled back");
    logger.error(summary.errorSummary || "Unknown error");
    if (summary.nextSteps.length > 0) {
      console.log("");
      printNextSteps(summary.nextSteps);
    }
    process.exit(1);
  }

  logger.success(`Successfully created worktrees in ${summary.successCount} repositories`);

  if (summary.hookOutcomes.length > 0) {
    console.log("");
    printHookResults(summary.hookOutcomes);
  }

  // Display worktree paths
  console.log("");
  logger.info("Worktree locations:");
  for (const result of summary.repositoryResults) {
    if (result.status === "success" && result.worktreePath) {
      console.log(`  • ${result.repository.name}: ${result.worktreePath}`);
    }
  }

  // Display warnings if any
  const warnings = summary.repositoryResults.flatMap((r) => r.warnings);
  if (warnings.length > 0) {
    console.log("");
    logger.warn("Warnings:");
    for (const warning of warnings) {
      console.log(`  • ${warning}`);
    }
  }

  await applyPostCreateDefaults(createDefaults, summary, context, deps);

  console.log("");
  logger.info(`Total duration: ${(summary.totalDuration / 1000).toFixed(2)}s`);
}
