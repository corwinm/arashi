/**
 * CLI Command: Create Worktree
 *
 * Creates coordinated worktrees across multiple repositories with a single command.
 * Supports repository filtering, conflict resolution, progress tracking, and automatic rollback.
 */

import { Command, Option } from "commander";
import {
  ConfigNotFoundError,
  ConfigValidationError,
  findWorkspaceRoot,
  loadConfigWithFallback,
  resolveGitPrimarySourceCheckout,
} from "../lib/config.ts";
import {
  ConflictAbortedError,
  InvalidBranchNameError,
  RepositoryValidationError,
  UserAbortedError,
  applyRepositoryFilter,
  calculateWorktreePath,
  calculateWorktreePathPlan,
  createCoordinatedWorktrees,
} from "../core/worktree.ts";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { existsSync, lstatSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { discoverRepositories } from "../core/repository.ts";
import { exec } from "../lib/git.ts";
import {
  collectRepositoryFilterValues,
  EmptyRepositoryFiltersError,
  filterRepositories as filterWorkspaceRepositories,
  findEmptyRepositoryFilters,
} from "../lib/repo-filter.ts";
import {
  isTmuxSession,
  launchSwitchTarget,
  preflightLaunchSwitchTarget,
  type LaunchDisposition,
  type LaunchPreflight,
  type LaunchSwitchDependencies,
  type LaunchSwitchOptions,
} from "../lib/switch-launcher.ts";
import {
  reconcileRepositoryManagedIgnore,
  restoreManagedIgnore,
  type ManagedIgnoreReconciliation,
} from "../lib/managed-ignore.ts";
import { DEFAULT_WORKTREES_DIR } from "../lib/worktree-location.ts";
import { resolveWorkspaceContext, workspaceJsonMetadata } from "../lib/workspace-context.ts";
import { releaseHookInterruptGuards, resolveHookInputMode } from "../lib/hooks.ts";
import { formatCreateHookSummary } from "../lib/create-hook-output.ts";
import {
  createStandaloneWorktree,
  StandaloneDestinationNotIgnoredError,
} from "../lib/standalone.ts";
import {
  CreateBaseResolutionError,
  resolveCreateBasePlan,
  type CreateBaseResolutionPlan,
} from "../lib/create-base.ts";
import { planConfiguredRepositoryMaterialization } from "../lib/materialization-preflight.ts";
import type { RepositoryMaterializationPlan } from "../lib/materialization.ts";
import { isValidRequestedBaseBranch, normalizeLogicalBranchName } from "../lib/git-branch-name.ts";
import {
  BaseBranchPolicyError,
  repositoryBaseOption,
  resolveBaseBranchPolicy,
  type EffectiveBaseBranch,
} from "../lib/base-branch-policy.ts";

type LoadedConfig = Awaited<ReturnType<typeof loadConfigWithFallback>>;
type Config = LoadedConfig["config"];
type MoveSummary = Awaited<ReturnType<typeof executeMovePlan>>;
type WorkspaceSelection = Awaited<ReturnType<typeof resolveWorkspaceReference>>;
type ConflictResolutionStrategy = "ABORT" | "REUSE_EXISTING" | "CREATE_ALTERNATE";
type HookOutcomeRecord = Awaited<
  ReturnType<typeof createCoordinatedWorktrees>
>["hookOutcomes"][number];
type LaunchMode = "auto" | "tmux" | "sesh" | "herdr";
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
  preflight: LaunchPreflight | null;
  summary: OperationSummary;
}

const ZERO = 0;

const destinationEntryExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
};
const ONE = 1;
const TWO = 2;
const ERROR_EXIT_CODE = 1;
const CANCELLED_EXIT_CODE = 2;
const MILLISECONDS_PER_SECOND = 1000;
const AUTO_LAUNCH_MODE: LaunchMode = "auto";
const SESH_LAUNCH_MODE: LaunchMode = "sesh";
const HERDR_LAUNCH_MODE: LaunchMode = "herdr";
const TMUX_LAUNCH_MODE: LaunchMode = "tmux";

const assertValidCreateRepositoryFilters = (
  filterResult: ReturnType<typeof filterWorkspaceRepositories>,
): void => {
  if (filterResult.emptyFilters.length > ZERO) {
    throw new EmptyRepositoryFiltersError(filterResult.emptyFilters);
  }
  if (filterResult.missing.length > ZERO) {
    throw new RepositoryValidationError(
      `Unknown repositories in --only filter: ${filterResult.missing.join(", ")}`,
      filterResult.missing[ZERO] ?? "",
    );
  }
  if (filterResult.unknownGroups.length > ZERO) {
    throw new RepositoryValidationError(
      `Unknown repository groups in --group filter: ${filterResult.unknownGroups.join(", ")}`,
      filterResult.unknownGroups[ZERO] ?? "",
    );
  }
  if (filterResult.emptyIntersection) {
    throw new RepositoryValidationError(
      "No repositories matched the combined --only/--group filters",
      "",
    );
  }
};

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

class WorktreeDestinationCollisionError extends Error {
  readonly code = "WORKTREE_DESTINATION_COLLISION";
  readonly details: {
    conflict: { repositoryName: string; worktreePath: string };
  };

  constructor(repositoryName: string, worktreePath: string) {
    super(`Worktree path already exists: ${worktreePath} (${repositoryName})`);
    this.name = "WorktreeDestinationCollisionError";
    this.details = { conflict: { repositoryName, worktreePath } };
  }
}

