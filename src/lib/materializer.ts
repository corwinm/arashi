import {
  constants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rmdir,
  stat,
  unlink,
  symlink,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  normalizeMaterializationPath,
  resolveMaterializationPath,
  type ExecutedMaterializationOutcome,
  type MaterializationAction,
  type MaterializationReasonCode,
} from "./materialization.ts";

export interface MaterializationOwnershipEntry {
  kind: "directory" | "file" | "symlink";
  path: string;
}

export interface MaterializationRollbackFailure {
  action: MaterializationAction;
  message: string;
  path: string;
  reasonCode: "rollback_failed";
  repositoryId: string;
}

export interface MaterializationResult {
  materializationRollback: {
    attempted: boolean;
    complete: boolean;
    failureCount: number;
    failures: MaterializationRollbackFailure[];
  };
  outcomes: ExecutedMaterializationOutcome[];
  ownershipLedger: MaterializationOwnershipEntry[];
  repositoryId: string;
}

export interface MaterializeRepositoryInput {
  copy: readonly string[];
  destinationRoot: string;
  repositoryId: string;
  sourceRoot: string;
  symlink: readonly string[];
}

export interface MaterializeRepositoryDependencies {
  createSymlink?: (target: string, path: string, kind: "dir" | "file") => Promise<void>;
  removeOwnedObject?: (entry: MaterializationOwnershipEntry) => Promise<void>;
}

class MaterializationFailure extends Error {
  readonly reasonCode: MaterializationReasonCode;

  constructor(reasonCode: MaterializationReasonCode) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const isUnsupportedSymlink = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  ["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"].includes(String(error.code));

const isContained = (root: string, candidate: string): boolean => {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
};

const safeOutcome = (
  action: MaterializationAction,
  path: string,
  status: ExecutedMaterializationOutcome["status"],
  reasonCode: MaterializationReasonCode,
  message: string,
): ExecutedMaterializationOutcome => ({ action, message, path, reasonCode, status });

async function canonicalSource(path: string, sourceRoot: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!isContained(sourceRoot, canonical)) throw new MaterializationFailure("source_escape");
    return canonical;
  } catch (error) {
    if (error instanceof MaterializationFailure) throw error;
    if (isMissing(error)) throw new MaterializationFailure("source_link_broken");
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String(error.code) === "ELOOP"
    ) {
      throw new MaterializationFailure("source_cycle");
    }
    throw new MaterializationFailure("copy_failed");
  }
}

async function ensureSafeParents(
  destinationRoot: string,
  destination: string,
  ledger: MaterializationOwnershipEntry[],
): Promise<void> {
  const parent = dirname(destination);
  const components = relative(resolve(destinationRoot), parent).split(sep).filter(Boolean);
  let current = resolve(destinationRoot);
  for (const component of components) {
    current = resolve(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new MaterializationFailure("destination_ancestor_unsafe");
      }
    } catch (error) {
      if (error instanceof MaterializationFailure) throw error;
      if (!isMissing(error)) throw new MaterializationFailure("destination_ancestor_unsafe");
      try {
        await mkdir(current);
        ledger.push({ kind: "directory", path: current });
      } catch (mkdirError) {
        if (
          typeof mkdirError === "object" &&
          mkdirError !== null &&
          "code" in mkdirError &&
          String(mkdirError.code) === "EEXIST"
        ) {
          throw new MaterializationFailure("destination_ancestor_unsafe");
        }
        throw new MaterializationFailure("copy_failed");
      }
    }
  }
}

async function assertDestinationAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new MaterializationFailure("destination_exists");
  } catch (error) {
    if (error instanceof MaterializationFailure) throw error;
    if (!isMissing(error)) throw new MaterializationFailure("destination_ancestor_unsafe");
  }
}

