import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { repositoryNoOpScaffold } from "./repository-config-editor.ts";
import type { RepositoryScriptPlan } from "./repository-config-editor.ts";
import { discoverLifecycleHookCandidates, resolveLifecycleHooksDirectory } from "./hooks.ts";

export interface OwnedRepositoryScript {
  path: string;
  bytes: Uint8Array;
  mode: number | null;
  dev: number;
  ino: number;
  birthtimeNs: bigint;
}

export interface RepositoryScriptTransactionDependencies {
  /** Test seam for an observable substitution after private preparation but before publication. */
  beforePublication?: (plan: RepositoryScriptPlan) => Promise<void>;
  /** Test seam for an observable substitution after publication but before final validation. */
  afterPublication?: (plan: RepositoryScriptPlan) => Promise<void>;
}

export class RepositoryScriptTransactionError extends Error {
  readonly owned: readonly OwnedRepositoryScript[];

  constructor(message: string, owned: readonly OwnedRepositoryScript[], cause: unknown) {
    super(message, { cause });
    this.name = "RepositoryScriptTransactionError";
    this.owned = Object.freeze([...owned]);
  }
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const inspectDirectory = async (path: string): Promise<DirectoryIdentity> => {
  const observed = await lstat(path);
  if (observed.isSymbolicLink()) {
    throw new Error(`Refusing active hook path with symbolic link parent: ${path}`);
  }
  if (!observed.isDirectory()) {
    throw new Error(`Refusing active hook path with non-directory parent: ${path}`);
  }
  return { dev: observed.dev, ino: observed.ino, path };
};

const sameDirectory = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

/**
 * Validates every path component from the caller-owned root and creates missing descendants one
 * component at a time. Starting at that trustworthy boundary avoids both skipping an earlier
 * symlink and rejecting platform aliases above the managed root (for example macOS /var ->
 * /private/var).
 */
const prepareParent = async (
  destination: string,
  ownerRoot: string,
): Promise<DirectoryIdentity[]> => {
  const parent = dirname(destination);
  const boundary = resolve(ownerRoot);
  const trustedHooksDirectory = resolve(resolveLifecycleHooksDirectory(boundary));
  if (resolve(parent) !== trustedHooksDirectory) {
    throw new Error(
      "Active hook destination must be directly inside the lifecycle hooks directory.",
    );
  }
  const descendant = relative(boundary, parent);
  if (descendant === ".." || descendant.startsWith(`..${sep}`) || isAbsolute(descendant)) {
    throw new Error(`Active hook destination is outside its owner root: ${destination}`);
  }

  const identities = [await inspectDirectory(boundary)];
  let cursor = boundary;
  for (const component of descendant.split(sep).filter(Boolean)) {
    const path = join(cursor, component);
    const parentBefore = await inspectDirectory(cursor);
    if (!sameDirectory(parentBefore, identities.at(-1) as DirectoryIdentity)) {
      throw new Error(`Active hook parent changed identity before directory inspection: ${cursor}`);
    }
    try {
      identities.push(await inspectDirectory(path));
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      try {
        await mkdir(path);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      identities.push(await inspectDirectory(path));
    }
    const parentAfter = await inspectDirectory(cursor);
    if (!sameDirectory(parentBefore, parentAfter)) {
      throw new Error(`Active hook parent changed identity during directory inspection: ${cursor}`);
    }
    cursor = path;
  }
  return identities;
};

const validateParents = async (expected: readonly DirectoryIdentity[]): Promise<void> => {
  for (const identity of expected) {
    const observed = await inspectDirectory(identity.path);
    if (!sameDirectory(identity, observed)) {
      throw new Error(`Active hook parent changed identity: ${identity.path}`);
    }
  }
};

const observeCompatibleParents = async (root: string): Promise<DirectoryIdentity[]> => {
  const identities: DirectoryIdentity[] = [];
  const resolvedRoot = resolve(root);
  for (const path of [
    resolvedRoot,
    join(resolvedRoot, ".arashi"),
    resolveLifecycleHooksDirectory(resolvedRoot),
  ]) {
    try {
      const observed = await lstat(path);
      if (observed.isSymbolicLink()) {
        throw new Error(`Compatible repository hook path has symbolic link ancestor: ${path}`);
      }
      if (!observed.isDirectory()) {
        throw new Error(`Compatible repository hook path has non-directory ancestor: ${path}`);
      }
      identities.push({ dev: observed.dev, ino: observed.ino, path });
    } catch (error) {
      if (isMissing(error) && path !== resolvedRoot) {
        break;
      }
      throw error;
    }
  }
  return identities;
};

const validateCompatibleSource = async (
  plan: RepositoryScriptPlan,
  expectedParents: readonly DirectoryIdentity[] | null,
): Promise<void> => {
  if (!plan.compatibleSourceRoot) return;
  const observedParents = await observeCompatibleParents(plan.compatibleSourceRoot);
  if (
    expectedParents &&
    (expectedParents.length !== observedParents.length ||
      expectedParents.some(
        (expected, index) => !sameDirectory(expected, observedParents[index] as DirectoryIdentity),
      ))
  ) {
    throw new Error(
      `Compatible repository hook path changed identity: ${plan.compatibleSourceRoot}`,
    );
  }
  const candidates = await discoverLifecycleHookCandidates(
    plan.lifecycle,
    plan.compatibleSourceRoot,
    plan.extension === ".ps1" ? "win32" : process.platform,
  );
  if (candidates.length > 0) {
    throw new Error(`Compatible repository hook source already exists: ${candidates.join(", ")}`);
  }
};

const validateOwnedDestination = async (entry: OwnedRepositoryScript): Promise<void> => {
  const observed = await lstat(entry.path, { bigint: true });
  if (
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    Number(observed.dev) !== entry.dev ||
    Number(observed.ino) !== entry.ino ||
    observed.birthtimeNs !== entry.birthtimeNs
  ) {
    throw new Error(`Active hook destination changed identity after publication: ${entry.path}`);
  }
  const bytes = await readFile(entry.path);
  const mode = entry.mode === null ? null : (await stat(entry.path)).mode & 0o777;
  if (!equalBytes(bytes, entry.bytes) || mode !== entry.mode) {
    throw new Error(`Active hook destination changed after publication: ${entry.path}`);
  }
};

const prepareTemporaryScript = async (
  temporaryPath: string,
  bytes: Uint8Array,
  mode: number | null,
): Promise<void> => {
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      if (mode !== null) {
        await handle.chmod(mode);
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Strongest practical pure Node/Bun installation: complete-file private preparation, exact mode,
 * hard-link no-replace publication, and observable parent/destination identity validation before
 * and after publication. Path-based APIs leave a narrow accepted race against a hostile local
 * process that can replace an ancestor between the final validation and the link operation.
 */
export const installRepositoryScripts = async (
  plans: readonly RepositoryScriptPlan[],
  dependencies: RepositoryScriptTransactionDependencies = {},
): Promise<OwnedRepositoryScript[]> => {
  const owned: OwnedRepositoryScript[] = [];
  try {
    for (const plan of plans) {
      const destination = resolve(plan.path);
      const expectedParents = await prepareParent(destination, plan.ownerRoot);
      const compatibleParents = plan.compatibleSourceRoot
        ? await observeCompatibleParents(plan.compatibleSourceRoot)
        : null;
      await validateCompatibleSource(plan, compatibleParents);
      const bytes = repositoryNoOpScaffold(plan.extension);
      const temporaryPath = join(
        dirname(destination),
        `.${basename(destination)}.arashi-${process.pid}-${randomUUID()}.tmp`,
      );
      let temporaryExists = false;
      try {
        await prepareTemporaryScript(temporaryPath, bytes, plan.mode);
        temporaryExists = true;
        const prepared = await lstat(temporaryPath, { bigint: true });
        if (!prepared.isFile() || prepared.isSymbolicLink()) {
          throw new Error(`Prepared active hook is not a regular file: ${destination}`);
        }
        await dependencies.beforePublication?.(plan);
        await validateParents(expectedParents);
        await validateCompatibleSource(plan, compatibleParents);
        await link(temporaryPath, destination);

        // Windows exposes a hard link's creation time per directory entry rather than preserving
        // the private staging path's value. Capture the published path's birth identity while
        // still requiring it to reference the prepared file.
        const published = await lstat(destination, { bigint: true });
        if (
          !published.isFile() ||
          published.isSymbolicLink() ||
          published.dev !== prepared.dev ||
          published.ino !== prepared.ino
        ) {
          throw new Error(`Published active hook is not a regular file: ${destination}`);
        }
        const entry: OwnedRepositoryScript = {
          birthtimeNs: published.birthtimeNs,
          bytes,
          dev: Number(published.dev),
          ino: Number(published.ino),
          mode: plan.mode,
          path: destination,
        };
        owned.push(entry);
        await dependencies.afterPublication?.(plan);
        await validateCompatibleSource(plan, compatibleParents);
        const validated = await lstat(destination, { bigint: true });
        if (
          !validated.isFile() ||
          validated.isSymbolicLink() ||
          validated.dev !== published.dev ||
          validated.ino !== published.ino ||
          validated.birthtimeNs !== published.birthtimeNs
        ) {
          throw new Error(`Published active hook is not a regular file: ${destination}`);
        }
        await validateParents(expectedParents);
        await validateOwnedDestination(entry);
        await rm(temporaryPath);
        temporaryExists = false;
      } finally {
        if (temporaryExists) {
          await rm(temporaryPath, { force: true }).catch(() => {});
        }
      }
    }
    return owned;
  } catch (error) {
    throw new RepositoryScriptTransactionError(
      `Failed to install active hook script: ${(error as Error).message}`,
      owned,
      error,
    );
  }
};

/**
 * Removes only entries that still match every observable ownership marker. Pure Node/Bun exposes
 * path-based unlink rather than a conditional identity-preserving unlink, so another local writer
 * can still replace the path after the final identity check. That narrow residual race is part of
 * the published CLI contract; callers must report preserved paths whenever ownership is uncertain.
 */
export const rollbackRepositoryScripts = async (
  owned: readonly OwnedRepositoryScript[],
): Promise<{ removed: string[]; preserved: string[] }> => {
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const entry of owned.toReversed()) {
    try {
      const before = await lstat(entry.path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) {
        preserved.push(entry.path);
        continue;
      }
      const bytes = await readFile(entry.path);
      const mode = entry.mode === null ? null : (await stat(entry.path)).mode & 0o777;
      const after = await lstat(entry.path, { bigint: true });
      if (
        entry.birthtimeNs !== 0n &&
        before.birthtimeNs !== 0n &&
        after.birthtimeNs !== 0n &&
        after.isFile() &&
        !after.isSymbolicLink() &&
        Number(before.dev) === entry.dev &&
        Number(before.ino) === entry.ino &&
        before.birthtimeNs === entry.birthtimeNs &&
        Number(after.dev) === entry.dev &&
        Number(after.ino) === entry.ino &&
        after.birthtimeNs === entry.birthtimeNs &&
        equalBytes(bytes, entry.bytes) &&
        mode === entry.mode
      ) {
        await rm(entry.path);
        removed.push(entry.path);
      } else {
        preserved.push(entry.path);
      }
    } catch (error) {
      if (!isMissing(error)) {
        preserved.push(entry.path);
      }
    }
  }
  const order = new Map(owned.map((entry, index) => [entry.path, index]));
  const byOriginalOrder = (left: string, right: string): number =>
    (order.get(left) ?? 0) - (order.get(right) ?? 0);
  return {
    preserved: preserved.toSorted(byOriginalOrder),
    removed: removed.toSorted(byOriginalOrder),
  };
};
