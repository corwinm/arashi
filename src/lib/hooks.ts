import { runtime } from "./runtime.ts";
import { access, readdir, realpath as resolveRealpath, stat } from "fs/promises";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, isAbsolute, join, normalize, resolve, win32 } from "path";
import { normalizeSpawnEnvironment } from "./shell-directives.ts";
import { withSpinnerPaused } from "./logger.ts";
import type { PausableSpinner } from "./logger.ts";

const ZERO = 0;
const ONE = 1;
const INTERRUPTED_EXIT_CODE = 130;
const retainedInterruptHandlers = new Set<() => void>();
export const DEFAULT_LIFECYCLE_HOOK_TIMEOUT = 300_000;

export const releaseHookInterruptGuards = (): void => {
  for (const handler of retainedInterruptHandlers) process.off("SIGINT", handler);
  retainedInterruptHandlers.clear();
};

// ============================================================================
// Type Definitions
// ============================================================================

export interface Hook {
  name: string;
  scriptPath: string;
  lifecycle: LifecyclePoint;
}

export interface HookContext {
  hookName: string;
  repoPath: string;
  operationData: Record<string, string>;
  hookInputMode?: HookInputMode;
  hookScope?: HookScope;
  sourceScriptPath?: string;
  targetRepoName?: string;
  targetRepoPath?: string;
  targetWorktreePath?: string;
  workspaceMode?: "configured" | "standalone";
  mainRepoPath?: string;
  parentRepoPath?: string;
}

export interface LifecyclePoint {
  name: string;
  timing: "pre" | "post" | "during";
  operation: string;
}

export interface HookResult {
  exitCode: number;
  signalCode: string | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  success: boolean;
  timedOut: boolean;
  duration: number;
}

export type HookScope = "repository" | "workspace" | "global-repository" | "global-shared";
export type HookInputMode = "tty" | "disabled" | "unavailable";

export interface HookInputResolutionOptions {
  hookInput?: boolean;
  json?: boolean;
  stdinIsTTY?: boolean;
}

export const resolveHookInputMode = (options: HookInputResolutionOptions): HookInputMode => {
  if (options.json === true || options.hookInput === false) return "disabled";
  return options.stdinIsTTY === true ? "tty" : "unavailable";
};

export interface HookTargetRepository {
  name: string;
  path: string;
}

export interface ResolvedLifecycleHook {
  hookName: string;
  scope: HookScope;
  scriptPath: string;
  sourceScriptPath: string;
  executionPath: string;
  targetRepositoryName: string;
  targetRepositoryPath: string;
}

export interface LifecycleHookLocation {
  hookName: string;
  scope: HookScope;
  scriptPath: string | null;
  executionPath: string;
  targetRepositoryName: string;
  targetRepositoryPath: string;
}

export class LifecycleHookDiscoveryError extends Error {
  readonly executionPath: string;
  readonly hookName: string;
  readonly scope: HookScope;
  readonly targetRepositoryName: string;
  readonly targetRepositoryPath: string;

  constructor(options: {
    cause: unknown;
    executionPath: string;
    hookName: string;
    scope: HookScope;
    targetRepositoryName: string;
    targetRepositoryPath: string;
  }) {
    super(options.cause instanceof Error ? options.cause.message : String(options.cause), {
      cause: options.cause,
    });
    this.name = "LifecycleHookDiscoveryError";
    this.executionPath = options.executionPath;
    this.hookName = options.hookName;
    this.scope = options.scope;
    this.targetRepositoryName = options.targetRepositoryName;
    this.targetRepositoryPath = options.targetRepositoryPath;
  }
}

export interface LifecycleHookOutcome {
  hookName: string;
  scope: HookScope;
  workspaceMode: "configured" | "standalone";
  hookStatus: HookOutcomeStatus;
  reasonCode: HookOutcomeReasonCode;
  message: string;
  repositoryId: string;
  sourceKind: "file" | "inline-config";
  sourceOwnerKind: "repository" | "user-global" | "workspace";
  sourceOwnerName: string | null;
  sourceScriptPath: string | null;
  executionPath: string | null;
  targetRepositoryName: string | null;
  targetRepositoryPath: string | null;
  targetWorktreePath: string | null;
  durationMs?: number;
}

export type HookOutcomeStatus = "success" | "failure" | "skipped";

export type HookOutcomeReasonCode =
  | "none"
  | "not_found"
  | "disabled"
  | "validation_failed"
  | "interpreter_unavailable"
  | "timeout"
  | "exit_non_zero"
  | "not_applicable";

export interface HookOutcomeMapping {
  hookStatus: HookOutcomeStatus;
  reasonCode: HookOutcomeReasonCode;
  message: string;
  durationMs?: number;
}

export interface HookConfig {
  timeout: number;
  enabled: boolean;
  allowedHooks: string[] | null;
  blockedHooks: string[];
}

export interface HookExecutionOptions {
  hookName: string;
  scriptPath: string;
  context: HookContext;
  timeout?: number;
  quiet?: boolean;
  hookInputMode?: HookInputMode;
  outputSpinner?: PausableSpinner | null;
  sourceKind?: "file" | "inline-config";
  sourceOwnerKind?: "repository" | "user-global" | "workspace";
  sourceOwnerName?: string | null;
}

export type InlineHookInterpreter = "bash" | "cmd" | "powershell";

export type AvailableInlineHookInterpreterResolution = {
  available: true;
  executablePath: string;
  interpreter: InlineHookInterpreter;
};

export type InlineHookInterpreterResolution =
  | AvailableInlineHookInterpreterResolution
  | { available: false; reasonCode: "interpreter_unavailable" };

export interface LifecycleHookSourceDescriptor {
  configuredField?: string;
  executionPath: string;
  lifecycle: "post-create" | "post-remove" | "pre-create" | "pre-remove";
  scope: HookScope;
  sourceKind: "file" | "inline-config";
  sourceOwnerKind: "global" | "repository" | "workspace";
  sourceOwnerName: string | null;
  sourceScriptPath: string | null;
  targetRepositoryName?: string;
}

export interface LifecycleHookPlanTarget {
  branchName: string;
  repositoryName: string;
  repositoryPath: string;
  worktreePath: string;
}

export type LifecycleHookPlanConsumer = "create" | "doctor" | "remove" | "remove-dry-run";
export type LifecycleHookPlanSlot =
  | "create.repository.post-materialization"
  | "create.repository.pre-after-materialization"
  | "create.workspace.post"
  | "create.workspace.pre"
  | "remove.target.post-finalization"
  | "remove.target.pre-destruction";

export interface PlannedLifecycleHookSource extends LifecycleHookSourceDescriptor {
  context: {
    branchName: string;
    cwd: string;
    repositoryName: string | null;
    repositoryPath: string | null;
    workspaceRoot: string;
    worktreePath: string | null;
  };
  failureDisposition: "gate-all-targets" | "retain-finalization" | "rollback-owned-create";
  hookName: string;
  slot: LifecycleHookPlanSlot;
}

export interface LifecycleHookAmbiguity {
  code: "CREATE_FAILED" | "HOOK_AMBIGUOUS" | "HOOK_CONFIGURATION_INVALID";
  hookName: LifecycleHookSourceDescriptor["lifecycle"];
  scope: HookScope;
  sourceKinds: [
    LifecycleHookSourceDescriptor["sourceKind"],
    LifecycleHookSourceDescriptor["sourceKind"],
  ];
  sourceOwnerKind: LifecycleHookSourceDescriptor["sourceOwnerKind"];
  sourceOwnerName: string | null;
  sourceScriptPath: string | null;
}

export type LifecycleHookPlan =
  | { classification: "ambiguous"; entries: []; failure: LifecycleHookAmbiguity }
  | {
      classification: "ready";
      entries: PlannedLifecycleHookSource[];
      removeGate?: {
        destructiveMutationAfterAllPreflight: true;
        postFinalizationRetainsOperationFailures: true;
        preflightSourceCount: number;
      };
    };

export type LifecycleHookPreparationCandidate =
  | {
      readonly kind: "absent";
      readonly source: LifecycleHookSourceDescriptor & {
        readonly sourceKind: "file";
        readonly sourceScriptPath: null;
      };
    }
  | {
      readonly kind: "file";
      readonly source: LifecycleHookSourceDescriptor & {
        readonly sourceKind: "file";
        readonly sourceScriptPath: string;
      };
    }
  | {
      readonly interpreters: Readonly<Partial<Record<InlineHookInterpreter, string>>>;
      readonly kind: "inline-config";
      readonly source: LifecycleHookSourceDescriptor & { readonly sourceKind: "inline-config" };
    };

export type PreparedLifecycleHookEntry =
  | {
      readonly kind: "absent";
      readonly plan: Readonly<PlannedLifecycleHookSource>;
    }
  | {
      readonly kind: "file";
      readonly plan: Readonly<PlannedLifecycleHookSource>;
      readonly scriptPath: string;
    }
  | {
      readonly kind: "inline-config";
      readonly plan: Readonly<PlannedLifecycleHookSource>;
      readonly resolution: Readonly<AvailableInlineHookInterpreterResolution>;
      readonly snippet: string;
    };