const createCommandErrorCode = (createError: unknown): string => {
  if (createError instanceof WorktreeDestinationCollisionError) {
    return createError.code;
  }
  if (createError instanceof BaseBranchPolicyError) {
    return createError.code;
  }
  if (createError instanceof CreateBaseResolutionError) {
    return createError.code;
  }
  if (createError instanceof InvalidBranchNameError) {
    return "INVALID_BRANCH_NAME";
  }
  if (createError instanceof RepositoryValidationError) {
    return "REPOSITORY_VALIDATION_ERROR";
  }
  if (createError instanceof ConfigValidationError) {
    return "CONFIG_VALIDATION_ERROR";
  }
  if (createError instanceof CreateSetupError) {
    return "WORKSPACE_CONFIG_NOT_FOUND";
  }
  if (createError instanceof StandaloneDestinationNotIgnoredError) {
    return createError.code;
  }
  if (createError instanceof SwitchCommandError) {
    return createError.code;
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
  if (createError instanceof WorktreeDestinationCollisionError) {
    return createError.details;
  }
  if (createError instanceof BaseBranchPolicyError) {
    return { issues: createError.issues };
  }
  if (createError instanceof CreateBaseResolutionError) {
    return {
      requestedBranch: createError.requestedBranch,
      source: createError.source,
      repositories: createError.failures,
    };
  }
  if (createError instanceof ConfigValidationError) {
    return createError.context;
  }
  if (createError instanceof StandaloneDestinationNotIgnoredError) {
    return createError.details;
  }
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

const createBaseJsonData = (plan: CreateBaseResolutionPlan, summary: OperationSummary) => ({
  requestedBranch: plan.requestedBranch,
  source: plan.source,
  repositories: (plan.effectiveRepositories ?? plan.repositories).map((resolution) => {
    const targetAction = summary.targetActionByRepositoryPath.get(resolution.repositoryPath);
    if (!targetAction) {
      throw new Error(
        `Repository '${resolution.repositoryName}' is missing a planned target action for '${resolution.repositoryPath}'`,
      );
    }
    return { ...resolution, targetAction };
  }),
});

const printCreateBasePlan = (
  plan: CreateBaseResolutionPlan,
  targetAction: (repositoryPath: string) => "created" | "reused",
): void => {
  info("Resolved repository bases:");
  for (const resolution of plan.effectiveRepositories ?? plan.repositories) {
    const resolved =
      resolution.resolvedRef && resolution.resolvedOid
        ? ` -> ${resolution.resolvedRef} @ ${resolution.resolvedOid}`
        : "";
    console.log(
      `  • ${resolution.repositoryName}: ${resolution.requestedBranch ?? plan.requestedBranch} (${resolution.source ?? plan.source})${resolved} [${targetAction(resolution.repositoryPath)}]`,
    );
  }
};

interface CreateSummaryJsonOptions {
  branchName: string;
  createBasePlan?: CreateBaseResolutionPlan;
  dirtyWorkspaceGuidance?: ReturnType<typeof buildDirtyGuidance>;
  moveSummary?: MoveSummary | null;
  managedIgnore?: ManagedIgnoreReconciliation;
  summary: OperationSummary;
  workspaceMetadata?: Record<string, unknown>;
}

const createSummaryJsonData = async ({
  branchName,
  createBasePlan,
  dirtyWorkspaceGuidance,
  managedIgnore,
  moveSummary,
  summary,
  workspaceMetadata,
}: CreateSummaryJsonOptions) => {
  const repositories = summary.repositoryResults.map((result) => ({
    branchName: result.branchName,
    duration: result.duration,
    error: result.error ? result.error.message : null,
    hookOutcomes: result.hookOutcomes,
    materializationOutcomes: result.materializationOutcomes ?? [],
    repositoryName: result.repository.name,
    repositoryPath: result.repository.path,
    status: result.status,
    warnings: result.warnings,
    worktreePath: result.worktreePath,
  }));
  const hasMaterialization =
    (summary.dryRunOutcome?.materializationPlans?.length ?? ZERO) > ZERO ||
    repositories.some((result) => result.materializationOutcomes.length > ZERO);
  return {
    ...workspaceMetadata,
    branchName,
    ...(createBasePlan ? { base: await createBaseJsonData(createBasePlan, summary) } : {}),
    dirtyWorkspaceGuidance,
    dryRun: summary.isDryRun === true,
    ...(summary.dryRunOutcome
      ? {
          dryRunOutcome: {
            conflicts: summary.dryRunOutcome.conflicts.map((conflict) => ({
              blocking: conflict.blocking,
              conflictType: conflict.conflictType,
              message: conflict.message,
              repositoryName: conflict.repositoryName,
              scope: conflict.scope,
            })),
            ...(hasMaterialization
              ? { materializationPlans: summary.dryRunOutcome.materializationPlans ?? [] }
              : {}),
            plannedWorktrees: summary.dryRunOutcome.plannedWorktrees.map((planned) => ({
              branchName: planned.branchName,
              planStatus: planned.planStatus,
              repositoryName: planned.repositoryName,
              worktreePath: planned.worktreePath,
            })),
            summaryCounts: summary.dryRunOutcome.summaryCounts,
          },
        }
      : {}),
    errorSummary: summary.errorSummary,
    failureCount: summary.failureCount,
    hookOutcomes: summary.hookOutcomes,
    managedIgnore,
    ...(summary.materializationRollback
      ? { materializationRollback: summary.materializationRollback }
      : {}),
    moveSummary,
    nextSteps: summary.nextSteps,
    repositories,
    ...(hasMaterialization ? { repositoryResults: repositories } : {}),
    rolledBack: summary.rolledBack,
    skippedCount: summary.skippedCount,
    successCount: summary.successCount,
    totalDuration: summary.totalDuration,
    totalRepositories: summary.totalRepositories,
  };
};

export interface CreateCommandOptions {
  /** Base branch requested for new target branches */
  base?: string;

  /** Repository-specific base overrides for configured workspaces */
  repoBase?: string[];

  /** Only create worktrees in specified repositories */
  only?: string[];

  /** Only create worktrees in repositories belonging to requested groups */
  group?: string[];

  /** Interactively select repositories */
  interactive?: boolean;

  /** Pre-select conflict resolution strategy */
  conflict?: ConflictResolutionStrategy;

  /** Disable hook execution */
  noHooks?: boolean;
  hooks?: boolean;

  /** Allow lifecycle hooks to inherit eligible terminal input */
  hookInput?: boolean;

  /** Hide progress indicators */
  noProgress?: boolean;
  progress?: boolean;

  /** Auto-switch to newly created parent worktree */
  switch?: boolean;

  /** Launch terminal/editor context for newly created parent worktree */
  json?: boolean;
  launch?: boolean;

  /** Request a tab disposition and imply launch plus switch */
  tab?: boolean;

  /** Force sesh launch mode when launching */
  sesh?: boolean;

  /** Force Herdr launch mode when launching */
  herdr?: boolean;

  /** Force plain tmux launch mode when launching */
  tmux?: boolean;

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
  disposition: LaunchDisposition;
  shouldSwitch: boolean;
  shouldLaunch: boolean;
  launchMode: LaunchMode;
}

class MaterializationPlanBlockedError extends Error {
  readonly code = "MATERIALIZATION_PLAN_BLOCKED";
  readonly details: {
    dryRunOutcome: { materializationPlans: readonly RepositoryMaterializationPlan[] };
  };

  constructor(materializationPlans: readonly RepositoryMaterializationPlan[]) {
    super("Configured worktree materialization preflight is blocked");
    this.name = "MaterializationPlanBlockedError";
    this.details = { dryRunOutcome: { materializationPlans } };
  }
}

const resolveDefaultMaterializationTarget = async (
  repository: Parameters<typeof createCoordinatedWorktrees>[1][number],
): Promise<string> => {
  const branch = repository.defaultBranch.replace(/^origin\//, "");
  for (const candidate of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      return (
        await exec(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], repository.path)
      ).stdout.trim();
    } catch {
      // Continue through the same local-before-origin precedence as create execution.
    }
  }
  const first = (
    await exec(["for-each-ref", "--format=%(objectname)", "refs/heads"], repository.path)
  ).stdout
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  if (!first) throw new Error(`Repository '${repository.name}' has no target Git tree`);
  return first;
};

export async function resolveReusableMaterializationTarget(
  repository: Parameters<typeof createCoordinatedWorktrees>[1][number],
  branchName: string,
  runGit: typeof exec = exec,
): Promise<string | undefined> {
  try {
    return (
      await runGit(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}^{commit}`],
        repository.path,
      )
    ).stdout.trim();
  } catch {
    // Coordinated execution reuses local branches only; remote-only targets are created from base.
    return undefined;
  }
}

export function shouldPreflightReusableMaterializationTarget(input: {
  conflict: NonNullable<WorktreeOperationOptions>["conflictResolution"] | undefined;
  dryRun: boolean;
  stdinIsTTY: boolean;
}): boolean {
  return (
    input.conflict === "REUSE_EXISTING" ||
    (input.dryRun !== true && input.conflict === undefined && input.stdinIsTTY)
  );
}

const preflightConfiguredMaterialization = async (input: {
  branchName: string;
  config: Config;
  createBasePlan: CreateBaseResolutionPlan | undefined;
  dryRun: boolean;
  repositories: Parameters<typeof createCoordinatedWorktrees>[1];
  reuseExisting: boolean;
  workspaceRoot: string;
}): Promise<readonly RepositoryMaterializationPlan[]> => {
  const plans: RepositoryMaterializationPlan[] = [];
  for (const repository of input.repositories) {
    const policy = input.config.repos[repository.name];
    const copy = policy?.copy ?? [];
    const symlink = policy?.symlink ?? [];
    if (copy.length === ZERO && symlink.length === ZERO) continue;
    const canonicalRepositoryPath = await realpath(repository.path);
    const reusedTargetOid = input.reuseExisting
      ? await resolveReusableMaterializationTarget(repository, input.branchName)
      : undefined;
    const targetOid =
      reusedTargetOid ??
      input.createBasePlan?.byCanonicalPath.get(canonicalRepositoryPath)?.resolvedOid ??
      (await resolveDefaultMaterializationTarget(repository));
    const destinationRoot = (
      await calculateWorktreePath({
        branchName: input.branchName,
        config: input.config,
        repo: repository,
      })
    ).path;
    const sourceRoot = await resolveGitPrimarySourceCheckout(
      canonicalRepositoryPath,
      repository.name,
    );
    plans.push(
      await planConfiguredRepositoryMaterialization({
        copy,
        destinationRoot,
        dryRun: input.dryRun,
        platform: process.platform,
        repositoryId: repository.name,
        repositoryPath: canonicalRepositoryPath,
        sourceRoot,
        symlink,
        targetOid,
      }),
    );
  }
  if (plans.some((plan) => plan.classification === "blocked")) {
    throw new MaterializationPlanBlockedError(plans);
  }
  return Object.freeze(plans);
};

export interface CreateCommandDependencies {
  resolveWorkspaceContext?: typeof resolveWorkspaceContext;
  resolveCreateInvocationContext?: (invocationPath?: string) => Promise<CreateInvocationContext>;
  resolveManagedIgnoreWorkspaceRoot?: (
    context: CreateInvocationContext,
    useBareRootWhenNoLinkedWorktree?: boolean,
  ) => Promise<string>;
  loadConfigWithFallback?: typeof loadConfigWithFallback;
  discoverRepositories?: typeof discoverRepositories;
  isGitRepository?: (path: string) => Promise<boolean>;
  resolveCurrentBranch?: (path: string) => Promise<string>;
  applyRepositoryFilter?: typeof applyRepositoryFilter;
  resolveCreateBasePlan?: typeof resolveCreateBasePlan;
  /** Complete configured materialization preflight; runs before managed-ignore mutation. */
  preflightMaterialization?: (input: {
    branchName: string;
    config: Config;
    createBasePlan: CreateBaseResolutionPlan | undefined;
    dryRun: boolean;
    repositories: Parameters<typeof createCoordinatedWorktrees>[1];
    reuseExisting: boolean;
    workspaceRoot: string;
  }) => Promise<readonly RepositoryMaterializationPlan[]>;
  calculateWorktreePathPlan?: typeof calculateWorktreePathPlan;
  listRegisteredWorktreePaths?: (
    repositoryPath: string,
  ) => Promise<readonly (string | { branch: string | null; path: string; prunable?: boolean })[]>;
  createCoordinatedWorktrees?: typeof createCoordinatedWorktrees;
  reconcileManagedIgnore?: typeof reconcileRepositoryManagedIgnore;
  restoreManagedIgnore?: typeof restoreManagedIgnore;
  destinationPathExists?: (path: string) => boolean;
  pathExists?: (path: string) => boolean;
  launchSwitchTarget?: (
    candidate: SwitchCandidate,
    options: LaunchSwitchOptions,
    deps: LaunchSwitchDependencies,
  ) => Promise<LaunchSwitchResult>;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  runProcess?: SwitchProcessRunner;
  resolveGitMainWorktree?: (path: string) => Promise<string | null>;
  /** Testable effective stdin terminal capability */
  stdinIsTTY?: boolean;
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
    const gitDirectory = await exec(["rev-parse", "--absolute-git-dir"], absoluteInvocationPath);
    const canonicalBareRoot = await realpath(gitDirectory.stdout.trim()).catch(() =>
      resolve(gitDirectory.stdout.trim()),
    );
    return {
      executionPath: canonicalBareRoot,
      invocationPath: canonicalBareRoot,
      repositoryType: "bare",
      workspaceRoot: canonicalBareRoot,
    };
  }

  const workspaceRoot = await findWorkspaceRoot(absoluteInvocationPath);
  const workspaceBareProbe = await exec(["rev-parse", "--is-bare-repository"], workspaceRoot);
  if (workspaceBareProbe.stdout.trim() === "true") {
    return {
      executionPath: workspaceRoot,
      invocationPath: absoluteInvocationPath,
      repositoryType: "bare",
      workspaceRoot,
    };
  }
  return {
    executionPath: workspaceRoot,
    invocationPath: absoluteInvocationPath,
    repositoryType: "non-bare",
    workspaceRoot,
  };
}

export async function resolveManagedIgnoreWorkspaceRoot(
  context: CreateInvocationContext,
  useBareRootWhenNoLinkedWorktree = false,
): Promise<string> {
  if (context.repositoryType !== "bare") {
    return context.workspaceRoot;
  }

  const configuredCommonDirectory = await realpath(context.executionPath).catch(() =>
    resolve(context.executionPath),
  );
  let candidatePath = resolve(context.invocationPath);
  while (true) {
    try {
      const commonDirectory = await exec(["rev-parse", "--git-common-dir"], candidatePath);
      const rawCommonDirectory = commonDirectory.stdout.trim();
      const absoluteCommonDirectory = isAbsolute(rawCommonDirectory)
        ? resolve(rawCommonDirectory)
        : resolve(candidatePath, rawCommonDirectory);
      const canonicalCommonDirectory = await realpath(absoluteCommonDirectory).catch(() =>
        resolve(absoluteCommonDirectory),
      );
      if (canonicalCommonDirectory === configuredCommonDirectory) {
        const invokingWorktreeRoot = await exec(["rev-parse", "--show-toplevel"], candidatePath);
        return invokingWorktreeRoot.stdout.trim();
      }
    } catch {
      // Keep walking: a nested child repository may hide the enclosing linked worktree.
    }

    const parentPath = dirname(candidatePath);
    if (parentPath === candidatePath) {
      break;
    }
    candidatePath = parentPath;
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
  if (useBareRootWhenNoLinkedWorktree) {
    return context.workspaceRoot;
  }
  const temporaryParent = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-worktree-"));
  const temporaryWorktree = join(temporaryParent, "worktree");
  try {
    const branchRefs = await exec(
      ["for-each-ref", "--format=%(refname)", "--sort=-committerdate", "refs/heads"],
      context.executionPath,
    );
    const sourceRef = branchRefs.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!sourceRef) {
      throw new CreateSetupError(
        "Managed ignore reconciliation requires at least one committed branch in the bare repository.",
      );
    }
    await exec(
      ["worktree", "add", "--detach", temporaryWorktree, sourceRef.trim()],
      context.executionPath,
    );
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
  const [summaryLine, ...detailLines] = formatCreateHookSummary(hookOutcomes);
  if (!summaryLine) {
    return;
  }

  info(summaryLine);
  for (const line of detailLines) {
    console.log(line);
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

export function applyCreateLaunchFlagPrecedence(
  options: CreateCommandOptions,
  rawArgs: readonly string[],
): CreateCommandOptions {
  if (rawArgs.includes("--launch") && rawArgs.includes("--no-launch")) {
    return { ...options, launch: true };
  }
  return options;
}

export function resolveCreateDefaults(
  options: CreateCommandOptions,
  workspaceConfig: Config,
): ResolvedCreateDefaults {
  validateCreateLaunchOptions(options);
  const createDefaults = resolveConfiguredCreateDefaults(options, workspaceConfig);

  let resolvedLaunch = createDefaults?.launch ?? "none";
  if (options.herdr === true) resolvedLaunch = "herdr";
  else if (options.sesh === true) resolvedLaunch = "sesh";
  else if (options.launch === true || options.tab === true) resolvedLaunch = "auto";
  else if (options.launch === false) resolvedLaunch = "none";

  let resolvedSwitch = createDefaults?.switch ?? false;
  if (options.switch === true) resolvedSwitch = true;
  else if (options.switch === false) resolvedSwitch = false;

  const shouldLaunch = options.tmux === true || resolvedLaunch !== "none";
  let launchMode: LaunchMode = AUTO_LAUNCH_MODE;
  if (options.tmux === true) launchMode = TMUX_LAUNCH_MODE;
  else if (resolvedLaunch === "sesh" || resolvedLaunch === "herdr") launchMode = resolvedLaunch;
  return {
    disposition: options.tab === true ? "tab" : "window",
    launchMode,
    shouldLaunch: options.tab === true || shouldLaunch,
    shouldSwitch: options.tab === true || shouldLaunch || resolvedSwitch,
  };
}

function validateCreateLaunchOptions(options: CreateCommandOptions): void {
  const launchOverrides = [
    options.tmux ? "tmux" : null,
    options.sesh ? "sesh" : null,
    options.herdr ? "herdr" : null,
  ].filter((value): value is "tmux" | "sesh" | "herdr" => value !== null);
  if (launchOverrides.length > ONE) {
    throw new SwitchCommandError(
      `Conflicting launch overrides provided (${launchOverrides.map((value) => `--${value}`).join(", ")}). Choose exactly one explicit create launcher.`,
      SwitchCommandErrorCode.CONFLICTING_LAUNCH_OPTIONS,
      { launchOverrides },
    );
  }
}

const isUnsupportedCreateJsonMode = (options: CreateCommandOptions): boolean =>
  options.json === true &&
  (options.interactive === true ||
    options.launch === true ||
    options.tmux === true ||
    options.sesh === true ||
    options.herdr === true ||
    options.switch === true ||
    options.tab === true);

const isExplicitTmuxJsonMode = (options: CreateCommandOptions): boolean =>
  options.json === true && options.tmux === true;

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

const createLaunchOptions = (defaults: ResolvedCreateDefaults): LaunchSwitchOptions => ({
  disposition: defaults.disposition,
  ...(defaults.launchMode === HERDR_LAUNCH_MODE ? { herdr: true } : {}),
  sesh: defaults.launchMode === SESH_LAUNCH_MODE,
  ...(defaults.launchMode === TMUX_LAUNCH_MODE ? { tmux: true } : {}),
});

const preflightCreateLaunch = (
  defaults: ResolvedCreateDefaults,
  options: CreateCommandOptions,
  deps: CreateCommandDependencies,
): Promise<LaunchPreflight | null> => {
  if (!defaults.shouldLaunch || options.dryRun === true) return Promise.resolve(null);
  return preflightLaunchSwitchTarget(createLaunchOptions(defaults), {
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    runProcess: deps.runProcess,
  });
};

interface DirtyGuidanceContext {
  guidance: ReturnType<typeof buildDirtyGuidance>;
  source: WorkspaceSelection;
  target: WorkspaceSelection;
}

const resolvePostCreateDirtyGuidance = async (
  sourceWorkspaceRoot: string,
  config: Config,
  branchName: string,
): Promise<DirtyGuidanceContext | null> => {
  const repositories = buildRepositoryTargets(sourceWorkspaceRoot, config.repos);
  const source = await findWorkspaceByPath(repositories, sourceWorkspaceRoot);
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
  preflight,
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
    createLaunchOptions(defaults),
    {
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      preflight,
      resolveGitMainWorktree: deps.resolveGitMainWorktree,
      runProcess: deps.runProcess,
    },
  );

  success(
    `Opened ${launchResult.mode} context for ${primaryResult.repository.name} at ${primaryResult.worktreePath}`,
  );
};

const applyStandaloneCreateOverrides = async (options: {
  branchName: string;
  commandOptions: CreateCommandOptions;
  context: Extract<Awaited<ReturnType<typeof resolveWorkspaceContext>>, { mode: "standalone" }>;
  deps: CreateCommandDependencies;
  preflight: LaunchPreflight | null;
  worktreePath: string;
}): Promise<void> => {
  if (options.commandOptions.dryRun) {
    return;
  }
  const defaults = resolveCreateDefaults(options.commandOptions, options.context.config);
  if (!defaults.shouldSwitch) {
    return;
  }

  info(`Default switch target: ${options.worktreePath}`);
  if (!defaults.shouldLaunch) {
    info("Launch skipped (resolved defaults disabled launch for this invocation).");
    return;
  }

  const launchCandidate = options.deps.launchSwitchTarget ?? launchSwitchTarget;
  const launchResult = await launchCandidate(
    {
      branchName: options.branchName,
      repoName: options.context.repository.name,
      worktreePath: options.worktreePath,
    },
    createLaunchOptions(defaults),
    {
      env: options.deps.env ?? process.env,
      platform: options.deps.platform ?? process.platform,
      preflight: options.preflight,
      resolveGitMainWorktree: options.deps.resolveGitMainWorktree,
      runProcess: options.deps.runProcess,
    },
  );
  success(
    `Opened ${launchResult.mode} context for ${options.context.repository.name} at ${options.worktreePath}`,
  );
};

export function createCommand(): Command {
  const editorHostOption = new Option(
    "--editor-host <host>",
    "Internal editor host context for create default resolution",
  )
    .choices([...CREATE_DEFAULT_EDITOR_HOSTS])
    .hideHelp();

  const conflictOption = new Option(
    "--conflict <strategy>",
    "Pre-select conflict resolution strategy (ABORT, REUSE_EXISTING)",
  ).choices(["ABORT", "REUSE_EXISTING"]);

  return new Command("create")
    .description("Create coordinated worktrees across multiple repositories")
    .argument("<branch>", "Branch name to create across repositories")
    .option("--base <branch>", "Base branch to use when creating new target branches")
    .addOption(
      repositoryBaseOption(
        "Override the base branch for one selected repository (repeatable; use @meta for the meta repository)",
      ),
    )
    .option(
      "-o, --only <repos>",
      "Only create in specified repositories (repeatable, comma-separated)",
      collectRepositoryFilterValues,
    )
    .option(
      "-g, --group <groups>",
      "Only create in repositories in requested groups (repeatable, comma-separated)",
      collectRepositoryFilterValues,
    )
    .option("-i, --interactive", "Interactively select repositories")
    .option("--switch", "Switch to the created parent worktree after create")
    .option("--no-switch", "Disable configured create switch defaults for this invocation")
    .option("--launch", "Launch terminal/editor context after create")
    .option("--no-launch", "Disable configured create launch defaults for this invocation")
    .option(
      "--tab",
      "Launch the created worktree in a tab; bypasses configured launch defaults and implies --launch and --switch",
    )
    .option("--sesh", "Launch using sesh mode (implies --launch)")
    .option("--herdr", "Launch using Herdr mode (implies --launch)")
    .option("--tmux", "Launch using plain tmux mode (implies --launch and --switch)")
    .addOption(conflictOption)
    .option("--no-hooks", "Disable hook execution")
    .option("--no-hook-input", "Execute hooks with input disabled and immediate EOF")
    .option("--no-progress", "Hide progress indicators")
    .option("-n, --dry-run", "Show what would be done without making changes")
    .option(
      "--move-changes",
      "Move compatible uncommitted changes from the current workspace after create",
    )
    .option("-j, --json", "Return structured JSON output for non-interactive create operations")
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

Configured create launch values: none | auto | sesh | herdr
Precedence: --tmux/--sesh/--herdr, --tab/--launch, --no-launch, matching configured scope, then none.
Any enabled launch implies post-create switch handling.
By default, launch opens a new OS window or managed independent-session equivalent.
--tab requests a true tab or equivalent; unsupported mappings fail without opening a window.
`,
    )
    .action(async (branchName: string, parsedOptions: CreateCommandOptions, command: Command) => {
      const rawArgs = command.parent?.args ?? process.argv.slice(2);
      const options = applyCreateLaunchFlagPrecedence(parsedOptions, rawArgs);
      if (options.json && options.tab) {
        writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
        process.exit(ERROR_EXIT_CODE);
      }
      if (isExplicitTmuxJsonMode(options)) {
        writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
        process.exit(ERROR_EXIT_CODE);
      }

      try {
        validateCreateLaunchOptions(options);
        if (isUnsupportedCreateJsonMode(options)) {
          writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
          process.exit(ERROR_EXIT_CODE);
        }
        const exitCode = await executeCreate(branchName, options).finally(
          releaseHookInterruptGuards,
        );
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

        if (createError instanceof MaterializationPlanBlockedError) {
          error(createError.message);
          for (const plan of createError.details.dryRunOutcome.materializationPlans) {
            for (const outcome of plan.outcomes) {
              console.log(
                `  • ${plan.repositoryId}: ${outcome.action} ${outcome.path} [${outcome.status}] ${outcome.message}`,
              );
            }
          }
          process.exit(ERROR_EXIT_CODE);
        } else if (createError instanceof EmptyRepositoryFiltersError) {
          error(createError.message);
          process.exit(CANCELLED_EXIT_CODE);
        } else if (createError instanceof CreateBaseResolutionError) {
          error(`Base branch '${createError.requestedBranch}' could not be resolved.`);
          for (const failure of createError.failures) {
            error(`${failure.repositoryName} (${failure.repositoryPath})`);
            for (const attemptedRef of failure.attemptedRefs) {
              error(`  attempted: ${attemptedRef}`);
            }
          }
          process.exit(ERROR_EXIT_CODE);
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
        } else if (createError instanceof SwitchCommandError) {
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
  const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY === true;
  const hookInputMode = resolveHookInputMode({
    hookInput: options.hookInput,
    json: options.json,
    stdinIsTTY,
  });
  if (options.json && options.tab) {
    writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
    return ERROR_EXIT_CODE;
  }
  if (isExplicitTmuxJsonMode(options)) {
    writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
    return ERROR_EXIT_CODE;
  }
  validateCreateLaunchOptions(options);
  if (isUnsupportedCreateJsonMode(options)) {
    writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
    return ERROR_EXIT_CODE;
  }
  if (options.tmux && options.dryRun !== true && !isTmuxSession(deps.env ?? process.env)) {
    throw new SwitchCommandError(
      "--tmux requires an active tmux client or session (non-empty TMUX environment variable not detected). Run inside tmux or choose a different launcher.",
      SwitchCommandErrorCode.TMUX_CONTEXT_REQUIRED,
    );
  }
  const emptyFilters = findEmptyRepositoryFilters(options.only, options.group);
  if (emptyFilters.length > ZERO) {
    throw new EmptyRepositoryFiltersError(emptyFilters);
  }

  if (options.base !== undefined && !isValidRequestedBaseBranch(options.base)) {
    throw new InvalidBranchNameError(
      `Invalid base branch name: ${options.base}`,
      options.base,
      "Base branch must be a valid Git branch name.",
    );
  }

  const workspaceContext = await (deps.resolveWorkspaceContext ?? resolveWorkspaceContext)();
  if (workspaceContext.mode === "standalone") {
    const standalonePolicy = resolveBaseBranchPolicy({
      command: "create",
      config: workspaceContext.config,
      globalBase: options.base,
      repositoryOverrides: options.repoBase,
      selectedRepositoryNames: [workspaceContext.repository.name],
      standalone: true,
    });
    const standaloneDefaults = resolveCreateDefaults(options, workspaceContext.config);
    if (options.json && standaloneDefaults.shouldLaunch) {
      writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
      return ERROR_EXIT_CODE;
    }
    const launchPreflight = await preflightCreateLaunch(standaloneDefaults, options, deps);
    if (options.dryRun && options.tab && !options.json) {
      info("Post-create launch preview: tab");
    }
    if (options.only || options.group || options.interactive) {
      throw new CreateSetupError(
        "Repository selection is not meaningful in standalone mode; omit --only, --group, and --interactive.",
      );
    }
    const standaloneRequest = standalonePolicy[0];
    const standaloneBasePlan =
      standaloneRequest?.requestedBranch === undefined
        ? undefined
        : await (deps.resolveCreateBasePlan ?? resolveCreateBasePlan)(
            [
              {
                defaultBranch: "",
                hasSetupScript: false,
                name: workspaceContext.repository.name,
                path: workspaceContext.mainRoot,
              },
            ],
            standaloneRequest.requestedBranch,
            standaloneRequest.source,
            true,
          );
    const standaloneResult = await createStandaloneWorktree(
      workspaceContext,
      branchName,
      options.dryRun === true,
      {
        createBasePlan: standaloneBasePlan,
        hookInputMode,
        quiet: options.json === true,
        skipHooks: options.noHooks === true || options.hooks === false,
      },
    );
    const { targetAction: standaloneTargetAction, ...standaloneOutput } = standaloneResult;
    const standaloneData = {
      ...workspaceJsonMetadata(workspaceContext),
      ...standaloneOutput,
      ...(standaloneBasePlan
        ? {
            base: {
              requestedBranch: standaloneBasePlan.requestedBranch,
              source: standaloneBasePlan.source,
              repositories: standaloneBasePlan.repositories.map((resolution) => ({
                ...resolution,
                targetAction: standaloneTargetAction,
              })),
            },
          }
        : {}),
    };
    if (options.json) {
      writeJsonEnvelope(createJsonSuccessEnvelope("create", standaloneData));
    } else {
      info("Workspace mode: standalone");
      if (options.dryRun && standaloneBasePlan) {
        printCreateBasePlan(standaloneBasePlan, () => standaloneTargetAction);
      }
      success(
        options.dryRun
          ? `Would create worktree at ${standaloneResult.worktreePath}`
          : `Created worktree at ${standaloneResult.worktreePath}`,
      );
    }
    await applyStandaloneCreateOverrides({
      branchName,
      commandOptions: options,
      context: workspaceContext,
      deps,
      preflight: launchPreflight,
      worktreePath: standaloneResult.worktreePath,
    });
    return ZERO;
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
  const resolveBasePlan = deps.resolveCreateBasePlan ?? resolveCreateBasePlan;
  const resolveWorktreePathPlan = deps.calculateWorktreePathPlan ?? calculateWorktreePathPlan;
  const listRegisteredWorktreePaths =
    deps.listRegisteredWorktreePaths ??
    (async (
      repositoryPath: string,
    ): Promise<readonly { branch: string | null; path: string; prunable: boolean }[]> => {
      const registrations = await exec(["worktree", "list", "--porcelain"], repositoryPath);
      const worktrees: { branch: string | null; path: string; prunable: boolean }[] = [];
      let current: { branch: string | null; path: string; prunable: boolean } | null = null;
      for (const line of registrations.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (current) {
            worktrees.push(current);
          }
          current = {
            branch: null,
            path: resolve(line.slice("worktree ".length)),
            prunable: false,
          };
        } else if (current && line.startsWith("branch ")) {
          current.branch = line.slice("branch ".length);
        } else if (current && line.startsWith("prunable")) {
          current.prunable = true;
        }
      }
      if (current) {
        worktrees.push(current);
      }
      return worktrees;
    });
  const runCreate = deps.createCoordinatedWorktrees ?? createCoordinatedWorktrees;
  const reconcileIgnore = deps.reconcileManagedIgnore ?? reconcileRepositoryManagedIgnore;
  const restoreIgnore = deps.restoreManagedIgnore ?? restoreManagedIgnore;
  const destinationPathExists = deps.destinationPathExists ?? destinationEntryExists;
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
  if (options.only || options.group) {
    const configuredRepositories = Object.entries(arashiConfig.repos).map(([name, repository]) => ({
      groups: repository.groups,
      name,
      path: resolve(currentDir, arashiConfig.reposDir, repository.path),
    }));
    const parentName = basename(currentDir);
    if (!configuredRepositories.some((repository) => repository.name === parentName)) {
      configuredRepositories.push({
        groups: arashiConfig.repos[parentName]?.groups,
        name: parentName,
        path: currentDir,
      });
    }
    assertValidCreateRepositoryFilters(
      filterWorkspaceRepositories(configuredRepositories, options.only, options.group),
    );
  }
  const createDefaults = resolveCreateDefaults(options, arashiConfig);
  if (options.json && createDefaults.shouldLaunch) {
    writeJsonEnvelope(unsupportedJsonModeError("create", "interactive-or-launch"));
    return ERROR_EXIT_CODE;
  }
  const launchPreflight = await preflightCreateLaunch(createDefaults, options, deps);
  if (options.dryRun && options.tab && !options.json) {
    info("Post-create launch preview: tab");
  }
  const reposDirAbsolute = resolve(currentDir, arashiConfig.reposDir);
  const discoveryResult = await discoverWorkspaceRepositories(reposDirAbsolute, {
    quiet: options.json === true,
  });

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

  const configuredRepositoryByCanonicalPath = new Map<
    string,
    { id: string; policy: Config["repos"][string] }
  >();
  for (const [id, policy] of Object.entries(arashiConfig.repos)) {
    try {
      configuredRepositoryByCanonicalPath.set(await realpath(resolve(currentDir, policy.path)), {
        id,
        policy,
      });
    } catch {
      // Missing configured repositories are not part of create discovery.
    }
  }
  for (const repository of allRepositories) {
    let canonicalRepositoryPath: string;
    try {
      canonicalRepositoryPath = await realpath(repository.path);
    } catch {
      continue;
    }
    const configured = configuredRepositoryByCanonicalPath.get(canonicalRepositoryPath);
    if (!configured) continue;
    if (repository.name !== configured.id) {
      repository.worktreeName = repository.name;
      repository.name = configured.id;
    }
    if (configured.policy.groups) {
      repository.groups = configured.policy.groups;
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
  assertValidCreateRepositoryFilters(groupFilterResult);

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
    resolveBaseBranchPolicy({
      command: "create",
      config: arashiConfig,
      globalBase: options.base,
      repositoryOverrides: options.repoBase,
      selectedRepositories: [],
    });
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

  const basePolicy = resolveBaseBranchPolicy({
    command: "create",
    config: arashiConfig,
    globalBase: options.base,
    repositoryOverrides: options.repoBase,
    selectedRepositories: selectedRepos.map((repository) => {
      const meta = repository === parentRepository;
      return {
        ...(meta ? {} : { configName: repository.name }),
        identity: meta ? "@meta" : repository.name,
        kind: meta ? ("meta" as const) : ("child" as const),
        repositoryName: repository.name,
      };
    }),
  });
  const createBaseRequests = basePolicy.filter(
    (request): request is EffectiveBaseBranch & { requestedBranch: string } =>
      request.requestedBranch !== undefined,
  );
  const repositoriesWithBase = selectedRepos.filter(
    (_repository, index) => basePolicy[index]?.requestedBranch !== undefined,
  );
  const strictRequests = createBaseRequests.map((request) => {
    const selectedIndex = basePolicy.indexOf(request);
    const repository = selectedRepos[selectedIndex]!;
    return {
      ...request,
      repositoryIdentity: request.repositoryIdentity,
      repositoryPath: repository.path,
    };
  });
  const strictCreateBasePlan =
    createBaseRequests.length === ZERO
      ? undefined
      : await resolveBasePlan(repositoriesWithBase, strictRequests);
  const createBasePlan = strictCreateBasePlan
    ? {
        ...strictCreateBasePlan,
        effectiveRepositories: await Promise.all(
          selectedRepos.map(async (repository, index) => {
            const policy = basePolicy[index]!;
            const canonicalRepositoryPath = await realpath(repository.path).catch(
              () => repository.path,
            );
            const strictResolution =
              strictCreateBasePlan.byCanonicalPath.get(canonicalRepositoryPath);
            return {
              ...strictResolution,
              repositoryIdentity: policy.repositoryIdentity ?? repository.name,
              repositoryName: repository.name,
              repositoryPath: strictResolution?.repositoryPath ?? canonicalRepositoryPath,
              requestedBranch:
                policy.requestedBranch ?? normalizeLogicalBranchName(repository.defaultBranch),
              source: policy.source,
            };
          }),
        ),
      }
    : undefined;

  const worktreePathPlan = await resolveWorktreePathPlan(selectedRepos, branchName, arashiConfig);
  const reusableWorktreePaths = new Set<string>();
  if (!options.dryRun) {
    const plannedDestinations = new Set<string>();
    for (const [repository, plannedPath] of worktreePathPlan) {
      const normalizedDestination = resolve(plannedPath.path);
      const duplicatePlan = plannedDestinations.has(normalizedDestination);
      const filesystemCollision = destinationPathExists(normalizedDestination);
      plannedDestinations.add(normalizedDestination);

      let canonicalDestination = normalizedDestination;
      if (filesystemCollision) {
        try {
          canonicalDestination = await realpath(normalizedDestination);
        } catch {
          // Tests and injected filesystems may report a collision without a host path.
        }
      }
      const registeredWorktrees = (await listRegisteredWorktreePaths(repository.path)).map(
        (registeredWorktree) =>
          typeof registeredWorktree === "string"
            ? { branch: null, path: registeredWorktree, prunable: false }
            : registeredWorktree,
      );
      let registration: (typeof registeredWorktrees)[number] | undefined = undefined;
      let targetBranchRegisteredElsewhere = false;
      const targetBranchRef = `refs/heads/${branchName}`;
      for (const registeredWorktree of registeredWorktrees) {
        let canonicalRegisteredPath = resolve(registeredWorktree.path);
        try {
          canonicalRegisteredPath = await realpath(canonicalRegisteredPath);
        } catch {
          // Keep the normalized registration path for stale or injected registrations.
        }
        if (canonicalRegisteredPath === canonicalDestination) {
          registration = registeredWorktree;
        } else if (registeredWorktree.branch === targetBranchRef) {
          targetBranchRegisteredElsewhere = true;
        }
      }
      const reusableRegistration =
        filesystemCollision &&
        registration?.branch === targetBranchRef &&
        registration.prunable !== true;
      if (reusableRegistration) {
        reusableWorktreePaths.add(normalizedDestination);
      }
      if (
        duplicatePlan ||
        targetBranchRegisteredElsewhere ||
        (filesystemCollision && !reusableRegistration) ||
        (registration !== undefined && !reusableRegistration)
      ) {
        throw new WorktreeDestinationCollisionError(repository.name, plannedPath.path);
      }
    }
  }

  const materializationPlans = await (
    deps.preflightMaterialization ?? preflightConfiguredMaterialization
  )({
    branchName,
    config: arashiConfig,
    createBasePlan,
    dryRun: options.dryRun === true,
    repositories: selectedRepos,
    reuseExisting: shouldPreflightReusableMaterializationTarget({
      conflict: options.conflict,
      dryRun: options.dryRun === true,
      stdinIsTTY,
    }),
    workspaceRoot: context.workspaceRoot,
  });

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
    createBasePlan,
    dryRun: options.dryRun || false,
    executeHooks: hooksEnabled,
    hookInputMode,
    hookTimeout: arashiConfig.hooks?.timeout,
    quietHooks: options.json === true,
    interactive: options.interactive || false,
    materializationPlans,
    resolvedConfig: arashiConfig,
    showProgress: options.json ? false : progressEnabled,
    worktreePathPlan,
    reusableWorktreePaths,
    workspaceRoot: context.workspaceRoot,
  };

  let storedIgnoreScope: string | null = null;
  if (context.repositoryType === "bare") {
    try {
      storedIgnoreScope = (
        await exec(["config", "--local", "--get", "arashi.ignoreScope"], context.executionPath)
      ).stdout.trim();
    } catch {
      storedIgnoreScope = null;
    }
  }
  const managedIgnoreWorkspaceRoot = await resolveIgnoreWorkspaceRoot(
    context,
    storedIgnoreScope === "tracked",
  );
  const trackedBareRootNeedsChildRules =
    storedIgnoreScope === "tracked" &&
    managedIgnoreWorkspaceRoot === context.workspaceRoot &&
    selectedRepos.some((repository) => repository.path !== context.executionPath);
  if (trackedBareRootNeedsChildRules) {
    throw new CreateSetupError(
      "Tracked managed-ignore changes for selected child repositories require an existing linked worktree. Create a parent worktree first, then retry.",
    );
  }
  const temporaryIgnoreWorkspace = temporaryManagedIgnoreWorktrees.has(managedIgnoreWorkspaceRoot);
  const moveSourceWorkspaceRoot =
    context.repositoryType === "bare" &&
    resolve(context.invocationPath) !== resolve(context.workspaceRoot)
      ? managedIgnoreWorkspaceRoot
      : context.executionPath;
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
    : await resolvePostCreateDirtyGuidance(moveSourceWorkspaceRoot, arashiConfig, branchName);
  const moveSummary =
    options.moveChanges && dirtyGuidanceContext
      ? await executeMovePlan(
          buildMovePlan(dirtyGuidanceContext.source, dirtyGuidanceContext.target),
        )
      : null;
  const dirtyWorkspaceGuidance = moveSummary ? null : (dirtyGuidanceContext?.guidance ?? null);

  // 7. Display results
  if (options.json) {
    const details = await createSummaryJsonData({
      branchName,
      createBasePlan,
      dirtyWorkspaceGuidance,
      managedIgnore,
      moveSummary,
      summary,
      workspaceMetadata: {
        mode: "configured",
        repositoriesBase: resolve(context.workspaceRoot, arashiConfig.reposDir),
        workspaceRoot: context.workspaceRoot,
        worktreesBase: resolve(
          context.workspaceRoot,
          arashiConfig.worktreesDir ?? DEFAULT_WORKTREES_DIR,
        ),
      },
    });
    if (summary.rolledBack || summary.failureCount > ZERO) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("create", {
          code: "CREATE_FAILED",
          details,
          message: summary.errorSummary ?? "Create failed",
        }),
      );
      return ERROR_EXIT_CODE;
    }
    writeJsonEnvelope(createJsonSuccessEnvelope("create", details));
    return ZERO;
  }

  console.log("");
  if (options.dryRun) {
    if (!summary.dryRunOutcome) {
      error("Dry-run did not produce a plan");
      return ERROR_EXIT_CODE;
    }

    const {
      plannedWorktrees,
      conflicts,
      materializationPlans = [],
      overallStatus,
      summaryCounts,
    } = summary.dryRunOutcome;

    if (createBasePlan) {
      printCreateBasePlan(createBasePlan, (repositoryPath) => {
        const targetAction = summary.targetActionByRepositoryPath.get(repositoryPath);
        if (!targetAction) {
          throw new Error(`Repository target action is missing for '${repositoryPath}'`);
        }
        return targetAction;
      });
      console.log("");
    }

    info("Dry-run plan:");
    for (const planned of plannedWorktrees) {
      const pathLabel = planned.worktreePath ?? "(unresolved)";
      const statusLabel = planned.planStatus === "blocked" ? "BLOCKED" : "OK";
      console.log(
        `  • ${planned.repositoryName}: ${planned.branchName} -> ${pathLabel} [${statusLabel}]`,
      );
    }

    if (materializationPlans.length > 0) {
      console.log("");
      info("Materialization plan:");
      for (const plan of materializationPlans) {
        for (const outcome of plan.outcomes) {
          console.log(
            `  • ${plan.repositoryId}: ${outcome.action} ${outcome.path} [${outcome.status}] ${outcome.message}`,
          );
        }
      }
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
      return ZERO;
    }

    error(`Plan status: ${statusLabel} (${summaryLabel})`);
    info(`Total duration: ${formatDurationSeconds(summary.totalDuration)}`);
    return ERROR_EXIT_CODE;
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

    const failedMaterialization = summary.repositoryResults.flatMap((result) =>
      (result.materializationOutcomes ?? []).map((outcome) => ({
        outcome,
        repositoryId: result.repository.name,
      })),
    );
    if (failedMaterialization.length > 0) {
      console.log("");
      info("Materialization results:");
      for (const { outcome, repositoryId } of failedMaterialization) {
        console.log(
          `  • ${repositoryId}: ${outcome.action} ${outcome.path} [${outcome.status}] ${outcome.message}`,
        );
      }
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

  const materializationResults = summary.repositoryResults.flatMap((result) =>
    (result.materializationOutcomes ?? []).map((outcome) => ({
      outcome,
      repositoryId: result.repository.name,
    })),
  );
  if (materializationResults.length > 0) {
    console.log("");
    info("Materialization results:");
    for (const { outcome, repositoryId } of materializationResults) {
      console.log(
        `  • ${repositoryId}: ${outcome.action} ${outcome.path} [${outcome.status}] ${outcome.message}`,
      );
    }
  }

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

  await applyPostCreateDefaults({
    context,
    defaults: createDefaults,
    deps,
    preflight: launchPreflight,
    summary,
  });

  console.log("");
  info(`Total duration: ${formatDurationSeconds(summary.totalDuration)}`);
  return ZERO;
}
