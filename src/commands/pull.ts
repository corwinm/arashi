/**
 * CLI Command: Pull
 *
 * Updates eligible repositories from their remotes with progress output,
 * rollback on conflict/error, and a non-zero exit on failures.
 */

import {
  buildSummary,
  formatProgress,
  formatResultLine,
  formatSummary,
} from "../lib/pull-output.ts";
import { findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { info } from "../lib/logger.ts";
import { Command } from "commander";
import type { PullResult, PullSummary } from "../lib/pull-types.ts";
import { checkRemoteChanges } from "../lib/git-remote.ts";
import { filterRepositories } from "../lib/repo-filter.ts";
import { runPullWithRollback } from "../lib/pull-runner.ts";

const ZERO = 0;
const ONE = 1;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const MILLISECONDS_PER_SECOND = 1000;

class CliUsageError extends Error {}

export interface PullCommandOptions {
  /** Only include repositories in specified groups (repeatable flag) */
  group?: string[];
  /** Output one JSON envelope to stdout */
  json?: boolean;
  /** Only include specified repositories (repeatable flag) */
  only?: string[];
  /** Show full git output for each repository */
  verbose?: boolean;
}

const executePull = async (options: PullCommandOptions): Promise<PullSummary> => {
  let workspaceRoot = "";
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    throw new CliUsageError(
      'Not in an arashi workspace. Run "arashi init" to initialize a workspace',
    );
  }

  const repositoriesResult = await loadWorkspaceRepositories(workspaceRoot).catch(
    (error): never => {
      throw new CliUsageError(
        `Failed to load workspace configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );

  const filterResult = filterRepositories(
    repositoriesResult.repositories,
    options.only,
    options.group,
  );
  if (filterResult.missing.length > ZERO) {
    throw new CliUsageError(
      `Unknown repositories in --only filter: ${filterResult.missing.join(", ")}`,
    );
  }
  if (filterResult.unknownGroups.length > ZERO) {
    throw new CliUsageError(
      `Unknown repository groups in --group filter: ${filterResult.unknownGroups.join(", ")}`,
    );
  }
  if (filterResult.emptyIntersection) {
    throw new CliUsageError("No repositories matched the combined --only/--group filters");
  }

  const repositories = filterResult.selected;
  if (repositories.length === ZERO) {
    if (!options.json) {
      info("No repositories selected for pull");
    }
    return { overallStatus: "success", results: [] };
  }

  const results: PullResult[] = [];
  const total = repositories.length;
  const timeoutMs = repositoriesResult.config.hooks?.timeout;

  for (let index = ZERO; index < repositories.length; index += ONE) {
    const repo = repositories[index];
    if (!options.json) {
      info(formatProgress(repo.name, index + ONE, total));
    }

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
      if (lastResult && !options.json) {
        info(formatResultLine(lastResult));
      }
    } else if (remoteStatus.hasRemoteChanges) {
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

      if (options.verbose && pullResult.output && !options.json) {
        console.log(pullResult.output);
      }

      if (!options.json) {
        info(formatResultLine(result));
      }
    } else {
      const elapsedSeconds = (Date.now() - start) / MILLISECONDS_PER_SECOND;
      results.push({
        elapsedSeconds,
        repositoryId: repo.name,
        status: "skipped",
      });
      const lastResult = results.at(-ONE);
      if (lastResult && !options.json) {
        info(formatResultLine(lastResult));
      }
    }
  }

  const summary = buildSummary(results);
  if (!options.json) {
    console.log(formatSummary(summary));
  }

  const hasFailures = results.some(
    (result) => result.status === "failed" || result.status === "manual-update",
  );
  if (hasFailures) {
    process.exitCode = ERROR_EXIT_CODE;
  }

  return summary;
};

export function createCommand(): Command {
  return new Command("pull")
    .description("Pull remote changes across eligible repositories")
    .option(
      "--only <repo>",
      "Only include a specific repository (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--group <group>",
      "Only include repositories in the requested group (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option("-v, --verbose", "Show verbose git output")
    .option("--json", "Output result as JSON")
    .action(async (options: PullCommandOptions) => {
      try {
        const summary = await executePull(options);
        if (options.json) {
          writeJsonEnvelope(createJsonSuccessEnvelope("pull", { ...summary }));
        }
      } catch (error) {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("pull", unknownErrorToJsonError(error)));
          process.exit(USAGE_EXIT_CODE);
        } else {
          if (error instanceof Error) {
            console.error(error.message);
          } else {
            console.error("Unknown error");
          }
          process.exit(error instanceof CliUsageError ? USAGE_EXIT_CODE : ERROR_EXIT_CODE);
        }
      }
    });
}
