import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, realpath, rename, rm } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

export type DeletionPathKind = "directory" | "file";

type NoFollowMetadata = Pick<
  BigIntStats,
  "dev" | "ino" | "isDirectory" | "isFile" | "isSymbolicLink"
>;

export interface DeletionPathIdentityEntry {
  path: string;
  identity: string;
  kind: DeletionPathKind;
}

export interface DeletionPathIdentity {
  path: string;
  leaf: DeletionPathIdentityEntry;
  ancestors: DeletionPathIdentityEntry[];
}

export interface DeletionIdentityIO {
  lstat: (path: string) => Promise<NoFollowMetadata>;
  realpath: (path: string) => Promise<string>;
  identityOf: (metadata: NoFollowMetadata, path: string) => string;
  rename: (source: string, destination: string) => Promise<void>;
  rm: (path: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>;
  quarantineName: () => string;
  afterRename?: (source: string, quarantine: string) => Promise<void>;
  beforeRemove?: (quarantine: string) => Promise<void>;
}

export class DeletionIdentityError extends Error {
  readonly code: "DELETE_CONCURRENT_CHANGE" | "DELETE_PATH_UNSAFE";
  readonly path: string;
  readonly reason: string;

  constructor(
    code: "DELETE_CONCURRENT_CHANGE" | "DELETE_PATH_UNSAFE",
    message: string,
    path: string,
    reason: string,
  ) {
    super(message);
    this.name = "DeletionIdentityError";
    this.code = code;
    this.path = path;
    this.reason = reason;
  }
}

const defaultIdentityOf = (metadata: NoFollowMetadata): string => {
  if (metadata.dev === undefined || metadata.ino === undefined)
    throw new DeletionIdentityError(
      "DELETE_PATH_UNSAFE",
      "The runtime cannot provide a stable no-follow file identity.",
      "",
      "identity-unavailable",
    );
  return `${process.platform === "win32" ? "windows" : "posix"}:${metadata.dev.toString()}:${metadata.ino.toString()}`;
};

const defaults: DeletionIdentityIO = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  identityOf: defaultIdentityOf,
  quarantineName: () => `.${randomUUID()}.arashi-delete`,
  rename,
  rm,
};

const resolveIO = (overrides: Partial<DeletionIdentityIO> = {}): DeletionIdentityIO => ({
  ...defaults,
  ...overrides,
});

const kindOf = (metadata: NoFollowMetadata): DeletionPathKind | null =>
  metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : null;

const unsafe = (path: string, reason: string, message: string): never => {
  throw new DeletionIdentityError("DELETE_PATH_UNSAFE", message, path, reason);
};

const changed = (path: string, reason: string, message: string): never => {
  throw new DeletionIdentityError("DELETE_CONCURRENT_CHANGE", message, path, reason);
};

