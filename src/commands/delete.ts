import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Command } from "commander";
import { loadConfigureSnapshot, type ConfigureSnapshot } from "./configure.ts";
import { ConfigError } from "../lib/config.ts";
import { inspectGitWorktreeTopology, type WorktreeRemovalPlan } from "../lib/delete-topology.ts";
import { exec as gitExec } from "../lib/git.ts";
import { GitFetchUrlIdentityError, gitFetchUrlsMatch } from "../lib/delete-git-url.ts";
import {
  discoverConfiguredRepositoryRemoveHookCandidates,
  discoverLifecycleHookCandidates,
  discoverLifecycleHookCandidatesInDirectory,
  lifecycleHookExtensions,
} from "../lib/hooks.ts";
import { GitLossEvidenceError, inspectRepositoryGitLoss } from "../lib/delete-git-loss.ts";
import {
  adoptUnpreparedQuarantine,
  captureDeletionIdentity,
  deletionRetirementPath,
  quarantineAndRetainIdentity,
  validateDeletionIdentity,
  validateExpectedAbsence,
  validatePreparedQuarantine,
  validateResidueIdentity,
  type DeletionPathIdentity,
} from "../lib/delete-identity.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { confirm, multiSelect } from "../lib/prompts.ts";
import {
  resolveWorkspaceTransactionLockPath,
  withWorkspaceTransactionLock,
} from "../lib/workspace-transaction-lock.ts";
import { persistExpectedBytesAtomically } from "../lib/configure-transaction.ts";
import {
  allocateDeleteGenerationSuffix,
  createDeleteResumeReceipt,
  normalizePreparedDeleteWarnings,
  recoverDeleteConfigurationBytes,
  remapDeleteResidues,
  readValidatedDeleteReceipt,
  readValidatedDeleteReceiptBytes,
  receiptPathForRepositoryKey,
  receiptPlanConfigDigest,
  removeDeleteResumeReceipt,
  runDeleteBatchTransaction,
  terminalDeleteResiduePath,
  updateDeleteResumeReceipt,
  type DeleteResumeReceipt,
  type DeleteTerminalResidue,
  type ValidatedDeleteReceipt,
} from "../lib/delete-transaction.ts";
import resolveUnaliasedPhysicalPath from "../lib/physical-path.ts";
import {
  ConfiguredWorkspaceRequiredError,
  resolveWorkspaceContext,
} from "../lib/workspace-context.ts";

export interface DeleteCommandOptions {
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

export const DELETE_ITEM_KINDS = [
  "resume-receipt",
  "canonical-clone",
  "linked-worktree",
  "worktree-metadata",
  "local-ref",
  "config-entry",
  "workspace-hook",
  "preserved-global-hook",
] as const;
export type DeleteItemKind = (typeof DELETE_ITEM_KINDS)[number];
export type DeleteItemState =
  | "planned"
  | "completed"
  | "preserved"
  | "blocked"
  | "failed"
  | "not-started";

export interface DeleteRepositoryItem {
  id: string;
  kind: DeleteItemKind;
  ownership: "delete" | "preserve";
  path: string | null;
  ref: string | null;
  oid: string | null;
  planned: boolean;
  completed: boolean;
  state: DeleteItemState;
  reasonCode: string | null;
  message: string | null;
}

export interface DeleteRepositoryPlan {
  id: string;
  items: DeleteRepositoryItem[];
  warnings: string[];
}

export const DELETE_PHASE_NAMES = [
  "provenance",
  "worktrees",
  "metadata",
  "canonical-clone",
  "workspace-hooks",
  "configuration",
  "verification",
] as const;
export type DeletePhaseName = (typeof DELETE_PHASE_NAMES)[number];

const CLOSED_DELETE_ERROR_CODES = new Set([
  "CONFIGURED_WORKSPACE_REQUIRED",
  "DELETE_SELECTION_REQUIRED",
  "DELETE_REPOSITORY_NOT_FOUND",
  "DELETE_CONFIG_INVALID",
  "DELETE_TOPOLOGY_INVALID",
  "DELETE_PATH_UNSAFE",
  "DELETE_HOOK_AMBIGUOUS",
  "DELETE_GIT_DATA_LOSS",
  "DELETE_CONFIRMATION_REQUIRED",
  "DELETE_CANCELLED",
  "DELETE_CONCURRENT_CHANGE",
  "DELETE_EXECUTION_FAILED",
  "DELETE_PARTIAL_FAILURE",
  "DELETE_RECEIPT_INVALID",
  "DELETE_RECEIPT_STALE",
  "DELETE_RECEIPT_UNSAFE",
]);

export const closedDeleteErrorCode = (
  error: unknown,
  fallback = "DELETE_EXECUTION_FAILED",
): string => {
  const candidate =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : fallback;
  return CLOSED_DELETE_ERROR_CODES.has(candidate) ? candidate : fallback;
};

const closedDeleteJsonError = (error: unknown, fallback: string) => {
  const converted = unknownErrorToJsonError(error, fallback);
  return CLOSED_DELETE_ERROR_CODES.has(converted.code)
    ? converted
    : { ...converted, code: fallback };
};

export interface DeletePhase {
  name: DeletePhaseName;
  state: "not-started" | "started" | "completed" | "failed";
  itemIds: string[];
  error: { code: string; message: string } | null;
  startedOrder: number | null;
  completedOrder: number | null;
}

export interface DeleteRepositoryResult {
  items: DeleteRepositoryItem[];
  phases: DeletePhase[];
  retry: { safe: boolean; argv: string[] | null; guidance: string };
  warnings: string[];
}

export interface DeleteConfigChainEntry {
  repositoryKey: string;
  expectedBefore: Uint8Array;
  expectedAfter: Uint8Array;
}

const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const sortRepositoryKeys = (keys: readonly string[]): string[] =>
  [...new Set(keys)].toSorted(bytewise);

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const topologyIdentity = (value: WorktreeRemovalPlan) => ({
  commonDirectory: value.commonDirectory,
  canonicalClonePath: value.canonicalClonePath,
  linkedWorktrees: value.linkedWorktrees,
  staleMetadata: value.staleMetadata,
});

const refEvidence = (items: readonly DeleteRepositoryItem[]) =>
  items
    .filter(({ kind }) => kind === "local-ref")
    .map(({ kind, ownership, path, ref, oid, reasonCode, message }) => ({
      kind,
      ownership,
      path,
      ref,
      oid,
      reasonCode,
      message,
    }));

const phaseRank: Record<DeleteItemKind, number> = {
  "resume-receipt": 0,
  "linked-worktree": 1,
  "worktree-metadata": 2,
  "canonical-clone": 3,
  "local-ref": 3,
  "workspace-hook": 4,
  "config-entry": 5,
  "preserved-global-hook": 6,
};

const itemIdentity = (item: DeleteRepositoryItem): string =>
  [item.path ?? "", item.ref ?? "", item.oid ?? ""].join("\0");

const normalizeItem = (source: DeleteRepositoryItem): DeleteRepositoryItem => {
  const projected = {
    kind: source.kind,
    ownership: source.ownership,
    path: source.path,
    ref: source.ref,
    oid: source.oid,
    planned: source.planned,
    completed: source.completed,
    state: source.state,
    reasonCode: source.reasonCode,
    message: source.message,
  };
  return { id: source.id || stableHash(projected), ...projected };
};

export const createDeletePlan = (
  items: readonly DeleteRepositoryItem[],
  warnings: readonly string[],
  authority: { configDigest: string },
): DeleteRepositoryPlan => {
  const normalizedItems = items.map(normalizeItem).toSorted((left, right) => {
    const rank = phaseRank[left.kind] - phaseRank[right.kind];
    if (rank !== 0) return rank;
    if (left.kind === "linked-worktree" && right.kind === "linked-worktree") {
      const depth =
        (right.path?.split(/[\\/]/u).length ?? 0) - (left.path?.split(/[\\/]/u).length ?? 0);
      if (depth !== 0) return depth;
    }
    return bytewise(itemIdentity(left), itemIdentity(right));
  });
  const normalizedWarnings = sortRepositoryKeys(warnings);
  return {
    id: stableHash({ authority, items: normalizedItems, warnings: normalizedWarnings }),
    items: normalizedItems,
    warnings: normalizedWarnings,
  };
};

export const buildDeleteConfigChain = (
  initialBytes: Uint8Array,
  repositoryKeys: readonly string[],
): DeleteConfigChainEntry[] => {
  const parsed = JSON.parse(Buffer.from(initialBytes).toString("utf8")) as {
    repos?: Record<string, unknown>;
    discoveredRepos?: Record<string, unknown>;
    discovered_repos?: Record<string, unknown>;
  };
  const repositoryMapKey = parsed.repos
    ? "repos"
    : parsed.discoveredRepos
      ? "discoveredRepos"
      : "discovered_repos";
  let before = initialBytes;
  return sortRepositoryKeys(repositoryKeys).map((repositoryKey) => {
    const map = parsed[repositoryMapKey] ?? {};
    delete map[repositoryKey];
    parsed[repositoryMapKey] = map;
    const after = new TextEncoder().encode(`${JSON.stringify(parsed, null, 2)}\n`);
    const entry = { expectedAfter: after, expectedBefore: before, repositoryKey };
    before = after;
    return entry;
  });
};

const phaseItems = (plan: DeleteRepositoryPlan, name: DeletePhaseName): string[] => {
  const kinds: Record<DeletePhaseName, DeleteItemKind[]> = {
    provenance: ["resume-receipt"],
    worktrees: ["linked-worktree"],
    metadata: ["worktree-metadata"],
    "canonical-clone": ["canonical-clone", "local-ref"],
    "workspace-hooks": ["workspace-hook"],
    configuration: ["config-entry"],
    verification: ["preserved-global-hook"],
  };
  return plan.items.filter((item) => kinds[name].includes(item.kind)).map((item) => item.id);
};

export const createDeleteResult = (
  plan: DeleteRepositoryPlan,
  _repositoryKey: string,
  _json: boolean,
): DeleteRepositoryResult => ({
  items: plan.items.map((item) => ({ ...item, state: item.planned ? "not-started" : item.state })),
  phases: DELETE_PHASE_NAMES.map((name) => ({
    name,
    state: "not-started",
    itemIds: phaseItems(plan, name),
    error: null,
    startedOrder: null,
    completedOrder: null,
  })),
  retry: {
    safe: false,
    argv: null,
    guidance: "No current durable receipt exists; inspect surviving state before retrying.",
  },
  warnings: [...plan.warnings],
});

export interface DeleteOrchestrationContext {
  repositoryKeys: string[];
  workspace: {
    mode: "configured";
    repositoriesBase: string;
    workspaceRoot: string;
    worktreesBase: string;
  };
}

export interface AcceptedDeletePlan {
  repositoryKey: string;
  plan: DeleteRepositoryPlan;
}

export interface DeleteBatchEntry extends AcceptedDeletePlan {
  result: DeleteRepositoryResult | null;
  state: "completed" | "failed" | "not-started";
  irreversibleCompleted?: boolean;
  failureCode?: string;
}

export interface DeleteOrchestrationResult {
  exitCode: number;
  errorCode: string | null;
  confirmation: "not-required" | "confirmed" | "declined" | "required";
  repositories: DeleteBatchEntry[];
}

const sanitizeHumanText = (value: string): string =>
  [...value]
    .map((character) => {
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      if (/^[\p{Cc}\p{Cf}]$/u.test(character))
        return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      return character;
    })
    .join("");

const humanItem = (item: DeleteRepositoryItem): string => {
  if (item.kind === "local-ref")
    return `${sanitizeHumanText(item.ref ?? "(unknown ref)")} @ ${sanitizeHumanText(item.oid ?? "(unknown oid)")}`;
  if (item.kind === "config-entry")
    return `${sanitizeHumanText(item.ref ?? "(unknown entry)")} in ${sanitizeHumanText(item.path ?? "(unknown file)")}`;
  return sanitizeHumanText(item.path ?? item.ref ?? "(no path)");
};

const previewGroups: ReadonlyArray<{
  heading: string;
  kinds: readonly DeleteItemKind[];
}> = [
  { heading: "Canonical clone", kinds: ["canonical-clone"] },
  { heading: "Linked worktrees", kinds: ["linked-worktree"] },
  { heading: "Worktree metadata", kinds: ["worktree-metadata"] },
  { heading: "Local refs", kinds: ["local-ref"] },
  { heading: "Workspace hooks", kinds: ["workspace-hook"] },
  { heading: "Configuration entry", kinds: ["config-entry"] },
  { heading: "Preserved global hooks", kinds: ["preserved-global-hook"] },
];

export const renderDeleteHumanPreview = (accepted: readonly AcceptedDeletePlan[]): string => {
  const lines = ["Delete plan:"];
  for (const { plan, repositoryKey } of accepted) {
    lines.push(`Repository: ${sanitizeHumanText(repositoryKey)}`);
    for (const group of previewGroups) {
      const items = plan.items.filter(({ kind }) => group.kinds.includes(kind));
      lines.push(`${group.heading}:`);
      if (items.length === 0) lines.push("  - none");
      else for (const item of items) lines.push(`  - ${humanItem(item)}`);
    }
    lines.push("Warnings:");
    if (plan.warnings.length === 0) lines.push("  - none");
    else for (const warning of plan.warnings) lines.push(`  - ${sanitizeHumanText(warning)}`);
  }
  return `${lines.join("\n")}\n`;
};

const renderSummaryEntry = (entry: DeleteBatchEntry): string[] => {
  const lines = [`- ${sanitizeHumanText(entry.repositoryKey)}`];
  const result = entry.result;
  if (!result) return lines;
  const completedPhases = result.phases
    .filter(({ state }) => state === "completed")
    .map(({ name }) => name);
  const failedPhases = result.phases
    .filter(({ state }) => state === "failed")
    .map(({ name }) => name);
  const surviving = result.items.filter(
    ({ ownership, state }) => ownership === "delete" && state !== "completed",
  );
  lines.push(`  Completed phases: ${completedPhases.length ? completedPhases.join(", ") : "none"}`);
  lines.push(`  Failed phases: ${failedPhases.length ? failedPhases.join(", ") : "none"}`);
  lines.push("  Surviving state:");
  if (surviving.length === 0) lines.push("    - none");
  else for (const item of surviving) lines.push(`    - ${item.kind}: ${humanItem(item)}`);
  if (entry.state !== "completed") {
    if (result.retry.safe && result.retry.argv)
      lines.push(`  Retry argv: ${JSON.stringify(result.retry.argv.map(sanitizeHumanText))}`);
    else lines.push(`  Retry: ${sanitizeHumanText(result.retry.guidance)}`);
  }
  return lines;
};

export const renderDeleteHumanSummary = (entries: readonly DeleteBatchEntry[]): string => {
  const groups: Array<{ heading: string; state: DeleteBatchEntry["state"] }> = [
    { heading: "Completed repositories", state: "completed" },
    { heading: "Failing repositories", state: "failed" },
    { heading: "Not-started repositories", state: "not-started" },
  ];
  const lines = ["Delete summary:"];
  for (const group of groups) {
    lines.push(`${group.heading}:`);
    const entriesForState = entries.filter(({ state }) => state === group.state);
    if (entriesForState.length === 0) lines.push("- none");
    else for (const entry of entriesForState) lines.push(...renderSummaryEntry(entry));
  }
  return `${lines.join("\n")}\n`;
};

type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason?: "exit" | "abort" };
type DeleteChoice = { name: string; value: string };

