import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { persistExpectedBytesAtomically } from "./configure-transaction.ts";
import type { DeletionPathIdentity } from "./delete-identity.ts";
import type { WorktreeRemovalPlan } from "./delete-topology.ts";

export interface DeleteReceiptIdentity {
  id: string;
  kind: string;
  path: string | null;
  ref: string | null;
  oid: string | null;
}

export interface DeleteResumeReceipt {
  version: 1;
  planId: string;
  parentIdentity: string;
  repositoryKey: string;
  configDigest: string;
  originalEntryDigest: string;
  identities: DeleteReceiptIdentity[];
  completedItemIds: string[];
  completedPhases: string[];
  remainingPhases: string[];
  retryArgv: string[];
  warnings: string[];
  runtime: {
    workspaceRoot: string;
    configPath: string;
    clonePath: string;
    hookPaths: string[];
    expectedConfigBase64: string;
    nextConfigBase64: string;
    topology: WorktreeRemovalPlan;
    identities: {
      clone: DeletionPathIdentity;
      worktrees: DeletionPathIdentity[];
      metadata: DeletionPathIdentity[];
      hooks: DeletionPathIdentity[];
    };
  };
}

export interface ValidatedDeleteReceipt {
  bytes: Uint8Array;
  identity: string;
  receipt: DeleteResumeReceipt;
}

export class DeleteReceiptError extends Error {
  readonly code: "DELETE_RECEIPT_INVALID" | "DELETE_RECEIPT_STALE" | "DELETE_RECEIPT_UNSAFE";
  readonly details: Record<string, unknown>;

  constructor(code: DeleteReceiptError["code"], message: string) {
    super(message);
    this.name = "DeleteReceiptError";
    this.code = code;
    this.details = { reason: code.toLowerCase().replaceAll("_", "-") };
  }
}

export interface DeleteReceiptSafetyIO {
  platform: NodeJS.Platform;
  assertWindowsOwnerOnly: (path: string) => Promise<boolean>;
}

const defaultReceiptSafety: DeleteReceiptSafetyIO = {
  platform: process.platform,
  // Node does not expose a trustworthy effective-ACL query. Windows callers must inject one.
  assertWindowsOwnerOnly: async () => false,
};

