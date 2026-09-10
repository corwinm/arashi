import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
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

export interface DeleteTerminalResidue {
  itemId: string;
  source: string;
  destination: string;
}

export interface DeleteResumeReceipt {
  version: 2;
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
  terminalResidues?: DeleteTerminalResidue[];
  runtime: {
    workspaceRoot: string;
    configPath: string;
    clonePath: string;
    quarantinePath?: string;
    worktreeQuarantines?: Array<{ path: string; quarantinePath: string }>;
    destructionPreparedItemIds?: string[];
    hookPaths: string[];
    expectedConfigBase64: string;
    nextConfigBase64: string;
    topology: WorktreeRemovalPlan;
    identities: {
      clone: DeletionPathIdentity;
      canonicalGitAdmin: DeletionPathIdentity;
      worktrees: DeletionPathIdentity[];
      worktreeAdmins: DeletionPathIdentity[];
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

export const classifyDeleteConfigurationBytes = (
  current: Uint8Array,
  expected: Uint8Array,
  next: Uint8Array,
): "already-published" | "publish" => {
  if (Buffer.from(current).equals(Buffer.from(next))) return "already-published";
  if (Buffer.from(current).equals(Buffer.from(expected))) return "publish";
  throw Object.assign(new Error("Configuration changed after planning."), {
    code: "DELETE_CONCURRENT_CHANGE",
  });
};

export const recoverDeleteConfigurationBytes = async (
  current: Uint8Array,
  expected: Uint8Array,
  next: Uint8Array,
  publish: () => Promise<unknown>,
  persistCompletion: () => Promise<unknown>,
): Promise<void> => {
  if (classifyDeleteConfigurationBytes(current, expected, next) === "publish") await publish();
  await persistCompletion();
};

export interface DeleteResidueMapping {
  source: string;
  destination: string;
}

export const allocateDeleteGenerationSuffix = async (
  base: string,
  pathsForSuffix: (suffix: string) => string[],
): Promise<string> => {
  for (let generation = 0; ; generation += 1) {
    const suffix = generation === 0 ? base : `${base}-${generation}`;
    let available = true;
    for (const path of pathsForSuffix(suffix)) {
      for (const candidate of [path, `${path}.retiring`]) {
        try {
          await lstat(candidate);
          available = false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    if (available) return suffix;
  }
};

export const terminalDeleteResiduePath = async (quarantine: string): Promise<string> => {
  try {
    await lstat(quarantine);
    return quarantine;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const retiring = `${quarantine}.retiring`;
  await lstat(retiring);
  return retiring;
};

export const remapDeleteResidues = (
  residues: DeleteResidueMapping[],
  oldAncestor: string,
  newAncestor: string,
): DeleteResidueMapping[] =>
  residues.map((residue) => {
    const child = relative(oldAncestor, residue.destination);
    if (
      child === "" ||
      child === ".." ||
      child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    )
      return residue;
    return { ...residue, destination: resolve(newAncestor, child) };
  });

export interface DeleteReceiptSafetyIO {
  platform: NodeJS.Platform;
  assertWindowsOwnerOnly: (path: string) => Promise<boolean>;
  setWindowsOwnerOnly: (path: string) => Promise<void>;
  openExclusive: (
    path: string,
    flags: string,
    mode: number,
  ) => Promise<Pick<FileHandle, "chmod" | "close" | "stat" | "sync" | "writeFile">>;
  link: (existingPath: string, newPath: string) => Promise<void>;
  publicationBoundary: (stage: "staged-synced" | "published-before-parent-sync") => Promise<void>;
  remove: (path: string) => Promise<void>;
  syncParentDirectory: (path: string) => Promise<void>;
  temporaryName: (path: string) => string;
}

const execFileAsync = promisify(execFile);
const windowsAclProbe = String.raw`
$target = $env:ARASHI_DELETE_RECEIPT_PATH
$acl = Get-Acl -LiteralPath $target
$sidType = [System.Security.Principal.SecurityIdentifier]
$access = @($acl.Access | ForEach-Object {
  @{ identity = $_.IdentityReference.Translate($sidType).Value; type = $_.AccessControlType.ToString() }
})
@{
  owner = $acl.GetOwner($sidType).Value
  currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  access = $access
} | ConvertTo-Json -Compress -Depth 3
`;
const windowsAclSet = String.raw`
$target = $env:ARASHI_DELETE_RECEIPT_PATH
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $target
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
if ((Get-Item -LiteralPath $target).PSIsContainer) {
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
}
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity, $rights, $inheritance, $propagation, [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
`;

export const windowsAclPowerShellEnvironment = (
  path: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...inherited, ARASHI_DELETE_RECEIPT_PATH: path };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath") delete env[key];
  }
  return env;
};

const execWindowsAclPowerShell = (script: string, path: string) =>
  execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { env: windowsAclPowerShellEnvironment(path) },
  );

export const parseWindowsOwnerOnlyAcl = (output: string): boolean => {
  try {
    const value = JSON.parse(output) as {
      owner?: unknown;
      currentUser?: unknown;
      access?: unknown;
    };
    return (
      typeof value.owner === "string" &&
      value.owner === value.currentUser &&
      Array.isArray(value.access) &&
      value.access.length > 0 &&
      value.access.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>).identity === value.currentUser &&
          (entry as Record<string, unknown>).type === "Allow",
      )
    );
  } catch {
    return false;
  }
};

const defaultReceiptSafety: DeleteReceiptSafetyIO = {
  platform: process.platform,
  assertWindowsOwnerOnly: async (path) => {
    try {
      const { stdout } = await execWindowsAclPowerShell(windowsAclProbe, path);
      return parseWindowsOwnerOnlyAcl(stdout);
    } catch {
      return false;
    }
  },
  setWindowsOwnerOnly: async (path) => {
    await execWindowsAclPowerShell(windowsAclSet, path);
  },
  link,
  openExclusive: (path, flags, mode) => open(path, flags, mode),
  publicationBoundary: async () => {},
  remove: (path) => rm(path, { force: true }),
  syncParentDirectory: async (path) => {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  temporaryName: (path) => `.${basename(path)}.arashi-${process.pid}-${randomUUID()}.tmp`,
};

const serializeReceipt = (receipt: DeleteResumeReceipt): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`);

const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const normalizePreparedDeleteWarnings = (
  warnings: readonly string[],
  preparedPaths: Iterable<readonly [path: string, quarantine: string]>,
): string[] =>
  warnings
    .map((warning) => {
      for (const [path, quarantine] of preparedPaths) {
        const prefix = `DELETE_GIT_DATA_LOSS: ${quarantine}:`;
        if (warning.startsWith(prefix))
          return `DELETE_GIT_DATA_LOSS: ${path}:${warning.slice(prefix.length)}`;
      }
      return warning;
    })
    .toSorted(bytewise);

export const receiptPlanConfigDigest = (
  acceptedConfigDigest: string,
  _targetExpectedConfigBytes: Uint8Array,
): string => acceptedConfigDigest;

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
  const resolvedSafety = { ...defaultReceiptSafety, ...safety };
  if (resolvedSafety.platform === "win32") {
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new DeleteReceiptError(
        "DELETE_RECEIPT_UNSAFE",
        "Delete receipt directory is not a plain directory.",
      );
    await resolvedSafety.setWindowsOwnerOnly(dirname(path));
  }
  await assertReceiptDirectory(path, safety);
  const stagedPath = join(dirname(path), resolvedSafety.temporaryName(path));
  const handle = await resolvedSafety.openExclusive(stagedPath, "wx", 0o600);
  let stagedExists = true;
  let published = false;
  try {
    await handle.writeFile(bytes);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    if (resolvedSafety.platform === "win32") {
      await resolvedSafety.setWindowsOwnerOnly(stagedPath);
      await assertOwnerOnly(stagedPath, safety);
    }
    await resolvedSafety.publicationBoundary("staged-synced");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await resolvedSafety.remove(stagedPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await resolvedSafety.link(stagedPath, path);
    published = true;
    if (resolvedSafety.platform === "win32") await resolvedSafety.setWindowsOwnerOnly(path);
    await assertOwnerOnly(path, safety);
    await resolvedSafety.publicationBoundary("published-before-parent-sync");
    await resolvedSafety.remove(stagedPath);
    stagedExists = false;
    await resolvedSafety.syncParentDirectory(dirname(path));
  } catch (error) {
    if (stagedExists) await resolvedSafety.remove(stagedPath).catch(() => undefined);
    throw error;
  }
  if (!published) throw new Error("Delete receipt publication did not complete.");
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

const assertPlainReceiptNoFollow = async (path: string): Promise<string> => {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new DeleteReceiptError(
      "DELETE_RECEIPT_UNSAFE",
      "Delete receipt is not a plain no-follow file.",
    );
  return `${metadata.dev.toString()}:${metadata.ino.toString()}`;
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
  "terminalResidues",
  "runtime",
] as const;
const legacyReceiptKeys = receiptKeys.filter((key) => key !== "terminalResidues");
const terminalResidueKeys = ["itemId", "source", "destination"] as const;
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
    /^(?:posix|windows)-v2:(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*):[1-9][0-9]*$/u.test(
      entry.identity,
    ) &&
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
  const quarantineRuntimeKeys = [...runtimeKeys, "quarantinePath", "worktreeQuarantines"];
  const nativeRuntimeKeys = [...quarantineRuntimeKeys, "destructionPreparedItemIds"];
  const hasQuarantineRuntime =
    exactKeys(runtime ?? {}, quarantineRuntimeKeys) || exactKeys(runtime ?? {}, nativeRuntimeKeys);
  const validNativeQuarantines =
    hasQuarantineRuntime &&
    typeof runtime?.quarantinePath === "string" &&
    Array.isArray(runtime.worktreeQuarantines) &&
    runtime.worktreeQuarantines.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        exactKeys(entry as Record<string, unknown>, ["path", "quarantinePath"]) &&
        typeof (entry as Record<string, unknown>).path === "string" &&
        typeof (entry as Record<string, unknown>).quarantinePath === "string",
    );
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
    (!exactKeys(record, receiptKeys) && !exactKeys(record, legacyReceiptKeys)) ||
    record.version !== 2 ||
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
    (record.terminalResidues !== undefined &&
      (!Array.isArray(record.terminalResidues) ||
        !record.terminalResidues.every(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            exactKeys(entry as Record<string, unknown>, terminalResidueKeys) &&
            typeof (entry as Record<string, unknown>).itemId === "string" &&
            typeof (entry as Record<string, unknown>).source === "string" &&
            typeof (entry as Record<string, unknown>).destination === "string",
        ))) ||
    !runtime ||
    Array.isArray(runtime) ||
    (!exactKeys(runtime, runtimeKeys) && !validNativeQuarantines) ||
    (exactKeys(runtime, nativeRuntimeKeys) && !stringArray(runtime.destructionPreparedItemIds)) ||
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
    !exactKeys(runtimeIdentities, [
      "clone",
      "canonicalGitAdmin",
      "worktrees",
      "worktreeAdmins",
      "metadata",
      "hooks",
    ]) ||
    !isDeletionIdentity(runtimeIdentities.clone) ||
    !isDeletionIdentity(runtimeIdentities.canonicalGitAdmin) ||
    !Array.isArray(runtimeIdentities.worktrees) ||
    !runtimeIdentities.worktrees.every(isDeletionIdentity) ||
    !Array.isArray(runtimeIdentities.worktreeAdmins) ||
    !runtimeIdentities.worktreeAdmins.every(isDeletionIdentity) ||
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
    if (item.kind === "preserved-global-hook") return !completedItems.has(item.id);
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
  const terminalResidues = (record.terminalResidues ?? []) as DeleteTerminalResidue[];
  const pathsForKind = (kind: string): string[] =>
    receiptIdentities
      .filter((item) => item.kind === kind && item.path !== null)
      .map((item) => item.path!)
      .toSorted();
  const deletionPaths = (value: unknown): string[] =>
    (value as DeletionPathIdentity[]).map(({ path }) => path).toSorted();
  const parsedRuntime = runtime as DeleteResumeReceipt["runtime"];
  const runtimeWorktreePaths = deletionPaths(parsedRuntime.identities.worktrees);
  const planSuffix = createHash("sha256")
    .update(`arashi-delete-quarantine-v1\0${record.planId as string}`)
    .digest("hex");
  const cloneQuarantinePrefix = `.arashi-delete-${Buffer.from(record.repositoryKey as string, "utf8").toString("hex")}-`;
  const selectedSuffix = parsedRuntime.quarantinePath
    ? basename(parsedRuntime.quarantinePath).slice(cloneQuarantinePrefix.length)
    : planSuffix;
  const validSelectedSuffix =
    selectedSuffix === planSuffix ||
    (selectedSuffix.startsWith(`${planSuffix}-`) &&
      /^\d+$/u.test(selectedSuffix.slice(planSuffix.length + 1)));
  const expectedCloneQuarantine = join(
    dirname(parsedRuntime.clonePath),
    `${cloneQuarantinePrefix}${selectedSuffix}`,
  );
  const quarantineMappings = parsedRuntime.worktreeQuarantines ?? [];
  const expectedMappings = parsedRuntime.identities.worktrees.map(({ path }) => ({
    path,
    quarantinePath: join(
      dirname(path),
      `.arashi-delete-worktree-${createHash("sha256").update(path, "utf8").digest("hex")}-${selectedSuffix}`,
    ),
  }));
  const contains = (ancestor: string, candidate: string): boolean => {
    const value = relative(ancestor, candidate);
    return (
      value === "" ||
      (value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    );
  };
  const protectedPaths = [
    parsedRuntime.workspaceRoot,
    parsedRuntime.configPath,
    parsedRuntime.topology.commonDirectory,
    parsedRuntime.topology.configuredActivePath,
    parsedRuntime.topology.primaryPath,
    parsedRuntime.topology.canonicalClonePath,
    ...parsedRuntime.topology.inventory.map(({ path }) => path),
    ...parsedRuntime.topology.linkedWorktrees.flatMap(({ path, metadataPath }) =>
      metadataPath === null ? [path] : [path, metadataPath],
    ),
    ...parsedRuntime.topology.staleMetadata.flatMap(({ path, worktreePath }) => [
      path,
      worktreePath,
    ]),
    ...receiptIdentities.flatMap(({ path }) => (path === null ? [] : [path])),
  ];
  const quarantineDestinations = [
    parsedRuntime.quarantinePath ?? "",
    ...quarantineMappings.map(({ quarantinePath }) => quarantinePath),
  ];
  const quarantineProvenanceIsConsistent =
    !hasQuarantineRuntime ||
    (isAbsolute(parsedRuntime.clonePath) &&
      validSelectedSuffix &&
      parsedRuntime.quarantinePath === expectedCloneQuarantine &&
      JSON.stringify(quarantineMappings) === JSON.stringify(expectedMappings) &&
      new Set(quarantineMappings.map(({ path }) => path)).size === quarantineMappings.length &&
      new Set(quarantineMappings.map(({ quarantinePath }) => quarantinePath)).size ===
        quarantineMappings.length &&
      new Set(quarantineDestinations).size === quarantineDestinations.length &&
      quarantineDestinations.every(
        (destination) =>
          isAbsolute(destination) &&
          protectedPaths.every((protectedPath) => !contains(destination, protectedPath)),
      ) &&
      quarantineMappings.every(
        ({ path, quarantinePath }) =>
          isAbsolute(path) && path !== quarantinePath && dirname(path) === dirname(quarantinePath),
      ));
  const deletionIdentitiesAreSelfConsistent = [
    parsedRuntime.identities.clone,
    ...parsedRuntime.identities.worktrees,
    ...parsedRuntime.identities.worktreeAdmins,
    ...parsedRuntime.identities.metadata,
    ...parsedRuntime.identities.hooks,
  ].every(({ path, leaf }) => leaf.path === path);
  const runtimeProvenanceIsConsistent =
    deletionIdentitiesAreSelfConsistent &&
    parsedRuntime.clonePath === parsedRuntime.topology.canonicalClonePath &&
    parsedRuntime.identities.clone.path === parsedRuntime.clonePath &&
    pathsForKind("canonical-clone").length === 1 &&
    pathsForKind("canonical-clone")[0] === parsedRuntime.clonePath &&
    JSON.stringify(runtimeWorktreePaths) === JSON.stringify(pathsForKind("linked-worktree")) &&
    JSON.stringify(deletionPaths(parsedRuntime.identities.worktreeAdmins)) ===
      JSON.stringify(
        parsedRuntime.topology.linkedWorktrees
          .flatMap(({ metadataPath, present }) =>
            present && metadataPath !== null ? [metadataPath] : [],
          )
          .toSorted(),
      ) &&
    JSON.stringify(deletionPaths(parsedRuntime.identities.metadata)) ===
      JSON.stringify(pathsForKind("worktree-metadata")) &&
    JSON.stringify(deletionPaths(parsedRuntime.identities.hooks)) ===
      JSON.stringify(pathsForKind("workspace-hook")) &&
    JSON.stringify([...parsedRuntime.hookPaths].toSorted()) ===
      JSON.stringify(pathsForKind("workspace-hook"));
  const prepared = parsedRuntime.destructionPreparedItemIds ?? [];
  const canonicalGroup = receiptIdentities
    .filter(({ kind }) => kind === "canonical-clone" || kind === "local-ref")
    .map(({ id }) => id);
  const preparedKinds = new Set([
    "linked-worktree",
    "worktree-metadata",
    "canonical-clone",
    "local-ref",
    "workspace-hook",
  ]);
  const preparedGroupIsValid =
    prepared.length === 0 ||
    (prepared.length === 1 &&
      receiptIdentities.some(
        ({ id, kind }) => id === prepared[0] && preparedKinds.has(kind) && kind !== "local-ref",
      )) ||
    (prepared.length === canonicalGroup.length &&
      canonicalGroup.every((id) => prepared.includes(id)));
  const preparedLedgerIsConsistent =
    new Set(prepared).size === prepared.length &&
    prepared.every(
      (id) =>
        !completedItems.has(id) &&
        receiptIdentities.some(({ id: itemId, kind }) => itemId === id && preparedKinds.has(kind)),
    ) &&
    preparedGroupIsValid &&
    prepared.every((id) => {
      const item = receiptIdentities.find(({ id: itemId }) => itemId === id);
      return (
        item !== undefined && phases.indexOf(receiptPhaseForKind(item.kind)!) === completed.length
      );
    });
  const residueKeys = terminalResidues.map(
    ({ itemId, source, destination }) => `${itemId}\0${source}\0${destination}`,
  );
  const terminalItemKinds = new Set([
    "canonical-clone",
    "linked-worktree",
    "worktree-metadata",
    "workspace-hook",
  ]);
  const expectedResidueDestination = (item: DeleteReceiptIdentity): string | null => {
    let destination: string | null = null;
    if (item.kind === "canonical-clone") destination = expectedCloneQuarantine;
    else if (item.kind === "linked-worktree")
      destination = expectedMappings.find(({ path }) => path === item.path)?.quarantinePath ?? null;
    else if (
      item.path !== null &&
      (item.kind === "worktree-metadata" || item.kind === "workspace-hook")
    )
      destination = join(
        dirname(item.path),
        `.arashi-delete-retained-${createHash("sha256")
          .update("arashi-delete-retained-v1\0")
          .update(record.planId as string)
          .update("\0")
          .update(item.id)
          .digest("hex")}-${selectedSuffix}`,
      );
    if (destination === null || item.kind === "canonical-clone" || item.kind === "linked-worktree")
      return destination;
    for (const ancestor of terminalResidues) {
      const ancestorItem = receiptIdentities.find(({ id }) => id === ancestor.itemId);
      if (
        ancestorItem &&
        (ancestorItem.kind === "canonical-clone" || ancestorItem.kind === "linked-worktree") &&
        contains(ancestor.source, destination)
      )
        destination = join(ancestor.destination, relative(ancestor.source, destination));
    }
    return destination;
  };
  const residueLedgerIsConsistent =
    residueKeys.join("\0") === residueKeys.toSorted(bytewise).join("\0") &&
    new Set(terminalResidues.map(({ itemId }) => itemId)).size === terminalResidues.length &&
    new Set(terminalResidues.map(({ source }) => source)).size === terminalResidues.length &&
    new Set(terminalResidues.map(({ destination }) => destination)).size ===
      terminalResidues.length &&
    terminalResidues.every(({ itemId, source, destination }) => {
      const item = receiptIdentities.find(({ id }) => id === itemId);
      const expectedDestination = item ? expectedResidueDestination(item) : null;
      return (
        item?.path === source &&
        terminalItemKinds.has(item.kind) &&
        expectedDestination !== null &&
        (destination === expectedDestination ||
          destination === `${expectedDestination}.retiring`) &&
        completedItems.has(itemId)
      );
    }) &&
    (terminalResidues.length === 0 || completed.length === phases.length);
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
    !runtimeProvenanceIsConsistent ||
    !quarantineProvenanceIsConsistent ||
    !preparedLedgerIsConsistent ||
    !residueLedgerIsConsistent
  )
    throw new DeleteReceiptError("DELETE_RECEIPT_INVALID", "Delete receipt ledger is invalid.");
  const normalizedRuntime = hasQuarantineRuntime
    ? parsedRuntime
    : {
        ...parsedRuntime,
        quarantinePath: expectedCloneQuarantine,
        worktreeQuarantines: expectedMappings,
        destructionPreparedItemIds: [],
      };
  return {
    ...(value as DeleteResumeReceipt),
    terminalResidues,
    runtime: normalizedRuntime,
  };
};

export const readValidatedDeleteReceipt = async (
  path: string,
  provenance: { parentIdentity: string; repositoryKey: string },
  overrides: Partial<DeleteReceiptSafetyIO> = {},
): Promise<ValidatedDeleteReceipt> => {
  await assertReceiptDirectory(path, overrides);
  const expectedIdentity = await assertPlainReceiptNoFollow(path);
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
    const openedIdentity = `${metadata.dev.toString()}:${metadata.ino.toString()}`;
    if (
      openedIdentity !== expectedIdentity ||
      (await assertPlainReceiptNoFollow(path)) !== expectedIdentity
    )
      throw new DeleteReceiptError(
        "DELETE_RECEIPT_UNSAFE",
        "Delete receipt identity changed while opening it.",
      );
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
      identity: openedIdentity,
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
  const resolvedSafety = { ...defaultReceiptSafety, ...safety };
  const persisted = await persistExpectedBytesAtomically(
    path,
    replacement,
    expectedBytes,
    undefined,
    resolvedSafety.platform === "win32"
      ? async (stagedPath) => {
          await resolvedSafety.setWindowsOwnerOnly(stagedPath);
          await assertOwnerOnly(stagedPath, safety);
        }
      : undefined,
  );
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
  const expectedIdentity = await assertPlainReceiptNoFollow(path);
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
    const metadata = await handle.stat({ bigint: true });
    const openedIdentity = `${metadata.dev.toString()}:${metadata.ino.toString()}`;
    if (
      openedIdentity !== expectedIdentity ||
      (await assertPlainReceiptNoFollow(path)) !== expectedIdentity
    )
      throw new DeleteReceiptError(
        "DELETE_RECEIPT_UNSAFE",
        "Delete receipt identity changed while opening it.",
      );
    if (!metadata.isFile())
      throw new DeleteReceiptError("DELETE_RECEIPT_UNSAFE", "Delete receipt is not a plain file.");
    if ((safety.platform ?? process.platform) !== "win32" && (Number(metadata.mode) & 0o077) !== 0)
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
  safety: Partial<DeleteReceiptSafetyIO> = {},
): Promise<string> => {
  await assertReceiptDirectory(path, safety);
  const originalIdentity = await assertPlainReceiptNoFollow(path);
  await assertOwnerOnly(path, safety);
  const parentBefore = await stat(dirname(path), { bigint: true });
  const parentIdentity = `${parentBefore.dev.toString()}:${parentBefore.ino.toString()}`;
  const quarantine = `${path}.${createHash("sha256").update(expectedBytes).digest("hex")}.retained`;
  await lstat(quarantine)
    .then(() => {
      throw new Error("Retained delete receipt destination already exists; preserved both files.");
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
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
    await assertOwnerOnly(quarantine, safety);
    const metadata = await lstat(quarantine, { bigint: true });
    const movedIdentity = `${metadata.dev.toString()}:${metadata.ino.toString()}`;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      movedIdentity !== originalIdentity ||
      (expectedIdentity !== undefined && movedIdentity !== expectedIdentity)
    ) {
      await restore();
      throw new Error("Delete receipt identity changed concurrently; preserved the newer file.");
    }
    const movedBytes = await readFile(quarantine);
    if (!Buffer.from(movedBytes).equals(Buffer.from(expectedBytes))) {
      await restore();
      throw new Error("Delete receipt changed concurrently; preserved the newer bytes.");
    }
    return quarantine;
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