async function copyNode(
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
  active: readonly string[],
  ledger: MaterializationOwnershipEntry[],
): Promise<void> {
  let lexical;
  try {
    lexical = await lstat(source);
  } catch (error) {
    if (isMissing(error)) throw new MaterializationFailure("source_link_broken");
    throw new MaterializationFailure("copy_failed");
  }
  const canonical = await canonicalSource(source, sourceRoot);
  if (active.some((ancestor) => resolve(ancestor) === resolve(canonical))) {
    throw new MaterializationFailure("source_cycle");
  }
  let followed;
  try {
    followed = await stat(source);
  } catch (error) {
    if (isMissing(error) || lexical.isSymbolicLink()) {
      throw new MaterializationFailure("source_link_broken");
    }
    throw new MaterializationFailure("copy_failed");
  }

  await ensureSafeParents(destinationRoot, destination, ledger);
  await assertDestinationAbsent(destination);
  if (followed.isDirectory()) {
    try {
      await mkdir(destination);
      ledger.push({ kind: "directory", path: destination });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String(error.code) === "EEXIST"
      ) {
        throw new MaterializationFailure("destination_exists");
      }
      throw new MaterializationFailure("copy_failed");
    }
    const nextActive = [...active, canonical];
    let children: string[];
    try {
      children = (await readdir(source)).toSorted();
    } catch {
      throw new MaterializationFailure("copy_failed");
    }
    for (const child of children) {
      await copyNode(
        resolve(source, child),
        resolve(destination, child),
        sourceRoot,
        destinationRoot,
        nextActive,
        ledger,
      );
    }
    return;
  }
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    ledger.push({ kind: "file", path: destination });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String(error.code) === "EEXIST"
    ) {
      throw new MaterializationFailure("destination_exists");
    }
    throw new MaterializationFailure("copy_failed");
  }
}

const defaultRemoveOwnedObject = async (entry: MaterializationOwnershipEntry): Promise<void> => {
  if (entry.kind === "directory") await rmdir(entry.path);
  else await unlink(entry.path);
};

export async function rollbackMaterializationOwnership(
  repositoryId: string,
  action: MaterializationAction,
  path: string,
  ledger: readonly MaterializationOwnershipEntry[],
  removeOwnedObject: (
    entry: MaterializationOwnershipEntry,
  ) => Promise<void> = defaultRemoveOwnedObject,
): Promise<MaterializationResult["materializationRollback"]> {
  const failures: MaterializationRollbackFailure[] = [];
  for (const owned of ledger.toReversed()) {
    try {
      await removeOwnedObject(owned);
    } catch {
      failures.push({
        action,
        message: "Owned materialization object could not be removed",
        path,
        reasonCode: "rollback_failed",
        repositoryId,
      });
    }
  }
  return {
    attempted: ledger.length > 0,
    complete: failures.length === 0,
    failureCount: failures.length,
    failures,
  };
}

