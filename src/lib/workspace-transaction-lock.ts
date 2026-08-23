import { randomUUID } from "node:crypto";
import { link, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { exec as gitExec } from "./git.ts";

const LOCK_RETRY_DELAY_MS = 20;
const TRANSACTION_LOCK_RETRY_COUNT = 90_000;
export const DEFAULT_INCOMPLETE_LOCK_STALE_MS = 30_000;

interface LockOwner {
  pid: number;
  token: string;
}

const readLockOwner = async (lockPath: string): Promise<LockOwner | null> => {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(owner.pid) && typeof owner.token === "string"
      ? { pid: owner.pid as number, token: owner.token }
      : null;
  } catch {
    return null;
  }
};

const lockOwnerIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const reclaimAbandonedLock = async (
  lockPath: string,
  incompleteLockStaleMs: number,
): Promise<boolean> => {
  let lockStat: Awaited<ReturnType<typeof stat>>;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const legacyClaimPath = `${lockPath}.reclaim-${lockStat.dev}-${lockStat.ino}`;
  const claimPrefix = `${legacyClaimPath}-`;
  const claimPath = `${claimPrefix}${process.pid}-${randomUUID()}`;
  try {
    await link(lockPath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const claimedStat = await stat(claimPath);
    const currentStat = await stat(lockPath).catch(() => null);
    if (!currentStat || claimedStat.dev !== currentStat.dev || claimedStat.ino !== currentStat.ino)
      return true;
    const claimNamePrefix = basename(claimPrefix);
    const liveClaims: string[] = [];
    for (const name of await readdir(dirname(lockPath))) {
      if (!name.startsWith(claimNamePrefix)) continue;
      const pid = Number(name.slice(claimNamePrefix.length).split("-", 1)[0]);
      const contenderPath = join(dirname(lockPath), name);
      if (!Number.isInteger(pid) || !lockOwnerIsAlive(pid)) {
        await rm(contenderPath, { force: true });
        continue;
      }
      liveClaims.push(name);
    }
    if (liveClaims.some((name) => name !== basename(claimPath))) return false;
    const owner = await readLockOwner(claimPath);
    if (owner && lockOwnerIsAlive(owner.pid)) return false;
    if (!owner && Date.now() - claimedStat.mtimeMs < incompleteLockStaleMs) return false;
    const finalCurrentStat = await stat(lockPath).catch(() => null);
    if (
      !finalCurrentStat ||
      claimedStat.dev !== finalCurrentStat.dev ||
      claimedStat.ino !== finalCurrentStat.ino
    )
      return true;
    await rm(lockPath);
    await rm(legacyClaimPath, { force: true });
    return true;
  } finally {
    await rm(claimPath, { force: true });
  }
};

export const withWorkspaceTransactionLock = async <T>(
  lockPath: string,
  operation: () => Promise<T>,
  incompleteLockStaleMs = DEFAULT_INCOMPLETE_LOCK_STALE_MS,
  retryCount = TRANSACTION_LOCK_RETRY_COUNT,
): Promise<T> => {
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    try {
      const candidate = await open(lockPath, "wx");
      try {
        await candidate.writeFile(JSON.stringify(owner));
        await candidate.sync();
        lock = candidate;
      } catch (error) {
        await candidate.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimAbandonedLock(lockPath, incompleteLockStaleMs)) continue;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_DELAY_MS));
    }
  }
  if (!lock) throw new Error(`Timed out waiting for workspace transaction lock: ${lockPath}`);
  try {
    return await operation();
  } finally {
    await lock.close();
    const currentOwner = await readLockOwner(lockPath);
    if (currentOwner?.token === owner.token) await rm(lockPath, { force: true });
  }
};

export const resolveWorkspaceTransactionLockPath = async (
  workspaceRoot: string,
  dependencies: { gitCommonDirectory?: (root: string) => Promise<string> } = {},
): Promise<string> => {
  try {
    const commonDirectory = dependencies.gitCommonDirectory
      ? await dependencies.gitCommonDirectory(workspaceRoot)
      : (await gitExec(["rev-parse", "--git-common-dir"], workspaceRoot)).stdout.trim();
    if (!commonDirectory) throw new Error("Git returned an empty common directory.");
    return join(
      await realpath(resolve(workspaceRoot, commonDirectory)),
      ".arashi-add.transaction.lock",
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("not a git repository")) throw error;
    return join(await realpath(workspaceRoot), ".arashi-add.transaction.lock");
  }
};
