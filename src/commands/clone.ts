import {
  applyCloneProtocol,
  discoverCloneRepositories,
  inferCloneProtocolPreference,
} from "../lib/clone-discovery.ts";
import { clone as cloneRepository, exec } from "../lib/git.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  unsupportedJsonModeError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { loadConfig, normalizeConfig, repairRepositoryGitUrls, saveConfig } from "../lib/config.ts";
import type { WorkspaceRepositoryRoots } from "../lib/config.ts";
import { info, error as logError, spinner, success, warn } from "../lib/logger.ts";
import { join, resolve } from "path";
import {
  confirm as promptConfirm,
  input as promptInput,
  multiSelect as promptMultiSelect,
  select as promptSelect,
} from "../lib/prompts.ts";
import { Command } from "commander";
import { removeDir } from "../lib/filesystem.ts";
import { stat } from "fs/promises";
import {
  reconcileRepositoryManagedIgnore,
  restoreManagedIgnore,
  type ManagedIgnoreReconciliation,
} from "../lib/managed-ignore.ts";
import { DEFAULT_WORKTREES_DIR } from "../lib/worktree-location.ts";
import { findConfiguredWorkspaceRoots } from "../lib/workspace-context.ts";

interface Choice<T> {
  value: T;
  name: string;
  description?: string;
}

type CloneProtocol = "ssh" | "https";
type Config = Awaited<ReturnType<typeof loadConfig>>;
type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason: "exit" | "abort" };

const ZERO = 0;
const SUCCESS_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const CANCELLED_STATUS = "cancelled" as const;
const SUCCESS_STATUS = "success" as const;
const PARTIAL_FAILURE_STATUS = "partial-failure" as const;

export interface CloneCommandOptions {
  all?: boolean;
  json?: boolean;
}

export interface CloneExecutionResult {
  status: "success" | "partial-failure" | "cancelled";
  cloned: string[];
  failed: { name: string; reason: string }[];
  skipped: string[];
  managedIgnore?: ManagedIgnoreReconciliation;
}

export interface CloneCommandDependencies {
  workspaceRoot?: string;
  workspaceRoots?: WorkspaceRepositoryRoots;
  findWorkspaceRoot?: () => Promise<string>;
  findWorkspaceRoots?: () => Promise<WorkspaceRepositoryRoots>;
  loadConfig?: (workspaceRoot: string) => Promise<Config>;
  saveConfig?: (workspaceRoot: string, config: Config) => Promise<void>;
  repairRepositoryGitUrls?: typeof repairRepositoryGitUrls;
  discoverCloneRepositories?: typeof discoverCloneRepositories;
  cloneRepository?: typeof cloneRepository;
  addWorktree?: (
    sourceRepositoryPath: string,
    destinationPath: string,
    branchName: string,
  ) => Promise<unknown>;
  resolveCurrentBranch?: (workspaceRoot: string) => Promise<string | null>;
  resolveSourceWorkspaceRoot?: (workspaceRoot: string) => string | null;
  pathExists?: (path: string) => Promise<boolean>;
  removeDir?: typeof removeDir;
  promptConfirm?: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;
  promptInput?: (message: string, defaultValue?: string) => Promise<PromptOutcome<string>>;
  promptMultiSelect?: <T>(message: string, choices: Choice<T>[]) => Promise<PromptOutcome<T[]>>;
  promptSelect?: <T>(message: string, choices: Choice<T>[]) => Promise<PromptOutcome<T>>;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}