export async function materializeRepository(
  input: MaterializeRepositoryInput,
  dependencies: MaterializeRepositoryDependencies = {},
): Promise<MaterializationResult> {
  const ledger: MaterializationOwnershipEntry[] = [];
  const outcomes: ExecutedMaterializationOutcome[] = [];
  const canonicalSourceRoot = await realpath(input.sourceRoot);
  const entries = [
    ...input.copy.map((path) => ({ action: "copy" as const, path })),
    ...input.symlink.map((path) => ({ action: "symlink" as const, path })),
  ];
  let failure: {
    action: MaterializationAction;
    path: string;
    reasonCode: MaterializationReasonCode;
  } | null = null;
  for (const entry of entries) {
    const normalizedPath = normalizeMaterializationPath(entry.path).path;
    const source = resolveMaterializationPath(input.sourceRoot, normalizedPath);
    const destination = resolveMaterializationPath(input.destinationRoot, normalizedPath);
    try {
      try {
        await lstat(source);
      } catch (error) {
        if (isMissing(error)) {
          outcomes.push(
            safeOutcome(
              entry.action,
              normalizedPath,
              "skipped",
              "source_missing",
              "Source is missing; entry is optional",
            ),
          );
          continue;
        }
        throw new MaterializationFailure("source_inspection_failed");
      }

      if (entry.action === "copy") {
        await copyNode(source, destination, canonicalSourceRoot, input.destinationRoot, [], ledger);
        outcomes.push(
          safeOutcome("copy", normalizedPath, "copied", "none", `Copied '${normalizedPath}'`),
        );
      } else {
        const canonical = await canonicalSource(source, canonicalSourceRoot);
        const sourceStat = await stat(source);
        await ensureSafeParents(input.destinationRoot, destination, ledger);
        await assertDestinationAbsent(destination);
        try {
          await (dependencies.createSymlink ?? symlink)(
            canonical,
            destination,
            sourceStat.isDirectory() ? "dir" : "file",
          );
          ledger.push({ kind: "symlink", path: destination });
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            String(error.code) === "EEXIST"
          ) {
            throw new MaterializationFailure("destination_exists");
          }
          throw new MaterializationFailure(
            isUnsupportedSymlink(error) ? "symlink_unsupported" : "symlink_failed",
          );
        }
        outcomes.push(
          safeOutcome("symlink", normalizedPath, "linked", "none", `Linked '${normalizedPath}'`),
        );
      }
    } catch (error) {
      const reasonCode =
        error instanceof MaterializationFailure
          ? error.reasonCode
          : entry.action === "copy"
            ? "copy_failed"
            : "symlink_failed";
      outcomes.push(
        safeOutcome(
          entry.action,
          normalizedPath,
          "failed",
          reasonCode,
          "Materialization failed safely",
        ),
      );
      failure = { action: entry.action, path: normalizedPath, reasonCode };
      break;
    }
  }

  const rollbackFailures: MaterializationRollbackFailure[] = [];
  const retainedLedger: MaterializationOwnershipEntry[] = [];
  if (failure) {
    const removeOwnedObject = dependencies.removeOwnedObject ?? defaultRemoveOwnedObject;
    for (const owned of ledger.toReversed()) {
      try {
        await removeOwnedObject(owned);
      } catch {
        if (dependencies.removeOwnedObject && owned.kind === "directory") {
          try {
            await rmdir(owned.path);
          } catch {
            // Confirmation below determines whether the owned object remains.
          }
        }
      }
      try {
        await lstat(owned.path);
        retainedLedger.push(owned);
      } catch (error) {
        if (isMissing(error)) continue;
        retainedLedger.push(owned);
      }
    }
    for (const outcome of outcomes) {
      if (outcome.status !== "copied" && outcome.status !== "linked") continue;
      const destination = resolveMaterializationPath(input.destinationRoot, outcome.path);
      const outcomeRetained = retainedLedger.some((owned) => isContained(destination, owned.path));
      if (!outcomeRetained) {
        outcome.status = "rolled-back";
        outcome.reasonCode = "rolled_back";
        outcome.message = `Rolled back '${outcome.path}'`;
      }
    }
    for (const retained of retainedLedger) {
      const owner = outcomes.find((outcome) => {
        if (outcome.status !== "copied" && outcome.status !== "linked") return false;
        return isContained(
          resolveMaterializationPath(input.destinationRoot, outcome.path),
          retained.path,
        );
      });
      rollbackFailures.push({
        action: owner?.action ?? failure.action,
        message: "Owned materialization object could not be removed",
        path: owner?.path ?? failure.path,
        reasonCode: "rollback_failed",
        repositoryId: input.repositoryId,
      });
    }
  }

  return {
    materializationRollback: {
      attempted: failure !== null,
      complete: rollbackFailures.length === 0,
      failureCount: rollbackFailures.length,
      failures: rollbackFailures,
    },
    outcomes,
    ownershipLedger: failure ? retainedLedger.toReversed() : ledger,
    repositoryId: input.repositoryId,
  };
}