const serializeReceipt = (receipt: DeleteResumeReceipt): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`);

export const receiptPathForRepositoryKey = (
  parentCommonDirectory: string,
  repositoryKey: string,
): string =>
  join(
    parentCommonDirectory,
    ".arashi-delete-receipts",
    `${createHash("sha256").update(repositoryKey, "utf8").digest("hex")}.json`,
  );

export const createDeleteResumeReceipt = async (
  path: string,
  receipt: DeleteResumeReceipt,
  safety: Partial<DeleteReceiptSafetyIO> = {},
): Promise<Uint8Array> => {
  const bytes = serializeReceipt(receipt);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertReceiptDirectory(path, safety);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await assertOwnerOnly(path, safety);
  } catch (error) {
    await rm(path).catch(() => undefined);
    throw error;
  }
  return bytes;
};

const assertOwnerOnly = async (
  path: string,
  overrides: Partial<DeleteReceiptSafetyIO> = {},
): Promise<void> => {
  const safety = { ...defaultReceiptSafety, ...overrides };
  if (safety.platform === "win32") {
    if (!(await safety.assertWindowsOwnerOnly(path)))
      throw new DeleteReceiptError(
        "DELETE_RECEIPT_UNSAFE",
        "Delete receipt owner-only Windows ACL could not be proven.",
      );
    return;
  }
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0)
    throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is not owner-only.");
};

const assertReceiptDirectory = async (
  path: string,
  overrides: Partial<DeleteReceiptSafetyIO> = {},
): Promise<void> => {
  const metadata = await lstat(dirname(path));
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new DeleteReceiptError(
      "DELETE_RECEIPT_UNSAFE",
      "Delete receipt directory is not a plain directory.",
    );
  await assertOwnerOnly(dirname(path), overrides);
};

const receiptKeys = [
  "version",
  "planId",
  "parentIdentity",
  "repositoryKey",
  "configDigest",
  "originalEntryDigest",
  "identities",
  "completedItemIds",
  "completedPhases",
  "remainingPhases",
  "retryArgv",
  "warnings",
  "runtime",
] as const;
const identityKeys = ["id", "kind", "path", "ref", "oid"] as const;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const pathIdentityEntryKeys = ["path", "identity", "kind"];
const isPathIdentityEntry = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    exactKeys(entry, pathIdentityEntryKeys) &&
    typeof entry.path === "string" &&
    typeof entry.identity === "string" &&
    (entry.kind === "file" || entry.kind === "directory")
  );
};
const isDeletionIdentity = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    exactKeys(identity, ["path", "leaf", "ancestors"]) &&
    typeof identity.path === "string" &&
    isPathIdentityEntry(identity.leaf) &&
    Array.isArray(identity.ancestors) &&
    identity.ancestors.every(isPathIdentityEntry)
  );
};
const isCanonicalBase64 = (value: string): boolean =>
  Buffer.from(value, "base64").toString("base64") === value;
const isHexDigest = (input: unknown): boolean =>
  typeof input === "string" && /^[0-9a-f]{64}$/u.test(input);
const receiptPhaseForKind = (kind: string): string | null =>
  ({
    "resume-receipt": "provenance",
    "linked-worktree": "worktrees",
    "worktree-metadata": "metadata",
    "canonical-clone": "canonical-clone",
    "local-ref": "canonical-clone",
    "workspace-hook": "workspace-hooks",
    "config-entry": "configuration",
    "preserved-global-hook": "verification",
  })[kind] ?? null;
const worktreeKeys = [
  "path",
  "head",
  "branch",
  "detached",
  "bare",
  "locked",
  "prunable",
  "metadataPath",
  "present",
];
const isWorktree = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    exactKeys(item, worktreeKeys) &&
    typeof item.path === "string" &&
    nullableString(item.head) &&
    nullableString(item.branch) &&
    typeof item.detached === "boolean" &&
    typeof item.bare === "boolean" &&
    nullableString(item.locked) &&
    nullableString(item.prunable) &&
    nullableString(item.metadataPath) &&
    typeof item.present === "boolean"
  );
};
const isTopology = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const topology = value as Record<string, unknown>;
  return (
    exactKeys(topology, [
      "commonDirectory",
      "configuredActivePath",
      "primaryPath",
      "canonicalClonePath",
      "linkedWorktrees",
      "staleMetadata",
      "inventory",
    ]) &&
    typeof topology.commonDirectory === "string" &&
    typeof topology.configuredActivePath === "string" &&
    typeof topology.primaryPath === "string" &&
    typeof topology.canonicalClonePath === "string" &&
    Array.isArray(topology.linkedWorktrees) &&
    topology.linkedWorktrees.every(isWorktree) &&
    Array.isArray(topology.inventory) &&
    topology.inventory.every(isWorktree) &&
    Array.isArray(topology.staleMetadata) &&
    topology.staleMetadata.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const metadata = entry as Record<string, unknown>;
      return (
        exactKeys(metadata, ["path", "worktreePath"]) &&
        typeof metadata.path === "string" &&
        typeof metadata.worktreePath === "string"
      );
    })
  );
};

const parseReceipt = (bytes: Uint8Array): DeleteResumeReceipt => {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new DeleteReceiptError(
      "DELETE_RECEIPT_INVALID",
      "Delete receipt is not valid UTF-8 JSON.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeleteReceiptError("DELETE_RECEIPT_INVALID", "Delete receipt must be an object.");
  const record = value as Record<string, unknown>;
  const identities = record.identities;
  const runtime = record.runtime as Record<string, unknown> | null;
  const runtimeIdentities = runtime?.identities as Record<string, unknown> | null;
  const runtimeKeys = [
    "workspaceRoot",
    "configPath",
    "clonePath",
    "hookPaths",
    "expectedConfigBase64",
    "nextConfigBase64",
    "topology",
    "identities",
  ];
  const validIdentities =
    Array.isArray(identities) &&
    identities.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        exactKeys(entry as Record<string, unknown>, identityKeys) &&
        typeof (entry as DeleteReceiptIdentity).id === "string" &&
        typeof (entry as DeleteReceiptIdentity).kind === "string" &&
        nullableString((entry as DeleteReceiptIdentity).path) &&
        nullableString((entry as DeleteReceiptIdentity).ref) &&
        nullableString((entry as DeleteReceiptIdentity).oid),
    );
  if (
    !exactKeys(record, receiptKeys) ||
    record.version !== 1 ||
    typeof record.planId !== "string" ||
    typeof record.parentIdentity !== "string" ||
    typeof record.repositoryKey !== "string" ||
    typeof record.configDigest !== "string" ||
    typeof record.originalEntryDigest !== "string" ||
    !validIdentities ||
    !stringArray(record.completedItemIds) ||
    !stringArray(record.completedPhases) ||
    !stringArray(record.remainingPhases) ||
    !stringArray(record.retryArgv) ||
    !stringArray(record.warnings) ||
    !runtime ||
    Array.isArray(runtime) ||
    !exactKeys(runtime, runtimeKeys) ||
    typeof runtime.workspaceRoot !== "string" ||
    typeof runtime.configPath !== "string" ||
    typeof runtime.clonePath !== "string" ||
    !stringArray(runtime.hookPaths) ||
    typeof runtime.expectedConfigBase64 !== "string" ||
    !isCanonicalBase64(runtime.expectedConfigBase64) ||
    typeof runtime.nextConfigBase64 !== "string" ||
    !isCanonicalBase64(runtime.nextConfigBase64) ||
    !isTopology(runtime.topology) ||
    !runtimeIdentities ||
    Array.isArray(runtimeIdentities) ||
    !exactKeys(runtimeIdentities, ["clone", "worktrees", "metadata", "hooks"]) ||
    !isDeletionIdentity(runtimeIdentities.clone) ||
    !Array.isArray(runtimeIdentities.worktrees) ||
    !runtimeIdentities.worktrees.every(isDeletionIdentity) ||
    !Array.isArray(runtimeIdentities.metadata) ||
    !runtimeIdentities.metadata.every(isDeletionIdentity) ||
    !Array.isArray(runtimeIdentities.hooks) ||
    !runtimeIdentities.hooks.every(isDeletionIdentity)
  )
    throw new DeleteReceiptError("DELETE_RECEIPT_INVALID", "Delete receipt schema is invalid.");
  const expectedRetry = ["aw", "delete", record.repositoryKey, "--force"];
  const retry = record.retryArgv as string[];
  if (
    !isHexDigest(record.planId) ||
    !isHexDigest(record.parentIdentity) ||
    !isHexDigest(record.configDigest) ||
    !isHexDigest(record.originalEntryDigest) ||
    !(
      retry.join("\0") === expectedRetry.join("\0") ||
      retry.join("\0") === [...expectedRetry, "--json"].join("\0")
    )
  )
    throw new DeleteReceiptError("DELETE_RECEIPT_INVALID", "Delete receipt provenance is invalid.");
  const phases = [
    "provenance",
    "worktrees",
    "metadata",
    "canonical-clone",
    "workspace-hooks",
    "configuration",
    "verification",
  ];
  const completed = record.completedPhases as string[];
  const remaining = record.remainingPhases as string[];
  const completedItems = new Set(record.completedItemIds as string[]);
  const firstRemainingIndex =
    remaining.length === 0 ? phases.length : phases.indexOf(remaining[0]!);
  const phaseLedgerIsConsistent = (identities as DeleteReceiptIdentity[]).every((item) => {
    const phase = receiptPhaseForKind(item.kind);
    if (phase === null) return false;
    const phaseIndex = phases.indexOf(phase);
    if (phaseIndex < completed.length) return completedItems.has(item.id);
    if (phaseIndex > firstRemainingIndex) return !completedItems.has(item.id);
    return true;
  });
  const activePhaseItems = (identities as DeleteReceiptIdentity[]).filter(
    ({ kind }) => receiptPhaseForKind(kind) === remaining[0],
  );
  let activePhaseGap = false;
  const activePhaseIsPrefix = activePhaseItems.every(({ id }) => {
    if (!completedItems.has(id)) activePhaseGap = true;
    return !activePhaseGap || !completedItems.has(id);
  });
  const receiptIdentities = identities as DeleteReceiptIdentity[];
  const pathsForKind = (kind: string): string[] =>
    receiptIdentities
      .filter((item) => item.kind === kind && item.path !== null)
      .map((item) => item.path!)
      .toSorted();
  const deletionPaths = (value: unknown): string[] =>
    (value as DeletionPathIdentity[]).map(({ path }) => path).toSorted();
  const parsedRuntime = runtime as DeleteResumeReceipt["runtime"];
  const deletionIdentitiesAreSelfConsistent = [
    parsedRuntime.identities.clone,
    ...parsedRuntime.identities.worktrees,
    ...parsedRuntime.identities.metadata,
    ...parsedRuntime.identities.hooks,
  ].every(({ path, leaf }) => leaf.path === path);
  const runtimeProvenanceIsConsistent =
    deletionIdentitiesAreSelfConsistent &&
    parsedRuntime.clonePath === parsedRuntime.topology.canonicalClonePath &&
    parsedRuntime.identities.clone.path === parsedRuntime.clonePath &&
    pathsForKind("canonical-clone").length === 1 &&
    pathsForKind("canonical-clone")[0] === parsedRuntime.clonePath &&
    JSON.stringify(deletionPaths(parsedRuntime.identities.worktrees)) ===
      JSON.stringify(pathsForKind("linked-worktree")) &&
    JSON.stringify(deletionPaths(parsedRuntime.identities.metadata)) ===
      JSON.stringify(pathsForKind("worktree-metadata")) &&
    JSON.stringify(deletionPaths(parsedRuntime.identities.hooks)) ===
      JSON.stringify(pathsForKind("workspace-hook")) &&
    JSON.stringify([...parsedRuntime.hookPaths].toSorted()) ===
      JSON.stringify(pathsForKind("workspace-hook"));
  if (
    new Set(completed).size !== completed.length ||
    new Set(remaining).size !== remaining.length ||
    [...completed, ...remaining].join("\0") !== phases.join("\0") ||
    !(record.completedItemIds as string[]).every((id) =>
      (identities as DeleteReceiptIdentity[]).some((item) => item.id === id),
    ) ||
    completedItems.size !== (record.completedItemIds as string[]).length ||
    new Set((identities as DeleteReceiptIdentity[]).map(({ id }) => id)).size !==
      (identities as DeleteReceiptIdentity[]).length ||
    !phaseLedgerIsConsistent ||
    !activePhaseIsPrefix ||
    !runtimeProvenanceIsConsistent
  )
    throw new DeleteReceiptError("DELETE_RECEIPT_INVALID", "Delete receipt ledger is invalid.");
  return value as DeleteResumeReceipt;
};

export const readValidatedDeleteReceipt = async (
  path: string,
  provenance: { parentIdentity: string; repositoryKey: string },
  overrides: Partial<DeleteReceiptSafetyIO> = {},
): Promise<ValidatedDeleteReceipt> => {
  await assertReceiptDirectory(path, overrides);
  await assertOwnerOnly(path, overrides);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is a symbolic link.");
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile())
      throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is not a plain file.");
    if (
      (overrides.platform ?? process.platform) !== "win32" &&
      (Number(metadata.mode) & 0o077) !== 0
    )
      throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is not owner-only.");
    const bytes = await handle.readFile();
    const receipt = parseReceipt(bytes);
    if (
      receipt.repositoryKey !== provenance.repositoryKey ||
      receipt.parentIdentity !== provenance.parentIdentity
    )
      throw new DeleteReceiptError("DELETE_RECEIPT_STALE", "Delete receipt provenance is stale.");
    const receiptItems = receipt.identities.filter(({ kind }) => kind === "resume-receipt");
    if (receiptItems.length !== 1 || receiptItems[0]!.path !== path)
      throw new DeleteReceiptError(
        "DELETE_RECEIPT_STALE",
        "Delete receipt path provenance is stale.",
      );
    return {
      bytes,
      identity: `${metadata.dev.toString()}:${metadata.ino.toString()}`,
      receipt,
    };
  } finally {
    await handle.close();
  }
};

export const updateDeleteResumeReceipt = async (
  path: string,
  expectedBytes: Uint8Array,
  receipt: DeleteResumeReceipt,
  safety: Partial<DeleteReceiptSafetyIO> = {},
): Promise<Uint8Array> => {
  await assertReceiptDirectory(path, safety);
  const current = await readValidatedDeleteReceiptBytes(path, safety);
  if (!Buffer.from(current).equals(Buffer.from(expectedBytes)))
    throw new Error("Delete receipt changed concurrently; preserved the newer bytes.");
  const replacement = serializeReceipt(receipt);
  const persisted = await persistExpectedBytesAtomically(path, replacement, expectedBytes);
  if (!persisted)
    throw new Error("Delete receipt changed concurrently; preserved the newer bytes.");
  await assertOwnerOnly(path, safety);
  return replacement;
};

export const readValidatedDeleteReceiptBytes = async (
  path: string,
  safety: Partial<DeleteReceiptSafetyIO> = {},
): Promise<Uint8Array> => {
  await assertReceiptDirectory(path, safety);
  await assertOwnerOnly(path, safety);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is a symbolic link.");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is not a plain file.");
    if ((safety.platform ?? process.platform) !== "win32" && (metadata.mode & 0o077) !== 0)
      throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is not owner-only.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

export const removeDeleteResumeReceipt = async (
  path: string,
  expectedBytes: Uint8Array,
  expectedIdentity?: string,
): Promise<void> => {
  await assertReceiptDirectory(path);
  await assertOwnerOnly(path);
  const parentBefore = await stat(dirname(path), { bigint: true });
  const parentIdentity = `${parentBefore.dev.toString()}:${parentBefore.ino.toString()}`;
  const quarantine = join(
    dirname(path),
    `.${basename(path)}.remove-${process.pid}-${randomUUID()}`,
  );
  await rename(path, quarantine);
  const restore = async (): Promise<void> => {
    const parentAfter = await stat(dirname(path), { bigint: true });
    if (`${parentAfter.dev.toString()}:${parentAfter.ino.toString()}` !== parentIdentity)
      throw new Error("Delete receipt parent changed; preserved quarantine for manual review.");
    try {
      await link(quarantine, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "Delete receipt destination was recreated; preserved quarantine for manual review.",
          { cause: error },
        );
      throw error;
    }
    await rm(quarantine);
  };
  try {
    await assertOwnerOnly(quarantine);
    if (expectedIdentity) {
      const metadata = await stat(quarantine, { bigint: true });
      const movedIdentity = `${metadata.dev.toString()}:${metadata.ino.toString()}`;
      if (movedIdentity !== expectedIdentity) {
        await restore();
        throw new Error("Delete receipt identity changed concurrently; preserved the newer file.");
      }
    }
    const movedBytes = await readFile(quarantine);
    if (!Buffer.from(movedBytes).equals(Buffer.from(expectedBytes))) {
      await restore();
      throw new Error("Delete receipt changed concurrently; preserved the newer bytes.");
    }
    await rm(quarantine);
  } catch (error) {
    const stillMoved = await stat(quarantine)
      .then(() => true)
      .catch(() => false);
    if (stillMoved) await restore().catch(() => undefined);
    throw error;
  }
};

interface BatchTarget {
  repositoryKey: string;
}

export const runDeleteBatchTransaction = async <TTarget extends BatchTarget, TResult>(
  targets: readonly TTarget[],
  dependencies: {
    withLock: <T>(operation: () => Promise<T>) => Promise<T>;
    revalidateAll: (targets: readonly TTarget[]) => Promise<void>;
    revalidateTarget?: (target: TTarget) => Promise<void>;
    executeTarget: (target: TTarget) => Promise<TResult>;
    failedTarget: (target: TTarget, error: unknown) => TResult;
    notStartedTarget: (target: TTarget) => TResult;
  },
): Promise<TResult[]> =>
  dependencies.withLock(async () => {
    await dependencies.revalidateAll(targets);
    const results: TResult[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      try {
        await dependencies.revalidateTarget?.(target);
        results.push(await dependencies.executeTarget(target));
      } catch (error) {
        results.push(dependencies.failedTarget(target, error));
        for (const remaining of targets.slice(index + 1))
          results.push(dependencies.notStartedTarget(remaining));
        break;
      }
    }
    return results;
  });