export function createCommand(): Command {
  return new Command("clone")
    .description("Clone missing configured repositories")
    .option("--all", "Clone all missing repositories without interactive selection")
    .option("--json", "Output result as JSON; requires --all")
    .action(async (options: CloneCommandOptions) => {
      if (options.json && !options.all) {
        writeJsonEnvelope(unsupportedJsonModeError("clone", "interactive-selection"));
        process.exit(ERROR_EXIT_CODE);
      }

      try {
        const result = await executeClone(options);

        if (options.json) {
          writeJsonEnvelope(createJsonSuccessEnvelope("clone", { ...result }));
        }

        if (result.status === CANCELLED_STATUS) {
          if (!options.json) {
            info("Clone operation cancelled.");
          }
          process.exit(SUCCESS_EXIT_CODE);
        }

        let exitCode = SUCCESS_EXIT_CODE;
        if (result.failed.length > ZERO) {
          exitCode = ERROR_EXIT_CODE;
        }

        process.exit(exitCode);
      } catch (error) {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("clone", unknownErrorToJsonError(error)));
        } else {
          logError(error instanceof Error ? error.message : String(error));
        }
        process.exit(ERROR_EXIT_CODE);
      }
    });
}

export async function executeClone(
  options: CloneCommandOptions,
  deps: CloneCommandDependencies = {},
): Promise<CloneExecutionResult> {
  const readConfig = deps.loadConfig ?? loadConfig;
  const writeConfig = deps.saveConfig ?? saveConfig;
  const repairGitUrls = deps.repairRepositoryGitUrls ?? repairRepositoryGitUrls;
  const discoverRepositories = deps.discoverCloneRepositories ?? discoverCloneRepositories;
  const runClone = deps.cloneRepository ?? cloneRepository;
  const runAddWorktree = deps.addWorktree ?? addRepositoryWorktree;
  const resolveBranch = deps.resolveCurrentBranch ?? resolveWorkspaceBranch;
  const resolveSourceRoot =
    deps.resolveSourceWorkspaceRoot ?? resolveCoordinatedSourceWorkspaceRoot;
  const exists = deps.pathExists ?? pathExists;
  const deleteDirectory = deps.removeDir ?? removeDir;
  const confirm = deps.promptConfirm ?? promptConfirm;
  const askInput = deps.promptInput ?? promptInput;
  const askMultiSelect = deps.promptMultiSelect ?? promptMultiSelect;
  const askSelect = deps.promptSelect ?? promptSelect;

  const interactive = Boolean(
    !options.json &&
    (deps.stdinIsTTY ?? process.stdin.isTTY) &&
    (deps.stdoutIsTTY ?? process.stdout.isTTY),
  );

  const { configurationRoot, executionRoot } = await resolveCloneWorkspaceRoots(deps);
  const sourceWorkspaceRoot =
    resolveSourceRoot(executionRoot) ??
    (configurationRoot === executionRoot ? null : configurationRoot);
  const currentBranch = sourceWorkspaceRoot ? await resolveBranch(executionRoot) : null;
  const config = normalizeConfig(await readConfig(configurationRoot));

  const repairResult = await repairGitUrls(executionRoot, config);
  let configUpdated = repairResult.updated;

  if (repairResult.repaired.length > 0 && !options.json) {
    info(`Recovered missing git URLs from local remotes: ${repairResult.repaired.join(", ")}`);
  }

  if (repairResult.updated) {
    await writeConfig(configurationRoot, config);
  }

  let discovery = await discoverRepositories(executionRoot, config);

  const reconcileResult = await reconcileUnmanagedRepositories({
    askInput,
    askSelect,
    config,
    confirm,
    deleteDirectory,
    interactive,
    quiet: Boolean(options.json),
    unmanagedRepositories: discovery.unmanagedLocal,
    workspaceRoot: executionRoot,
  });

  if (reconcileResult.cancelled) {
    return {
      cloned: [],
      failed: [],
      skipped: [],
      status: CANCELLED_STATUS,
    };
  }

  if (reconcileResult.updatedConfig) {
    configUpdated = true;
    await writeConfig(configurationRoot, config);
    discovery = await discoverRepositories(executionRoot, config);
  }

  if (discovery.configuredMissing.length === 0) {
    if (!options.json) {
      success("All configured repositories are already present. Nothing to clone.");
    }
    return {
      cloned: [],
      failed: [],
      skipped: [],
      status: SUCCESS_STATUS,
    };
  }

  const missingWithUrls = discovery.configuredMissing.filter(
    (repository) =>
      typeof repository.config.gitUrl === "string" && repository.config.gitUrl.length > 0,
  );
  const missingWithoutUrls = discovery.configuredMissing.filter(
    (repository) => !repository.config.gitUrl,
  );

  if (interactive && missingWithoutUrls.length > 0) {
    for (const repository of missingWithoutUrls) {
      const enteredUrl = await askInput(
        `Enter git URL for missing repository '${repository.name}' (leave empty to skip):`,
      );
      if (enteredUrl.status === "cancelled") {
        return {
          cloned: [],
          failed: [],
          skipped: [],
          status: CANCELLED_STATUS,
        };
      }

      const value = enteredUrl.value.trim();
      if (value) {
        repository.config.gitUrl = value;
        missingWithUrls.push(repository);
        configUpdated = true;
      }
    }
  }

  const unresolvedMissingWithoutUrls = missingWithoutUrls
    .filter((repository) => !repository.config.gitUrl)
    .map((repository) => repository.name);
  if (unresolvedMissingWithoutUrls.length > 0 && !options.json) {
    warn(
      `Skipping repositories without configured gitUrl: ${unresolvedMissingWithoutUrls.join(", ")}`,
    );
  }

  if (missingWithUrls.length === 0) {
    throw new Error("No missing repositories have cloneable git URLs configured.");
  }

  const preferredProtocol = await resolveProtocolPreference({
    askSelect,
    interactive,
    urls: Object.values(config.repos).map((repo) => repo.gitUrl),
  });

  let selectedRepositories = missingWithUrls;
  if (!options.all) {
    if (!interactive) {
      throw new Error("Interactive selection requires a TTY. Use `arashi clone --all` instead.");
    }

    const selectionChoices: Choice<string>[] = missingWithUrls.map((repository) => ({
      description: repository.path,
      name: repository.name,
      value: repository.name,
    }));

    const selection = await askMultiSelect(
      "Select missing repositories to clone:",
      selectionChoices,
    );

    if (selection.status === "cancelled") {
      return {
        cloned: [],
        failed: [],
        skipped: [],
        status: CANCELLED_STATUS,
      };
    }

    const selectedNames = new Set(selection.value);
    selectedRepositories = missingWithUrls.filter((repository) =>
      selectedNames.has(repository.name),
    );

    if (selectedRepositories.length === 0) {
      if (!options.json) {
        info("No repositories selected for cloning.");
      }
      return {
        cloned: [],
        failed: [],
        skipped: missingWithUrls.map((repository) => repository.name),
        status: SUCCESS_STATUS,
      };
    }
  }

  const cloned: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  let residualMaterializedState = false;
  const skipped = missingWithUrls
    .map((repository) => repository.name)
    .filter((name) => !selectedRepositories.some((repository) => repository.name === name));

  const managedIgnore = await reconcileRepositoryManagedIgnore({
    reposDir: config.reposDir,
    workspaceRoot: configurationRoot,
    worktreesDir: config.worktreesDir ?? DEFAULT_WORKTREES_DIR,
  });
  if (!options.json) {
    for (const warning of managedIgnore.warnings) {
      warn(warning);
    }
  }

  for (const repository of selectedRepositories) {
    const rawGitUrl = repository.config.gitUrl;
    if (rawGitUrl) {
      const sourceRepositoryPath = sourceWorkspaceRoot
        ? resolve(sourceWorkspaceRoot, repository.config.path)
        : null;
      const canCompleteAsWorktree = Boolean(
        sourceRepositoryPath && currentBranch && (await exists(sourceRepositoryPath)),
      );
      const cloneUrl = preferredProtocol
        ? applyCloneProtocol(rawGitUrl, preferredProtocol)
        : rawGitUrl;

      const cloneSpinner = options.json
        ? undefined
        : spinner(`Cloning ${repository.name}...`).start();

      try {
        if (canCompleteAsWorktree && sourceRepositoryPath && currentBranch) {
          await runAddWorktree(sourceRepositoryPath, repository.path, currentBranch);
        } else {
          await runClone(cloneUrl, repository.path);
          configUpdated = configUpdated || repository.config.gitUrl !== cloneUrl;
          repository.config.gitUrl = cloneUrl;
        }

        cloneSpinner?.succeed(`Cloned ${repository.name}`);
        cloned.push(repository.name);
      } catch (error) {
        let reason = error instanceof Error ? error.message : String(error);
        if (await exists(repository.path)) {
          try {
            await deleteDirectory(repository.path);
          } catch (cleanupError) {
            residualMaterializedState = true;
            reason += `; cleanup failed: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`;
          }
        }
        residualMaterializedState = residualMaterializedState || (await exists(repository.path));
        cloneSpinner?.fail(`Failed to clone ${repository.name}`);
        failed.push({
          name: repository.name,
          reason,
        });
      }
    } else {
      failed.push({
        name: repository.name,
        reason: "Missing gitUrl in configuration",
      });
    }
  }

  try {
    if (configUpdated) {
      await writeConfig(configurationRoot, config);
    }
  } catch (error) {
    if (cloned.length === ZERO && !residualMaterializedState && managedIgnore.changed) {
      await restoreManagedIgnore(managedIgnore);
    }
    throw error;
  }

  if (cloned.length === ZERO && !residualMaterializedState && managedIgnore.changed) {
    await restoreManagedIgnore(managedIgnore);
  }

  if (failed.length > 0) {
    if (!options.json) {
      warn(`Clone completed with failures (${failed.length}).`);
      for (const failure of failed) {
        info(`  - ${failure.name}: ${failure.reason}`);
      }
    }
  } else if (!options.json) {
    success(`Clone completed for ${cloned.length} repositories.`);
  }

  let status: CloneExecutionResult["status"] = SUCCESS_STATUS;
  if (failed.length > ZERO) {
    status = PARTIAL_FAILURE_STATUS;
  }

  return {
    cloned,
    failed,
    managedIgnore,
    skipped,
    status,
  };
}

