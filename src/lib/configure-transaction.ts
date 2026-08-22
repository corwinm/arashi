import { readFile } from "node:fs/promises";
import { basename as posixBasename, win32 } from "node:path";
import type { Config } from "./config.ts";
import { serializeConfig } from "./config.ts";
import { runtime } from "./runtime.ts";
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
  restoreConfigBytes?(expected: Uint8Array, observed: Uint8Array): Promise<void>;
  saveConfig(candidate: Config): Promise<void>;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}

export const runConfigureTransaction = async (options: {
  candidate: Config;
  expectedBytes: Uint8Array;
  plans: readonly RepositoryScriptPlan[];
  dependencies: ConfigureTransactionDependencies;
}): Promise<void> => {
  const transactionBytes = new TextEncoder().encode(serializeConfig(options.candidate));
  return options.dependencies.withLock(async () => {
    const current = await options.dependencies.readConfigBytes();
    if (!equalBytes(current, options.expectedBytes))
      throw new Error("Configuration changed concurrently; preserved the newer bytes.");
    let owned: OwnedRepositoryScript[] = [];
    let saveStarted = false;
    try {
      await options.dependencies.revalidatePlans?.(options.plans);
      owned = await options.dependencies.installScripts(options.plans);
      const afterInstall = await options.dependencies.readConfigBytes();
      if (!equalBytes(afterInstall, options.expectedBytes))
        throw new Error("Configuration changed concurrently; preserved the newer bytes.");
      saveStarted = true;
      await options.dependencies.saveConfig(options.candidate);
    } catch (error) {
      if (error instanceof RepositoryScriptTransactionError) {
        owned = [...error.owned];
      }
      if (owned.length > 0) await options.dependencies.rollbackScripts(owned);
      if (saveStarted && options.dependencies.restoreConfigBytes) {
        const observed = await options.dependencies.readConfigBytes();
        if (equalBytes(observed, transactionBytes))
          await options.dependencies.restoreConfigBytes(options.expectedBytes, observed);
      }
      throw error;
    }
  });
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
    const pathName = platform === "win32" ? win32.basename(plan.path) : posixBasename(plan.path);
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
  save: (candidate: Config) => Promise<void>,
): ConfigureTransactionDependencies => {
  return {
    installScripts: installRepositoryScripts,
    readConfigBytes: () => readFile(configPath),
    revalidatePlans: revalidateRepositoryScriptPlans,
    restoreConfigBytes: async (expected) => runtime.write(configPath, expected),
    rollbackScripts: rollbackRepositoryScripts,
    saveConfig: save,
    withLock: async (operation) => {
      const lockPath = await resolveWorkspaceTransactionLockPath(workspaceRoot);
      return withWorkspaceTransactionLock(lockPath, operation);
    },
  };
};
