import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import type { Config } from "./config.ts";
import { serializeConfig } from "./config.ts";
import type { RepositoryScriptPlan } from "./repository-config-editor.ts";
import {
  RepositoryScriptTransactionError,
  installRepositoryScripts,
  rollbackRepositoryScripts,
  type OwnedRepositoryScript,
} from "./repository-script-transaction.ts";
import {
  resolveWorkspaceTransactionLockPath,
  withWorkspaceTransactionLock,
} from "./workspace-transaction-lock.ts";
import { discoverLifecycleHookCandidates } from "./hooks.ts";

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

export interface ConfigureTransactionDependencies {
  readConfigBytes(): Promise<Uint8Array>;
  revalidatePlans?(plans: readonly RepositoryScriptPlan[]): Promise<void>;
  installScripts(plans: readonly RepositoryScriptPlan[]): Promise<OwnedRepositoryScript[]>;
  rollbackScripts(
    owned: readonly OwnedRepositoryScript[],
  ): Promise<{ removed: string[]; preserved: string[] }>;
  restoreConfig?(originalBytes: Uint8Array, expectedCandidateBytes: Uint8Array): Promise<boolean>;
  saveConfig(candidate: Config): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

export const runConfigureTransaction = async (options: {
  candidate: Config;
  expectedBytes: Uint8Array;
  plans: readonly RepositoryScriptPlan[];
  dependencies: ConfigureTransactionDependencies;
}): Promise<void> => {
  return options.dependencies.withLock(async () => {
    const current = await options.dependencies.readConfigBytes();
    if (!equalBytes(current, options.expectedBytes))
      throw new Error("Configuration changed concurrently; preserved the newer bytes.");
    let owned: OwnedRepositoryScript[] = [];
    let saveAttempted = false;
    try {
      await options.dependencies.revalidatePlans?.(options.plans);
      owned = await options.dependencies.installScripts(options.plans);
      const afterInstall = await options.dependencies.readConfigBytes();
      if (!equalBytes(afterInstall, options.expectedBytes))
        throw new Error("Configuration changed concurrently; preserved the newer bytes.");
      saveAttempted = true;
      await options.dependencies.saveConfig(options.candidate);
    } catch (error) {
      if (error instanceof RepositoryScriptTransactionError) {
        owned = [...error.owned];
      }
      const cleanupErrors: unknown[] = [];
      if (saveAttempted && options.dependencies.restoreConfig) {
        try {
          await options.dependencies.restoreConfig(
            options.expectedBytes,
            new TextEncoder().encode(serializeConfig(options.candidate)),
          );
        } catch (recoveryError) {
          cleanupErrors.push(recoveryError);
        }
      }
      if (owned.length > 0) {
        try {
          const rollback = await options.dependencies.rollbackScripts(owned);
          for (const path of rollback.preserved) {
            cleanupErrors.push(
              new Error(`Preserved modified or unowned active hook during rollback: ${path}`),
            );
          }
        } catch (rollbackError) {
          cleanupErrors.push(rollbackError);
        }
      }
      if (cleanupErrors.length > 0) {
        const aggregateError = new AggregateError(
          [error, ...cleanupErrors],
          "Configuration transaction failed and recovery was incomplete; inspect the nested errors.",
        );
        aggregateError.cause = error;
        throw aggregateError;
      }
      throw error;
    }
  });
};

interface AtomicConfigurePersistenceDependencies {
  open(
    path: string,
    flags: "wx",
    mode: number,
  ): Promise<{
    chmod(mode: number): Promise<void>;
    chown(uid: number, gid: number): Promise<void>;
    close(): Promise<void>;
    stat(): Promise<{ gid: number; uid: number }>;
    sync(): Promise<void>;
    writeFile(bytes: Uint8Array): Promise<void>;
  }>;
  readFile(path: string): Promise<Uint8Array>;
  realpath?(path: string): Promise<string>;
  platform: NodeJS.Platform;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  stat(path: string): Promise<{ gid: number; mode: number }>;
  temporaryName: (configPath: string) => string;
}

const atomicPersistenceDefaults: AtomicConfigurePersistenceDependencies = {
  open,
  platform: process.platform,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  temporaryName: (configPath) =>
    `.${basename(configPath)}.arashi-${process.pid}-${randomUUID()}.tmp`,
};

/** Atomically replaces live bytes only when they still equal the exact expected snapshot. */
export const persistExpectedBytesAtomically = async (
  configPath: string,
  replacementBytes: Uint8Array,
  expectedBytes: Uint8Array,
  dependencies: AtomicConfigurePersistenceDependencies = atomicPersistenceDefaults,
): Promise<boolean> => {
  const persistencePath = dependencies.realpath
    ? await dependencies.realpath(configPath)
    : configPath;
  const beforeStage = await dependencies.readFile(persistencePath);
  if (!equalBytes(beforeStage, expectedBytes)) return false;
  const temporaryPath = join(dirname(persistencePath), dependencies.temporaryName(persistencePath));
  let temporaryExists = false;
  let failure: unknown;
  let persisted = false;
  try {
    const handle = await dependencies.open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    let replace = false;
    try {
      await handle.writeFile(replacementBytes);
      await handle.sync();
      const beforeReplace = await dependencies.readFile(persistencePath);
      if (equalBytes(beforeReplace, expectedBytes)) {
        if (dependencies.platform !== "win32") {
          const liveMetadata = await dependencies.stat(persistencePath);
          const stagedMetadata = await handle.stat();
          if (stagedMetadata.gid !== liveMetadata.gid) {
            await handle.chown(stagedMetadata.uid, liveMetadata.gid);
          }
          await handle.chmod(liveMetadata.mode & 0o777);
          await handle.sync();
        }
        replace = true;
      }
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (closeError) {
      failure = failure
        ? new AggregateError([failure, closeError], "Atomic configuration staging failed to close.")
        : closeError;
    }
    if (failure) throw failure;
    if (replace) {
      await dependencies.rename(temporaryPath, persistencePath);
      temporaryExists = false;
      persisted = true;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (temporaryExists) {
      try {
        await dependencies.rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        failure = failure
          ? new AggregateError(
              [failure, cleanupError],
              `Atomic configuration staging failed and could not clean ${temporaryPath}.`,
            )
          : cleanupError;
      }
    }
  }
  if (failure) throw failure;
  return persisted;
};

/** Privately stage complete canonical bytes before atomically replacing the live configuration. */
export const persistConfigureAtomically = async (
  configPath: string,
  candidate: Config,
  expectedBytes: Uint8Array,
  dependencies: AtomicConfigurePersistenceDependencies = atomicPersistenceDefaults,
): Promise<void> => {
  const persisted = await persistExpectedBytesAtomically(
    configPath,
    new TextEncoder().encode(serializeConfig(candidate)),
    expectedBytes,
    dependencies,
  );
  if (!persisted) throw new Error("Configuration changed concurrently; preserved the newer bytes.");
};

export const revalidateRepositoryScriptPlans = async (
  plans: readonly RepositoryScriptPlan[],
  dependencies: {
    discoverLifecycleHookCandidates?: typeof discoverLifecycleHookCandidates;
  } = {},
): Promise<void> => {
  const discoverCandidates =
    dependencies.discoverLifecycleHookCandidates ?? discoverLifecycleHookCandidates;
  const destinations = new Set<string>();
  for (const plan of plans) {
    const platform: NodeJS.Platform = plan.extension === ".ps1" ? "win32" : process.platform;
    const pathName = platform === "win32" ? win32.basename(plan.path) : basename(plan.path);
    const hookName = pathName.slice(0, -plan.extension.length);
    const destinationKey = platform === "win32" ? plan.path.toLowerCase() : plan.path;
    if (destinations.has(destinationKey))
      throw new Error(`Duplicate active hook destination in transaction plan: ${plan.path}`);
    destinations.add(destinationKey);
    const nativeCandidates = await discoverCandidates(hookName, plan.ownerRoot, platform);
    if (nativeCandidates.length > 0)
      throw new Error(`Native active hook already exists for ${plan.lifecycle}; preserved it.`);
  }
};

export const defaultConfigureTransactionDependencies = (
  workspaceRoot: string,
  configPath: string,
  expectedBytes: Uint8Array,
): ConfigureTransactionDependencies => {
  return {
    installScripts: installRepositoryScripts,
    readConfigBytes: () => readFile(configPath),
    revalidatePlans: revalidateRepositoryScriptPlans,
    restoreConfig: (originalBytes, expectedCandidateBytes) =>
      persistExpectedBytesAtomically(configPath, originalBytes, expectedCandidateBytes),
    rollbackScripts: rollbackRepositoryScripts,
    saveConfig: (candidate) => persistConfigureAtomically(configPath, candidate, expectedBytes),
    withLock: async (operation) => {
      const lockPath = await resolveWorkspaceTransactionLockPath(workspaceRoot);
      return withWorkspaceTransactionLock(lockPath, operation);
    },
  };
};