async function resolveCloneWorkspaceRoots(
  deps: CloneCommandDependencies,
): Promise<WorkspaceRepositoryRoots> {
  if (deps.workspaceRoots) {
    return deps.workspaceRoots;
  }

  if (deps.workspaceRoot) {
    return { configurationRoot: deps.workspaceRoot, executionRoot: deps.workspaceRoot };
  }

  if (deps.findWorkspaceRoots) {
    return deps.findWorkspaceRoots();
  }

  if (deps.findWorkspaceRoot) {
    const workspaceRoot = await deps.findWorkspaceRoot();
    return { configurationRoot: workspaceRoot, executionRoot: workspaceRoot };
  }

  return findConfiguredWorkspaceRoots("clone");
}

export function resolveCoordinatedSourceWorkspaceRoot(workspaceRoot: string): string | null {
  const marker = ".arashi/worktrees/";
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/");
  const markerIndex = normalizedRoot.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  return normalizedRoot.slice(0, markerIndex);
}

async function resolveWorkspaceBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const result = await exec(["symbolic-ref", "--short", "HEAD"], workspaceRoot);
    const branch = result.stdout.trim();
    return branch.length > ZERO ? branch : null;
  } catch {
    return null;
  }
}

function addRepositoryWorktree(
  sourceRepositoryPath: string,
  destinationPath: string,
  branchName: string,
): Promise<unknown> {
  return exec(["worktree", "add", destinationPath, branchName], sourceRepositoryPath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const resolveProtocolPreference = async (options: {
  interactive: boolean;
  urls: (string | undefined)[];
  askSelect: <T>(message: string, choices: Choice<T>[]) => Promise<PromptOutcome<T>>;
}): Promise<CloneProtocol | undefined> => {
  const inferred = inferCloneProtocolPreference(options.urls);
  if (inferred.protocol) {
    return inferred.protocol;
  }

  if (!options.interactive) {
    return undefined;
  }

  const choice = await options.askSelect("Choose clone protocol for this run:", [
    {
      description: "git@host:owner/repo.git",
      name: "SSH",
      value: "ssh" as CloneProtocol,
    },
    {
      description: "https://host/owner/repo.git",
      name: "HTTPS",
      value: "https" as CloneProtocol,
    },
  ]);

  if (choice.status === "cancelled") {
    return undefined;
  }

  return choice.value;
};

const reconcileUnmanagedRepositories = async (options: {
  interactive: boolean;
  workspaceRoot: string;
  config: Config;
  quiet?: boolean;
  unmanagedRepositories: { name: string; path: string }[];
  confirm: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;
  askInput: (message: string, defaultValue?: string) => Promise<PromptOutcome<string>>;
  askSelect: <T>(message: string, choices: Choice<T>[]) => Promise<PromptOutcome<T>>;
  deleteDirectory: (path: string) => Promise<void>;
}): Promise<{ cancelled: boolean; updatedConfig: boolean }> => {
  if (options.unmanagedRepositories.length === ZERO) {
    return { cancelled: false, updatedConfig: false };
  }

  if (!options.interactive) {
    if (!options.quiet) {
      info(
        `Ignoring ${options.unmanagedRepositories.length} unmanaged local repositories (interactive reconciliation required).`,
      );
    }
    return { cancelled: false, updatedConfig: false };
  }

  let updatedConfig = false;

  for (const unmanagedRepository of options.unmanagedRepositories) {
    const action = await options.askSelect(
      `Unmanaged repository '${unmanagedRepository.name}' found.`,
      [
        {
          description: "Track this existing local repository",
          name: "Add to config",
          value: "add" as const,
        },
        {
          description: "Remove the local repository directory",
          name: "Delete local clone",
          value: "delete" as const,
        },
        {
          description: "Leave repository unmanaged",
          name: "Do nothing",
          value: "ignore" as const,
        },
      ],
    );

    if (action.status === "cancelled") {
      return { cancelled: true, updatedConfig };
    }

    if (action.value === "delete") {
      const confirmation = await options.confirm(
        `Delete unmanaged repository '${unmanagedRepository.name}' at ${unmanagedRepository.path}?`,
        false,
      );
      if (confirmation.status === "cancelled") {
        return { cancelled: true, updatedConfig };
      }
      if (confirmation.value) {
        await options.deleteDirectory(unmanagedRepository.path);
        info(`Deleted ${unmanagedRepository.name}`);
      }
    } else if (action.value !== "ignore") {
      let gitUrl = await readOriginRemoteUrl(unmanagedRepository.path);
      if (!gitUrl) {
        const enteredUrl = await options.askInput(
          `Enter git URL for '${unmanagedRepository.name}' (leave empty to skip):`,
        );
        if (enteredUrl.status === "cancelled") {
          return { cancelled: true, updatedConfig };
        }

        const value = enteredUrl.value.trim();
        if (value.length === ZERO) {
          warn(`Skipped adding ${unmanagedRepository.name}: no git URL provided.`);
        } else {
          gitUrl = value;
        }
      }

      if (gitUrl) {
        const repoConfig: Config["repos"][string] = {
          gitUrl,
          path: join(".", options.config.reposDir, unmanagedRepository.name),
        };

        options.config.repos[unmanagedRepository.name] = repoConfig;
        updatedConfig = true;
        info(`Added ${unmanagedRepository.name} to configuration.`);
      }
    }
  }

  return { cancelled: false, updatedConfig };
};

const readOriginRemoteUrl = async (repoPath: string): Promise<string | undefined> => {
  try {
    const result = await exec(["remote", "get-url", "origin"], repoPath);
    const remoteUrl = result.stdout.trim();
    if (remoteUrl.length > ZERO) {
      return remoteUrl;
    }

    return undefined;
  } catch {
    return undefined;
  }
};