type ReadyLifecycleHookPlan = Extract<LifecycleHookPlan, { classification: "ready" }>;
type ImmutableAmbiguousLifecycleHookPlan = {
  readonly classification: "ambiguous";
  readonly entries: readonly never[];
  readonly failure: Readonly<LifecycleHookAmbiguity>;
};
type ImmutableReadyLifecycleHookPlan = {
  readonly classification: "ready";
  readonly entries: readonly Readonly<PlannedLifecycleHookSource>[];
  readonly removeGate?: Readonly<NonNullable<ReadyLifecycleHookPlan["removeGate"]>>;
};

export type PreparedLifecycleHookSources =
  | {
      readonly classification: "ambiguous";
      readonly plan: ImmutableAmbiguousLifecycleHookPlan;
    }
  | {
      readonly classification: "file-invalid";
      readonly plan: ImmutableReadyLifecycleHookPlan;
      readonly plannedEntry: Readonly<PlannedLifecycleHookSource>;
      readonly validation: Readonly<ValidationResult>;
    }
  | {
      readonly classification: "interpreter-unavailable";
      readonly plan: ImmutableReadyLifecycleHookPlan;
      readonly plannedEntry: Readonly<PlannedLifecycleHookSource>;
    }
  | {
      readonly classification: "ready";
      readonly entries: readonly PreparedLifecycleHookEntry[];
      readonly plan: ImmutableReadyLifecycleHookPlan;
    };

interface RunLifecycleHookOptions {
  lifecyclePoint: string;
  operationData: Record<string, string>;
  options?: { skipHooks?: boolean; timeout?: number };
  repoPath: string;
}

type RunLifecycleHookArgs =
  | [
      lifecyclePoint: string,
      repoPath: string,
      operationData: Record<string, string>,
      options?: { skipHooks?: boolean; timeout?: number },
    ]
  | [options: RunLifecycleHookOptions];

export interface ValidationResult {
  valid: boolean;
  error?: string;
  reasonCode?: "validation_failed" | "interpreter_unavailable";
}

export const GLOBAL_HOOKS = {
  postCreate: "post-create",
  postRemove: "post-remove",
  preCreate: "pre-create",
  preRemove: "pre-remove",
} as const;

export const REPO_SPECIFIC_LIFECYCLES = ["pre-create", "post-create"] as const;

export type RepoSpecificLifecycle = (typeof REPO_SPECIFIC_LIFECYCLES)[number];

export const getRepoSpecificHookName = (
  lifecycle: RepoSpecificLifecycle,
  repoName: string,
): string => `${lifecycle}.${repoName}`;

export const parseRepoSpecificHookName = (
  hookName: string,
): { lifecycle: RepoSpecificLifecycle; repoName: string } | null => {
  for (const lifecycle of REPO_SPECIFIC_LIFECYCLES) {
    const prefix = `${lifecycle}.`;
    if (hookName.startsWith(prefix)) {
      const repoName = hookName.slice(prefix.length);
      if (repoName.length === ZERO) {
        return null;
      }
      return { lifecycle, repoName };
    }
  }

  return null;
};

export const buildHookOperationData = (options: {
  branchName?: string;
  repoName?: string;
  worktreePath?: string;
  mainRepoPath?: string;
  parentRepoPath?: string;
}): Record<string, string> => {
  const data: Record<string, string> = {};

  if (options.branchName) {
    data.BRANCH_NAME = options.branchName;
  }

  if (options.repoName) {
    data.REPO_NAME = options.repoName;
  }

  if (options.worktreePath) {
    data.WORKTREE_PATH = options.worktreePath;
  }

  if (options.mainRepoPath) {
    data.MAIN_REPO_PATH = options.mainRepoPath;
  }

  if (options.parentRepoPath) {
    data.PARENT_REPO_PATH = options.parentRepoPath;
  }

  return data;
};

export interface RemoveHookOperationDataOptions {
  branchNames?: string[];
  worktreePaths?: string[];
  repositoryNames?: string[];
  targets?: RemoveHookTarget[];
  mainRepoPath: string;
}

export interface RemoveHookTarget {
  repository: string;
  branchName: string | null;
  worktreePath: string | null;
}

export const compareUnicodeScalars = (left: string, right: string): number => {
  const leftPoints = [...left].map((value) => value.codePointAt(0) ?? ZERO);
  const rightPoints = [...right].map((value) => value.codePointAt(0) ?? ZERO);
  for (let index = ZERO; index < Math.min(leftPoints.length, rightPoints.length); index += ONE) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
};

export const normalizeLifecyclePath = (value: string): string => {
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  if (windows) {
    const normalized = value.replaceAll("\\", "/");
    const unc = normalized.startsWith("//");
    const prefix = unc ? "//" : `${normalized[0].toUpperCase()}:`;
    const rest = normalized.slice(2);
    const parts: string[] = [];
    for (const part of rest.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        const minimumParts = unc ? 2 : 0;
        if (parts.length > minimumParts) parts.pop();
      } else parts.push(part);
    }
    if (unc) return `//${parts.join("/")}`;
    return `${prefix}/${parts.join("/")}`;
  }
  const absolute = isAbsolute(value) ? value : resolve(value);
  return normalize(absolute)
    .replaceAll("\\", "/")
    .replace(/(?<!^)\/$/, "");
};

export const buildRemoveHookOperationData = (
  options: RemoveHookOperationDataOptions,
): Record<string, string> => {
  const inputTargets =
    options.targets ??
    (options.repositoryNames ?? []).map((repository, index) => ({
      branchName: options.branchNames?.[index] ?? null,
      repository,
      worktreePath: options.worktreePaths?.[index] ?? null,
    }));
  const targetMap = new Map<string, RemoveHookTarget>();
  for (const target of inputTargets) {
    if (!target.repository) continue;
    const canonical = {
      branchName: target.branchName || null,
      repository: target.repository,
      worktreePath: target.worktreePath ? normalizeLifecyclePath(target.worktreePath) : null,
    };
    targetMap.set(JSON.stringify(canonical), canonical);
  }
  const targets = [...targetMap.values()].toSorted((left, right) => {
    const repository = compareUnicodeScalars(left.repository, right.repository);
    if (repository !== ZERO) return repository;
    if (left.worktreePath === null && right.worktreePath !== null) return -ONE;
    if (left.worktreePath !== null && right.worktreePath === null) return ONE;
    const worktree = compareUnicodeScalars(left.worktreePath ?? "", right.worktreePath ?? "");
    if (worktree !== ZERO) return worktree;
    if (left.branchName === null && right.branchName !== null) return -ONE;
    if (left.branchName !== null && right.branchName === null) return ONE;
    return compareUnicodeScalars(left.branchName ?? "", right.branchName ?? "");
  });
  const sortedDistinct = (values: Array<string | null>): string[] =>
    [
      ...new Set(values.filter((value): value is string => value !== null && value.length > ZERO)),
    ].toSorted(compareUnicodeScalars);
  const uniqueBranches = sortedDistinct(targets.map((target) => target.branchName));
  const uniqueWorktreePaths = sortedDistinct(targets.map((target) => target.worktreePath));
  const uniqueRepositories = sortedDistinct(targets.map((target) => target.repository));

  const operationData = buildHookOperationData({
    branchName: uniqueBranches.length === ONE ? uniqueBranches[0] : undefined,
    mainRepoPath: options.mainRepoPath,
    repoName: uniqueRepositories.length === ONE ? uniqueRepositories[0] : undefined,
    worktreePath: uniqueWorktreePaths.length === ONE ? uniqueWorktreePaths[0] : undefined,
  });

  operationData.OPERATION = "remove";
  operationData.REMOVE_TARGETS_JSON = JSON.stringify(targets);
  operationData.REMOVE_TARGET_BRANCHES = uniqueBranches.join(",");
  operationData.REMOVE_TARGET_WORKTREES = uniqueWorktreePaths.join(",");
  operationData.REMOVE_TARGET_REPOSITORIES = uniqueRepositories.join(",");
  operationData.REMOVE_TOTAL_BRANCHES = String(uniqueBranches.length);
  operationData.REMOVE_TOTAL_WORKTREES = String(uniqueWorktreePaths.length);
  operationData.REMOVE_TOTAL_REPOSITORIES = String(uniqueRepositories.length);

  return operationData;
};

export const isHookSkipped = (result: HookResult | null): boolean => result === null;

export const isHookFailure = (result: HookResult | null): boolean =>
  result !== null && !result.success;

export const mapHookSkippedOutcome = (
  reasonCode: Exclude<HookOutcomeReasonCode, "none" | "timeout" | "exit_non_zero">,
  message: string,
): HookOutcomeMapping => ({
  hookStatus: "skipped",
  message,
  reasonCode,
});

