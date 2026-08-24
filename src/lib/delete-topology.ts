import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { exec as gitExec, execRaw as gitExecRaw } from "./git.ts";
import resolveUnaliasedPhysicalPath from "./physical-path.ts";

export interface GitWorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
  metadataPath: string | null;
  present: boolean;
}

export interface WorktreeRemovalPlan {
  commonDirectory: string;
  configuredActivePath: string;
  primaryPath: string;
  canonicalClonePath: string;
  linkedWorktrees: GitWorktreeRecord[];
  staleMetadata: Array<{ path: string; worktreePath: string }>;
  inventory: GitWorktreeRecord[];
}

const topologyError = (message: string): Error =>
  new Error(`Invalid Git worktree topology: ${message}`);
const bytewise = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const pathDepth = (path: string): number => path.split(/[\\/]/u).filter(Boolean).length;

const splitField = (field: string): { key: string; value: string | null } => {
  const offset = field.indexOf(" ");
  return offset === -1
    ? { key: field, value: null }
    : { key: field.slice(0, offset), value: field.slice(offset + 1) };
};

export const parseGitWorktreePorcelainZ = (input: Uint8Array | string): GitWorktreeRecord[] => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0 || bytes.at(-1) !== 0 || bytes.length < 2 || bytes.at(-2) !== 0)
    throw topologyError("porcelain output must end with a NUL record separator");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw topologyError("porcelain output is not valid UTF-8");
  }
  const rawRecords = text.slice(0, -2).split("\0\0");
  if (rawRecords.some((record) => !record))
    throw topologyError("empty or duplicate record separator");

  const seenPaths = new Set<string>();
  return rawRecords.map((rawRecord) => {
    const fields = rawRecord.split("\0");
    if (fields.some((field) => !field)) throw topologyError("empty field");
    const first = splitField(fields[0]!);
    if (first.key !== "worktree" || !first.value || !isAbsolute(first.value))
      throw topologyError("record must start with an absolute worktree path");
    const path = resolve(first.value);
    if (seenPaths.has(path)) throw topologyError("duplicate worktree path");
    seenPaths.add(path);

    let head: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked: string | null = null;
    let prunable: string | null = null;
    const seenFields = new Set<string>();
    for (const field of fields.slice(1)) {
      const { key, value } = splitField(field);
      if (seenFields.has(key)) throw topologyError(`duplicate ${key} field`);
      seenFields.add(key);
      switch (key) {
        case "HEAD":
          if (!value || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value))
            throw topologyError("invalid HEAD object ID");
          head = value;
          break;
        case "branch":
          if (!value || !value.startsWith("refs/heads/")) throw topologyError("invalid branch ref");
          branch = value;
          break;
        case "detached":
          if (value !== null) throw topologyError("detached field cannot have a value");
          detached = true;
          break;
        case "bare":
          if (value !== null) throw topologyError("bare field cannot have a value");
          bare = true;
          break;
        case "locked":
          locked = value ?? "";
          break;
        case "prunable":
          prunable = value ?? "";
          break;
        default:
          throw topologyError(`unknown porcelain field ${key}`);
      }
    }
    if (branch && detached) throw topologyError("record cannot be both branch and detached");
    if (bare && (head || branch || detached))
      throw topologyError("bare record has checkout fields");
    if (!bare && (!head || (!branch && !detached)))
      throw topologyError("checkout record is incomplete");
    return {
      bare,
      branch,
      detached,
      head,
      locked,
      metadataPath: null,
      path,
      present: true,
      prunable,
    };
  });
};

export const createWorktreeRemovalPlan = (input: {
  commonDirectory: string;
  configuredActivePath: string;
  records: readonly GitWorktreeRecord[];
}): WorktreeRemovalPlan => {
  if (input.records.length === 0) throw topologyError("worktree inventory is empty");
  const commonDirectory = resolve(input.commonDirectory);
  const configuredActivePath = resolve(input.configuredActivePath);
  const inventory = input.records.map((record) => ({ ...record, path: resolve(record.path) }));
  const configured = inventory.find((record) => record.path === configuredActivePath);
  if (!configured || !configured.present)
    throw topologyError("configured active path is not a live inventory member");
  const primary = inventory[0]!;
  if (!primary.present || primary.prunable !== null)
    throw topologyError("canonical primary worktree is stale");
  const locked = inventory.find((record) => record.locked !== null);
  if (locked) throw topologyError(`locked worktree blocks deletion: ${locked.path}`);

  const stale = inventory.filter((record) => record.prunable !== null && !record.present);
  for (const record of stale) {
    if (!record.metadataPath)
      throw topologyError(`stale worktree metadata is unavailable: ${record.path}`);
    const offset = relative(join(commonDirectory, "worktrees"), resolve(record.metadataPath));
    if (!offset || offset.startsWith("..") || isAbsolute(offset))
      throw topologyError(`stale metadata escapes common directory: ${record.metadataPath}`);
  }
  const linkedWorktrees = inventory
    .slice(1)
    .filter((record) => record.present)
    .toSorted((left, right) => {
      const depth = pathDepth(right.path) - pathDepth(left.path);
      return depth || bytewise(left.path, right.path);
    });
  const staleMetadata = stale
    .map((record) => ({ path: resolve(record.metadataPath!), worktreePath: record.path }))
    .toSorted((left, right) => bytewise(left.path, right.path));
  return {
    canonicalClonePath: primary.path,
    commonDirectory,
    configuredActivePath,
    inventory,
    linkedWorktrees,
    primaryPath: primary.path,
    staleMetadata,
  };
};