export const orchestrateDelete = async (input: {
  context: DeleteOrchestrationContext;
  repository: string | undefined;
  options: DeleteCommandOptions;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  planner: (repositoryKey: string) => Promise<DeleteRepositoryPlan>;
  preview?: (plans: AcceptedDeletePlan[]) => Promise<void> | void;
  select?: (message: string, choices: DeleteChoice[]) => Promise<PromptOutcome<string[]>>;
  confirm?: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;
  executeBatch?: (plans: AcceptedDeletePlan[]) => Promise<DeleteBatchEntry[]>;
}): Promise<DeleteOrchestrationResult> => {
  const base = {
    confirmation: "not-required" as const,
    repositories: [] as DeleteBatchEntry[],
  };
  let selected: string[];
  if (input.repository !== undefined) {
    if (!input.context.repositoryKeys.includes(input.repository))
      return { ...base, errorCode: "DELETE_REPOSITORY_NOT_FOUND", exitCode: 1 };
    selected = [input.repository];
  } else {
    if (input.context.repositoryKeys.length === 0)
      return { ...base, errorCode: "DELETE_REPOSITORY_NOT_FOUND", exitCode: 1 };
    if (input.options.json || !input.stdinIsTTY || !input.stdoutIsTTY || input.select === undefined)
      return { ...base, errorCode: "DELETE_SELECTION_REQUIRED", exitCode: 2 };
    const selection = await input.select(
      "Select configured repositories to delete:",
      sortRepositoryKeys(input.context.repositoryKeys).map((key) => ({ name: key, value: key })),
    );
    if (selection.status === "cancelled" || selection.value.length === 0)
      return { ...base, errorCode: "DELETE_CANCELLED", exitCode: 2 };
    selected = selection.value;
  }

  const accepted: AcceptedDeletePlan[] = [];
  for (const repositoryKey of sortRepositoryKeys(selected)) {
    accepted.push({ plan: await input.planner(repositoryKey), repositoryKey });
  }
  const repositories = accepted.map(({ plan, repositoryKey }) => ({
    plan,
    repositoryKey,
    result: null,
    state: "not-started" as const,
  }));
  const hasGitLoss = accepted.some(({ plan }) =>
    plan.warnings.some((warning) => warning.startsWith("DELETE_GIT_DATA_LOSS")),
  );
  await input.preview?.(accepted);
  if (hasGitLoss && !input.options.force && !input.options.dryRun)
    return {
      confirmation: "not-required",
      repositories,
      errorCode: "DELETE_GIT_DATA_LOSS",
      exitCode: 1,
    };
  if (input.options.dryRun)
    return { confirmation: "not-required", repositories, errorCode: null, exitCode: 0 };

  let confirmation: DeleteOrchestrationResult["confirmation"] = "not-required";
  if (!input.options.force) {
    if (
      input.options.json ||
      !input.stdinIsTTY ||
      !input.stdoutIsTTY ||
      input.confirm === undefined
    )
      return {
        confirmation: "required",
        repositories,
        errorCode: "DELETE_CONFIRMATION_REQUIRED",
        exitCode: 2,
      };
    const outcome = await input.confirm(
      `Delete ${accepted.map(({ repositoryKey }) => repositoryKey).join(", ")}?`,
      false,
    );
    if (outcome.status === "cancelled" || !outcome.value)
      return { confirmation: "declined", repositories, errorCode: "DELETE_CANCELLED", exitCode: 2 };
    confirmation = "confirmed";
  }

  if (!input.executeBatch)
    return { confirmation, repositories, errorCode: "DELETE_EXECUTION_FAILED", exitCode: 1 };
  let executed: DeleteBatchEntry[];
  try {
    executed = await input.executeBatch(accepted);
  } catch (error) {
    const code = closedDeleteErrorCode(error);
    executed = accepted.map(({ plan, repositoryKey }, index) => {
      const result = createDeleteResult(plan, repositoryKey, input.options.json === true);
      if (index === 0) {
        const phase = result.phases[0]!;
        phase.state = "failed";
        phase.error = {
          code,
          message:
            error instanceof Error ? sanitizeHumanText(error.message) : "Delete execution failed.",
        };
        return { plan, repositoryKey, result, state: "failed", failureCode: code };
      }
      return { plan, repositoryKey, result, state: "not-started" };
    });
  }
  const failed = executed.some(({ state }) => state === "failed");
  const completedBeforeFailure =
    failed &&
    executed.some(
      ({ state, irreversibleCompleted }) => state === "completed" || irreversibleCompleted,
    );
  const failureCode = executed.find(({ state }) => state === "failed")?.failureCode;
  return {
    confirmation,
    repositories: executed,
    errorCode: completedBeforeFailure
      ? "DELETE_PARTIAL_FAILURE"
      : failed
        ? (failureCode ?? "DELETE_EXECUTION_FAILED")
        : null,
    exitCode: failed ? 1 : 0,
  };
};

class DeleteCommandError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly exitCode: number;

  constructor(code: string, message: string, details: Record<string, unknown>, exitCode = 1) {
    super(message);
    this.name = "DeleteCommandError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

interface PlannedRepositoryRuntime {
  acceptedConfigDigest: string;
  configPath: string;
  expectedConfigBytes: Uint8Array;
  nextConfigBytes: Uint8Array;
  clonePath: string;
  cloneIdentity: string;
  topology: WorktreeRemovalPlan;
  hookPaths: string[];
  identities: RuntimeDeletionIdentities;
  workspaceRoot: string;
  parentIdentity: string;
  originalEntryDigest: string;
  receiptPath: string;
  resumeReceipt?: DeleteResumeReceipt;
}

export interface RuntimeDeletionIdentities {
  clone: DeletionPathIdentity;
  canonicalGitAdmin: DeletionPathIdentity;
  worktrees: DeletionPathIdentity[];
  worktreeAdmins: DeletionPathIdentity[];
  metadata: DeletionPathIdentity[];
  hooks: DeletionPathIdentity[];
}

const uniqueSortedPaths = (paths: string[]): string[] =>
  [...new Set(paths.map((path) => resolve(path)))].toSorted(bytewise);

export const captureRuntimeDeletionIdentities = async (
  topology: WorktreeRemovalPlan,
  hookPaths: string[],
): Promise<RuntimeDeletionIdentities> => {
  const worktreePaths = uniqueSortedPaths(
    topology.linkedWorktrees.filter(({ present }) => present).map(({ path }) => path),
  );
  const metadataPaths = uniqueSortedPaths(topology.staleMetadata.map(({ path }) => path));
  const worktreeAdminPaths = uniqueSortedPaths(
    topology.linkedWorktrees.flatMap(({ metadataPath, present }) =>
      present && metadataPath !== null ? [metadataPath] : [],
    ),
  );
  return {
    clone: await captureDeletionIdentity(topology.canonicalClonePath, "directory"),
    canonicalGitAdmin: await captureDeletionIdentity(topology.commonDirectory, "directory"),
    hooks: await Promise.all(
      uniqueSortedPaths(hookPaths).map((path) => captureDeletionIdentity(path, "file")),
    ),
    metadata: await Promise.all(
      metadataPaths.map((path) => captureDeletionIdentity(path, "directory")),
    ),
    worktreeAdmins: await Promise.all(
      worktreeAdminPaths.map((path) => captureDeletionIdentity(path, "directory")),
    ),
    worktrees: await Promise.all(
      worktreePaths.map((path) => captureDeletionIdentity(path, "directory")),
    ),
  };
};

export const validateRuntimeDeletionIdentities = async (
  identities: RuntimeDeletionIdentities,
): Promise<void> => {
  await validateDeletionIdentity(identities.clone);
  await validateDeletionIdentity(identities.canonicalGitAdmin);
  for (const identity of [
    ...identities.worktrees,
    ...identities.worktreeAdmins,
    ...identities.metadata,
    ...identities.hooks,
  ]) {
    await validateDeletionIdentity(identity);
  }
};

const validatePresentOrExpectedAbsent = async (
  identity: DeletionPathIdentity,
): Promise<"present" | "absent"> => {
  try {
    await validateDeletionIdentity(identity);
    return "present";
  } catch {
    await validateExpectedAbsence(identity);
    return "absent";
  }
};

const pathExists = async (path: string): Promise<boolean> =>
  lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });

const pauseDeleteCommandTestBoundary = async (point: string): Promise<void> => {
  if (process.env.NODE_ENV !== "test" || process.env.ARASHI_DELETE_TEST_PAUSE !== point) return;
  const ready = process.env.ARASHI_DELETE_TEST_READY;
  const resume = process.env.ARASHI_DELETE_TEST_RESUME;
  if (!ready || !resume) throw new Error("Delete command test boundary paths are missing.");
  await writeFile(ready, point, { flag: "wx" });
  while (!(await pathExists(resume))) await new Promise((resolve) => setTimeout(resolve, 10));
};

const deleteError = (
  code: string,
  message: string,
  details: Record<string, unknown>,
  exitCode = 1,
): DeleteCommandError => new DeleteCommandError(code, message, details, exitCode);

export const removePlannedWorkspaceHooks = async (hooks: DeletionPathIdentity[]): Promise<void> => {
  for (const hook of hooks) await validateDeletionIdentity(hook);
  throw deleteError(
    "DELETE_PATH_UNSAFE",
    "Workspace hook deletion requires durable receipt transaction provenance.",
    { reason: "durable-receipt-required" },
  );
};

const assertPlainDirectory = async (path: string): Promise<string> => {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw deleteError("DELETE_TOPOLOGY_INVALID", "Configured repository path does not exist.", {
        path,
        reason: "configured-path-missing",
      });
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw deleteError(
      "DELETE_PATH_UNSAFE",
      "Configured repository path is not a plain directory.",
      {
        path,
        reason: "unexpected-path-kind",
      },
    );
  let physical: string;
  try {
    physical = await resolveUnaliasedPhysicalPath(path);
  } catch {
    throw deleteError(
      "DELETE_PATH_UNSAFE",
      "Configured repository path traverses a physical alias.",
      {
        path,
        reason: "physical-alias",
      },
    );
  }
  return physical;
};

const assertContainedLeaf = (root: string, path: string): void => {
  const offset = relative(resolve(root), resolve(path));
  if (!offset || offset.startsWith("..") || isAbsolute(offset))
    throw deleteError("DELETE_PATH_UNSAFE", "Deletion target is outside its authoritative root.", {
      path,
      reason: "path-escape",
    });
};

