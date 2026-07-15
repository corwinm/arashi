import type { PushResult, PushSummary } from "../lib/push-types.ts";
import {
  buildPushSummary,
  formatPushProgress,
  formatPushResultLine,
  formatPushSummary,
} from "../lib/push-output.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { executePushPlan, planPush } from "../lib/push-runner.ts";
import { loadWorkspaceRepositories } from "../lib/config.ts";
import {
  ConfiguredWorkspaceRequiredError,
  findConfiguredWorkspaceRoot,
} from "../lib/workspace-context.ts";
import { Command } from "commander";
import { EmptyRepositoryFiltersError, filterRepositories } from "../lib/repo-filter.ts";
import { info } from "../lib/logger.ts";

const ZERO = 0;
const ONE = 1;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;

class CliUsageError extends Error {}

export interface PushCommandOptions {
  dryRun?: boolean;
  group?: string[];
  json?: boolean;
  only?: string[];
  setUpstream?: boolean;
}

export const executePush = async (options: PushCommandOptions): Promise<PushSummary> => {
  let workspaceRoot = "";
  try {
    workspaceRoot = await findConfiguredWorkspaceRoot("push");
  } catch (error) {
    if (error instanceof ConfiguredWorkspaceRequiredError) throw error;
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
  if (filterResult.emptyFilters.length > ZERO) {
    throw new EmptyRepositoryFiltersError(filterResult.emptyFilters);
  }
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
      info("No repositories selected for push");
    }
    return buildPushSummary([], {
      dryRun: Boolean(options.dryRun),
      only: options.only,
      setUpstream: Boolean(options.setUpstream),
    });
  }

  const results: PushResult[] = [];
  const total = repositories.length;

  for (let index = ZERO; index < repositories.length; index += ONE) {
    const repo = repositories[index];
    if (!options.json) {
      info(formatPushProgress(repo.name, index + ONE, total));
    }

    const plan = await planPush(repo, {
      dryRun: options.dryRun,
      setUpstream: options.setUpstream,
    });
    const result = plan.shouldPush && !options.dryRun ? await executePushPlan(plan) : plan.result;
    results.push(result);

    if (!options.json) {
      info(formatPushResultLine(result));
    }
  }

  const summary = buildPushSummary(results, {
    dryRun: Boolean(options.dryRun),
    only: options.only,
    setUpstream: Boolean(options.setUpstream),
  });

  if (!options.json) {
    console.log(formatPushSummary(summary));
  }

  if (summary.overallStatus === "failure") {
    process.exitCode = ERROR_EXIT_CODE;
  }

  return summary;
};

export function createCommand(): Command {
  return new Command("push")
    .description("Push coordinated branches across eligible repositories")
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
    .option("--set-upstream", "Set upstream tracking when publishing new branches")
    .option("--dry-run", "Preview push operations without mutating remotes")
    .option("--json", "Output result as JSON")
    .action(async (options: PushCommandOptions) => {
      try {
        const summary = await executePush(options);
        if (options.json) {
          const warnings = summary.results
            .filter((result) => result.status === "skipped")
            .map((result) => ({
              code: "REPOSITORY_SKIPPED",
              details: { repositoryId: result.repositoryId },
              message: result.reason ?? `${result.repositoryId} skipped`,
            }));
          const envelope =
            summary.overallStatus === "failure"
              ? createJsonErrorEnvelope(
                  "push",
                  {
                    code: "PUSH_FAILED",
                    details: { results: summary.results, totals: summary.totals },
                    message: "One or more repositories failed to push",
                  },
                  warnings,
                )
              : createJsonSuccessEnvelope("push", { ...summary }, warnings);
          writeJsonEnvelope(envelope);
        }
      } catch (error) {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("push", unknownErrorToJsonError(error)));
          process.exit(USAGE_EXIT_CODE);
        } else {
          console.error(error instanceof Error ? error.message : "Unknown error");
          process.exit(
            error instanceof CliUsageError || error instanceof EmptyRepositoryFiltersError
              ? USAGE_EXIT_CODE
              : ERROR_EXIT_CODE,
          );
        }
      }
    });
}