export const mapHookExecutionResult = (result: HookResult): HookOutcomeMapping => {
  if (result.success) {
    return {
      durationMs: result.duration,
      hookStatus: "success",
      message: "Hook completed",
      reasonCode: "none",
    };
  }

  if (result.timedOut) {
    return {
      durationMs: result.duration,
      hookStatus: "failure",
      message: "Hook timed out after configured limit",
      reasonCode: "timeout",
    };
  }

  return {
    durationMs: result.duration,
    hookStatus: "failure",
    message: `Hook exited with code ${result.exitCode}`,
    reasonCode: "exit_non_zero",
  };
};

// ============================================================================
// Helper Functions (Internal)
// ============================================================================

const isRegularExecutable = async (path: string, platform: NodeJS.Platform): Promise<boolean> => {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return false;
    }
    if (platform !== "win32") {
      await access(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
};

export const resolveInlineHookInterpreter = async (options: {
  env: Record<string, string | undefined>;
  interpreters: Partial<Record<InlineHookInterpreter, string>>;
  isExecutableFile?: (path: string) => Promise<boolean>;
  platform: NodeJS.Platform;
  realpath?: (path: string) => Promise<string>;
}): Promise<InlineHookInterpreterResolution> => {
  const executable =
    options.isExecutableFile ?? ((path: string) => isRegularExecutable(path, options.platform));
  const canonicalize = options.realpath ?? resolveRealpath;
  const candidates: { interpreter: InlineHookInterpreter; path: string }[] = [];

  if (options.platform === "win32") {
    const systemRoot = options.env.SystemRoot;
    const driveQualifiedSystemRoot = systemRoot && /^[A-Za-z]:[\\/]/u.test(systemRoot);
    if (driveQualifiedSystemRoot) {
      const separator = systemRoot.includes(win32.sep.repeat(2)) ? win32.sep.repeat(2) : win32.sep;
      if (options.interpreters.powershell) {
        candidates.push({
          interpreter: "powershell",
          path: [systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"].join(
            separator,
          ),
        });
      }
      if (options.interpreters.cmd) {
        candidates.push({
          interpreter: "cmd",
          path: [systemRoot, "System32", "cmd.exe"].join(separator),
        });
      }
    }
    if (options.interpreters.bash) {
      for (const entry of (options.env.PATH ?? "").split(win32.delimiter).filter(Boolean)) {
        candidates.push({ interpreter: "bash", path: win32.join(entry, "bash.exe") });
      }
    }
  } else if (options.interpreters.bash) {
    for (const entry of (options.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      candidates.push({ interpreter: "bash", path: join(entry, "bash") });
    }
  }

  for (const candidate of candidates) {
    if (!(await executable(candidate.path))) {
      continue;
    }
    try {
      const executablePath = await canonicalize(candidate.path);
      if (!isAbsolute(executablePath) && options.platform !== "win32") {
        continue;
      }
      if (options.platform === "win32" && !win32.isAbsolute(executablePath)) {
        continue;
      }
      return { available: true, executablePath, interpreter: candidate.interpreter };
    } catch {
      // An executable that cannot be canonicalized is not a trusted runtime candidate.
    }
  }
  return { available: false, reasonCode: "interpreter_unavailable" };
};

export type InlineHookConsumerResolution =
  | (AvailableInlineHookInterpreterResolution & {
      consumer: "doctor" | "remove-dry-run" | "runtime";
    })
  | {
      available: false;
      consumer: "runtime";
      errorCode: "HOOK_INTERPRETER_UNAVAILABLE";
      outcome: { hookStatus: "validation_failed"; reasonCode: "interpreter_unavailable" };
      reasonCode: "interpreter_unavailable";
    }
  | {
      available: false;
      consumer: "remove-dry-run";
      preview: { availability: "unavailable"; reasonCode: "interpreter_unavailable" };
      reasonCode: "interpreter_unavailable";
    }
  | {
      available: false;
      consumer: "doctor";
      finding: { code: "HOOK_INTERPRETER_UNAVAILABLE"; severity: "error" };
      reasonCode: "interpreter_unavailable";
    };

export const resolveInlineHookForConsumer = async (options: {
  consumer: "doctor" | "remove-dry-run" | "runtime";
  env: Record<string, string | undefined>;
  interpreters: Partial<Record<InlineHookInterpreter, string>>;
  isExecutableFile?: (path: string) => Promise<boolean>;
  platform: NodeJS.Platform;
  realpath?: (path: string) => Promise<string>;
}): Promise<InlineHookConsumerResolution> => {
  const resolution = await resolveInlineHookInterpreter(options);
  if (resolution.available) {
    return { ...resolution, consumer: options.consumer };
  }
  if (options.consumer === "runtime") {
    return {
      available: false,
      consumer: "runtime",
      errorCode: "HOOK_INTERPRETER_UNAVAILABLE",
      outcome: { hookStatus: "validation_failed", reasonCode: resolution.reasonCode },
      reasonCode: resolution.reasonCode,
    };
  }
  if (options.consumer === "remove-dry-run") {
    return {
      available: false,
      consumer: "remove-dry-run",
      preview: { availability: "unavailable", reasonCode: resolution.reasonCode },
      reasonCode: resolution.reasonCode,
    };
  }
  return {
    available: false,
    consumer: "doctor",
    finding: { code: "HOOK_INTERPRETER_UNAVAILABLE", severity: "error" },
    reasonCode: resolution.reasonCode,
  };
};

const sourceProjection = (
  source: LifecycleHookSourceDescriptor,
): LifecycleHookSourceDescriptor => ({
  ...(source.configuredField === undefined ? {} : { configuredField: source.configuredField }),
  executionPath: source.executionPath,
  lifecycle: source.lifecycle,
  scope: source.scope,
  sourceKind: source.sourceKind,
  sourceOwnerKind: source.sourceOwnerKind,
  sourceOwnerName: source.sourceOwnerName,
  sourceScriptPath: source.sourceScriptPath,
  ...(source.targetRepositoryName === undefined
    ? {}
    : { targetRepositoryName: source.targetRepositoryName }),
});

export const planLifecycleHookSources = (options: {
  consumer: LifecycleHookPlanConsumer;
  sources: LifecycleHookSourceDescriptor[];
  targets: readonly LifecycleHookPlanTarget[];
  workspaceRoot: string;
}): LifecycleHookPlan => {
  const groups = new Map<string, LifecycleHookSourceDescriptor[]>();
  for (const source of options.sources) {
    const key = JSON.stringify([
      source.lifecycle,
      source.scope,
      source.sourceOwnerKind,
      source.sourceOwnerName,
      source.targetRepositoryName,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  for (const candidates of groups.values()) {
    if (candidates.length < 2) {
      continue;
    }
    const fileSource = candidates.find((candidate) => candidate.sourceKind === "file");
    const [source] = candidates;
    const [firstCandidate, secondCandidate] = candidates.toSorted((left, right) =>
      left.sourceKind.localeCompare(right.sourceKind),
    );
    let code: LifecycleHookAmbiguity["code"] = "HOOK_CONFIGURATION_INVALID";
    if (options.consumer === "create") {
      code = "CREATE_FAILED";
    } else if (options.consumer === "doctor") {
      code = "HOOK_AMBIGUOUS";
    }
    return {
      classification: "ambiguous",
      entries: [],
      failure: {
        code,
        hookName: source.lifecycle,
        scope: source.scope,
        sourceKinds: [firstCandidate.sourceKind, secondCandidate.sourceKind],
        sourceOwnerKind: source.sourceOwnerKind,
        sourceOwnerName: source.sourceOwnerName,
        sourceScriptPath: fileSource?.sourceScriptPath ?? null,
      },
    };
  }

  const sources = options.sources.map(sourceProjection);
  const [firstTarget] = options.targets;
  const entries: PlannedLifecycleHookSource[] = [];
  const appendCreate = (
    source: LifecycleHookSourceDescriptor | undefined,
    target: LifecycleHookPlanTarget | undefined,
    slot:
      | "create.repository.post-materialization"
      | "create.repository.pre-after-materialization"
      | "create.workspace.post"
      | "create.workspace.pre",
  ): void => {
    if (!source || !firstTarget) {
      return;
    }
    const repositorySource = source.scope === "repository";
    entries.push({
      ...source,
      context:
        repositorySource && target
          ? {
              branchName: target.branchName,
              cwd: target.worktreePath,
              repositoryName: target.repositoryName,
              repositoryPath: target.repositoryPath,
              workspaceRoot: options.workspaceRoot,
              worktreePath: target.worktreePath,
            }
          : {
              branchName: firstTarget.branchName,
              cwd: options.workspaceRoot,
              repositoryName: null,
              repositoryPath: null,
              workspaceRoot: options.workspaceRoot,
              worktreePath: null,
            },
      failureDisposition: "rollback-owned-create",
      hookName:
        repositorySource && target
          ? `${source.lifecycle}.${target.repositoryName}`
          : source.lifecycle,
      slot,
    });
  };

  if (options.consumer === "create" || options.consumer === "doctor") {
    appendCreate(
      sources.find((source) => source.lifecycle === "pre-create" && source.scope === "workspace"),
      undefined,
      "create.workspace.pre",
    );
    for (const target of options.targets) {
      appendCreate(
        sources.find(
          (source) =>
            source.lifecycle === "pre-create" &&
            source.scope === "repository" &&
            source.sourceOwnerName === target.repositoryName,
        ),
        target,
        "create.repository.pre-after-materialization",
      );
      appendCreate(
        sources.find(
          (source) =>
            source.lifecycle === "post-create" &&
            source.scope === "repository" &&
            source.sourceOwnerName === target.repositoryName,
        ),
        target,
        "create.repository.post-materialization",
      );
    }
    appendCreate(
      sources.find((source) => source.lifecycle === "post-create" && source.scope === "workspace"),
      undefined,
      "create.workspace.post",
    );
    if (options.consumer === "create") {
      return { classification: "ready", entries };
    }
  }

  const scopes: HookScope[] = ["repository", "workspace", "global-repository", "global-shared"];
  for (const lifecycle of ["pre-remove", "post-remove"] as const) {
    for (const target of options.targets) {
      for (const scope of scopes) {
        const source = sources.find(
          (candidate) =>
            candidate.lifecycle === lifecycle &&
            candidate.scope === scope &&
            (scope === "repository"
              ? candidate.sourceOwnerName === target.repositoryName
              : scope === "global-repository" || scope === "global-shared"
                ? candidate.targetRepositoryName === target.repositoryName
                : true),
        );
        if (!source) {
          continue;
        }
        entries.push({
          ...source,
          context: {
            branchName: target.branchName,
            cwd: source.executionPath,
            repositoryName: target.repositoryName,
            repositoryPath: target.repositoryPath,
            workspaceRoot: options.workspaceRoot,
            worktreePath: target.worktreePath,
          },
          failureDisposition:
            lifecycle === "pre-remove" ? "gate-all-targets" : "retain-finalization",
          hookName: lifecycle,
          slot:
            lifecycle === "pre-remove"
              ? "remove.target.pre-destruction"
              : "remove.target.post-finalization",
        });
      }
    }
  }
  return {
    classification: "ready",
    entries,
    removeGate: {
      destructiveMutationAfterAllPreflight: true,
      postFinalizationRetainsOperationFailures: true,
      preflightSourceCount: entries.length,
    },
  };
};

const lifecycleSourceKey = (source: LifecycleHookSourceDescriptor): string =>
  JSON.stringify([
    source.configuredField ?? null,
    source.executionPath,
    source.lifecycle,
    source.scope,
    source.sourceKind,
    source.sourceOwnerKind,
    source.sourceOwnerName,
    source.sourceScriptPath,
    source.targetRepositoryName,
  ]);

const freezePlannedLifecycleEntry = (
  entry: PlannedLifecycleHookSource,
): Readonly<PlannedLifecycleHookSource> =>
  Object.freeze({ ...entry, context: Object.freeze({ ...entry.context }) });

const freezeReadyLifecyclePlan = (plan: ReadyLifecycleHookPlan): ImmutableReadyLifecycleHookPlan =>
  Object.freeze({
    ...plan,
    entries: Object.freeze(plan.entries.map(freezePlannedLifecycleEntry)),
    ...(plan.removeGate ? { removeGate: Object.freeze({ ...plan.removeGate }) } : {}),
  });

export const prepareLifecycleHookSources = async (options: {
  candidates: readonly LifecycleHookPreparationCandidate[];
  consumer: LifecycleHookPlanConsumer;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  targets: readonly LifecycleHookPlanTarget[];
  workspaceRoot: string;
}): Promise<PreparedLifecycleHookSources> => {
  const planned = planLifecycleHookSources({
    consumer: options.consumer,
    sources: options.candidates.map((candidate) => candidate.source),
    targets: options.targets,
    workspaceRoot: options.workspaceRoot,
  });
  if (planned.classification === "ambiguous") {
    return Object.freeze({
      classification: "ambiguous",
      plan: Object.freeze({
        ...planned,
        entries: Object.freeze([]),
        failure: Object.freeze({ ...planned.failure }),
      }),
    });
  }

  const plan = freezeReadyLifecyclePlan(planned);
  const candidates = new Map(
    options.candidates.map(
      (candidate) => [lifecycleSourceKey(candidate.source), candidate] as const,
    ),
  );
  const fileValidations = new Map<string, Readonly<ValidationResult>>();
  const inlineResolutions = new Map<
    string,
    Readonly<AvailableInlineHookInterpreterResolution> | null
  >();
  const entries: PreparedLifecycleHookEntry[] = [];

  for (const plannedEntry of plan.entries) {
    const key = lifecycleSourceKey(plannedEntry);
    const candidate = candidates.get(key);
    if (!candidate) {
      throw new Error(`Lifecycle planner returned an unknown source for ${plannedEntry.hookName}`);
    }
    if (candidate.kind === "absent") {
      entries.push(Object.freeze({ kind: "absent", plan: plannedEntry }));
      continue;
    }
    if (candidate.kind === "file") {
      let validation = fileValidations.get(key);
      if (!validation) {
        validation = Object.freeze(await validateHook(candidate.source.sourceScriptPath as string));
        fileValidations.set(key, validation);
      }
      if (!validation.valid) {
        return Object.freeze({
          classification: "file-invalid",
          plan,
          plannedEntry,
          validation,
        });
      }
      entries.push(
        Object.freeze({
          kind: "file",
          plan: plannedEntry,
          scriptPath: candidate.source.sourceScriptPath,
        }),
      );
      continue;
    }

    let resolution = inlineResolutions.get(key);
    if (resolution === undefined) {
      const resolved = await resolveInlineHookInterpreter({
        env: options.env,
        interpreters: candidate.interpreters,
        platform: options.platform,
      });
      resolution = resolved.available ? Object.freeze({ ...resolved }) : null;
      inlineResolutions.set(key, resolution);
    }
    if (!resolution) {
      return Object.freeze({
        classification: "interpreter-unavailable",
        plan,
        plannedEntry,
      });
    }
    const snippet = candidate.interpreters[resolution.interpreter];
    if (!snippet) {
      throw new Error(`Prepared inline hook '${plannedEntry.hookName}' has no selected snippet`);
    }
    entries.push(
      Object.freeze({
        kind: "inline-config",
        plan: plannedEntry,
        resolution,
        snippet,
      }),
    );
  }

  return Object.freeze({
    classification: "ready",
    entries: Object.freeze(entries),
    plan,
  });
};

export const getHookSpawnCommand = (
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  if (platform === "win32") {
    if (scriptPath.toLowerCase().endsWith(".ps1")) {
      return [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ];
    }
    return [scriptPath];
  }

  return [scriptPath];
};

/**
 * Constructs environment variables from hook context.
 */
export const buildHookEnvironment = (context: HookContext): Record<string, string> => {
  const env: Record<string, string> = {
    ...normalizeSpawnEnvironment(process.env),
  };

  for (const [key, value] of Object.entries(context.operationData)) env[`ARASHI_${key}`] = value;

  env.ARASHI_HOOK_NAME = context.hookName;
  env.ARASHI_HOOK_EXECUTION_PATH = context.repoPath;
  env.ARASHI_HOOK_INPUT = context.hookInputMode ?? "unavailable";

  if (context.hookScope) {
    env.ARASHI_HOOK_SCOPE = context.hookScope;
  }

  // This reserved field describes a real native source file only. Operation data
  // must never fabricate it for an inline hook.
  delete env.ARASHI_HOOK_SOURCE_PATH;
  if (context.sourceScriptPath) {
    env.ARASHI_HOOK_SOURCE_PATH = resolve(context.sourceScriptPath);
  }

  if (context.targetRepoName) {
    env.ARASHI_HOOK_TARGET_REPOSITORY = context.targetRepoName;
  }

  if (context.targetRepoPath) {
    env.ARASHI_HOOK_TARGET_REPO_PATH = context.targetRepoPath;
  }
  if (context.targetWorktreePath) env.ARASHI_HOOK_TARGET_WORKTREE_PATH = context.targetWorktreePath;
  if (context.workspaceMode) env.ARASHI_HOOK_WORKSPACE_MODE = context.workspaceMode;
  if (context.mainRepoPath) env.ARASHI_MAIN_REPO_PATH = context.mainRepoPath;
  if (context.parentRepoPath) env.ARASHI_PARENT_REPO_PATH = context.parentRepoPath;

  // Historical aliases are lifecycle-specific. Callers provide REPO_PATH when its
  // compatibility value differs from the process cwd.
  if (!env.ARASHI_REPO_PATH) {
    env.ARASHI_REPO_PATH = context.targetRepoPath ?? context.repoPath;
  }

  return env;
};

/**
 * Streams and prefixes output from a ReadableStream.
 */
const streamOutput = async (
  stream: ReadableStream,
  prefix: string,
  quiet = false,
): Promise<string> => {
  const decoder = new TextDecoder();
  let output = "";
  let buffer = "";

  const writeCompleteLines = (decoded: string): void => {
    output += decoded;
    buffer += decoded;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";

    for (const line of parts) {
      if (!quiet) {
        console.log(`${prefix} ${line}`);
      }
    }
  };

  for await (const chunk of stream) {
    writeCompleteLines(decoder.decode(chunk, { stream: true }));
  }
  writeCompleteLines(decoder.decode());

  if (buffer && !quiet) {
    console.log(`${prefix} ${buffer}`);
  }

  return output;
};

const streamRawOutput = async (
  stream: ReadableStream,
  write: (chunk: Uint8Array) => void,
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
    chunks.push(bytes.slice());
    write(bytes);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
};

const formatInteractiveHookAttribution = (options: HookExecutionOptions): string => {
  const context = options.context;
  const sourceKind = options.sourceKind ?? "file";
  const sourceOwnerKind =
    options.sourceOwnerKind ??
    (context.hookScope === "repository"
      ? "repository"
      : context.hookScope?.startsWith("global-")
        ? "user-global"
        : "workspace");
  const sourceOwnerName =
    sourceOwnerKind === "repository"
      ? (options.sourceOwnerName ?? context.targetRepoName ?? null)
      : null;
  const fields = [
    `lifecycle=${context.hookName}`,
    `scope=${context.hookScope ?? "workspace"}`,
    `sourceKind=${sourceKind}`,
    `sourceOwnerKind=${sourceOwnerKind}`,
    `sourceOwnerName=${sourceOwnerName ?? "null"}`,
  ];
  if (context.targetRepoName) {
    fields.push(`targetRepository=${context.targetRepoName}`);
  }
  if (context.targetWorktreePath) {
    fields.push(`targetWorktree=${context.targetWorktreePath}`);
  }
  if (!context.targetRepoName && !context.targetWorktreePath) {
    fields.push(`target=${context.targetRepoPath ?? context.mainRepoPath ?? context.repoPath}`);
  }
  if (sourceKind === "file") {
    fields.push(`filePath=${context.sourceScriptPath ?? options.scriptPath}`);
  }
  return `🪝 Hook input: ${fields.join(" ")}`;
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Discovers a hook script for a given lifecycle point.
 *
 * @param hookName - Name of the lifecycle point (e.g., "pre-create", "pre-create.<repo>")
 * @param repoPath - Absolute path to the repository
 * @returns Absolute path to hook script if found, null if not found
 */
export const findHook = async (hookName: string, repoPath: string): Promise<string | null> => {
  return discoverLifecycleHook(hookName, repoPath);
};

export const lifecycleHookExtensions = (
  platform: NodeJS.Platform = process.platform,
): readonly string[] => (platform === "win32" ? [".ps1", ".cmd", ".bat"] : [".sh"]);

export class LifecycleHookAmbiguityError extends Error {
  readonly candidates: string[];
  readonly code = "HOOK_AMBIGUOUS" as const;
  readonly sourceKinds: ["file", "file"];

  constructor(hookName: string, candidates: string[]) {
    super(`Ambiguous lifecycle hook '${hookName}': ${candidates.join(", ")}`);
    this.name = "LifecycleHookAmbiguityError";
    this.candidates = candidates;
    this.sourceKinds = ["file", "file"];
  }
}

export const discoverLifecycleHookCandidatesInDirectory = async (
  hookName: string,
  hooksDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[]> => {
  const extensions = lifecycleHookExtensions(platform);
  let entries: string[];
  try {
    entries = await readdir(hooksDirectory);
  } catch {
    return Object.freeze([]);
  }
  const expectedNames = extensions.map((extension) => `${hookName}${extension}`.toLowerCase());
  return Object.freeze(
    entries
      .filter((entry) =>
        platform === "win32"
          ? expectedNames.includes(entry.toLowerCase())
          : entry === `${hookName}.sh`,
      )
      .map((entry) => resolve(hooksDirectory, entry))
      .toSorted(compareUnicodeScalars),
  );
};

export const discoverLifecycleHookInDirectory = async (
  hookName: string,
  hooksDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> => {
  const candidates = await discoverLifecycleHookCandidatesInDirectory(
    hookName,
    hooksDirectory,
    platform,
  );
  if (candidates.length > ONE) {
    throw new LifecycleHookAmbiguityError(hookName, [...candidates]);
  }
  return candidates[ZERO] ?? null;
};

export const discoverLifecycleHookCandidates = async (
  hookName: string,
  repoPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<readonly string[]> =>
  discoverLifecycleHookCandidatesInDirectory(
    hookName,
    join(repoPath, ".arashi", "hooks"),
    platform,
  );

export const discoverLifecycleHook = async (
  hookName: string,
  repoPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> => {
  const hooksDirectory = join(repoPath, ".arashi", "hooks");
  return discoverLifecycleHookInDirectory(hookName, hooksDirectory, platform);
};

export const resolveScopedLifecycleHooks = async (options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
  globalOnly?: boolean;
}): Promise<ResolvedLifecycleHook[]> => {
  const locations = await resolveScopedLifecycleHookLocations(options);
  return locations
    .filter((location): location is LifecycleHookLocation & { scriptPath: string } =>
      Boolean(location.scriptPath),
    )
    .map((location) => ({
      ...location,
      scriptPath: location.scriptPath,
      sourceScriptPath: location.scriptPath,
    }));
};

export const resolveScopedLifecycleHookLocations = async (options: {
  hookName: string;
  workspaceRoot: string;
  targetRepositories: HookTargetRepository[];
  globalOnly?: boolean;
}): Promise<LifecycleHookLocation[]> => {
  const resolved: LifecycleHookLocation[] = [];
  const userHome = process.env.HOME ?? homedir();
  const globalHooksDir = join(userHome, ".arashi", "hooks");

  for (const target of options.targetRepositories) {
    const discoverScoped = async (
      scope: HookScope,
      hooksDirectory: string,
      executionPath: string,
    ): Promise<string | null> => {
      try {
        return await discoverLifecycleHookInDirectory(options.hookName, hooksDirectory);
      } catch (cause) {
        throw new LifecycleHookDiscoveryError({
          cause,
          executionPath,
          hookName: options.hookName,
          scope,
          targetRepositoryName: target.name,
          targetRepositoryPath: target.path,
        });
      }
    };
    const repositoryHookPath = options.globalOnly
      ? null
      : await discoverScoped("repository", join(target.path, ".arashi", "hooks"), target.path);
    const workspaceHookPath = options.globalOnly
      ? null
      : await discoverScoped(
          "workspace",
          join(options.workspaceRoot, ".arashi", "hooks"),
          options.workspaceRoot,
        );
    const globalRepositoryHookPath = await discoverScoped(
      "global-repository",
      join(globalHooksDir, target.name),
      target.path,
    );
    const globalSharedHookPath = await discoverScoped("global-shared", globalHooksDir, target.path);

    if (!options.globalOnly && target.path !== options.workspaceRoot) {
      resolved.push({
        executionPath: target.path,
        hookName: options.hookName,
        scope: "repository",
        scriptPath: repositoryHookPath,
        targetRepositoryName: target.name,
        targetRepositoryPath: target.path,
      });
    }

    if (!options.globalOnly) {
      resolved.push({
        executionPath: options.workspaceRoot,
        hookName: options.hookName,
        scope: "workspace",
        scriptPath: workspaceHookPath,
        targetRepositoryName: target.name,
        targetRepositoryPath: target.path,
      });
    }

    resolved.push({
      executionPath: target.path,
      hookName: options.hookName,
      scope: "global-repository",
      scriptPath: globalRepositoryHookPath,
      targetRepositoryName: target.name,
      targetRepositoryPath: target.path,
    });

    resolved.push({
      executionPath: target.path,
      hookName: options.hookName,
      scope: "global-shared",
      scriptPath: globalSharedHookPath,
      targetRepositoryName: target.name,
      targetRepositoryPath: target.path,
    });
  }

  return resolved;
};

/**
 * Validates that a hook script is executable and properly configured.
 *
 * @param hookPath - Absolute path to the hook script
 * @returns Validation result with status and error message if invalid
 */
export const validateHook = async (hookPath: string): Promise<ValidationResult> => {
  try {
    const stats = await stat(hookPath);

    if (!stats.isFile()) {
      return {
        error: `Hook is not a file: ${hookPath}`,
        reasonCode: "validation_failed",
        valid: false,
      };
    }

    // Check execute permissions on Unix
    if (process.platform !== "win32") {
      try {
        await access(hookPath, constants.X_OK);
      } catch {
        return {
          error: `Hook is not executable: ${hookPath}. Run: chmod +x ${hookPath}`,
          reasonCode: "validation_failed",
          valid: false,
        };
      }
    }

    if (process.platform === "win32") {
      let command: string[];
      try {
        command = getHookSpawnCommand(hookPath);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          reasonCode: "interpreter_unavailable",
          valid: false,
        };
      }
      const interpreter = /\.(?:cmd|bat)$/i.test(hookPath) ? "cmd.exe" : command[ZERO];
      const lookup = runtime.spawnSync(["where.exe", interpreter], {
        stderr: "ignore",
        stdout: "ignore",
      });
      if (lookup.exitCode !== ZERO) {
        return {
          error: `Required hook interpreter is unavailable: ${interpreter}`,
          reasonCode: "interpreter_unavailable",
          valid: false,
        };
      }
    }

    return { valid: true };
  } catch (error) {
    return {
      error: `Failed to validate hook: ${error}`,
      reasonCode: "validation_failed",
      valid: false,
    };
  }
};

/**
 * Executes a hook script with provided context and returns the result.
 *
 * @param options - Hook execution options
 * @returns Complete execution result including exit code and output
 */
interface NativeHookExecutionOptions extends HookExecutionOptions {
  redactedErrorValues?: readonly string[];
  redactedOutputValues?: readonly string[];
  spawnCommand?: string[];
  windowsVerbatimArguments?: boolean;
}

const REDACTED_INLINE_OUTPUT = "[inline hook snippet redacted]";

const stripShellDiagnosticQuotes = (value: string): string => value.replaceAll(/[`"']/gu, "");

const staticInlineAssignmentValues = (snippet: string): readonly string[] =>
  [
    ...snippet.matchAll(
      /(?:^|[\s;])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;\r\n]+))/gmu,
    ),
  ]
    .map((match) => match[ONE] ?? match[2] ?? match[3] ?? "")
    .filter((value) => value.length > ZERO);

const inlineSnippetStreamRedactionValues = (snippet: string): readonly string[] =>
  Object.freeze([
    ...new Set([
      snippet,
      ...staticInlineAssignmentValues(snippet),
      ...snippet.split(/\r?\n/u).flatMap((line) => {
        const trimmed = line.trim();
        const withoutRedirection = trimmed.split(/[<>]/u, ONE)[ZERO]?.trim() ?? "";
        return [
          line,
          trimmed,
          stripShellDiagnosticQuotes(trimmed),
          withoutRedirection,
          stripShellDiagnosticQuotes(withoutRedirection),
        ].filter((value) => value.length > ZERO);
      }),
    ]),
  ]);

const inlineSnippetDiagnosticRedactionValues = (snippet: string): readonly string[] =>
  Object.freeze([
    ...new Set([
      ...inlineSnippetStreamRedactionValues(snippet),
      ...snippet
        .split(/[\s&|;()<>]+/u)
        .map((token) => token.replace(/^[`"']+/u, "").replace(/[`"']+$/u, ""))
        .filter((token) => token.length > ZERO),
    ]),
  ]);

const concatenateBytes = (
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> => {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, ZERO);
  combined.set(right, left.length);
  return combined;
};

const byteSequenceIndex = (haystack: Uint8Array, needle: Uint8Array): number => {
  const finalStart = haystack.length - needle.length;
  for (let start = ZERO; start <= finalStart; start += ONE) {
    let matches = true;
    for (let offset = ZERO; offset < needle.length; offset += ONE) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -ONE;
};

const bytesEndWithPrefix = (haystack: Uint8Array, needle: Uint8Array, length: number): boolean => {
  const start = haystack.length - length;
  for (let offset = ZERO; offset < length; offset += ONE) {
    if (haystack[start + offset] !== needle[offset]) return false;
  }
  return true;
};

const redactHookOutputStream = (
  stream: ReadableStream,
  values: readonly string[] | undefined,
): ReadableStream => {
  const encoder = new TextEncoder();
  const redactedValues = [
    ...new Map(
      (values ?? [])
        .filter((value) => value.length > ZERO)
        .map((value) => [value, encoder.encode(value)] as const),
    ).values(),
  ].toSorted((left, right) => right.length - left.length);
  if (redactedValues.length === ZERO) return stream;

  const replacement = encoder.encode(REDACTED_INLINE_OUTPUT);
  let pending = new Uint8Array();
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, flush: boolean): void => {
    while (pending.length > ZERO) {
      let matchIndex = -ONE;
      let matchedValue: Uint8Array | undefined;
      for (const value of redactedValues) {
        const index = byteSequenceIndex(pending, value);
        if (index >= ZERO && (matchIndex < ZERO || index < matchIndex)) {
          matchIndex = index;
          matchedValue = value;
        }
      }
      if (matchedValue !== undefined) {
        if (matchIndex > ZERO) controller.enqueue(pending.slice(ZERO, matchIndex));
        controller.enqueue(replacement);
        pending = pending.slice(matchIndex + matchedValue.length);
        continue;
      }
      if (flush) {
        controller.enqueue(pending);
        pending = new Uint8Array();
        return;
      }
      let retainedLength = ZERO;
      for (const value of redactedValues) {
        const maximumCandidate = Math.min(value.length - ONE, pending.length);
        for (let length = maximumCandidate; length > retainedLength; length -= ONE) {
          if (bytesEndWithPrefix(pending, value, length)) {
            retainedLength = length;
            break;
          }
        }
      }
      const safeLength = pending.length - retainedLength;
      if (safeLength === ZERO) return;
      controller.enqueue(pending.slice(ZERO, safeLength));
      pending = pending.slice(safeLength);
    }
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      emit(controller, true);
    },
    transform(chunk, controller) {
      pending = concatenateBytes(pending, chunk);
      emit(controller, false);
    },
  });
  return (stream as ReadableStream<Uint8Array>).pipeThrough(transform);
};

const executeHookUnpaused = async (options: NativeHookExecutionOptions): Promise<HookResult> => {
  const startTime = Date.now();
  const timeout = options.timeout ?? DEFAULT_LIFECYCLE_HOOK_TIMEOUT;
  const hookInputMode = options.hookInputMode ?? options.context.hookInputMode ?? "unavailable";
  const interactiveOutput = hookInputMode === "tty" && options.quiet !== true;

  if (interactiveOutput) {
    console.log(formatInteractiveHookAttribution(options));
  } else if (!options.quiet) {
    console.log(`🪝 Executing hook: ${options.hookName}`);
  }

  let lineageDirectory: string | undefined;
  let lineageDescriptor: number | undefined;
  let terminalSignalMarkerPath: string | undefined;
  let terminalSignalRequestPath: string | undefined;
  let terminalSignalAckPath: string | undefined;
  let terminalSignalObserver: ReturnType<typeof runtime.spawn> | undefined;
  let terminalSignalObservationUnavailable = false;
  let interruptCleanup: Promise<void> | undefined;
  let settledResult: HookResult | undefined;
  let pendingInterrupt = false;
  let activeForwardInterrupt = (): void => {
    pendingInterrupt = true;
  };
  const handleInterrupt = (): void => activeForwardInterrupt();
  process.on("SIGINT", handleInterrupt);
  try {
    if (process.platform !== "win32") {
      lineageDirectory = mkdtempSync(join(tmpdir(), "arashi-hook-lineage-"));
      lineageDescriptor = openSync(join(lineageDirectory, "lineage"), "w");
      if (process.stdin.isTTY === true) {
        terminalSignalMarkerPath = join(lineageDirectory, "terminal-sigint");
        terminalSignalRequestPath = join(lineageDirectory, "terminal-signal-request");
        terminalSignalAckPath = join(lineageDirectory, "terminal-signal-ack");
        const observerReadyPath = join(lineageDirectory, "terminal-observer-ready");
        terminalSignalObserver = runtime.spawn(
          [
            "sh",
            "-c",
            'trap \'printf observed > "$ARASHI_TERMINAL_SIGINT"; if [ -f "$ARASHI_SIGNAL_REQUEST" ]; then printf terminal > "$ARASHI_SIGNAL_ACK"; rm -f "$ARASHI_SIGNAL_REQUEST"; fi\' INT; trap \'kill "$observer_child" 2>/dev/null; exit 0\' TERM; printf ready > "$ARASHI_SIGNAL_OBSERVER_READY"; while :; do if [ -f "$ARASHI_SIGNAL_REQUEST" ]; then if [ -f "$ARASHI_TERMINAL_SIGINT" ]; then printf terminal > "$ARASHI_SIGNAL_ACK"; else printf direct > "$ARASHI_SIGNAL_ACK"; fi; rm -f "$ARASHI_SIGNAL_REQUEST"; fi; sleep 0.005 & observer_child=$!; wait "$observer_child"; done',
          ],
          {
            env: {
              ...process.env,
              ARASHI_SIGNAL_OBSERVER_READY: observerReadyPath,
              ARASHI_SIGNAL_REQUEST: terminalSignalRequestPath,
              ARASHI_SIGNAL_ACK: terminalSignalAckPath,
              ARASHI_TERMINAL_SIGINT: terminalSignalMarkerPath,
            },
            stderr: "ignore",
            stdin: "ignore",
            stdout: "ignore",
          },
        );
        await terminalSignalObserver.spawned;
        for (let attempt = 0; attempt < 100 && !existsSync(observerReadyPath); attempt += ONE) {
          await new Promise((resolveReady) => setTimeout(resolveReady, ONE));
        }
        if (!existsSync(observerReadyPath)) {
          terminalSignalObserver.kill("SIGTERM");
          terminalSignalObserver = undefined;
          terminalSignalMarkerPath = undefined;
          terminalSignalObservationUnavailable = true;
        }
      }
    } else if (process.stdin.isTTY === true) {
      const powershellLookup = runtime.spawnSync(["where.exe", "powershell.exe"], {
        stderr: "ignore",
        stdout: "ignore",
      });
      if (powershellLookup.exitCode !== ZERO) {
        terminalSignalObservationUnavailable = true;
      } else {
        lineageDirectory = mkdtempSync(join(tmpdir(), "arashi-hook-observer-"));
        terminalSignalMarkerPath = join(lineageDirectory, "terminal-sigint");
        terminalSignalRequestPath = join(lineageDirectory, "terminal-signal-request");
        terminalSignalAckPath = join(lineageDirectory, "terminal-signal-ack");
        const observerReadyPath = join(lineageDirectory, "terminal-observer-ready");
        terminalSignalObserver = runtime.spawn(
          [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            '$handler = [ConsoleCancelEventHandler]{ param($sender, $eventArgs) [IO.File]::WriteAllText($env:ARASHI_TERMINAL_SIGINT, "observed"); if ([IO.File]::Exists($env:ARASHI_SIGNAL_REQUEST)) { [IO.File]::WriteAllText($env:ARASHI_SIGNAL_ACK, "terminal"); [IO.File]::Delete($env:ARASHI_SIGNAL_REQUEST) }; $eventArgs.Cancel = $true }; [Console]::add_CancelKeyPress($handler); [IO.File]::WriteAllText($env:ARASHI_SIGNAL_OBSERVER_READY, "ready"); try { while ($true) { if ([IO.File]::Exists($env:ARASHI_SIGNAL_REQUEST) -and [IO.File]::Exists($env:ARASHI_TERMINAL_SIGINT)) { [IO.File]::WriteAllText($env:ARASHI_SIGNAL_ACK, "terminal"); [IO.File]::Delete($env:ARASHI_SIGNAL_REQUEST) }; Start-Sleep -Milliseconds 5 } } finally { [Console]::remove_CancelKeyPress($handler) }',
          ],
          {
            env: {
              ...process.env,
              ARASHI_SIGNAL_OBSERVER_READY: observerReadyPath,
              ARASHI_SIGNAL_REQUEST: terminalSignalRequestPath,
              ARASHI_SIGNAL_ACK: terminalSignalAckPath,
              ARASHI_TERMINAL_SIGINT: terminalSignalMarkerPath,
            },
            stderr: "ignore",
            stdin: "ignore",
            stdout: "ignore",
          },
        );
        await terminalSignalObserver.spawned;
        for (let attempt = 0; attempt < 1000 && !existsSync(observerReadyPath); attempt += ONE) {
          await new Promise((resolveReady) => setTimeout(resolveReady, ONE));
        }
        if (!existsSync(observerReadyPath)) {
          terminalSignalObserver.kill("SIGTERM");
          terminalSignalObserver = undefined;
          terminalSignalMarkerPath = undefined;
          terminalSignalObservationUnavailable = true;
        }
      }
    }
    if (pendingInterrupt) {
      settledResult = {
        duration: Date.now() - startTime,
        exitCode: INTERRUPTED_EXIT_CODE,
        killed: true,
        signalCode: "SIGINT",
        stderr: "",
        stdout: "",
        success: false,
        timedOut: false,
      };
      return settledResult;
    }
    const spawnCommand = options.spawnCommand ?? getHookSpawnCommand(options.scriptPath);
    const proc = runtime.spawn(spawnCommand, {
      callBatchFile:
        options.spawnCommand === undefined && /\.(?:cmd|bat)$/i.test(options.scriptPath),
      cwd: options.context.repoPath,
      env: buildHookEnvironment({ ...options.context, hookInputMode }),
      extraStdio: lineageDescriptor === undefined ? [] : [lineageDescriptor],
      killSignal: "SIGTERM",
      stdin: hookInputMode === "tty" ? "inherit" : "ignore",
      stderr: "pipe",
      stdout: "pipe",
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    if (lineageDescriptor !== undefined) {
      closeSync(lineageDescriptor);
      lineageDescriptor = undefined;
    }
    let interrupted = false;
    let interruptEscalation: ReturnType<typeof setTimeout> | undefined;
    let interruptedProcessIds: number[] = [];
    let timeoutTriggered = false;
    let hookTimeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutEscalation: ReturnType<typeof setTimeout> | undefined;
    const captureHookProcessTree = (roots: number[]): number[] => {
      const listing =
        process.platform === "win32"
          ? runtime.spawnSync(
              [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-Command",
                'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
              ],
              { stderr: "ignore" },
            )
          : runtime.spawnSync(["ps", "-eo", "pid=,ppid="], { stderr: "ignore" });
      if (listing.exitCode !== ZERO) return roots;
      const children = new Map<number, number[]>();
      for (const line of listing.stdout.toString().split("\n")) {
        const [pidText, parentText] = line.trim().split(/\s+/);
        const pid = Number.parseInt(pidText, 10);
        const parent = Number.parseInt(parentText, 10);
        if (![pid, parent].every((value) => Number.isInteger(value))) continue;
        children.set(parent, [...(children.get(parent) ?? []), pid]);
      }
      const result: number[] = [];
      const visited = new Set<number>();
      const visit = (pid: number): void => {
        if (visited.has(pid)) return;
        visited.add(pid);
        for (const child of children.get(pid) ?? []) visit(child);
        result.push(pid);
      };
      for (const root of roots) visit(root);
      return result;
    };
    const captureHookLineage = (): number[] => {
      if (!lineageDirectory || process.platform === "win32") return [];
      const lineagePath = join(lineageDirectory, "lineage");
      if (process.platform === "linux") {
        const holders: number[] = [];
        let processEntries: Array<import("fs").Dirent<string>>;
        try {
          processEntries = readdirSync("/proc", { withFileTypes: true });
        } catch {
          return [];
        }
        for (const entry of processEntries) {
          if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
          const descriptorDirectory = join("/proc", entry.name, "fd");
          try {
            if (
              readdirSync(descriptorDirectory).some((descriptor) => {
                try {
                  return readlinkSync(join(descriptorDirectory, descriptor)) === lineagePath;
                } catch {
                  return false;
                }
              })
            ) {
              holders.push(Number.parseInt(entry.name, 10));
            }
          } catch {
            // Processes can exit or deny inspection between /proc reads.
          }
        }
        return holders;
      }
      const holders = runtime.spawnSync(["/usr/sbin/lsof", "-t", "--", lineagePath], {
        stderr: "ignore",
      });
      if (holders.exitCode !== ZERO) return [];
      return holders.stdout
        .toString()
        .split("\n")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((pid) => Number.isInteger(pid));
    };
    const signalHookTree = (signal: NodeJS.Signals): void => {
      if (!proc.pid) {
        proc.kill(signal);
        return;
      }
      if (interruptedProcessIds.length === 0) {
        const roots = [proc.pid, ...(process.platform === "win32" ? [] : captureHookLineage())];
        interruptedProcessIds = captureHookProcessTree(roots);
      } else if (signal === "SIGKILL") {
        const roots = [
          ...new Set([
            ...interruptedProcessIds,
            ...(process.platform === "win32" ? [] : captureHookLineage()),
          ]),
        ];
        interruptedProcessIds = captureHookProcessTree(roots);
      }
      if (process.platform === "win32") {
        if (signal !== "SIGKILL") {
          proc.kill(signal);
          return;
        }
        for (const pid of interruptedProcessIds.map(
          (_, index, values) => values[values.length - index - ONE],
        )) {
          runtime.spawnSync(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
            stderr: "ignore",
          });
        }
        return;
      }
      const processIds =
        signal === "SIGKILL"
          ? interruptedProcessIds.map((_, index, values) => values[values.length - index - ONE])
          : interruptedProcessIds;
      for (const pid of processIds) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    };
    hookTimeout = setTimeout(() => {
      timeoutTriggered = true;
      signalHookTree("SIGTERM");
      timeoutEscalation = setTimeout(() => signalHookTree("SIGKILL"), 250);
    }, timeout);
    activeForwardInterrupt = (): void => {
      pendingInterrupt = true;
      if (interrupted) return;
      interrupted = true;
      interruptCleanup = new Promise((resolveCleanup) => {
        interruptEscalation = setTimeout(() => {
          try {
            signalHookTree("SIGKILL");
          } finally {
            resolveCleanup();
          }
        }, 250);
        const forwardOrObserveInterrupt = async (): Promise<void> => {
          if (
            terminalSignalObserver &&
            terminalSignalMarkerPath &&
            terminalSignalRequestPath &&
            terminalSignalAckPath
          ) {
            rmSync(terminalSignalAckPath, { force: true });
            writeFileSync(terminalSignalRequestPath, "check");
            for (
              let attempt = 0;
              attempt < 100 &&
              !existsSync(terminalSignalMarkerPath) &&
              !existsSync(terminalSignalAckPath);
              attempt += ONE
            ) {
              await new Promise((resolveAck) => setTimeout(resolveAck, ONE));
            }
            if (existsSync(terminalSignalMarkerPath)) return;
            // POSIX can acknowledge direct-only delivery after the shell trap boundary. Windows
            // has no ordered cross-process completion event for console-control dispatch, so an
            // absent acknowledgement is intentionally treated as unknown and never forwarded.
            if (!existsSync(terminalSignalAckPath)) return;
            if (readFileSync(terminalSignalAckPath, "utf8") === "terminal") return;
          }
          // Without a terminal observer, console-origin delivery is ambiguous. The bounded tree
          // escalation below remains authoritative without risking a duplicate Ctrl-C delivery.
          if (terminalSignalObservationUnavailable) return;
          signalHookTree("SIGINT");
        };
        void forwardOrObserveInterrupt();
      });
    };
    if (pendingInterrupt) activeForwardInterrupt();

    try {
      const timeoutCleanup = proc.exited.then(() => {
        if (timeoutTriggered) signalHookTree("SIGKILL");
        if (timeoutEscalation) clearTimeout(timeoutEscalation);
      });
      const stdoutStream = redactHookOutputStream(proc.stdout, options.redactedOutputValues);
      const stderrStream = redactHookOutputStream(
        proc.stderr,
        options.redactedErrorValues ?? options.redactedOutputValues,
      );
      const [stdout, stderr] = interactiveOutput
        ? await Promise.all([
            streamRawOutput(stdoutStream, (chunk) => process.stdout.write(chunk)),
            streamRawOutput(stderrStream, (chunk) => process.stderr.write(chunk)),
          ])
        : await Promise.all([
            streamOutput(stdoutStream, `[${options.hookName}:OUT]`, options.quiet),
            streamOutput(stderrStream, `[${options.hookName}:ERR]`, options.quiet),
          ]);

      await timeoutCleanup;
      if (hookTimeout) clearTimeout(hookTimeout);
      if (interruptCleanup) await interruptCleanup;

      const duration = Date.now() - startTime;
      const childExitCode = proc.exitCode ?? -ONE;
      const exitCode = interrupted
        ? INTERRUPTED_EXIT_CODE
        : timeoutTriggered
          ? -ONE
          : childExitCode;

      settledResult = {
        duration,
        exitCode,
        killed: proc.killed || interrupted || timeoutTriggered,
        signalCode: interrupted ? "SIGINT" : timeoutTriggered ? "SIGTERM" : proc.signalCode,
        stderr,
        stdout,
        success: exitCode === ZERO,
        timedOut: timeoutTriggered,
      };
      return settledResult;
    } finally {
      if (hookTimeout) clearTimeout(hookTimeout);
      if (timeoutEscalation) clearTimeout(timeoutEscalation);
      if (interruptEscalation) clearTimeout(interruptEscalation);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    settledResult = {
      duration,
      exitCode: -ONE,
      killed: false,
      signalCode: null,
      stderr: `Failed to execute hook: ${errorMessage}`,
      stdout: "",
      success: false,
      timedOut: false,
    };
    return settledResult;
  } finally {
    if (terminalSignalObserver) {
      terminalSignalObserver.kill("SIGTERM");
      await Promise.race([
        terminalSignalObserver.exited,
        new Promise((resolveObserver) => setTimeout(resolveObserver, 100)),
      ]);
      if (terminalSignalObserver.exitCode === null) terminalSignalObserver.kill("SIGKILL");
    }
    if (interruptCleanup) await interruptCleanup;
    if (lineageDescriptor !== undefined) closeSync(lineageDescriptor);
    if (lineageDirectory) rmSync(lineageDirectory, { force: true, recursive: true });
    if (pendingInterrupt && settledResult) {
      settledResult.exitCode = INTERRUPTED_EXIT_CODE;
      settledResult.killed = true;
      settledResult.signalCode = "SIGINT";
      settledResult.success = false;
      settledResult.timedOut = false;
    }
    if (pendingInterrupt) retainedInterruptHandlers.add(handleInterrupt);
    else process.off("SIGINT", handleInterrupt);
  }
};

export const executeHook = (options: HookExecutionOptions): Promise<HookResult> =>
  withSpinnerPaused(options.outputSpinner, () => executeHookUnpaused(options));

export const getInlineHookSpawnCommand = (
  executablePath: string,
  interpreter: InlineHookInterpreter,
  snippet: string,
): string[] => {
  if (interpreter === "bash") {
    return [executablePath, "-c", snippet];
  }
  if (interpreter === "powershell") {
    return [
      executablePath,
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      snippet,
    ];
  }
  return [executablePath, "/d", "/e:on", "/v:off", "/s", "/c", snippet];
};

export interface InlineHookSourceMetadata {
  sourceKind: "inline-config";
  sourceOwnerKind: "repository" | "workspace";
  sourceOwnerName: string | null;
  sourceScriptPath: null;
}

export interface ExecuteInlineHookOptions {
  context: HookContext;
  hookInputMode?: HookInputMode;
  hookName: string;
  outputSpinner?: PausableSpinner | null;
  progress?: boolean;
  quiet?: boolean;
  resolution: AvailableInlineHookInterpreterResolution;
  snippet: string;
  source: InlineHookSourceMetadata;
  timeout?: number;
}

export const executeInlineHook = async (
  options: ExecuteInlineHookOptions,
): Promise<{ outcome: Record<string, unknown>; result: HookResult }> => {
  const executionOptions: NativeHookExecutionOptions = {
    context: {
      ...options.context,
      hookName: options.hookName,
      sourceScriptPath: undefined,
    },
    hookInputMode: options.hookInputMode,
    hookName: options.hookName,

    outputSpinner: options.outputSpinner,
    quiet: options.quiet,
    redactedErrorValues: inlineSnippetDiagnosticRedactionValues(options.snippet),
    redactedOutputValues: inlineSnippetStreamRedactionValues(options.snippet),
    scriptPath: options.resolution.executablePath,
    sourceKind: options.source.sourceKind,
    sourceOwnerKind: options.source.sourceOwnerKind,
    sourceOwnerName: options.source.sourceOwnerName,
    spawnCommand: getInlineHookSpawnCommand(
      options.resolution.executablePath,
      options.resolution.interpreter,
      options.snippet,
    ),
    timeout: options.timeout,
    windowsVerbatimArguments: options.resolution.interpreter === "cmd",
  };
  const result = await withSpinnerPaused(
    options.quiet === true || options.progress === false ? undefined : options.outputSpinner,
    () => executeHookUnpaused(executionOptions),
  );
  const mapped = mapHookExecutionResult(result);
  return {
    outcome: {
      environment: null,
      errors: [],
      findings: [],
      hookName: options.hookName,
      logs: [],
      ...mapped,
      previews: [],
      ...options.source,
    },
    result,
  };
};

/**
 * High-level function to discover, validate, and execute a hook for a lifecycle point.
 *
 * @param lifecyclePoint - Name of the lifecycle point (e.g., "pre-create")
 * @param repoPath - Absolute path to the repository
 * @param operationData - Context-specific data for the hook
 * @param options - Optional settings (skipHooks, timeout)
 * @returns Execution result if hook ran, null if skipped or not found
 */
const normalizeRunLifecycleHookArgs = (...args: RunLifecycleHookArgs): RunLifecycleHookOptions => {
  const [firstArg, repoPath, operationData, options] = args;
  if (
    typeof firstArg === "object" &&
    firstArg !== null &&
    "lifecyclePoint" in firstArg &&
    "repoPath" in firstArg &&
    "operationData" in firstArg
  ) {
    return firstArg as RunLifecycleHookOptions;
  }

  return {
    lifecyclePoint: firstArg as string,
    operationData: operationData as Record<string, string>,
    options,
    repoPath: repoPath as string,
  };
};

export const runLifecycleHook = async (
  ...args: RunLifecycleHookArgs
): Promise<HookResult | null> => {
  const { lifecyclePoint, operationData, options, repoPath } = normalizeRunLifecycleHookArgs(
    ...args,
  );
  if (options?.skipHooks) {
    console.log(`⏭️  Skipping hooks (--no-hooks flag)`);
    return null;
  }

  const hookPath = await findHook(lifecyclePoint, repoPath);
  if (!hookPath) {
    return null;
  }

  const validation = await validateHook(hookPath);
  if (!validation.valid) {
    console.error(`❌ Hook validation failed: ${validation.error}`);
    return null;
  }

  const result = await executeHook({
    context: {
      hookName: lifecyclePoint,
      operationData,
      repoPath,
    },
    hookName: lifecyclePoint,
    scriptPath: hookPath,
    timeout: options?.timeout,
  });

  if (result.success) {
    console.log(`✅ Hook "${lifecyclePoint}" succeeded (${result.duration}ms)`);
  } else if (result.timedOut) {
    console.warn(`⏱️  Hook "${lifecyclePoint}" timed out after ${result.duration}ms`);
  } else {
    console.warn(`⚠️  Hook "${lifecyclePoint}" failed with exit code ${result.exitCode}`);
  }

  return result;
};