export const discoverDeleteHookPaths = async (
  workspaceRoot: string,
  repositoryKey: string,
  inlineHooks?: {
    "pre-create"?: unknown;
    "post-create"?: unknown;
    "pre-remove"?: unknown;
    "post-remove"?: unknown;
  },
  activeRepositoryPath?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ owned: string[]; preservedGlobal: string[] }> => {
  const hooksRoot = join(workspaceRoot, ".arashi", "hooks");
  const owned: string[] = [];
  const preservedGlobal: string[] = [];
  for (const lifecycle of ["pre-create", "post-create", "pre-remove", "post-remove"] as const) {
    const hookName = `${lifecycle}.${repositoryKey}`;
    const ownedActive = [
      ...(await discoverLifecycleHookCandidates(hookName, workspaceRoot, platform)),
    ];
    const active =
      activeRepositoryPath && (lifecycle === "pre-remove" || lifecycle === "post-remove")
        ? [
            ...(await discoverConfiguredRepositoryRemoveHookCandidates({
              activeRepositoryPath,
              configurationRoot: workspaceRoot,
              lifecycle,
              platform,
              repositoryName: repositoryKey,
            })),
          ]
        : ownedActive;
    if (active.length > 1)
      throw deleteError("DELETE_HOOK_AMBIGUOUS", "Multiple active hook candidates exist.", {
        lifecycle,
        reason: "multiple-active-candidates",
      });
    if (active.length > 0 && inlineHooks?.[lifecycle] !== undefined)
      throw deleteError("DELETE_HOOK_AMBIGUOUS", "Inline and native repository hooks conflict.", {
        lifecycle,
        reason: "inline-file-ambiguity",
      });
    for (const candidate of ownedActive) {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw deleteError("DELETE_HOOK_AMBIGUOUS", "A targeted hook is not a plain file.", {
          lifecycle,
          path: candidate,
          reason: "unexpected-path-kind",
        });
      assertContainedLeaf(hooksRoot, candidate);
      owned.push(candidate);
    }
    for (const extension of lifecycleHookExtensions(platform)) {
      const template = join(hooksRoot, `${hookName}${extension}.example`);
      try {
        const metadata = await lstat(template);
        if (!metadata.isFile() || metadata.isSymbolicLink())
          throw deleteError(
            "DELETE_HOOK_AMBIGUOUS",
            "A targeted hook template is not a plain file.",
            {
              lifecycle,
              path: template,
              reason: "unexpected-path-kind",
            },
          );
        assertContainedLeaf(hooksRoot, template);
        owned.push(template);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    preservedGlobal.push(
      ...(await discoverLifecycleHookCandidatesInDirectory(
        lifecycle,
        join(process.env.HOME?.trim() || homedir(), ".arashi", "hooks", repositoryKey),
        platform,
      )),
    );
  }
  return {
    owned: owned.toSorted(bytewise),
    preservedGlobal: preservedGlobal.toSorted(bytewise),
  };
};

const serializeWithoutRepository = (
  snapshot: ConfigureSnapshot,
  repositoryKey: string,
): Uint8Array => {
  const persisted = structuredClone(snapshot.persisted) as Record<string, unknown>;
  const repositoryMapKey = persisted.repos
    ? "repos"
    : persisted.discoveredRepos
      ? "discoveredRepos"
      : "discovered_repos";
  const repos = persisted[repositoryMapKey] as Record<string, unknown>;
  delete repos[repositoryKey];
  return new TextEncoder().encode(`${JSON.stringify(persisted, null, 2)}\n`);
};

const containsPath = (ancestor: string, candidate: string): boolean => {
  const offset = relative(resolve(ancestor), resolve(candidate));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
};

const planConfiguredRepository = async (
  snapshot: ConfigureSnapshot,
  repositoryKey: string,
): Promise<{ plan: DeleteRepositoryPlan; runtime: PlannedRepositoryRuntime }> => {
  const repository = snapshot.config.repos[repositoryKey];
  if (!repository)
    throw deleteError(
      "DELETE_REPOSITORY_NOT_FOUND",
      "The exact configured repository key was not found.",
      {
        repositoryKey,
      },
    );
  const configuredActivePath = resolve(
    snapshot.executionRoot ?? snapshot.workspaceRoot,
    repository.path,
  );
  await assertPlainDirectory(configuredActivePath);
  let topology: WorktreeRemovalPlan;
  try {
    topology = await inspectGitWorktreeTopology(configuredActivePath);
  } catch {
    throw deleteError(
      "DELETE_TOPOLOGY_INVALID",
      "Configured repository Git identity is unavailable.",
      {
        repositoryKey,
        reason: "git-common-directory-unavailable",
      },
    );
  }
  const clonePath = topology.canonicalClonePath;
  const cloneIdentity = await assertPlainDirectory(clonePath);
  const commonDirectory = topology.commonDirectory;
  const parentCommon = await gitExec(["rev-parse", "--git-common-dir"], snapshot.workspaceRoot)
    .then(({ stdout }) => realpath(resolve(snapshot.workspaceRoot, stdout.trim())))
    .catch(() => null);
  if (!containsPath(clonePath, commonDirectory))
    throw deleteError(
      "DELETE_TOPOLOGY_INVALID",
      "Configured repository Git metadata is outside the owned canonical clone.",
      { repositoryKey, reason: "external-git-metadata" },
    );
  if (parentCommon === commonDirectory)
    throw deleteError(
      "DELETE_TOPOLOGY_INVALID",
      "Configured repository aliases the parent repository.",
      {
        repositoryKey,
        reason: "parent-identity",
      },
    );
  const protectedParentPaths = [
    snapshot.workspaceRoot,
    snapshot.executionRoot ?? snapshot.workspaceRoot,
    ...(parentCommon ? [parentCommon] : []),
  ];
  if (
    [clonePath, ...topology.linkedWorktrees.map(({ path }) => path)].some((target) =>
      protectedParentPaths.some((protectedPath) => containsPath(target, protectedPath)),
    )
  )
    throw deleteError(
      "DELETE_TOPOLOGY_INVALID",
      "Configured repository deletion target contains parent workspace state.",
      { repositoryKey, reason: "parent-containment" },
    );
  const topologyPaths = new Set(topology.inventory.map(({ path }) => resolve(path)));
  const deletionRoots = [clonePath, ...topology.linkedWorktrees.map(({ path }) => path)];
  for (const [otherKey, otherRepository] of Object.entries(snapshot.config.repos)) {
    if (otherKey === repositoryKey) continue;
    const configuredOtherPath = resolve(
      snapshot.executionRoot ?? snapshot.workspaceRoot,
      otherRepository.path,
    );
    if (deletionRoots.some((root) => containsPath(root, configuredOtherPath)))
      throw deleteError(
        "DELETE_TOPOLOGY_INVALID",
        "Another configured repository path is contained by the selected deletion topology.",
        { repositoryKey, otherRepositoryKey: otherKey, reason: "shared-configured-topology" },
      );
    try {
      const otherPath = await realpath(configuredOtherPath);
      const otherCommon = await gitExec(["rev-parse", "--git-common-dir"], otherPath)
        .then(({ stdout }) => realpath(resolve(otherPath, stdout.trim())))
        .catch(() => null);
      if (
        topologyPaths.has(resolve(otherPath)) ||
        deletionRoots.some((root) => containsPath(root, otherPath)) ||
        otherCommon === commonDirectory
      )
        throw deleteError(
          "DELETE_TOPOLOGY_INVALID",
          "Another configured repository key references the selected Git topology.",
          { repositoryKey, otherRepositoryKey: otherKey, reason: "shared-configured-topology" },
        );
    } catch (error) {
      if (error instanceof DeleteCommandError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const storedFetchOutput = (await gitExec(["remote", "get-url", "--all", "origin"], clonePath))
      .stdout;
    const storedFetchUrl = (
      storedFetchOutput.endsWith("\n") ? storedFetchOutput.slice(0, -1) : storedFetchOutput
    )
      .split("\n")
      .filter(Boolean);
    const configuredUrl =
      typeof repository.gitUrl === "string" && repository.gitUrl.trim()
        ? repository.gitUrl
        : storedFetchUrl[0];
    if (!configuredUrl) throw new Error("configured Git URL is unavailable");
    await gitFetchUrlsMatch({
      configuredCwd: snapshot.executionRoot ?? snapshot.workspaceRoot,
      configuredUrl,
      fetchCwd: clonePath,
      fetchUrls: storedFetchUrl,
    });
  } catch (error) {
    const mismatch = error instanceof GitFetchUrlIdentityError && error.reason === "mismatch";
    throw deleteError(
      "DELETE_TOPOLOGY_INVALID",
      mismatch
        ? "Configured repository URL does not match any clone fetch URL."
        : "Configured repository URL identity is unavailable.",
      {
        repositoryKey,
        reason: mismatch ? "fetch-url-mismatch" : "fetch-url-unavailable",
      },
    );
  }
  let gitLoss: Awaited<ReturnType<typeof inspectRepositoryGitLoss>>;
  try {
    gitLoss = await inspectRepositoryGitLoss(topology);
  } catch (error) {
    if (error instanceof GitLossEvidenceError)
      throw deleteError("DELETE_GIT_DATA_LOSS", error.message, {
        repositoryKey,
        reason: "git-evidence-unavailable",
      });
    throw error;
  }
  const hooks = await discoverDeleteHookPaths(
    snapshot.workspaceRoot,
    repositoryKey,
    repository.hooks,
    configuredActivePath,
  );
  const hookPaths = hooks.owned;
  const identities = await captureRuntimeDeletionIdentities(topology, hookPaths);
  const configPath = join(snapshot.workspaceRoot, ".arashi", "config.json");
  const parentAuthority = parentCommon ?? join(snapshot.workspaceRoot, ".git");
  const receiptPath = receiptPathForRepositoryKey(parentAuthority, repositoryKey);
  const items: DeleteRepositoryItem[] = [
    {
      id: "",
      kind: "resume-receipt",
      ownership: "delete",
      path: receiptPath,
      ref: null,
      oid: null,
      planned: true,
      completed: false,
      state: "planned",
      reasonCode: null,
      message: null,
    },
    ...topology.linkedWorktrees.map(
      (worktree): DeleteRepositoryItem => ({
        id: "",
        kind: "linked-worktree",
        ownership: "delete",
        path: worktree.path,
        ref: worktree.branch,
        oid: worktree.head,
        planned: true,
        completed: false,
        state: "planned",
        reasonCode: null,
        message: null,
      }),
    ),
    ...topology.staleMetadata.map(
      (metadata): DeleteRepositoryItem => ({
        id: "",
        kind: "worktree-metadata",
        ownership: "delete",
        path: metadata.path,
        ref: null,
        oid: null,
        planned: true,
        completed: false,
        state: "planned",
        reasonCode: null,
        message: null,
      }),
    ),
    {
      id: "",
      kind: "canonical-clone",
      ownership: "delete",
      path: clonePath,
      ref: null,
      oid: null,
      planned: true,
      completed: false,
      state: "planned",
      reasonCode: null,
      message: null,
    },
    ...gitLoss.items,
    ...hookPaths.map(
      (path): DeleteRepositoryItem => ({
        id: "",
        kind: "workspace-hook",
        ownership: "delete",
        path,
        ref: null,
        oid: null,
        planned: true,
        completed: false,
        state: "planned",
        reasonCode: null,
        message: null,
      }),
    ),
    ...hooks.preservedGlobal.map(
      (path): DeleteRepositoryItem => ({
        id: "",
        kind: "preserved-global-hook",
        ownership: "preserve",
        path,
        ref: null,
        oid: null,
        planned: false,
        completed: false,
        state: "preserved",
        reasonCode: null,
        message: null,
      }),
    ),
    {
      id: "",
      kind: "config-entry",
      ownership: "delete",
      path: configPath,
      ref: `${
        (snapshot.persisted as Record<string, unknown>).repos
          ? "repos"
          : (snapshot.persisted as Record<string, unknown>).discoveredRepos
            ? "discoveredRepos"
            : "discovered_repos"
      }.${repositoryKey}`,
      oid: null,
      planned: true,
      completed: false,
      state: "planned",
      reasonCode: null,
      message: null,
    },
  ];
  return {
    plan: createDeletePlan(items, gitLoss.warnings, {
      configDigest: createHash("sha256").update(snapshot.bytes).digest("hex"),
    }),
    runtime: {
      acceptedConfigDigest: createHash("sha256").update(snapshot.bytes).digest("hex"),
      cloneIdentity,
      clonePath,
      configPath,
      expectedConfigBytes: snapshot.bytes,
      hookPaths,
      identities,
      topology,
      nextConfigBytes: serializeWithoutRepository(snapshot, repositoryKey),
      workspaceRoot: snapshot.workspaceRoot,
      parentIdentity: stableHash({ commonDirectory: parentAuthority }),
      originalEntryDigest: stableHash(repository),
      receiptPath,
    },
  };
};

const reconstructReceiptPlan = (
  loaded: ValidatedDeleteReceipt,
): { plan: DeleteRepositoryPlan; runtime: PlannedRepositoryRuntime } => {
  const receipt = loaded.receipt;
  const items = receipt.identities.map(
    ({ id, kind, path, ref, oid }): DeleteRepositoryItem => ({
      id,
      kind: kind as DeleteItemKind,
      ownership: kind === "preserved-global-hook" ? "preserve" : "delete",
      path,
      ref,
      oid,
      planned: kind !== "preserved-global-hook",
      completed: false,
      state: kind === "preserved-global-hook" ? "preserved" : "planned",
      reasonCode: null,
      message: null,
    }),
  );
  const reconstructedPlan = createDeletePlan(items, receipt.warnings, {
    configDigest: receipt.configDigest,
  });
  if (reconstructedPlan.id !== receipt.planId)
    throw deleteError("DELETE_RECEIPT_STALE", "Delete receipt plan provenance is stale.", {
      repositoryKey: receipt.repositoryKey,
      reason: "plan-id-mismatch",
    });
  if (
    receipt.runtime.configPath !== join(receipt.runtime.workspaceRoot, ".arashi", "config.json") ||
    receipt.runtime.clonePath !== receipt.runtime.topology.canonicalClonePath ||
    receipt.runtime.identities.clone.path !== receipt.runtime.clonePath ||
    receipt.runtime.identities.canonicalGitAdmin.path !==
      receipt.runtime.topology.commonDirectory ||
    stableHash(receipt.runtime.hookPaths) !==
      stableHash(receipt.runtime.identities.hooks.map(({ path }) => path))
  )
    throw deleteError("DELETE_RECEIPT_STALE", "Delete receipt runtime provenance is stale.", {
      repositoryKey: receipt.repositoryKey,
      reason: "runtime-provenance-mismatch",
    });
  return {
    plan: reconstructedPlan,
    runtime: {
      acceptedConfigDigest: receipt.configDigest,
      cloneIdentity: receipt.runtime.identities.clone.leaf?.identity ?? "",
      clonePath: receipt.runtime.clonePath,
      configPath: receipt.runtime.configPath,
      expectedConfigBytes: Buffer.from(receipt.runtime.expectedConfigBase64, "base64"),
      hookPaths: [...receipt.runtime.hookPaths],
      identities: receipt.runtime.identities,
      nextConfigBytes: Buffer.from(receipt.runtime.nextConfigBase64, "base64"),
      originalEntryDigest: receipt.originalEntryDigest,
      parentIdentity: receipt.parentIdentity,
      receiptPath: receipt.identities.find(({ kind }) => kind === "resume-receipt")?.path ?? "",
      resumeReceipt: receipt,
      topology: receipt.runtime.topology,
      workspaceRoot: receipt.runtime.workspaceRoot,
    },
  };
};

const probeDeleteReceipt = async (
  repositoryKey: string,
  workspaceRoot: string,
): Promise<ValidatedDeleteReceipt | null> => {
  const commonRaw = (await gitExec(["rev-parse", "--git-common-dir"], workspaceRoot)).stdout.trim();
  const parentCommon = await realpath(resolve(workspaceRoot, commonRaw));
  const path = receiptPathForRepositoryKey(parentCommon, repositoryKey);
  try {
    return await readValidatedDeleteReceipt(path, {
      parentIdentity: stableHash({ commonDirectory: parentCommon }),
      repositoryKey,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const markPhase = (
  result: DeleteRepositoryResult,
  name: DeletePhaseName,
  order: number,
): DeletePhase => {
  const phase = result.phases.find((candidate) => candidate.name === name)!;
  phase.state = "started";
  phase.startedOrder = order;
  return phase;
};

const completePhase = (result: DeleteRepositoryResult, phase: DeletePhase, order: number): void => {
  phase.state = "completed";
  phase.completedOrder = order;
  for (const id of phase.itemIds) {
    const item = result.items.find((candidate) => candidate.id === id);
    if (item && item.ownership === "delete")
      Object.assign(item, { completed: true, state: "completed" });
  }
};

export const markDeletePhaseFailure = (
  result: DeleteRepositoryResult,
  phase: DeletePhase,
  error: unknown,
  activeItemId: string | null,
): void => {
  const code = closedDeleteErrorCode(error);
  phase.state = "failed";
  phase.completedOrder = null;
  phase.error = {
    code,
    message: error instanceof Error ? error.message : "Delete execution failed.",
  };
  let activeSeen = activeItemId === null;
  for (const id of phase.itemIds) {
    const item = result.items.find((candidate) => candidate.id === id);
    if (item?.ownership === "preserve") continue;
    if (id === activeItemId) {
      activeSeen = true;
      if (item && !item.completed) Object.assign(item, { state: "failed", reasonCode: code });
      continue;
    } else if (activeSeen) {
      if (!item || item.completed) continue;
      Object.assign(item, {
        state: "blocked",
        reasonCode: "DELETE_BLOCKED_BY_PRIOR_FAILURE",
        message: "Not attempted because an earlier deletion step failed.",
      });
    }
  }
};

class DeleteExecutionFailure extends Error {
  readonly result: DeleteRepositoryResult;
  readonly cause: unknown;
  readonly irreversible: boolean;

  constructor(result: DeleteRepositoryResult, cause: unknown, irreversible: boolean) {
    super(cause instanceof Error ? cause.message : "Delete execution failed.");
    this.name = "DeleteExecutionFailure";
    this.result = result;
    this.cause = cause;
    this.irreversible = irreversible;
  }
}

const createReceiptRecord = (
  repositoryKey: string,
  plan: DeleteRepositoryPlan,
  runtime: PlannedRepositoryRuntime,
  json: boolean,
  completedPhases: DeletePhaseName[],
  completedItemIds: string[],
  destructionPreparedItemIds: string[] = [],
  generationSuffix = createHash("sha256")
    .update(`arashi-delete-quarantine-v1\0${plan.id}`)
    .digest("hex"),
  terminalResidues: DeleteTerminalResidue[] = [],
): DeleteResumeReceipt => {
  return {
    version: 2,
    planId: plan.id,
    parentIdentity: runtime.parentIdentity,
    repositoryKey,
    configDigest: receiptPlanConfigDigest(
      runtime.acceptedConfigDigest,
      runtime.expectedConfigBytes,
    ),
    originalEntryDigest: runtime.originalEntryDigest,
    identities: plan.items.map(({ id, kind, path, ref, oid }) => ({ id, kind, path, ref, oid })),
    completedItemIds,
    completedPhases,
    remainingPhases: DELETE_PHASE_NAMES.filter((phase) => !completedPhases.includes(phase)),
    retryArgv: ["aw", "delete", repositoryKey, "--force", ...(json ? ["--json"] : [])],
    warnings: [...plan.warnings],
    terminalResidues: [...terminalResidues],
    runtime: {
      workspaceRoot: runtime.workspaceRoot,
      configPath: runtime.configPath,
      clonePath: runtime.clonePath,
      quarantinePath: join(
        dirname(runtime.clonePath),
        `.arashi-delete-${Buffer.from(repositoryKey, "utf8").toString("hex")}-${generationSuffix}`,
      ),
      worktreeQuarantines: runtime.identities.worktrees.map(({ path }) => ({
        path,
        quarantinePath: join(
          dirname(path),
          `.arashi-delete-worktree-${createHash("sha256").update(path, "utf8").digest("hex")}-${generationSuffix}`,
        ),
      })),
      destructionPreparedItemIds,
      hookPaths: [...runtime.hookPaths],
      expectedConfigBase64: Buffer.from(runtime.expectedConfigBytes).toString("base64"),
      nextConfigBase64: Buffer.from(runtime.nextConfigBytes).toString("base64"),
      topology: runtime.topology,
      identities: runtime.identities,
    },
  };
};

const executePlannedRepository = async (
  repositoryKey: string,
  plan: DeleteRepositoryPlan,
  runtime: PlannedRepositoryRuntime,
  json: boolean,
  revalidatePhase?: (
    phase: DeletePhaseName,
    completedItemIds: ReadonlySet<string>,
  ) => Promise<void>,
): Promise<DeleteRepositoryResult> => {
  const result = createDeleteResult(plan, repositoryKey, json);
  const baseGenerationSuffix = createHash("sha256")
    .update(`arashi-delete-quarantine-v1\0${plan.id}`)
    .digest("hex");
  const cloneQuarantinePrefix = `.arashi-delete-${Buffer.from(repositoryKey, "utf8").toString("hex")}-`;
  const retainedPathForItem = (item: DeleteRepositoryItem, path: string, suffix: string): string =>
    join(
      dirname(path),
      `.arashi-delete-retained-${createHash("sha256")
        .update("arashi-delete-retained-v1\0")
        .update(plan.id)
        .update("\0")
        .update(item.id)
        .digest("hex")}-${suffix}`,
    );
  const generationSuffix = runtime.resumeReceipt?.runtime.quarantinePath
    ? basename(runtime.resumeReceipt.runtime.quarantinePath).slice(cloneQuarantinePrefix.length)
    : await allocateDeleteGenerationSuffix(baseGenerationSuffix, (suffix) => [
        join(dirname(runtime.clonePath), `${cloneQuarantinePrefix}${suffix}`),
        ...runtime.identities.worktrees.map(({ path }) =>
          join(
            dirname(path),
            `.arashi-delete-worktree-${createHash("sha256").update(path, "utf8").digest("hex")}-${suffix}`,
          ),
        ),
        ...plan.items.flatMap((item) =>
          item.path && (item.kind === "worktree-metadata" || item.kind === "workspace-hook")
            ? [retainedPathForItem(item, item.path, suffix)]
            : [],
        ),
      ]);
  let order = 1;
  let irreversible = false;
  let receiptBytes: Uint8Array | null = null;
  let receiptIdentity: string | null = null;
  let durable = false;
  const completedPhases: DeletePhaseName[] = [];
  const completedItemIds: string[] = [];
  let destructionPreparedItemIds: string[] = [];
  let terminalResidues: DeleteTerminalResidue[] = [
    ...(runtime.resumeReceipt?.terminalResidues ?? []),
  ];
  let activePhase: DeletePhase | null = null;
  let activeItemId: string | null = null;
  const receiptRuntime = (): DeleteResumeReceipt["runtime"] =>
    createReceiptRecord(
      repositoryKey,
      plan,
      runtime,
      json,
      completedPhases,
      completedItemIds,
      destructionPreparedItemIds,
      generationSuffix,
      terminalResidues,
    ).runtime;
  const persist = async (): Promise<void> => {
    const nextReceipt = createReceiptRecord(
      repositoryKey,
      plan,
      runtime,
      json,
      completedPhases,
      completedItemIds,
      destructionPreparedItemIds,
      generationSuffix,
      terminalResidues,
    );
    receiptBytes = await updateDeleteResumeReceipt(runtime.receiptPath, receiptBytes!, nextReceipt);
    runtime.resumeReceipt = nextReceipt;
    const loaded = await readValidatedDeleteReceipt(runtime.receiptPath, {
      parentIdentity: runtime.parentIdentity,
      repositoryKey,
    });
    receiptIdentity = loaded.identity;
    durable = true;
  };
  const finish = async (phase: DeletePhase): Promise<void> => {
    completePhase(result, phase, order++);
    for (const id of phase.itemIds) {
      if (!completedItemIds.includes(id)) completedItemIds.push(id);
    }
    completedPhases.push(phase.name);
    await persist();
  };
  const adoptUnprepared = async (
    identity: DeletionPathIdentity,
    quarantine: string,
    ids: string[],
  ): Promise<void> => {
    if (
      ids.every((id) => completedItemIds.includes(id)) ||
      ids.every((id) => destructionPreparedItemIds.includes(id)) ||
      (await pathExists(identity.path))
    )
      return;
    await adoptUnpreparedQuarantine(identity, quarantine);
    destructionPreparedItemIds = [...ids];
    await persist();
  };
  const completeItems = async (
    items: DeleteRepositoryItem[],
    action: (prepared: boolean, prepare: () => Promise<void>) => Promise<void>,
  ): Promise<void> => {
    if (items.every(({ id }) => completedItemIds.includes(id))) return;
    const ids = items.map(({ id }) => id);
    const requiresPrepared = items.some(({ kind }) => kind !== "config-entry");
    activeItemId = items.find(({ id }) => !completedItemIds.includes(id))?.id ?? null;
    irreversible = true;
    const alreadyPrepared = ids.every((id) => destructionPreparedItemIds.includes(id));
    durable = alreadyPrepared;
    await action(alreadyPrepared, async () => {
      destructionPreparedItemIds = [...ids];
      await persist();
      durable = true;
    });
    if (requiresPrepared && !ids.every((id) => destructionPreparedItemIds.includes(id)))
      throw new Error("Delete destruction completed without durable prepared provenance.");
    const previousCompleted = [...completedItemIds];
    completedItemIds.push(...ids.filter((id) => !completedItemIds.includes(id)));
    destructionPreparedItemIds = [];
    try {
      await persist();
    } catch (error) {
      completedItemIds.splice(0, completedItemIds.length, ...previousCompleted);
      destructionPreparedItemIds = [...ids];
      throw error;
    }
    for (const item of items) {
      const resultItem = result.items.find(({ id }) => id === item.id);
      if (resultItem) Object.assign(resultItem, { completed: true, state: "completed" });
    }
    activeItemId = null;
  };
  const validateRetainedWorktreeAdministration = async (
    worktree: WorktreeRemovalPlan["linkedWorktrees"][number],
    quarantine: string,
  ): Promise<void> => {
    const identity = runtime.identities.worktreeAdmins.find(
      ({ path }) => path === worktree.metadataPath,
    );
    if (!identity)
      throw new Error("Delete worktree administration identity provenance is missing.");
    await validateDeletionIdentity(identity);
    const head = await readFile(join(worktree.metadataPath!, "HEAD"), "utf8");
    if (!worktree.branch || head !== `ref: ${worktree.branch}\n`)
      throw deleteError(
        "DELETE_CONCURRENT_CHANGE",
        "Linked checkout administration branch changed during recovery.",
        { repositoryKey },
      );
    const gitdir = (await readFile(join(worktree.metadataPath!, "gitdir"), "utf8")).trimEnd();
    const observed = isAbsolute(gitdir) ? resolve(gitdir) : resolve(worktree.metadataPath!, gitdir);
    const allowed = [resolve(worktree.path, ".git"), resolve(quarantine, ".git")];
    if (!allowed.includes(observed))
      throw deleteError(
        "DELETE_CONCURRENT_CHANGE",
        "Linked checkout administration topology changed during recovery.",
        { repositoryKey },
      );
  };
  try {
    activePhase = markPhase(result, "provenance", order++);
    try {
      receiptBytes = await createDeleteResumeReceipt(
        runtime.receiptPath,
        createReceiptRecord(repositoryKey, plan, runtime, json, [], [], [], generationSuffix),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing = await readValidatedDeleteReceipt(runtime.receiptPath, {
        parentIdentity: runtime.parentIdentity,
        repositoryKey,
      });
      const expected = createReceiptRecord(
        repositoryKey,
        plan,
        runtime,
        json,
        [],
        [],
        [],
        generationSuffix,
      );
      if (
        existing.receipt.planId !== expected.planId ||
        existing.receipt.configDigest !== expected.configDigest ||
        existing.receipt.originalEntryDigest !== expected.originalEntryDigest ||
        stableHash(existing.receipt.identities) !== stableHash(expected.identities)
      )
        throw deleteError("DELETE_RECEIPT_STALE", "Existing delete receipt is stale.", {
          repositoryKey,
        });
      if (
        existing.receipt.runtime.quarantinePath === undefined ||
        existing.receipt.runtime.worktreeQuarantines === undefined ||
        existing.receipt.runtime.destructionPreparedItemIds === undefined ||
        existing.receipt.terminalResidues === undefined
      ) {
        const upgraded = createReceiptRecord(
          repositoryKey,
          plan,
          runtime,
          json,
          existing.receipt.completedPhases as DeletePhaseName[],
          existing.receipt.completedItemIds,
          [],
          generationSuffix,
        );
        await updateDeleteResumeReceipt(runtime.receiptPath, existing.bytes, upgraded);
        existing = await readValidatedDeleteReceipt(runtime.receiptPath, {
          parentIdentity: runtime.parentIdentity,
          repositoryKey,
        });
      }
      receiptBytes = existing.bytes;
      receiptIdentity = existing.identity;
      completedPhases.push(...(existing.receipt.completedPhases as DeletePhaseName[]));
      completedItemIds.push(...existing.receipt.completedItemIds);
      destructionPreparedItemIds = [...(existing.receipt.runtime.destructionPreparedItemIds ?? [])];
      terminalResidues = [...(existing.receipt.terminalResidues ?? [])];
      for (const item of result.items) {
        if (completedItemIds.includes(item.id))
          Object.assign(item, { completed: true, state: "completed" });
      }
    }
    durable = true;
    if (!receiptIdentity)
      receiptIdentity = (
        await readValidatedDeleteReceipt(runtime.receiptPath, {
          parentIdentity: runtime.parentIdentity,
          repositoryKey,
        })
      ).identity;
    if (!completedPhases.includes("provenance")) {
      completePhase(result, activePhase, order++);
      for (const id of activePhase.itemIds) {
        if (!completedItemIds.includes(id)) completedItemIds.push(id);
      }
      completedPhases.push("provenance");
      await persist();
    } else completePhase(result, activePhase, order++);

    if (await pathExists(runtime.identities.clone.path)) {
      await validateDeletionIdentity(runtime.identities.canonicalGitAdmin);
    } else {
      const cloneQuarantine = receiptRuntime().quarantinePath;
      if (!cloneQuarantine)
        throw deleteError("DELETE_RECEIPT_STALE", "Canonical quarantine provenance is missing.", {
          repositoryKey,
        });
      const retainedClone = (await pathExists(cloneQuarantine))
        ? cloneQuarantine
        : deletionRetirementPath(cloneQuarantine);
      await validateResidueIdentity(
        runtime.identities.canonicalGitAdmin,
        join(
          retainedClone,
          relative(runtime.identities.clone.path, runtime.identities.canonicalGitAdmin.path),
        ),
      );
    }

    activePhase = markPhase(result, "worktrees", order++);
    irreversible = true;
    for (const worktree of runtime.topology.linkedWorktrees) {
      const item = plan.items.find(
        ({ kind, path }) => kind === "linked-worktree" && path === worktree.path,
      );
      const identity = runtime.identities.worktrees.find(({ path }) => path === worktree.path);
      const quarantine = receiptRuntime().worktreeQuarantines?.find(
        ({ path }) => path === worktree.path,
      )?.quarantinePath;
      if (item && identity && quarantine) {
        if (completedItemIds.includes(item.id)) {
          await validateExpectedAbsence(identity);
          const retiredQuarantine = deletionRetirementPath(quarantine);
          const retainedWorktree = (await pathExists(quarantine)) ? quarantine : retiredQuarantine;
          await validatePreparedQuarantine(identity, retainedWorktree);
          if (await pathExists(runtime.identities.clone.path))
            await validateRetainedWorktreeAdministration(worktree, quarantine);
          continue;
        }
        if (!(await pathExists(identity.path)))
          await validateRetainedWorktreeAdministration(worktree, quarantine);
        await adoptUnprepared(identity, quarantine, [item.id]);
      }
    }
    await revalidatePhase?.("worktrees", new Set(completedItemIds));
    for (const worktree of runtime.topology.linkedWorktrees) {
      const item = plan.items.find(
        ({ kind, path }) => kind === "linked-worktree" && path === worktree.path,
      );
      if (!item || completedItemIds.includes(item.id)) continue;
      await completeItems([item], async (prepared, prepare) => {
        const identity = runtime.identities.worktrees.find(({ path }) => path === worktree.path);
        if (!identity) throw new Error("Delete worktree identity provenance is missing.");
        const quarantine = receiptRuntime().worktreeQuarantines?.find(
          ({ path }) => path === worktree.path,
        )?.quarantinePath;
        if (!quarantine) throw new Error("Delete worktree quarantine provenance is missing.");
        const metadataPath = worktree.metadataPath;
        const adminIdentity = runtime.identities.worktreeAdmins.find(
          ({ path }) => path === metadataPath,
        );
        if (!adminIdentity)
          throw new Error("Delete worktree administration identity provenance is missing.");

        if (prepared && (await pathExists(worktree.path)))
          throw deleteError("DELETE_RECEIPT_STALE", "Prepared worktree source was recreated.", {
            repositoryKey,
          });
        const retiredQuarantine = deletionRetirementPath(quarantine);
        if ((await pathExists(quarantine)) || (prepared && (await pathExists(retiredQuarantine)))) {
          await quarantineAndRetainIdentity(identity, {
            quarantinePath: quarantine,
            alreadyQuarantined: true,
          });
        } else if (!prepared) {
          await quarantineAndRetainIdentity(identity, {
            quarantinePath: quarantine,
            beforeRetain: async () => {
              await pauseDeleteCommandTestBoundary("linked-after-quarantine");
              await validateRetainedWorktreeAdministration(worktree, quarantine);
              await prepare();
              await pauseDeleteCommandTestBoundary("linked-after-prepare");
            },
          });
        }
        if (!prepared && !destructionPreparedItemIds.includes(item.id))
          throw new Error("Worktree destruction was not durably prepared.");
        await validateExpectedAbsence(identity);
        const retainedWorktree = (await pathExists(quarantine)) ? quarantine : retiredQuarantine;
        await validatePreparedQuarantine(identity, retainedWorktree);
        // The administration directory is retained with the canonical clone,
        // whose receipt-owned quarantine is established later in this transaction.
        if (await pathExists(adminIdentity.path)) await validateDeletionIdentity(adminIdentity);
      });
      await pauseDeleteCommandTestBoundary("linked-after-completion");
    }
    if (!completedPhases.includes("worktrees")) await finish(activePhase);
    else completePhase(result, activePhase, order++);

    activePhase = markPhase(result, "metadata", order++);
    for (const metadata of runtime.identities.metadata) {
      const item = plan.items.find(
        ({ kind, path }) => kind === "worktree-metadata" && path === metadata.path,
      );
      if (item)
        await adoptUnprepared(
          metadata,
          retainedPathForItem(item, metadata.path, generationSuffix),
          [item.id],
        );
    }
    await revalidatePhase?.("metadata", new Set(completedItemIds));
    for (const metadata of runtime.identities.metadata) {
      const item = plan.items.find(
        ({ kind, path }) => kind === "worktree-metadata" && path === metadata.path,
      );
      if (!item || completedItemIds.includes(item.id)) continue;
      await completeItems([item], async (prepared, prepare) => {
        const quarantine = retainedPathForItem(item, metadata.path, generationSuffix);

        if (prepared && (await pathExists(metadata.path)))
          throw deleteError("DELETE_RECEIPT_STALE", "Prepared metadata source was recreated.", {
            repositoryKey,
          });
        if (await pathExists(quarantine))
          await quarantineAndRetainIdentity(metadata, {
            quarantinePath: quarantine,
            alreadyQuarantined: true,
          });
        else
          await quarantineAndRetainIdentity(metadata, {
            quarantinePath: quarantine,
            beforeRetain: prepare,
          });
      });
    }
    if (!completedPhases.includes("metadata")) await finish(activePhase);
    else completePhase(result, activePhase, order++);

    activePhase = markPhase(result, "canonical-clone", order++);
    const cloneItems = plan.items.filter(
      ({ kind }) => kind === "canonical-clone" || kind === "local-ref",
    );
    const cloneQuarantine = receiptRuntime().quarantinePath;
    if (cloneQuarantine)
      await adoptUnprepared(
        runtime.identities.clone,
        cloneQuarantine,
        cloneItems.map(({ id }) => id),
      );
    await revalidatePhase?.("canonical-clone", new Set(completedItemIds));
    await completeItems(cloneItems, async (prepared, prepare) => {
      const quarantine = receiptRuntime().quarantinePath;
      if (!quarantine) throw new Error("Delete clone quarantine provenance is missing.");

      if (prepared && (await pathExists(runtime.identities.clone.path)))
        throw deleteError("DELETE_RECEIPT_STALE", "Prepared clone source was recreated.", {
          repositoryKey,
        });
      const retiredQuarantine = deletionRetirementPath(quarantine);
      if ((await pathExists(quarantine)) || (prepared && (await pathExists(retiredQuarantine)))) {
        await quarantineAndRetainIdentity(runtime.identities.clone, {
          quarantinePath: quarantine,
          alreadyQuarantined: true,
        });
      } else if (!prepared) {
        await quarantineAndRetainIdentity(runtime.identities.clone, {
          quarantinePath: quarantine,
          beforeRetain: prepare,
        });
      }
      if (!prepared && !cloneItems.every(({ id }) => destructionPreparedItemIds.includes(id)))
        throw new Error("Clone destruction was not durably prepared.");
      await validateExpectedAbsence(runtime.identities.clone);
      const retainedClone = (await pathExists(quarantine)) ? quarantine : retiredQuarantine;
      await validatePreparedQuarantine(runtime.identities.clone, retainedClone);
    });
    if (!completedPhases.includes("canonical-clone")) await finish(activePhase);
    else completePhase(result, activePhase, order++);
    await pauseDeleteCommandTestBoundary("clone-phase-completed");

    activePhase = markPhase(result, "workspace-hooks", order++);
    for (const hook of runtime.identities.hooks) {
      const item = plan.items.find(
        ({ kind, path }) => kind === "workspace-hook" && path === hook.path,
      );
      if (item)
        await adoptUnprepared(hook, retainedPathForItem(item, hook.path, generationSuffix), [
          item.id,
        ]);
    }
    await revalidatePhase?.("workspace-hooks", new Set(completedItemIds));
    for (const hook of runtime.identities.hooks) {
      const item = plan.items.find(
        ({ kind, path }) => kind === "workspace-hook" && path === hook.path,
      );
      if (!item || completedItemIds.includes(item.id)) continue;
      await completeItems([item], async (prepared, prepare) => {
        const quarantine = retainedPathForItem(item, hook.path, generationSuffix);

        if (prepared && (await pathExists(hook.path)))
          throw deleteError("DELETE_RECEIPT_STALE", "Prepared hook source was recreated.", {
            repositoryKey,
          });
        if (await pathExists(quarantine))
          await quarantineAndRetainIdentity(hook, {
            quarantinePath: quarantine,
            alreadyQuarantined: true,
          });
        else
          await quarantineAndRetainIdentity(hook, {
            quarantinePath: quarantine,
            beforeRetain: prepare,
          });
      });
    }
    if (!completedPhases.includes("workspace-hooks")) await finish(activePhase);
    else completePhase(result, activePhase, order++);

    activePhase = markPhase(result, "configuration", order++);
    await revalidatePhase?.("configuration", new Set(completedItemIds));
    const configItem = plan.items.find(({ kind }) => kind === "config-entry")!;
    if (completedItemIds.includes(configItem.id)) {
      const current = await readFile(runtime.configPath);
      if (!Buffer.from(current).equals(Buffer.from(runtime.nextConfigBytes)))
        throw deleteError(
          "DELETE_CONCURRENT_CHANGE",
          "Completed configuration removal could not be proven.",
          { repositoryKey, reason: "config-removal-not-proven" },
        );
    }
    if (!completedItemIds.includes(configItem.id)) {
      activeItemId = configItem.id;
      irreversible = true;
      durable = false;
      const current = await readFile(runtime.configPath);
      await recoverDeleteConfigurationBytes(
        current,
        runtime.expectedConfigBytes,
        runtime.nextConfigBytes,
        async () => {
          const published = await persistExpectedBytesAtomically(
            runtime.configPath,
            runtime.nextConfigBytes,
            runtime.expectedConfigBytes,
          );
          if (!published)
            throw deleteError("DELETE_CONCURRENT_CHANGE", "Configuration changed after planning.", {
              repositoryKey,
              reason: "config-bytes-changed",
            });
        },
        async () => {
          completedItemIds.push(configItem.id);
          try {
            await persist();
          } catch (error) {
            completedItemIds.splice(completedItemIds.indexOf(configItem.id), 1);
            throw error;
          }
          const resultItem = result.items.find(({ id }) => id === configItem.id);
          if (resultItem) Object.assign(resultItem, { completed: true, state: "completed" });
          activeItemId = null;
        },
      );
    }
    if (!completedPhases.includes("configuration")) await finish(activePhase);
    else completePhase(result, activePhase, order++);

    activePhase = markPhase(result, "verification", order++);
    await revalidatePhase?.("verification", new Set(completedItemIds));
    const cleanupBytes = await readValidatedDeleteReceiptBytes(runtime.receiptPath);
    if (!Buffer.from(cleanupBytes).equals(Buffer.from(receiptBytes!)))
      throw deleteError("DELETE_CONCURRENT_CHANGE", "Delete receipt changed before cleanup.", {
        repositoryKey,
        reason: "receipt-bytes-changed",
      });
    const receiptState = receiptRuntime();
    let retainedCleanup: DeleteTerminalResidue[] = [];
    for (const item of plan.items) {
      if (!completedItemIds.includes(item.id) || !item.path) continue;
      if (item.kind === "linked-worktree") {
        const quarantine = receiptState.worktreeQuarantines?.find(
          ({ path }) => path === item.path,
        )?.quarantinePath;
        if (quarantine)
          retainedCleanup.push({
            itemId: item.id,
            source: item.path,
            destination: await terminalDeleteResiduePath(quarantine),
          });
      }
      if (item.kind === "canonical-clone" && receiptState.quarantinePath) {
        retainedCleanup.push({
          itemId: item.id,
          source: item.path,
          destination: await terminalDeleteResiduePath(receiptState.quarantinePath),
        });
      }
      if (item.kind === "worktree-metadata" || item.kind === "workspace-hook")
        retainedCleanup.push({
          itemId: item.id,
          source: item.path,
          destination: retainedPathForItem(item, item.path, generationSuffix),
        });
    }
    for (const ancestor of retainedCleanup.filter(({ source }) =>
      plan.items.some(
        (item) =>
          item.path === source &&
          (item.kind === "canonical-clone" || item.kind === "linked-worktree"),
      ),
    ))
      retainedCleanup = remapDeleteResidues(
        retainedCleanup,
        ancestor.source,
        ancestor.destination,
      ) as DeleteTerminalResidue[];
    for (const residue of retainedCleanup) {
      if (
        plan.items.some(
          (item) =>
            item.path === residue.source &&
            (item.kind === "worktree-metadata" || item.kind === "workspace-hook"),
        )
      )
        residue.destination = await terminalDeleteResiduePath(residue.destination);
    }
    retainedCleanup = retainedCleanup.toSorted((left, right) =>
      bytewise(
        `${left.itemId}\0${left.source}\0${left.destination}`,
        `${right.itemId}\0${right.source}\0${right.destination}`,
      ),
    );
    if (!completedPhases.includes("verification")) completedPhases.push("verification");
    if (terminalResidues.length === 0) terminalResidues = retainedCleanup;
    else if (stableHash(terminalResidues) !== stableHash(retainedCleanup))
      throw deleteError("DELETE_RECEIPT_STALE", "Terminal delete residue mapping is stale.", {
        repositoryKey,
        reason: "terminal-residue-mismatch",
      });
    for (const residue of terminalResidues) {
      const item = plan.items.find(({ id }) => id === residue.itemId)!;
      const identity =
        item.kind === "canonical-clone"
          ? runtime.identities.clone
          : item.kind === "linked-worktree"
            ? runtime.identities.worktrees.find(({ path }) => path === item.path)
            : item.kind === "worktree-metadata"
              ? runtime.identities.metadata.find(({ path }) => path === item.path)
              : runtime.identities.hooks.find(({ path }) => path === item.path);
      if (!identity)
        throw deleteError("DELETE_RECEIPT_STALE", "Terminal delete residue identity is missing.", {
          repositoryKey,
          reason: "terminal-residue-identity-missing",
        });
      await validateResidueIdentity(identity, residue.destination);
    }
    await persist();
    const retainedReceipt = await removeDeleteResumeReceipt(
      runtime.receiptPath,
      receiptBytes!,
      receiptIdentity!,
    );
    const outputCleanup = [
      ...terminalResidues,
      { source: runtime.receiptPath, destination: retainedReceipt },
    ];
    result.warnings = sortRepositoryKeys([
      ...result.warnings,
      ...outputCleanup.map(
        ({ source, destination }) => `DELETE_RETAINED_CLEANUP: ${source} -> ${destination}`,
      ),
    ]);
    completePhase(result, activePhase, order++);
    result.retry = {
      safe: false,
      argv: null,
      guidance: "Deletion completed; no retry is required.",
    };
    return result;
  } catch (error) {
    if (activePhase) markDeletePhaseFailure(result, activePhase, error, activeItemId);
    if (durable && receiptBytes && receiptIdentity) {
      try {
        const survivingReceipt = await readValidatedDeleteReceipt(runtime.receiptPath, {
          parentIdentity: runtime.parentIdentity,
          repositoryKey,
        });
        durable =
          survivingReceipt.identity === receiptIdentity &&
          Buffer.from(survivingReceipt.bytes).equals(Buffer.from(receiptBytes));
      } catch {
        durable = false;
      }
    }
    result.retry.safe = receiptBytes !== null && durable;
    if (result.retry.safe) {
      result.retry.argv = ["aw", "delete", repositoryKey, "--force", ...(json ? ["--json"] : [])];
      result.retry.guidance =
        "Retry the exact configured repository after reviewing surviving state.";
    } else {
      result.retry.argv = null;
      result.retry.guidance = "Resume provenance is unavailable; inspect surviving state manually.";
    }
    throw new DeleteExecutionFailure(result, error, irreversible);
  }
};

export const executeDelete = async (
  repository: string | undefined,
  options: DeleteCommandOptions & { stdinIsTTY?: boolean; stdoutIsTTY?: boolean },
): Promise<number> => {
  let snapshot: ConfigureSnapshot;
  let existingReceipt: ValidatedDeleteReceipt | null = null;
  let earlyWorkspace: DeleteOrchestrationContext["workspace"] | null = null;
  try {
    const context = await resolveWorkspaceContext();
    if (context.mode === "standalone") throw new ConfiguredWorkspaceRequiredError("delete");
    snapshot = await loadConfigureSnapshot();
    earlyWorkspace = {
      mode: "configured",
      repositoriesBase: resolve(
        snapshot.executionRoot ?? snapshot.workspaceRoot,
        snapshot.config.reposDir,
      ),
      workspaceRoot: snapshot.workspaceRoot,
      worktreesBase: resolve(
        snapshot.executionRoot ?? snapshot.workspaceRoot,
        snapshot.config.worktreesDir ?? ".arashi/worktrees",
      ),
    };
    if (repository !== undefined)
      existingReceipt = await probeDeleteReceipt(repository, snapshot.workspaceRoot);
  } catch (error) {
    const baseFailure =
      error instanceof ConfiguredWorkspaceRequiredError
        ? closedDeleteJsonError(error, "DELETE_CONFIG_INVALID")
        : error instanceof ConfigError
          ? {
              code: "DELETE_CONFIG_INVALID",
              message: "Configured workspace state is invalid for repository deletion.",
            }
          : closedDeleteJsonError(error, "DELETE_CONFIG_INVALID");
    const failure =
      error instanceof ConfiguredWorkspaceRequiredError
        ? baseFailure
        : {
            ...baseFailure,
            details: {
              workspace: earlyWorkspace,
              repositoryKey: repository ?? null,
              dryRun: options.dryRun === true,
              force: options.force === true,
              confirmation: "not-required",
              plan: null,
              result: null,
            },
          };
    if (!options.json) {
      process.stderr.write(`${failure.message}\n`);
      return 1;
    }
    writeJsonEnvelope(createJsonErrorEnvelope("delete", failure));
    return 1;
  }
  const runtimePlans = new Map<string, PlannedRepositoryRuntime>();
  let outcome: DeleteOrchestrationResult;
  try {
    if (existingReceipt) {
      const reconstructed = reconstructReceiptPlan(existingReceipt);
      if (reconstructed.runtime.workspaceRoot !== snapshot.workspaceRoot)
        throw deleteError("DELETE_RECEIPT_STALE", "Delete receipt workspace is stale.", {
          repositoryKey: repository,
        });
      runtimePlans.set(existingReceipt.receipt.repositoryKey, reconstructed.runtime);
    }
    outcome = await orchestrateDelete({
      context: {
        repositoryKeys: sortRepositoryKeys([
          ...Object.keys(snapshot.config.repos),
          ...(existingReceipt ? [existingReceipt.receipt.repositoryKey] : []),
        ]),
        workspace: {
          mode: "configured",
          repositoriesBase: resolve(
            snapshot.executionRoot ?? snapshot.workspaceRoot,
            snapshot.config.reposDir,
          ),
          workspaceRoot: snapshot.workspaceRoot,
          worktreesBase: resolve(
            snapshot.executionRoot ?? snapshot.workspaceRoot,
            snapshot.config.worktreesDir ?? ".arashi/worktrees",
          ),
        },
      },
      repository,
      options,
      stdinIsTTY: options.stdinIsTTY === true,
      stdoutIsTTY: options.stdoutIsTTY === true,
      select: multiSelect,
      confirm,
      planner: async (repositoryKey) => {
        if (existingReceipt?.receipt.repositoryKey === repositoryKey) {
          const reconstructed = reconstructReceiptPlan(existingReceipt);
          runtimePlans.set(repositoryKey, reconstructed.runtime);
          return reconstructed.plan;
        }
        const planned = await planConfiguredRepository(snapshot, repositoryKey);
        runtimePlans.set(repositoryKey, planned.runtime);
        return planned.plan;
      },
      preview: options.json
        ? undefined
        : (accepted) => {
            process.stdout.write(renderDeleteHumanPreview(accepted));
          },
      executeBatch: async (accepted) => {
        const chain = buildDeleteConfigChain(
          snapshot.bytes,
          accepted
            .filter(({ repositoryKey }) => !runtimePlans.get(repositoryKey)?.resumeReceipt)
            .map(({ repositoryKey }) => repositoryKey),
        );
        for (const entry of chain) {
          const runtime = runtimePlans.get(entry.repositoryKey)!;
          runtime.expectedConfigBytes = entry.expectedBefore;
          runtime.nextConfigBytes = entry.expectedAfter;
        }
        const lockPath = await resolveWorkspaceTransactionLockPath(snapshot.workspaceRoot);
        return runDeleteBatchTransaction(accepted, {
          withLock: (operation) => withWorkspaceTransactionLock(lockPath, operation),
          revalidateAll: async (plans) => {
            const freshPlans = plans.filter(
              ({ repositoryKey }) => !runtimePlans.get(repositoryKey)?.resumeReceipt,
            );
            if (freshPlans.length) {
              const current = await readFile(
                join(snapshot.workspaceRoot, ".arashi", "config.json"),
              );
              if (!Buffer.from(current).equals(Buffer.from(snapshot.bytes)))
                throw deleteError(
                  "DELETE_CONCURRENT_CHANGE",
                  "Configuration changed after planning.",
                  { reason: "config-bytes-changed" },
                );
            }
            for (const { plan, repositoryKey } of freshPlans) {
              const runtime = runtimePlans.get(repositoryKey)!;
              const refreshedHooks = (
                await discoverDeleteHookPaths(
                  runtime.workspaceRoot,
                  repositoryKey,
                  snapshot.config.repos[repositoryKey]?.hooks,
                  runtime.topology.configuredActivePath,
                )
              ).owned;
              await validateRuntimeDeletionIdentities(runtime.identities);
              const refreshedTopology = await inspectGitWorktreeTopology(runtime.clonePath);

              if (
                stableHash(topologyIdentity(refreshedTopology)) !==
                stableHash(topologyIdentity(runtime.topology))
              )
                throw deleteError(
                  "DELETE_CONCURRENT_CHANGE",
                  "Git topology changed after planning.",
                  {
                    repositoryKey,
                    reason: "git-topology-changed",
                  },
                );
              const refreshedLoss = await inspectRepositoryGitLoss(refreshedTopology);

              if (
                stableHash({
                  items: refEvidence(refreshedLoss.items),
                  warnings: refreshedLoss.warnings,
                }) !== stableHash({ items: refEvidence(plan.items), warnings: plan.warnings })
              )
                throw deleteError(
                  "DELETE_CONCURRENT_CHANGE",
                  "Git evidence changed after planning.",
                  {
                    repositoryKey,
                    reason: "git-evidence-changed",
                  },
                );
              if (stableHash(refreshedHooks) !== stableHash(runtime.hookPaths))
                throw deleteError(
                  "DELETE_CONCURRENT_CHANGE",
                  "Hook ownership changed after planning.",
                  {
                    repositoryKey,
                    reason: "hook-ownership-changed",
                  },
                );
            }
          },
          revalidateTarget: async ({ plan, repositoryKey }) => {
            const runtime = runtimePlans.get(repositoryKey)!;
            const receiptRuntimeState =
              runtime.resumeReceipt?.runtime ??
              createReceiptRecord(repositoryKey, plan, runtime, options.json === true, [], [])
                .runtime;
            await discoverDeleteHookPaths(
              runtime.workspaceRoot,
              repositoryKey,
              snapshot.config.repos[repositoryKey]?.hooks,
              runtime.topology.configuredActivePath,
            );
            const completed = new Set(runtime.resumeReceipt?.completedItemIds ?? []);
            const prepared = new Set(
              runtime.resumeReceipt?.runtime.destructionPreparedItemIds ?? [],
            );
            const preparedDestructionPending = plan.items.some(
              (item) => prepared.has(item.id) && !completed.has(item.id),
            );
            const isCompleted = (kind: DeleteItemKind, path: string | null = null) => {
              const item = plan.items.find(
                (candidate) =>
                  candidate.kind === kind && (path === null || candidate.path === path),
              );
              return item ? completed.has(item.id) : false;
            };
            const current = await readFile(runtime.configPath);
            const expectedConfigStates = isCompleted("config-entry")
              ? [runtime.nextConfigBytes]
              : [runtime.expectedConfigBytes, runtime.nextConfigBytes];
            if (
              !expectedConfigStates.some((expected) =>
                Buffer.from(current).equals(Buffer.from(expected)),
              )
            )
              throw deleteError(
                "DELETE_CONCURRENT_CHANGE",
                "Configuration chain changed before target execution.",
                { repositoryKey, reason: "config-chain-changed" },
              );
            if (!isCompleted("canonical-clone")) {
              const cloneState = await validatePresentOrExpectedAbsent(runtime.identities.clone);
              const absentWorktreePaths = new Set<string>();
              const unpreparedWorktreePaths = new Set<string>();
              const preparedWorktreePaths = new Map<string, string>();
              for (const identity of runtime.identities.worktrees) {
                const item = plan.items.find(
                  ({ kind, path }) => kind === "linked-worktree" && path === identity.path,
                );
                if (!item || isCompleted("linked-worktree", identity.path)) continue;
                const quarantine = receiptRuntimeState.worktreeQuarantines?.find(
                  ({ path }) => path === identity.path,
                )?.quarantinePath;
                if (prepared.has(item.id)) {
                  if (!quarantine)
                    throw deleteError(
                      "DELETE_RECEIPT_STALE",
                      "Prepared worktree quarantine is missing.",
                      { repositoryKey },
                    );
                  await validateExpectedAbsence(identity);
                  if (await pathExists(quarantine)) {
                    await validatePreparedQuarantine(identity, quarantine);
                    preparedWorktreePaths.set(identity.path, quarantine);
                  } else absentWorktreePaths.add(identity.path);
                } else if ((await validatePresentOrExpectedAbsent(identity)) === "absent") {
                  if (quarantine && (await pathExists(quarantine))) {
                    await validatePreparedQuarantine(identity, quarantine);
                    unpreparedWorktreePaths.add(identity.path);
                  } else absentWorktreePaths.add(identity.path);
                }
              }
              for (const identity of runtime.identities.worktreeAdmins) {
                const worktree = runtime.topology.linkedWorktrees.find(
                  ({ metadataPath }) => metadataPath === identity.path,
                );
                if (worktree && !isCompleted("linked-worktree", worktree.path)) {
                  const item = plan.items.find(
                    ({ kind, path }) => kind === "linked-worktree" && path === worktree.path,
                  );
                  const quarantine = receiptRuntimeState.worktreeQuarantines?.find(
                    ({ path }) => path === worktree.path,
                  )?.quarantinePath;
                  if (absentWorktreePaths.has(worktree.path)) {
                    if (await pathExists(identity.path)) await validateDeletionIdentity(identity);
                  } else if (
                    item &&
                    prepared.has(item.id) &&
                    quarantine &&
                    !(await pathExists(quarantine))
                  ) {
                    if (await pathExists(identity.path)) await validateDeletionIdentity(identity);
                  } else await validateDeletionIdentity(identity);
                }
              }
              for (const identity of runtime.identities.metadata) {
                if (!isCompleted("worktree-metadata", identity.path))
                  await validatePresentOrExpectedAbsent(identity);
              }
              const linkedRetirementStarted =
                absentWorktreePaths.size > 0 ||
                unpreparedWorktreePaths.size > 0 ||
                preparedWorktreePaths.size > 0 ||
                runtime.topology.linkedWorktrees.some(({ path }) =>
                  isCompleted("linked-worktree", path),
                );
              if (
                cloneState === "present" &&
                !preparedDestructionPending &&
                !linkedRetirementStarted
              ) {
                const refreshed = await inspectGitWorktreeTopology(runtime.clonePath);
                const retainedWorktreePaths = new Map(
                  receiptRuntimeState.worktreeQuarantines
                    ?.filter(({ path }) => isCompleted("linked-worktree", path))
                    .map(({ path, quarantinePath }) => [path, quarantinePath] as const) ?? [],
                );
                const repairedUnpreparedPaths = new Map<string, string>();
                for (const worktree of runtime.topology.linkedWorktrees) {
                  if (!unpreparedWorktreePaths.has(worktree.path)) continue;
                  const quarantine = receiptRuntimeState.worktreeQuarantines?.find(
                    ({ path }) => path === worktree.path,
                  )?.quarantinePath;
                  if (
                    quarantine &&
                    refreshed.linkedWorktrees.some(
                      ({ path, metadataPath }) =>
                        path === quarantine && metadataPath === worktree.metadataPath,
                    )
                  )
                    repairedUnpreparedPaths.set(worktree.path, quarantine);
                }
                const expectedTopology = {
                  ...runtime.topology,
                  linkedWorktrees: runtime.topology.linkedWorktrees
                    .filter(
                      ({ path }) =>
                        !absentWorktreePaths.has(path) &&
                        (!unpreparedWorktreePaths.has(path) || repairedUnpreparedPaths.has(path)),
                    )
                    .map((worktree) => ({
                      ...worktree,
                      path:
                        preparedWorktreePaths.get(worktree.path) ??
                        repairedUnpreparedPaths.get(worktree.path) ??
                        retainedWorktreePaths.get(worktree.path) ??
                        worktree.path,
                    })),
                  staleMetadata: [
                    ...runtime.topology.staleMetadata,
                    ...runtime.topology.linkedWorktrees.flatMap((worktree) =>
                      unpreparedWorktreePaths.has(worktree.path) &&
                      !repairedUnpreparedPaths.has(worktree.path) &&
                      worktree.metadataPath
                        ? [{ path: worktree.metadataPath, worktreePath: worktree.path }]
                        : [],
                    ),
                  ],
                };
                if (
                  stableHash(topologyIdentity(refreshed)) !==
                  stableHash(topologyIdentity(expectedTopology))
                )
                  throw deleteError(
                    "DELETE_CONCURRENT_CHANGE",
                    "Git topology changed before target execution.",
                    { repositoryKey, reason: "git-topology-changed" },
                  );
                const refreshedLoss = await inspectRepositoryGitLoss(refreshed);
                const completedWorktreePaths = runtime.topology.linkedWorktrees
                  .filter(({ path }) => absentWorktreePaths.has(path))
                  .map(({ path }) => path);
                const expectedWarnings = plan.warnings.filter(
                  (warning) =>
                    !completedWorktreePaths.some((path) =>
                      warning.startsWith(`DELETE_GIT_DATA_LOSS: ${path}:`),
                    ),
                );
                const refreshedWarnings = normalizePreparedDeleteWarnings(
                  normalizePreparedDeleteWarnings(
                    normalizePreparedDeleteWarnings(refreshedLoss.warnings, retainedWorktreePaths),
                    preparedWorktreePaths,
                  ),
                  repairedUnpreparedPaths,
                );
                if (
                  stableHash({
                    items: refEvidence(refreshedLoss.items),
                    warnings: refreshedWarnings,
                  }) !== stableHash({ items: refEvidence(plan.items), warnings: expectedWarnings })
                )
                  throw deleteError(
                    "DELETE_CONCURRENT_CHANGE",
                    "Git evidence changed before target execution.",
                    { repositoryKey, reason: "git-evidence-changed" },
                  );
              }
            }
            const presentHooks = new Set<string>();
            for (const identity of runtime.identities.hooks) {
              if (
                !isCompleted("workspace-hook", identity.path) &&
                (await validatePresentOrExpectedAbsent(identity)) === "present"
              )
                presentHooks.add(identity.path);
            }
            const refreshedHooks = (
              await discoverDeleteHookPaths(
                runtime.workspaceRoot,
                repositoryKey,
                snapshot.config.repos[repositoryKey]?.hooks,
                runtime.topology.configuredActivePath,
              )
            ).owned;
            const expectedHooks = runtime.hookPaths.filter((path) => presentHooks.has(path));
            if (stableHash(refreshedHooks) !== stableHash(expectedHooks))
              throw deleteError(
                "DELETE_CONCURRENT_CHANGE",
                "Hook ownership changed before target execution.",
                { repositoryKey, reason: "hook-ownership-changed" },
              );
          },
          executeTarget: async ({ plan, repositoryKey }): Promise<DeleteBatchEntry> => ({
            plan,
            repositoryKey,
            result: await executePlannedRepository(
              repositoryKey,
              plan,
              runtimePlans.get(repositoryKey)!,
              options.json === true,
              async (phase, completed) => {
                const runtime = runtimePlans.get(repositoryKey)!;
                const receiptRuntimeState =
                  runtime.resumeReceipt?.runtime ??
                  createReceiptRecord(repositoryKey, plan, runtime, options.json === true, [], [])
                    .runtime;
                const remaining = (kind: DeleteItemKind) =>
                  plan.items.filter((item) => item.kind === kind && !completed.has(item.id));
                if (phase === "worktrees") {
                  if (remaining("linked-worktree").length === 0) return;
                  await validateDeletionIdentity(runtime.identities.clone);
                  const absentPaths = new Set<string>();
                  const unpreparedPaths = new Set<string>();
                  const preparedPaths = new Map<string, string>();
                  for (const identity of runtime.identities.worktrees) {
                    const item = remaining("linked-worktree").find(
                      ({ path }) => path === identity.path,
                    );
                    if (!item) continue;
                    const prepared =
                      runtime.resumeReceipt?.runtime.destructionPreparedItemIds?.includes(
                        item.id,
                      ) === true;
                    if (prepared) {
                      const quarantine = receiptRuntimeState.worktreeQuarantines?.find(
                        ({ path }) => path === identity.path,
                      )?.quarantinePath;
                      if (!quarantine)
                        throw deleteError(
                          "DELETE_RECEIPT_STALE",
                          "Prepared worktree quarantine is missing.",
                          { repositoryKey },
                        );
                      const retiredQuarantine = deletionRetirementPath(quarantine);
                      const preparedQuarantine = (await pathExists(quarantine))
                        ? quarantine
                        : (await pathExists(retiredQuarantine))
                          ? retiredQuarantine
                          : undefined;
                      await validateExpectedAbsence(identity);
                      if (preparedQuarantine) {
                        await validatePreparedQuarantine(identity, preparedQuarantine);
                        preparedPaths.set(identity.path, preparedQuarantine);
                      } else absentPaths.add(identity.path);
                    } else if ((await validatePresentOrExpectedAbsent(identity)) === "absent") {
                      const quarantine = receiptRuntimeState.worktreeQuarantines?.find(
                        ({ path }) => path === identity.path,
                      )?.quarantinePath;
                      if (quarantine && (await pathExists(quarantine))) {
                        await validatePreparedQuarantine(identity, quarantine);
                        unpreparedPaths.add(identity.path);
                      } else absentPaths.add(identity.path);
                    }
                  }
                  for (const identity of runtime.identities.worktreeAdmins) {
                    const worktree = runtime.topology.linkedWorktrees.find(
                      ({ metadataPath }) => metadataPath === identity.path,
                    );
                    const item = worktree
                      ? remaining("linked-worktree").find(({ path }) => path === worktree.path)
                      : undefined;
                    if (!item) continue;
                    const prepared =
                      runtime.resumeReceipt?.runtime.destructionPreparedItemIds?.includes(
                        item.id,
                      ) === true;
                    const quarantine = receiptRuntimeState.worktreeQuarantines?.find(
                      ({ path }) => path === worktree!.path,
                    )?.quarantinePath;
                    if (absentPaths.has(worktree!.path)) {
                      if (await pathExists(identity.path)) await validateDeletionIdentity(identity);
                    } else if (prepared && quarantine && !(await pathExists(quarantine))) {
                      if (await pathExists(identity.path)) await validateDeletionIdentity(identity);
                    } else await validateDeletionIdentity(identity);
                  }
                  if (preparedPaths.size > 0 || unpreparedPaths.size > 0) return;
                  const refreshed = await inspectGitWorktreeTopology(runtime.clonePath);
                  const retainedPaths = new Map(
                    receiptRuntimeState.worktreeQuarantines
                      ?.filter(({ path }) =>
                        plan.items.some(
                          ({ id, kind, path: itemPath }) =>
                            kind === "linked-worktree" && itemPath === path && completed.has(id),
                        ),
                      )
                      .map(({ path, quarantinePath }) => [path, quarantinePath] as const) ?? [],
                  );
                  const retiringPreparedPaths = new Map<string, string>();
                  for (const worktree of runtime.topology.linkedWorktrees) {
                    const quarantine = receiptRuntimeState.worktreeQuarantines?.find(
                      ({ path }) => path === worktree.path,
                    )?.quarantinePath;
                    if (
                      quarantine &&
                      preparedPaths.get(worktree.path) === deletionRetirementPath(quarantine)
                    )
                      retiringPreparedPaths.set(worktree.path, quarantine);
                  }
                  const expectedTopology = {
                    ...topologyIdentity(runtime.topology),
                    linkedWorktrees: runtime.topology.linkedWorktrees
                      .filter(
                        ({ path }) =>
                          !absentPaths.has(path) &&
                          !unpreparedPaths.has(path) &&
                          !retainedPaths.has(path) &&
                          !retiringPreparedPaths.has(path),
                      )
                      .map((worktree) => ({
                        ...worktree,
                        path:
                          preparedPaths.get(worktree.path) ??
                          retainedPaths.get(worktree.path) ??
                          worktree.path,
                      })),
                    staleMetadata: [
                      ...runtime.topology.staleMetadata,
                      ...runtime.topology.linkedWorktrees.flatMap((worktree) => {
                        if (!worktree.metadataPath) return [];
                        if (unpreparedPaths.has(worktree.path))
                          return [{ path: worktree.metadataPath, worktreePath: worktree.path }];
                        if (retainedPaths.has(worktree.path))
                          return [{ path: worktree.metadataPath, worktreePath: worktree.path }];
                        const quarantine = retiringPreparedPaths.get(worktree.path);
                        return quarantine
                          ? [{ path: worktree.metadataPath, worktreePath: quarantine }]
                          : [];
                      }),
                    ],
                  };
                  if (stableHash(topologyIdentity(refreshed)) !== stableHash(expectedTopology))
                    throw deleteError(
                      "DELETE_CONCURRENT_CHANGE",
                      "Git topology changed before worktree deletion.",
                      { repositoryKey, reason: "git-topology-changed" },
                    );
                  const refreshedLoss = await inspectRepositoryGitLoss(refreshed);
                  const refreshedWarnings = normalizePreparedDeleteWarnings(
                    normalizePreparedDeleteWarnings(refreshedLoss.warnings, retainedPaths),
                    preparedPaths,
                  );
                  const completedWorktreePaths = runtime.topology.linkedWorktrees
                    .filter(
                      ({ path }) =>
                        absentPaths.has(path) ||
                        retainedPaths.has(path) ||
                        retiringPreparedPaths.has(path),
                    )
                    .map(({ path }) => path);
                  const expectedWarnings = plan.warnings.filter(
                    (warning) =>
                      !completedWorktreePaths.some((path) =>
                        warning.startsWith(`DELETE_GIT_DATA_LOSS: ${path}:`),
                      ),
                  );
                  if (
                    stableHash({
                      items: refEvidence(refreshedLoss.items),
                      warnings: refreshedWarnings,
                    }) !==
                    stableHash({ items: refEvidence(plan.items), warnings: expectedWarnings })
                  )
                    throw deleteError(
                      "DELETE_CONCURRENT_CHANGE",
                      "Git evidence changed before worktree deletion.",
                      { repositoryKey, reason: "git-evidence-changed" },
                    );
                } else if (phase === "metadata") {
                  for (const identity of runtime.identities.metadata) {
                    const item = remaining("worktree-metadata").find(
                      ({ path }) => path === identity.path,
                    );
                    if (item) await validatePresentOrExpectedAbsent(identity);
                  }
                } else if (phase === "canonical-clone" && remaining("canonical-clone").length) {
                  if (
                    (await validatePresentOrExpectedAbsent(runtime.identities.clone)) === "absent"
                  )
                    return;
                  if (
                    plan.items.some(
                      ({ id, kind }) => kind === "linked-worktree" && completed.has(id),
                    )
                  ) {
                    await validateDeletionIdentity(runtime.identities.clone);
                    for (const identity of runtime.identities.worktreeAdmins) {
                      if (await pathExists(identity.path)) await validateDeletionIdentity(identity);
                    }
                    return;
                  }
                  const refreshed = await inspectGitWorktreeTopology(runtime.clonePath);
                  const refreshedLoss = await inspectRepositoryGitLoss(refreshed);
                  const retainedPaths = new Map<string, string>();
                  const retiredCompletedPaths = new Set<string>();
                  for (const { path, quarantinePath } of receiptRuntimeState.worktreeQuarantines ??
                    []) {
                    if (
                      !plan.items.some(
                        ({ id, kind, path: itemPath }) =>
                          kind === "linked-worktree" && itemPath === path && completed.has(id),
                      )
                    )
                      continue;
                    const retiring = deletionRetirementPath(quarantinePath);
                    if (!(await pathExists(quarantinePath)) && (await pathExists(retiring))) {
                      retainedPaths.set(path, retiring);
                      retiredCompletedPaths.add(path);
                    } else retainedPaths.set(path, quarantinePath);
                  }
                  const expectedWarnings = plan.warnings.filter(
                    (warning) =>
                      ![...retiredCompletedPaths].some((path) =>
                        warning.startsWith(`DELETE_GIT_DATA_LOSS: ${path}:`),
                      ),
                  );
                  if (
                    stableHash({
                      items: refEvidence(refreshedLoss.items),
                      warnings: normalizePreparedDeleteWarnings(
                        refreshedLoss.warnings,
                        retainedPaths,
                      ),
                    }) !==
                    stableHash({ items: refEvidence(plan.items), warnings: expectedWarnings })
                  )
                    throw deleteError(
                      "DELETE_CONCURRENT_CHANGE",
                      "Git loss evidence changed before clone deletion.",
                      { repositoryKey, reason: "git-evidence-changed" },
                    );
                } else if (phase === "workspace-hooks") {
                  const refreshed = (
                    await discoverDeleteHookPaths(
                      runtime.workspaceRoot,
                      repositoryKey,
                      snapshot.config.repos[repositoryKey]?.hooks,
                      runtime.topology.configuredActivePath,
                    )
                  ).owned;
                  const expected: string[] = [];
                  for (const item of remaining("workspace-hook")) {
                    const identity = runtime.identities.hooks.find(
                      ({ path }) => path === item.path,
                    );
                    if (identity && (await validatePresentOrExpectedAbsent(identity)) === "present")
                      expected.push(item.path!);
                  }
                  if (stableHash(refreshed) !== stableHash(expected))
                    throw deleteError(
                      "DELETE_CONCURRENT_CHANGE",
                      "Hook ownership changed before hook deletion.",
                      { repositoryKey, reason: "hook-ownership-changed" },
                    );
                } else if (phase === "configuration") {
                  const current = await readFile(runtime.configPath);
                  const configItem = plan.items.find(({ kind }) => kind === "config-entry")!;
                  const expectedStates = completed.has(configItem.id)
                    ? [runtime.nextConfigBytes]
                    : [runtime.expectedConfigBytes, runtime.nextConfigBytes];
                  if (
                    !expectedStates.some((expected) =>
                      Buffer.from(current).equals(Buffer.from(expected)),
                    )
                  )
                    throw deleteError(
                      "DELETE_CONCURRENT_CHANGE",
                      "Configuration changed before persistence.",
                      {
                        repositoryKey,
                        reason: completed.has(configItem.id)
                          ? "config-removal-not-proven"
                          : "config-bytes-changed",
                      },
                    );
                } else if (phase === "verification") {
                  const current = await readFile(runtime.configPath);
                  if (!Buffer.from(current).equals(Buffer.from(runtime.nextConfigBytes)))
                    throw deleteError(
                      "DELETE_CONCURRENT_CHANGE",
                      "Configuration changed before receipt cleanup.",
                      { repositoryKey, reason: "config-bytes-changed" },
                    );
                  for (const item of plan.items) {
                    if (
                      item.ownership !== "delete" ||
                      !item.path ||
                      item.kind === "resume-receipt" ||
                      item.kind === "config-entry"
                    )
                      continue;
                    try {
                      await lstat(item.path);
                      throw deleteError(
                        "DELETE_CONCURRENT_CHANGE",
                        "A completed deletion target still exists.",
                        { repositoryKey, path: item.path, reason: "terminal-target-present" },
                      );
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                    }
                  }
                }
              },
            ),
            state: "completed",
          }),
          failedTarget: ({ plan, repositoryKey }, error): DeleteBatchEntry => {
            const failure =
              error instanceof DeleteExecutionFailure
                ? error
                : new DeleteExecutionFailure(
                    createDeleteResult(plan, repositoryKey, options.json === true),
                    error,
                    false,
                  );
            return {
              plan,
              repositoryKey,
              result: failure.result,
              state: "failed",
              irreversibleCompleted: failure.irreversible,
              failureCode: closedDeleteErrorCode(failure.cause),
            };
          },
          notStartedTarget: ({ plan, repositoryKey }): DeleteBatchEntry => ({
            plan,
            repositoryKey,
            result: createDeleteResult(plan, repositoryKey, options.json === true),
            state: "not-started",
          }),
        });
      },
    });
  } catch (error) {
    const failure = closedDeleteJsonError(error, "DELETE_TOPOLOGY_INVALID");
    if (options.json)
      writeJsonEnvelope(
        createJsonErrorEnvelope("delete", {
          ...failure,
          details: {
            workspace: {
              mode: "configured",
              repositoriesBase: resolve(
                snapshot.executionRoot ?? snapshot.workspaceRoot,
                snapshot.config.reposDir,
              ),
              workspaceRoot: snapshot.workspaceRoot,
              worktreesBase: resolve(
                snapshot.executionRoot ?? snapshot.workspaceRoot,
                snapshot.config.worktreesDir ?? ".arashi/worktrees",
              ),
            },
            repositoryKey: repository ?? null,
            dryRun: options.dryRun === true,
            force: options.force === true,
            confirmation: "not-required",
            plan: null,
            result: null,
          },
        }),
      );
    else process.stderr.write(`${failure.message}\n`);
    return error instanceof DeleteCommandError ? error.exitCode : 1;
  }

  const first = outcome.repositories[0];
  const workspace = {
    mode: "configured" as const,
    repositoriesBase: resolve(
      snapshot.executionRoot ?? snapshot.workspaceRoot,
      snapshot.config.reposDir,
    ),
    workspaceRoot: snapshot.workspaceRoot,
    worktreesBase: resolve(
      snapshot.executionRoot ?? snapshot.workspaceRoot,
      snapshot.config.worktreesDir ?? ".arashi/worktrees",
    ),
  };
  const data = first
    ? {
        workspace,
        repositoryKey: outcome.repositories.length === 1 ? first.repositoryKey : null,
        dryRun: options.dryRun === true,
        force: options.force === true,
        confirmation: outcome.confirmation,
        plan:
          outcome.repositories.length === 1
            ? first.plan
            : outcome.repositories.map((entry) => entry.plan),
        result:
          outcome.repositories.length === 1
            ? first.result
            : outcome.repositories.map((entry) => entry.result),
      }
    : null;
  if (outcome.errorCode) {
    const details =
      outcome.errorCode === "DELETE_SELECTION_REQUIRED"
        ? { command: "delete", reason: "repository-required" }
        : (data ?? {
            workspace,
            repositoryKey: repository ?? null,
            dryRun: options.dryRun === true,
            force: options.force === true,
            confirmation: outcome.confirmation,
            plan: null,
            result: null,
          });
    if (options.json)
      writeJsonEnvelope(
        createJsonErrorEnvelope("delete", {
          code: outcome.errorCode,
          details,
          message:
            outcome.errorCode === "DELETE_SELECTION_REQUIRED"
              ? "An explicit configured repository key is required in JSON or non-interactive mode."
              : `Delete failed: ${outcome.errorCode}`,
        }),
      );
    else {
      if (outcome.repositories.length > 0)
        process.stdout.write(renderDeleteHumanSummary(outcome.repositories));
      process.stderr.write(`Delete failed: ${outcome.errorCode}\n`);
    }
    return outcome.exitCode;
  }
  if (options.json && data) writeJsonEnvelope(createJsonSuccessEnvelope("delete", data));
  else if (data && !options.dryRun)
    process.stdout.write(renderDeleteHumanSummary(outcome.repositories));
  return outcome.exitCode;
};

export function createCommand(): Command {
  return new Command("delete")
    .description("Delete configured repository dependencies")
    .argument("[repository]", "Exact configured repository key")
    .option("-f, --force", "Confirm deletion and override Git data-loss guards")
    .option("-n, --dry-run", "Preview the complete deletion plan without mutation")
    .option("-j, --json", "Output one machine-readable JSON document")
    .action(async (repository: string | undefined, options: DeleteCommandOptions) => {
      process.exitCode = await executeDelete(repository, {
        ...options,
        stdinIsTTY: process.stdin.isTTY,
        stdoutIsTTY: process.stdout.isTTY,
      });
    });
}