type WorktreePathPresence = "absent" | "plain-directory" | "unsafe-occupied";

const pathPresence = async (path: string): Promise<WorktreePathPresence> => {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink()
      ? "plain-directory"
      : "unsafe-occupied";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
};

const verifyRegisteredWorktreeIdentity = async (
  record: GitWorktreeRecord,
  commonDirectory: string,
): Promise<void> => {
  let observedCommon: string;
  try {
    const commonRaw = (await gitExec(["rev-parse", "--git-common-dir"], record.path)).stdout.trim();
    observedCommon = await realpath(resolve(record.path, commonRaw));
  } catch {
    throw topologyError(`registered worktree Git identity is unavailable: ${record.path}`);
  }
  if (observedCommon !== commonDirectory)
    throw topologyError(`registered worktree has a different common directory: ${record.path}`);
  if (!record.bare) {
    let topLevel: string;
    try {
      const raw = (await gitExec(["rev-parse", "--show-toplevel"], record.path)).stdout.trim();
      topLevel = await realpath(raw);
    } catch {
      throw topologyError(`registered worktree root identity is unavailable: ${record.path}`);
    }
    if (topLevel !== (await realpath(record.path)))
      throw topologyError(`registered worktree root identity does not match: ${record.path}`);
  }
};

const attachMetadataPaths = async (
  records: GitWorktreeRecord[],
  commonDirectory: string,
): Promise<void> => {
  const metadataRoot = join(commonDirectory, "worktrees");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(metadataRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const byWorktree = new Map(records.map((record) => [record.path, record]));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw topologyError(`unexpected worktree metadata entry: ${entry.name}`);
    const metadataPath = join(metadataRoot, entry.name);
    const gitdir = (await readFile(join(metadataPath, "gitdir"), "utf8")).trim();
    if (!isAbsolute(gitdir)) throw topologyError(`relative metadata gitdir: ${metadataPath}`);
    const record = byWorktree.get(resolve(gitdir, ".."));
    if (!record || record.metadataPath)
      throw topologyError(`orphaned or duplicate metadata: ${metadataPath}`);
    record.metadataPath = metadataPath;
  }
};

export const inspectGitWorktreeTopology = async (
  configuredActivePath: string,
): Promise<WorktreeRemovalPlan> => {
  const configured = resolve(configuredActivePath);
  const configuredMetadata = await lstat(configured);
  if (!configuredMetadata.isDirectory() || configuredMetadata.isSymbolicLink())
    throw topologyError("configured active path is not a plain directory");
  try {
    await resolveUnaliasedPhysicalPath(configured);
  } catch {
    throw topologyError("configured active path traverses a physical alias");
  }
  const commonRaw = (await gitExec(["rev-parse", "--git-common-dir"], configured)).stdout.trim();
  const commonDirectory = await realpath(resolve(configured, commonRaw));
  const output = (await gitExecRaw(["worktree", "list", "--porcelain", "-z"], configured)).stdout;
  const records = parseGitWorktreePorcelainZ(output);
  await Promise.all(
    records.map(async (record) => {
      const presence = await pathPresence(record.path);
      if (presence === "unsafe-occupied")
        throw topologyError(`registered worktree path is occupied unsafely: ${record.path}`);
      record.present = presence === "plain-directory";
      if (record.present) await verifyRegisteredWorktreeIdentity(record, commonDirectory);
    }),
  );
  await attachMetadataPaths(records, commonDirectory);
  return createWorktreeRemovalPlan({ commonDirectory, configuredActivePath: configured, records });
};

export const executeLinkedWorktreeRemovals = async (plan: WorktreeRemovalPlan): Promise<void> => {
  for (const worktree of plan.linkedWorktrees) {
    await gitExec(["worktree", "remove", "--force", "--", worktree.path], plan.primaryPath);
  }
};

export const pruneOwnedStaleMetadata = async (plan: WorktreeRemovalPlan): Promise<void> => {
  if (plan.staleMetadata.length > 0)
    await gitExec(["worktree", "prune", "--expire", "now"], plan.primaryPath);
};

export const executeWorktreeRemovalPlan = async (plan: WorktreeRemovalPlan): Promise<void> => {
  await executeLinkedWorktreeRemovals(plan);
  await pruneOwnedStaleMetadata(plan);
};
