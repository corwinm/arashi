import { Command } from "commander";
import { resolve } from "path";
import { findWorkspaceRoot, loadConfig, type Config } from "../lib/config.ts";
import * as logger from "../lib/logger.ts";
import { exec } from "../lib/git.ts";
import { filterRepositories } from "../lib/config/filter-repos.ts";
import { alignRepositoryBranch } from "../lib/git/sync-branch.ts";
import { createRollbackTracker, recordCreatedBranch } from "../lib/git/sync-rollback.ts";
import type { SyncResult, SyncSummary } from "../lib/git/sync-types.ts";

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
        if (summary.failureCount > 0) {
          process.exit(1);
        }
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
      }
    });
}

export async function executeSync(options: SyncCommandOptions): Promise<SyncSummary> {
  const workspaceRoot = await findWorkspaceRoot();
  const config = await loadConfig(workspaceRoot);
  const parentBranch = await getParentBranch(workspaceRoot);

  const { repositories, missing } = filterRepositories(config.discovered_repos, options.only);
  if (missing.length > 0) {
    throw new Error(`Repositories not found: ${missing.join(", ")}`);
  }

  if (repositories.length === 0) {
    throw new Error("No managed repositories found to sync");
  }

  const timeoutMs = getSyncTimeoutMs(config);
  const tracker = createRollbackTracker();

  const results: SyncResult[] = [];

  for (const repo of repositories) {
    const repoPath = resolve(workspaceRoot, repo.config.path);
    const spinner = logger.spinner(`Syncing ${repo.name}...`);
    spinner.start();

    const startTime = Date.now();
    let outcome;

    try {
      outcome = await alignRepositoryBranch({
        repoPath,
        targetBranch: parentBranch,
        timeoutMs,
      });
    } catch (error) {
      outcome = {
        status: "failure" as const,
        createdBranch: false,
        previousBranch: null,
        currentBranch: null,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const durationMs = Date.now() - startTime;

    const result: SyncResult = {
      repositoryName: repo.name,
      targetBranch: parentBranch,
      status: outcome.status,
      durationMs,
      createdBranch: outcome.createdBranch,
      errorMessage: outcome.errorMessage,
    };

    if (outcome.status === "success") {
      const createdSuffix = outcome.createdBranch ? " (created)" : "";
      spinner.succeed(
        `${repo.name}: synced to ${parentBranch}${createdSuffix} (${formatDuration(durationMs)})`,
      );
    } else if (outcome.status === "timeout") {
      spinner.fail(`${repo.name}: timed out (${formatDuration(durationMs)})`);
    } else {
      spinner.fail(`${repo.name}: failed (${formatDuration(durationMs)})`);
    }

    if (options.verbose) {
      printVerboseResult(result);
    }

    if (outcome.createdBranch) {
      recordCreatedBranch(tracker, {
        repositoryName: repo.name,
        repoPath,
        branchName: parentBranch,
        previousBranch: outcome.previousBranch,
      });
    }

    results.push(result);
  }

  const successCount = results.filter((result) => result.status === "success").length;
  const failureCount = results.length - successCount;

  printSummary({ successCount, failureCount, results });

  return {
    successCount,
    failureCount,
    results,
  };
}

async function getParentBranch(workspaceRoot: string): Promise<string> {
  const result = await exec(["rev-parse", "--abbrev-ref", "HEAD"], workspaceRoot);
  const branch = result.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("Parent repository is in detached HEAD state");
  }
  return branch;
}

function getSyncTimeoutMs(config: Config): number {
  const configWithSync = config as {
    sync?: { timeoutSeconds?: number; timeout_seconds?: number };
    timeoutSeconds?: number;
  };
  const timeoutSeconds =
    configWithSync.sync?.timeoutSeconds ??
    configWithSync.sync?.timeout_seconds ??
    configWithSync.timeoutSeconds;

  if (
    typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds) &&
    timeoutSeconds >= 0
  ) {
    return Math.floor(timeoutSeconds * 1000);
  }

  return 300000;
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(2)}s`;
  }
  return `${durationMs}ms`;
}

function printVerboseResult(result: SyncResult): void {
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

  logger.info(`  ${result.repositoryName}: ${detailParts.join(", ")}`);
}

function printSummary(summary: SyncSummary): void {
  if (summary.failureCount === 0) {
    logger.success(
      `Sync complete: ${summary.successCount} succeeded, ${summary.failureCount} failed`,
    );
    return;
  }

  logger.error(`Sync complete: ${summary.successCount} succeeded, ${summary.failureCount} failed`);
  for (const result of summary.results) {
    if (result.status === "success") {
      continue;
    }
    const errorMessage = result.errorMessage ? ` - ${result.errorMessage}` : "";
    logger.info(
      `  ${result.repositoryName}: ${result.status} (${formatDuration(result.durationMs)})${errorMessage}`,
    );
  }
}
