import type { SyncResult, SyncSummary } from "../lib/git/sync-types.ts";
import { createRollbackTracker, recordCreatedBranch } from "../lib/git/sync-rollback.ts";
import { findWorkspaceRoot, loadConfig } from "../lib/config.ts";
import { info, error as logError, spinner, success } from "../lib/logger.ts";
import { Command } from "commander";
import { alignRepositoryBranch } from "../lib/git/sync-branch.ts";
import { exec } from "../lib/git.ts";
import { filterRepositories } from "../lib/config/filter-repos.ts";
import { resolve } from "path";

type Config = Awaited<ReturnType<typeof loadConfig>>;
type SyncBranchOutcome = Awaited<ReturnType<typeof alignRepositoryBranch>>;

const ZERO = 0;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const MILLISECONDS_PER_SECOND = 1000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DETACHED_HEAD = "HEAD";

interface SyncCommandOptions {
  only?: string;
  verbose?: boolean;
}

export function createCommand(): Command {
  return new Command("sync")
    .description("Align managed repositories to the parent branch")
    .option("--only <repos>", "Only sync specified repositories (comma-separated)")
    .option("-v, --verbose", "Show detailed output for each repository")
    .action(async (options: SyncCommandOptions) => {
      try {
        const summary = await executeSync(options);
        if (summary.failureCount > ZERO) {
          process.exit(ERROR_EXIT_CODE);
        }
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        process.exit(USAGE_EXIT_CODE);
      }
    });
}

export async function executeSync(options: SyncCommandOptions): Promise<SyncSummary> {
  const workspaceRoot = await findWorkspaceRoot();
  const config = await loadConfig(workspaceRoot);
  const parentBranch = await getParentBranch(workspaceRoot);

  const { repositories, missing } = filterRepositories(config.repos, options.only);
  if (missing.length > 0) {
    throw new Error(`Repositories not found: ${missing.join(", ")}`);
  }

  if (repositories.length === ZERO) {
    throw new Error("No managed repositories found to sync");
  }

  const timeoutMs = getSyncTimeoutMs(config);
  const tracker = createRollbackTracker();

  const results: SyncResult[] = [];

  for (const repo of repositories) {
    const repoPath = resolve(workspaceRoot, repo.config.path);
    const syncSpinner = spinner(`Syncing ${repo.name}...`);
    syncSpinner.start();

    const startTime = Date.now();
    const defaultOutcome: SyncBranchOutcome = {
      createdBranch: false,
      currentBranch: null,
      errorMessage: "Unknown sync failure",
      previousBranch: null,
      status: "failure" as const,
    };
    let outcome: SyncBranchOutcome = defaultOutcome;

    try {
      outcome = await alignRepositoryBranch({
        repoPath,
        targetBranch: parentBranch,
        timeoutMs,
      });
    } catch (error) {
      outcome = {
        createdBranch: false,
        currentBranch: null,
        errorMessage: error instanceof Error ? error.message : String(error),
        previousBranch: null,
        status: "failure" as const,
      };
    }

    const durationMs = Date.now() - startTime;

    const result: SyncResult = {
      createdBranch: outcome.createdBranch,
      durationMs,
      errorMessage: outcome.errorMessage,
      repositoryName: repo.name,
      status: outcome.status,
      targetBranch: parentBranch,
    };

    if (outcome.status === "success") {
      const createdSuffix = outcome.createdBranch ? " (created)" : "";
      syncSpinner.succeed(
        `${repo.name}: synced to ${parentBranch}${createdSuffix} (${formatDuration(durationMs)})`,
      );
    } else if (outcome.status === "timeout") {
      syncSpinner.fail(`${repo.name}: timed out (${formatDuration(durationMs)})`);
    } else {
      syncSpinner.fail(`${repo.name}: failed (${formatDuration(durationMs)})`);
    }

    if (options.verbose) {
      printVerboseResult(result);
    }

    if (outcome.createdBranch) {
      recordCreatedBranch(tracker, {
        branchName: parentBranch,
        previousBranch: outcome.previousBranch,
        repoPath,
        repositoryName: repo.name,
      });
    }

    results.push(result);
  }

  const successCount = results.filter((result) => result.status === "success").length;
  const failureCount = results.length - successCount;

  printSummary({ failureCount, results, successCount });

  return {
    failureCount,
    results,
    successCount,
  };
}

const getParentBranch = async (workspaceRoot: string): Promise<string> => {
  const result = await exec(["rev-parse", "--abbrev-ref", "HEAD"], workspaceRoot);
  const branch = result.stdout.trim();
  if (!branch || branch === DETACHED_HEAD) {
    throw new Error("Parent repository is in detached HEAD state");
  }
  return branch;
};

const getSyncTimeoutMs = (config: Config): number => {
  const configWithSync = config as {
    sync?: { timeoutSeconds?: number; timeout_seconds?: number };
    timeoutSeconds?: number;
  };
  let { timeoutSeconds } = configWithSync;
  if (configWithSync.sync?.timeout_seconds !== undefined) {
    timeoutSeconds = configWithSync.sync.timeout_seconds;
  }
  if (configWithSync.sync?.timeoutSeconds !== undefined) {
    ({ timeoutSeconds } = configWithSync.sync);
  }

  if (
    typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds) &&
    timeoutSeconds >= ZERO
  ) {
    return Math.floor(timeoutSeconds * MILLISECONDS_PER_SECOND);
  }

  return DEFAULT_TIMEOUT_MS;
};

const formatDuration = (durationMs: number): string => {
  if (durationMs >= MILLISECONDS_PER_SECOND) {
    return `${(durationMs / MILLISECONDS_PER_SECOND).toFixed(2)}s`;
  }
  return `${durationMs}ms`;
};

const printVerboseResult = (result: SyncResult): void => {
  const detailParts = [
    `branch=${result.targetBranch}`,
    `duration=${formatDuration(result.durationMs)}`,
  ];

  if (result.createdBranch) {
    detailParts.push("created=true");
  }

  if (result.errorMessage) {
    detailParts.push(`error=${result.errorMessage}`);
  }

  info(`  ${result.repositoryName}: ${detailParts.join(", ")}`);
};

const printSummary = (summary: SyncSummary): void => {
  if (summary.failureCount === ZERO) {
    success(`Sync complete: ${summary.successCount} succeeded, ${summary.failureCount} failed`);
    return;
  }

  logError(`Sync complete: ${summary.successCount} succeeded, ${summary.failureCount} failed`);
  for (const result of summary.results) {
    if (result.status === "success") {
      continue;
    }
    let errorMessage = "";
    if (result.errorMessage) {
      errorMessage = ` - ${result.errorMessage}`;
    }
    info(
      `  ${result.repositoryName}: ${result.status} (${formatDuration(result.durationMs)})${errorMessage}`,
    );
  }
};