const inspectEntry = async (
  path: string,
  expectedKind: DeletionPathKind,
  io: DeletionIdentityIO,
): Promise<DeletionPathIdentityEntry> => {
  let metadata: NoFollowMetadata;
  try {
    metadata = await io.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      unsafe(path, "path-missing", "A required deletion path does not exist.");
    throw error;
  }
  if (metadata.isSymbolicLink())
    unsafe(path, "symbolic-link", "A deletion path traverses a symbolic link or junction.");
  if (kindOf(metadata) !== expectedKind)
    unsafe(path, "unexpected-path-kind", "A deletion path has an unexpected filesystem kind.");
  let physical: string;
  try {
    physical = resolve(await io.realpath(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      unsafe(path, "path-missing", "A required deletion path disappeared during inspection.");
    throw error;
  }
  if (physical !== path)
    unsafe(path, "physical-alias", "A deletion path traverses a physical alias.");
  let identity: string;
  try {
    identity = io.identityOf(metadata, path);
  } catch (error) {
    if (error instanceof DeletionIdentityError) {
      throw new DeletionIdentityError(error.code, error.message, path, error.reason);
    }
    throw error;
  }
  if (!identity)
    unsafe(path, "identity-unavailable", "The runtime cannot provide a stable file identity.");
  return { identity, kind: expectedKind, path };
};

const ancestorPaths = (path: string): string[] => {
  const result: string[] = [];
  const root = parse(path).root;
  let current = dirname(path);
  while (true) {
    result.push(current);
    if (current === root) return result.toReversed();
    const parent = dirname(current);
    if (parent === current) return result.toReversed();
    current = parent;
  }
};

export const captureDeletionIdentity = async (
  inputPath: string,
  expectedKind: DeletionPathKind,
  overrides: Partial<DeletionIdentityIO> = {},
): Promise<DeletionPathIdentity> => {
  const io = resolveIO(overrides);
  const path = resolve(inputPath);
  const ancestors: DeletionPathIdentityEntry[] = [];
  for (const ancestor of ancestorPaths(path)) {
    ancestors.push(await inspectEntry(ancestor, "directory", io));
  }
  const leaf = await inspectEntry(path, expectedKind, io);
  return { ancestors, leaf, path };
};

const inspectForValidation = async (
  expected: DeletionPathIdentityEntry,
  io: DeletionIdentityIO,
  reason: string,
): Promise<void> => {
  let current: DeletionPathIdentityEntry;
  try {
    current = await inspectEntry(expected.path, expected.kind, io);
  } catch (error) {
    if (error instanceof DeletionIdentityError)
      changed(expected.path, reason, "A planned deletion path changed after planning.");
    throw error;
  }
  if (current.identity !== expected.identity)
    changed(expected.path, reason, "A planned deletion path identity changed after planning.");
};

export const validateDeletionIdentity = async (
  captured: DeletionPathIdentity,
  overrides: Partial<DeletionIdentityIO> = {},
): Promise<void> => {
  const io = resolveIO(overrides);
  for (const ancestor of captured.ancestors) {
    await inspectForValidation(ancestor, io, "ancestor-identity-changed");
  }
  await inspectForValidation(captured.leaf, io, "identity-changed");
};

export const validateExpectedAbsence = async (
  captured: DeletionPathIdentity,
  overrides: Partial<DeletionIdentityIO> = {},
): Promise<void> => {
  const io = resolveIO(overrides);
  for (const ancestor of captured.ancestors) {
    await inspectForValidation(ancestor, io, "ancestor-identity-changed");
  }
  try {
    await io.lstat(captured.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  changed(
    captured.path,
    "expected-path-still-present",
    "A deletion target expected to be absent is still present.",
  );
};

const validateMovedLeaf = async (
  quarantine: string,
  captured: DeletionPathIdentity,
  io: DeletionIdentityIO,
): Promise<void> => {
  let moved: DeletionPathIdentityEntry;
  try {
    moved = await inspectEntry(quarantine, captured.leaf.kind, io);
  } catch (error) {
    if (error instanceof DeletionIdentityError)
      changed(
        quarantine,
        "quarantine-identity-changed",
        "The quarantined object changed identity.",
      );
    throw error;
  }
  if (moved.identity !== captured.leaf.identity)
    changed(quarantine, "quarantine-identity-changed", "The quarantined object changed identity.");
};

export const quarantineAndRemoveIdentity = async (
  captured: DeletionPathIdentity,
  overrides: Partial<DeletionIdentityIO> = {},
): Promise<void> => {
  const io = resolveIO(overrides);
  await validateDeletionIdentity(captured, io);
  const parent = captured.ancestors.at(-1);
  if (!parent) return unsafe(captured.path, "parent-unavailable", "Deletion target has no parent.");
  await inspectForValidation(parent, io, "ancestor-identity-changed");
  const quarantine = resolve(dirname(captured.path), io.quarantineName());
  if (dirname(quarantine) !== dirname(captured.path) || quarantine === captured.path)
    unsafe(
      captured.path,
      "quarantine-path-invalid",
      "A same-parent quarantine path is unavailable.",
    );
  try {
    await io.rename(captured.path, quarantine);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "ENOTSUP" || code === "EINVAL")
      unsafe(
        captured.path,
        "atomic-rename-unavailable",
        "Same-parent atomic rename is unavailable.",
      );
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY")
      changed(captured.path, "rename-anomaly", "Deletion target changed during quarantine rename.");
    throw error;
  }
  try {
    if (io.afterRename) await io.afterRename(captured.path, quarantine);
    await inspectForValidation(parent, io, "ancestor-identity-changed");
    await validateMovedLeaf(quarantine, captured, io);
    if (io.beforeRemove) await io.beforeRemove(quarantine);
    await inspectForValidation(parent, io, "ancestor-identity-changed");
    await validateMovedLeaf(quarantine, captured, io);
    await io.rm(quarantine, { recursive: captured.leaf.kind === "directory" });
  } catch (error) {
    try {
      await inspectForValidation(parent, io, "ancestor-identity-changed");
      try {
        await io.lstat(captured.path);
        changed(
          captured.path,
          "quarantine-restore-unsafe",
          "The original destination was recreated; preserved the quarantined object.",
        );
      } catch (sourceError) {
        if ((sourceError as NodeJS.ErrnoException).code !== "ENOENT") throw sourceError;
      }
      await validateMovedLeaf(quarantine, captured, io);
      await io.rename(quarantine, captured.path);
    } catch {
      if (error instanceof DeletionIdentityError && error.reason === "quarantine-identity-changed")
        throw error;
      changed(
        quarantine,
        "quarantine-restore-unsafe",
        "Quarantine restoration guards failed; preserved the quarantined object.",
      );
    }
    throw error;
  }
};
