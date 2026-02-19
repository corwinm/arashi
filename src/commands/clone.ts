import { Command } from "commander";
import { join } from "path";
import {
  findWorkspaceRoot,
  loadConfig,
  saveConfig,
  type Config,
  repairRepositoryGitUrls,
} from "../lib/config.ts";
import { clone as cloneRepository, exec, getDefaultBranch } from "../lib/git.ts";
import { removeDir } from "../lib/filesystem.ts";
import {
  applyCloneProtocol,
  discoverCloneRepositories,
  inferCloneProtocolPreference,
  type CloneProtocol,
} from "../lib/clone-discovery.ts";
import {
  confirm as promptConfirm,
  input as promptInput,
  multiSelect as promptMultiSelect,
  select as promptSelect,
  type Choice,
  type PromptOutcome,
} from "../lib/prompts.ts";
import * as logger from "../lib/logger.ts";

export interface CloneCommandOptions {
  all?: boolean;
}

export interface CloneExecutionResult {
  status: "success" | "partial-failure" | "cancelled";
  cloned: string[];
  failed: Array<{ name: string; reason: string }>;
  skipped: string[];
}

interface CloneCommandDependencies {
  workspaceRoot?: string;
  findWorkspaceRoot?: () => Promise<string>;
  loadConfig?: (workspaceRoot: string) => Promise<Config>;
  saveConfig?: (workspaceRoot: string, config: Config) => Promise<void>;
  repairRepositoryGitUrls?: typeof repairRepositoryGitUrls;
  discoverCloneRepositories?: typeof discoverCloneRepositories;
  cloneRepository?: typeof cloneRepository;
  getDefaultBranch?: typeof getDefaultBranch;
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
    .action(async (options: CloneCommandOptions) => {
      try {
        const result = await executeClone(options);

        if (result.status === "cancelled") {
          logger.info("Clone operation cancelled.");
          process.exit(0);
        }

        process.exit(result.failed.length > 0 ? 1 : 0);
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

export async function executeClone(
  options: CloneCommandOptions,
  deps: CloneCommandDependencies = {},
): Promise<CloneExecutionResult> {
  const resolveWorkspaceRoot = deps.findWorkspaceRoot ?? findWorkspaceRoot;
  const readConfig = deps.loadConfig ?? loadConfig;
  const writeConfig = deps.saveConfig ?? saveConfig;
  const repairGitUrls = deps.repairRepositoryGitUrls ?? repairRepositoryGitUrls;
  const discoverRepositories = deps.discoverCloneRepositories ?? discoverCloneRepositories;
  const runClone = deps.cloneRepository ?? cloneRepository;
  const readDefaultBranch = deps.getDefaultBranch ?? getDefaultBranch;
  const deleteDirectory = deps.removeDir ?? removeDir;
  const confirm = deps.promptConfirm ?? promptConfirm;
  const askInput = deps.promptInput ?? promptInput;
  const askMultiSelect = deps.promptMultiSelect ?? promptMultiSelect;
  const askSelect = deps.promptSelect ?? promptSelect;

  const interactive = Boolean(
    (deps.stdinIsTTY ?? process.stdin.isTTY) && (deps.stdoutIsTTY ?? process.stdout.isTTY),
  );

  const workspaceRoot = deps.workspaceRoot ?? (await resolveWorkspaceRoot());
  const config = await readConfig(workspaceRoot);

  const repairResult = await repairGitUrls(workspaceRoot, config);
  let configUpdated = repairResult.updated;

  if (repairResult.repaired.length > 0) {
    logger.info(
      `Recovered missing git URLs from local remotes: ${repairResult.repaired.join(", ")}`,
    );
  }

  if (repairResult.updated) {
    await writeConfig(workspaceRoot, config);
  }

  let discovery = await discoverRepositories(workspaceRoot, config);

  const reconcileResult = await reconcileUnmanagedRepositories({
    interactive,
    workspaceRoot,
    config,
    unmanagedRepositories: discovery.unmanagedLocal,
    confirm,
    askInput,
    askSelect,
    readDefaultBranch,
    deleteDirectory,
  });

  if (reconcileResult.cancelled) {
    return {
      status: "cancelled",
      cloned: [],
      failed: [],
      skipped: [],
    };
  }

  if (reconcileResult.updatedConfig) {
    configUpdated = true;
    await writeConfig(workspaceRoot, config);
    discovery = await discoverRepositories(workspaceRoot, config);
  }

  if (discovery.configuredMissing.length === 0) {
    logger.success("All configured repositories are already present. Nothing to clone.");
    return {
      status: "success",
      cloned: [],
      failed: [],
      skipped: [],
    };
  }

  const missingWithUrls = discovery.configuredMissing.filter(
    (repository) =>
      typeof repository.config.git_url === "string" && repository.config.git_url.length > 0,
  );
  const missingWithoutUrls = discovery.configuredMissing.filter(
    (repository) => !repository.config.git_url,
  );

  if (interactive && missingWithoutUrls.length > 0) {
    for (const repository of missingWithoutUrls) {
      const enteredUrl = await askInput(
        `Enter git URL for missing repository '${repository.name}' (leave empty to skip):`,
      );
      if (enteredUrl.status === "cancelled") {
        return {
          status: "cancelled",
          cloned: [],
          failed: [],
          skipped: [],
        };
      }

      const value = enteredUrl.value.trim();
      if (!value) {
        continue;
      }

      repository.config.git_url = value;
      missingWithUrls.push(repository);
      configUpdated = true;
    }
  }

  const unresolvedMissingWithoutUrls = missingWithoutUrls
    .filter((repository) => !repository.config.git_url)
    .map((repository) => repository.name);
  if (unresolvedMissingWithoutUrls.length > 0) {
    logger.warn(
      `Skipping repositories without configured git_url: ${unresolvedMissingWithoutUrls.join(", ")}`,
    );
  }

  if (missingWithUrls.length === 0) {
    throw new Error("No missing repositories have cloneable git URLs configured.");
  }

  const preferredProtocol = await resolveProtocolPreference({
    interactive,
    urls: Object.values(config.discovered_repos).map((repo) => repo.git_url),
    askSelect,
  });

  let selectedRepositories = missingWithUrls;
  if (!options.all) {
    if (!interactive) {
      throw new Error("Interactive selection requires a TTY. Use `arashi clone --all` instead.");
    }

    const selectionChoices: Choice<string>[] = missingWithUrls.map((repository) => ({
      value: repository.name,
      name: repository.name,
      description: repository.path,
    }));

    const selection = await askMultiSelect(
      "Select missing repositories to clone:",
      selectionChoices,
    );

    if (selection.status === "cancelled") {
      return {
        status: "cancelled",
        cloned: [],
        failed: [],
        skipped: [],
      };
    }

    const selectedNames = new Set(selection.value);
    selectedRepositories = missingWithUrls.filter((repository) =>
      selectedNames.has(repository.name),
    );

    if (selectedRepositories.length === 0) {
      logger.info("No repositories selected for cloning.");
      return {
        status: "success",
        cloned: [],
        failed: [],
        skipped: missingWithUrls.map((repository) => repository.name),
      };
    }
  }

  const cloned: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  const skipped = missingWithUrls
    .map((repository) => repository.name)
    .filter((name) => !selectedRepositories.some((repository) => repository.name === name));

  for (const repository of selectedRepositories) {
    const rawGitUrl = repository.config.git_url;
    if (!rawGitUrl) {
      failed.push({
        name: repository.name,
        reason: "Missing git_url in configuration",
      });
      continue;
    }

    const cloneUrl = preferredProtocol
      ? applyCloneProtocol(rawGitUrl, preferredProtocol)
      : rawGitUrl;
    const cloneSpinner = logger.spinner(`Cloning ${repository.name}...`).start();

    try {
      await runClone(cloneUrl, repository.path);
      cloneSpinner.succeed(`Cloned ${repository.name}`);
      cloned.push(repository.name);

      if (repository.config.git_url !== cloneUrl) {
        repository.config.git_url = cloneUrl;
        configUpdated = true;
      }

      if (!repository.config.default_branch) {
        try {
          repository.config.default_branch = await readDefaultBranch(repository.path);
          configUpdated = true;
        } catch {
          // Best effort: keep clone success even if default branch detection fails
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      cloneSpinner.fail(`Failed to clone ${repository.name}`);
      failed.push({
        name: repository.name,
        reason,
      });
    }
  }

  if (configUpdated) {
    await writeConfig(workspaceRoot, config);
  }

  if (failed.length > 0) {
    logger.warn(`Clone completed with failures (${failed.length}).`);
    for (const failure of failed) {
      logger.info(`  - ${failure.name}: ${failure.reason}`);
    }
  } else {
    logger.success(`Clone completed for ${cloned.length} repositories.`);
  }

  return {
    status: failed.length > 0 ? "partial-failure" : "success",
    cloned,
    failed,
    skipped,
  };
}

async function resolveProtocolPreference(options: {
  interactive: boolean;
  urls: Array<string | undefined>;
  askSelect: <T>(message: string, choices: Choice<T>[]) => Promise<PromptOutcome<T>>;
}): Promise<CloneProtocol | null> {
  const inferred = inferCloneProtocolPreference(options.urls);
  if (inferred.protocol) {
    return inferred.protocol;
  }

  if (!options.interactive) {
    return null;
  }

  const choice = await options.askSelect("Choose clone protocol for this run:", [
    {
      value: "ssh" as CloneProtocol,
      name: "SSH",
      description: "git@host:owner/repo.git",
    },
    {
      value: "https" as CloneProtocol,
      name: "HTTPS",
      description: "https://host/owner/repo.git",
    },
  ]);

  if (choice.status === "cancelled") {
    return null;
  }

  return choice.value;
}

async function reconcileUnmanagedRepositories(options: {
  interactive: boolean;
  workspaceRoot: string;
  config: Config;
  unmanagedRepositories: Array<{ name: string; path: string }>;
  confirm: (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;
  askInput: (message: string, defaultValue?: string) => Promise<PromptOutcome<string>>;
  askSelect: <T>(message: string, choices: Choice<T>[]) => Promise<PromptOutcome<T>>;
  readDefaultBranch: (repoPath: string) => Promise<string>;
  deleteDirectory: (path: string) => Promise<void>;
}): Promise<{ cancelled: boolean; updatedConfig: boolean }> {
  if (options.unmanagedRepositories.length === 0) {
    return { cancelled: false, updatedConfig: false };
  }

  if (!options.interactive) {
    logger.info(
      `Ignoring ${options.unmanagedRepositories.length} unmanaged local repositories (interactive reconciliation required).`,
    );
    return { cancelled: false, updatedConfig: false };
  }

  let updatedConfig = false;

  for (const unmanagedRepository of options.unmanagedRepositories) {
    const action = await options.askSelect(
      `Unmanaged repository '${unmanagedRepository.name}' found.`,
      [
        {
          value: "add" as const,
          name: "Add to config",
          description: "Track this existing local repository",
        },
        {
          value: "delete" as const,
          name: "Delete local clone",
          description: "Remove the local repository directory",
        },
        {
          value: "ignore" as const,
          name: "Do nothing",
          description: "Leave repository unmanaged",
        },
      ],
    );

    if (action.status === "cancelled") {
      return { cancelled: true, updatedConfig };
    }

    if (action.value === "ignore") {
      continue;
    }

    if (action.value === "delete") {
      const confirmation = await options.confirm(
        `Delete unmanaged repository '${unmanagedRepository.name}' at ${unmanagedRepository.path}?`,
        false,
      );
      if (confirmation.status === "cancelled") {
        return { cancelled: true, updatedConfig };
      }
      if (!confirmation.value) {
        continue;
      }

      await options.deleteDirectory(unmanagedRepository.path);
      logger.info(`Deleted ${unmanagedRepository.name}`);
      continue;
    }

    let gitUrl = await readOriginRemoteUrl(unmanagedRepository.path);
    if (!gitUrl) {
      const enteredUrl = await options.askInput(
        `Enter git URL for '${unmanagedRepository.name}' (leave empty to skip):`,
      );
      if (enteredUrl.status === "cancelled") {
        return { cancelled: true, updatedConfig };
      }

      const value = enteredUrl.value.trim();
      if (value.length === 0) {
        logger.warn(`Skipped adding ${unmanagedRepository.name}: no git URL provided.`);
        continue;
      }

      gitUrl = value;
    }

    let defaultBranch: string | undefined;
    try {
      defaultBranch = await options.readDefaultBranch(unmanagedRepository.path);
    } catch {
      defaultBranch = undefined;
    }

    const repoConfig: Config["discovered_repos"][string] = {
      path: join(".", options.config.repos_dir, unmanagedRepository.name),
      git_url: gitUrl,
      is_bare: false,
      worktrees: [],
    };
    if (defaultBranch) {
      repoConfig.default_branch = defaultBranch;
    }

    options.config.discovered_repos[unmanagedRepository.name] = repoConfig;
    updatedConfig = true;
    logger.info(`Added ${unmanagedRepository.name} to configuration.`);
  }

  return { cancelled: false, updatedConfig };
}

async function readOriginRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const result = await exec(["remote", "get-url", "origin"], repoPath);
    const remoteUrl = result.stdout.trim();
    return remoteUrl.length > 0 ? remoteUrl : null;
  } catch {
    return null;
  }
}
