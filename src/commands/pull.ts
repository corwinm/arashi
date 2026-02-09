/**
 * CLI Command: Pull
 *
 * Updates eligible repositories from their remotes with progress output,
 * rollback on conflict/error, and a non-zero exit on failures.
 */

import { Command } from "commander";
import * as logger from "../lib/logger.ts";
import { findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import { filterRepositories } from "../lib/repo-filter.ts";
import { checkRemoteChanges } from "../lib/git-remote.ts";
import { runPullWithRollback } from "../lib/pull-runner.ts";
import {
  buildSummary,
  formatProgress,
  formatResultLine,
  formatSummary,
} from "../lib/pull-output.ts";
import type { PullResult } from "../lib/pull-types.ts";

export interface PullCommandOptions {
  /** Only include specified repositories (repeatable flag) */
  only?: string[];
  /** Show full git output for each repository */
  verbose?: boolean;
}

async function executePull(options: PullCommandOptions): Promise<void> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    logger.error("Not in an arashi workspace");
    logger.info('Run "arashi init" to initialize a workspace');
    process.exit(2);
  }

  let repositoriesResult;
  try {
    repositoriesResult = await loadWorkspaceRepositories(workspaceRoot);
  } catch (error) {
    logger.error("Failed to load workspace configuration");
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const filterResult = filterRepositories(repositoriesResult.repositories, options.only);
  if (filterResult.missing.length > 0) {
    logger.error("Unknown repositories in --only filter:");
    for (const name of filterResult.missing) {
      logger.info(`  • ${name}`);
    }
    process.exit(2);
  }

  const repositories = filterResult.selected;
  if (repositories.length === 0) {
    logger.info("No repositories selected for pull");
    process.exit(0);
  }

  const results: PullResult[] = [];
  const total = repositories.length;
  const timeoutMs = repositoriesResult.config.hooks?.timeout;

  for (let index = 0; index < repositories.length; index += 1) {
    const repo = repositories[index];
    logger.info(formatProgress(repo.name, index + 1, total));

    const start = Date.now();
    const remoteStatus = await checkRemoteChanges(repo.name, repo.path);
    if (remoteStatus.error) {
      const elapsedSeconds = (Date.now() - start) / 1000;
      results.push({
        repositoryId: repo.name,
        status: "failed",
        elapsedSeconds,
        errorMessage: `Remote check failed: ${remoteStatus.error}`,
      });
      logger.info(formatResultLine(results[results.length - 1]));
      continue;
    }

    if (!remoteStatus.hasRemoteChanges) {
      const elapsedSeconds = (Date.now() - start) / 1000;
      results.push({
        repositoryId: repo.name,
        status: "skipped",
        elapsedSeconds,
      });
      logger.info(formatResultLine(results[results.length - 1]));
      continue;
    }

    const pullResult = await runPullWithRollback(repo.path, {
      timeoutMs,
      verbose: options.verbose,
      remote: remoteStatus.remote || undefined,
      branch: remoteStatus.branch || undefined,
    });
    const elapsedSeconds = (Date.now() - start) / 1000;
    const result: PullResult = {
      repositoryId: repo.name,
      status: pullResult.status,
      elapsedSeconds,
      errorMessage: pullResult.errorMessage,
      output: pullResult.output,
    };
    results.push(result);

    if (options.verbose && pullResult.output) {
      console.log(pullResult.output);
    }

    logger.info(formatResultLine(result));
  }

  const summary = buildSummary(results);
  console.log(formatSummary(summary));

  const hasFailures = results.some((r) => r.status === "failed" || r.status === "manual-update");
  process.exit(hasFailures ? 1 : 0);
}

export function createCommand(): Command {
  return new Command("pull")
    .description("Pull remote changes across eligible repositories")
    .option(
      "--only <repo>",
      "Only include a specific repository (repeatable)",
      (value, previous: string[] = []) => {
        return previous.concat(value);
      },
    )
    .option("-v, --verbose", "Show verbose git output")
    .action(async (options: PullCommandOptions) => {
      try {
        await executePull(options);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Unknown error");
        }
        process.exit(1);
      }
    });
}
