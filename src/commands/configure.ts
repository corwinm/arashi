import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { Command } from "commander";
import {
  findWorkspaceRoot,
  getConfigPath,
  ConfigParseError,
  normalizeConfig,
  saveConfig,
  type Config,
} from "../lib/config.ts";
import { collectConfigurationEdits } from "../lib/configure-controller.ts";
import {
  defaultConfigureTransactionDependencies,
  runConfigureTransaction,
} from "../lib/configure-transaction.ts";
import { inspectConfiguration } from "../lib/workspace-config-editor.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
  type JsonEnvelope,
} from "../lib/json-output.ts";
import { observeRepositoryActivePaths } from "../lib/repository-active-path-observer.ts";
import { exec as gitExec } from "../lib/git.ts";
import { discoverRepositoryLocalCandidates } from "../lib/repository-candidate-discovery.ts";

export interface ConfigureOptions {
  json?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}
export interface ConfigureSnapshot {
  bytes: Uint8Array;
  config: Config;
  executionRoot?: string;
  persisted?: unknown;
  workspaceRoot: string;
}
const configureLifecycles = ["pre-create", "post-create", "pre-remove", "post-remove"] as const;
const resolveExecutionRoot = async (configurationRoot: string, invocationPath: string) => {
  let current = resolve(invocationPath);
  const filesystemRoot = parse(current).root;
  while (true) {
    try {
      const common = (await gitExec(["rev-parse", "--git-common-dir"], current)).stdout.trim();
      const commonDirectory = isAbsolute(common) ? resolve(common) : resolve(current, common);
      if (commonDirectory === resolve(configurationRoot)) {
        const bare = (await gitExec(["rev-parse", "--is-bare-repository"], current)).stdout.trim();
        if (bare === "true") return configurationRoot;
        return resolve((await gitExec(["rev-parse", "--show-toplevel"], current)).stdout.trim());
      }
    } catch {
      // A nested child repository may have unrelated metadata; continue through its parents.
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  return configurationRoot;
};

export const loadConfigureSnapshot = async (root?: string): Promise<ConfigureSnapshot> => {
  const invocationPath = root ?? process.cwd();
  const workspaceRoot = root ?? (await findWorkspaceRoot(invocationPath, { validate: false }));
  const bytes = await readFile(getConfigPath(workspaceRoot));
  let persisted: unknown;
  try {
    persisted = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new ConfigParseError(getConfigPath(workspaceRoot), error as Error);
  }
  const config = normalizeConfig(persisted);
  if (!("worktreesDir" in (persisted as object)) && !("worktrees_dir" in (persisted as object)))
    delete config.worktreesDir;
  return {
    bytes,
    config,
    executionRoot: await resolveExecutionRoot(workspaceRoot, invocationPath),
    persisted: persisted as Record<string, unknown>,
    workspaceRoot,
  };
};

export const inspectConfigureSnapshot = async (snapshot: ConfigureSnapshot) => {
  const nativeSources: Array<{
    lifecycle: (typeof configureLifecycles)[number];
    ownerName?: string;
    scope: "workspace" | "repository";
    sourceKind: "file";
  }> = [];
  const workspaceObserver = observeRepositoryActivePaths({
    activeConfigRoot: snapshot.workspaceRoot,
    activeRepositoryPath: snapshot.executionRoot ?? snapshot.workspaceRoot,
    repositoryScopedCreate: false,
  });
  const workspaceObservations = await workspaceObserver({
    lifecycles: configureLifecycles.map((lifecycle) => ({
      inlineConfigured: snapshot.config.hooks?.scripts?.[lifecycle] !== undefined,
      lifecycle,
      plannedPath: null,
    })),
    repositoryName: "@workspace",
  });
  for (const observation of workspaceObservations) {
    if (observation.destinationExists || (observation.nativeCandidateCount ?? 0) > 0)
      nativeSources.push({
        lifecycle: observation.lifecycle,
        scope: "workspace",
        sourceKind: "file",
      });
  }
  for (const [name, repository] of Object.entries(snapshot.config.repos)) {
    const observer = observeRepositoryActivePaths({
      activeConfigRoot: snapshot.workspaceRoot,
      activeRepositoryPath: resolve(
        snapshot.executionRoot ?? snapshot.workspaceRoot,
        repository.path,
      ),
    });
    const observations = await observer({
      lifecycles: configureLifecycles.map((lifecycle) => ({
        inlineConfigured: repository.hooks?.[lifecycle] !== undefined,
        lifecycle,
        plannedPath: null,
      })),
      repositoryName: name,
    });
    for (const observation of observations) {
      if (observation.destinationExists || (observation.nativeCandidateCount ?? 0) > 0)
        nativeSources.push({
          lifecycle: observation.lifecycle,
          ownerName: name,
          scope: "repository",
          sourceKind: "file",
        });
    }
  }
  return inspectConfiguration(snapshot.config, undefined, snapshot.persisted, nativeSources);
};
export interface ConfigureDependencies {
  loadSnapshot: () => Promise<ConfigureSnapshot>;
  collectEdits: typeof collectConfigurationEdits;
  transact: typeof runConfigureTransaction;
  writeJson: (value: JsonEnvelope<Record<string, unknown>>) => void;
}
const defaults: ConfigureDependencies = {
  collectEdits: collectConfigurationEdits,
  loadSnapshot: loadConfigureSnapshot,
  transact: runConfigureTransaction,
  writeJson: writeJsonEnvelope,
};

export const executeConfigure = async (
  options: ConfigureOptions = {},
  dependencies: ConfigureDependencies = defaults,
): Promise<number> => {
  let snapshot: ConfigureSnapshot;
  try {
    snapshot = await dependencies.loadSnapshot();
  } catch (error) {
    if (!options.json) throw error;
    dependencies.writeJson(
      createJsonErrorEnvelope("configure", unknownErrorToJsonError(error, "CONFIG_LOAD_FAILED")),
    );
    return 1;
  }
  if (options.json) {
    dependencies.writeJson(
      createJsonSuccessEnvelope("configure", await inspectConfigureSnapshot(snapshot)),
    );
    return 0;
  }
  if (options.stdinIsTTY !== true || options.stdoutIsTTY !== true)
    throw new Error(
      "Interactive configure requires both stdin and stdout to be TTYs. Use --json for inspection.",
    );
  const result = await dependencies.collectEdits({
    activeConfigRoot: snapshot.workspaceRoot,
    config: snapshot.config,
    persisted: snapshot.persisted,
    discoverRepositoryCandidates: discoverRepositoryLocalCandidates,
    executionRoot: snapshot.executionRoot,
    observeRepositoryActivePaths: (context) => observeRepositoryActivePaths(context),
    observeWorkspaceActivePaths: observeRepositoryActivePaths({
      activeConfigRoot: snapshot.workspaceRoot,
      activeRepositoryPath: snapshot.executionRoot ?? snapshot.workspaceRoot,
      repositoryScopedCreate: false,
    }),
    originalSerialized: new TextDecoder().decode(snapshot.bytes),
  });
  if (result.status === "no-changes") {
    console.log("No configuration changes.");
    return 0;
  }
  if (result.status !== "confirmed") return result.status === "cancelled" ? 2 : 0;
  const configPath = getConfigPath(snapshot.workspaceRoot);
  await dependencies.transact({
    candidate: result.session.candidate,
    expectedBytes: snapshot.bytes,
    plans: result.session.scripts,
    dependencies: defaultConfigureTransactionDependencies(
      snapshot.workspaceRoot,
      configPath,
      (candidate) => saveConfig(snapshot.workspaceRoot, candidate),
    ),
  });
  console.log("Configuration updated.");
  return 0;
};

export const createCommand = (): Command =>
  new Command("configure")
    .description("Inspect or interactively edit supported workspace configuration")
    .option(
      "-j, --json",
      "Inspect supported configured and effective values without prompting or mutation",
    )
    .addHelpText(
      "after",
      "\nEditing requires TTY stdin and stdout. --json is sanitized inspection only; unsupported fields remain available through direct config.json editing.\n",
    )
    .action(async (options: ConfigureOptions) => {
      process.exitCode = await executeConfigure({
        ...options,
        stdinIsTTY: process.stdin.isTTY,
        stdoutIsTTY: process.stdout.isTTY,
      });
    });
