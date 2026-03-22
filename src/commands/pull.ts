/**
 * CLI Command: Pull
 *
 * Updates eligible repositories from their remotes with progress output,
 * rollback on conflict/error, and a non-zero exit on failures.
 */

import { Command } from "commander";
import { findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import { filterRepositories } from "../lib/repo-filter.ts";
import { checkRemoteChanges } from "../lib/git-remote.ts";
import { info, error as logError } from "../lib/logger.ts";
import { runPullWithRollback } from "../lib/pull-runner.ts";
import {
  buildSummary,
  formatProgress,
  formatResultLine,
  formatSummary,
} from "../lib/pull-output.ts";
import type { PullResult } from "../lib/pull-types.ts";

const ZERO = 0;
const ONE = 1;
const SUCCESS_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const MILLISECONDS_PER_SECOND = 1000;

export interface PullCommandOptions {
  /** Only include specified repositories (repeatable flag) */
  only?: string[];
  /** Show full git output for each repository */
  verbose?: boolean;
}

const executePull = async (options: PullCommandOptions): Promise<void> => {
  let workspaceRoot: string;
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    logError("Not in an arashi workspace");
    info('Run "arashi init" to initialize a workspace');
    process.exit(USAGE_EXIT_CODE);
  }

  let repositoriesResult;
  try {
    repositoriesResult = await loadWorkspaceRepositories(workspaceRoot);
  } catch (error) {
    logError("Failed to load workspace configuration");
    logError(error instanceof Error ? error.message : String(error));
    process.exit(USAGE_EXIT_CODE);
  }

  const filterResult = filterRepositories(repositoriesResult.repositories, options.only);
  if (filterResult.missing.length > ZERO) {
    logError("Unknown repositories in --only filter:");
    for (const name of filterResult.missing) {
      info(`  • ${name}`);
    }
    process.exit(USAGE_EXIT_CODE);
  }

  const repositories = filterResult.selected;
  if (repositories.length === ZERO) {
    info("No repositories selected for pull");
    process.exit(SUCCESS_EXIT_CODE);
  }

  const results: PullResult[] = [];
  const total = repositories.length;
  const timeoutMs = repositoriesResult.config.hooks?.timeout;

  for (let index = ZERO; index < repositories.length; index += ONE) {
    const repo = repositories[index];
    info(formatProgress(repo.name, index + ONE, total));

    const start = Date.now();
    const remoteStatus = await checkRemoteChanges(repo.name, repo.path);
    if (remoteStatus.error) {
      const elapsedSeconds = (Date.now() - start) / MILLISECONDS_PER_SECOND;
      results.push({
        elapsedSeconds,
        errorMessage: `Remote check failed: ${remoteStatus.error}`,
        repositoryId: repo.name,
        status: "failed",
      });
      const lastResult = results.at(-ONE);
      if (lastResult) {
        info(formatResultLine(lastResult));
      }
      continue;
    }

    if (!remoteStatus.hasRemoteChanges) {
      const elapsedSeconds = (Date.now() - start) / MILLISECONDS_PER_SECOND;
      results.push({
        elapsedSeconds,
        repositoryId: repo.name,
        status: "skipped",
      });
      const lastResult = results.at(-ONE);
      if (lastResult) {
        info(formatResultLine(lastResult));
      }
      continue;
    }

    const pullResult = await runPullWithRollback(repo.path, {
      branch: remoteStatus.branch || undefined,
      remote: remoteStatus.remote || undefined,
      timeoutMs,
      verbose: options.verbose,
    });
    const elapsedSeconds = (Date.now() - start) / MILLISECONDS_PER_SECOND;
    const result: PullResult = {
      elapsedSeconds,
      errorMessage: pullResult.errorMessage,
      output: pullResult.output,
      repositoryId: repo.name,
      status: pullResult.status,
    };
    results.push(result);

    if (options.verbose && pullResult.output) {
      console.log(pullResult.output);
    }

    info(formatResultLine(result));
  }

  const summary = buildSummary(results);
  console.log(formatSummary(summary));

  const hasFailures = results.some(
    (result) => result.status === "failed" || result.status === "manual-update",
  );
  if (hasFailures) {
    process.exit(ERROR_EXIT_CODE);
  }

  process.exit(SUCCESS_EXIT_CODE);
};

export function createCommand(): Command {
  return new Command("pull")
    .description("Pull remote changes across eligible repositories")
    .option(
      "--only <repo>",
      "Only include a specific repository (repeatable)",
      (value, previous: string[] = []) => previous.concat(value),
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
        process.exit(ERROR_EXIT_CODE);
      }
    });
}
