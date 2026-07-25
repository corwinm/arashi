import type { SetupExecutionResult, SetupRunSummary } from "../lib/setup-types.ts";
import {
  buildSummary,
  formatProgress,
  formatResultLine,
  formatSummary,
} from "../lib/setup-output.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import {
  discoverSetupTargets,
  isExecutableTarget,
  orderSetupTargets,
} from "../lib/setup-targets.ts";
import { loadWorkspaceRepositories, type WorkspaceRepositoryRoots } from "../lib/config.ts";
import { info, error as logError } from "../lib/logger.ts";
import { Command } from "commander";
import { EmptyRepositoryFiltersError, filterRepositories } from "../lib/repo-filter.ts";
import { runSetupTarget } from "../lib/setup-runner.ts";
import {
  ConfiguredWorkspaceRequiredError,
  findConfiguredWorkspaceRoots,
} from "../lib/workspace-context.ts";

const ZERO = 0;
const ONE = 1;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const DEFAULT_TIMEOUT_MS = 300_000;

class CliUsageError extends Error {}

export interface SetupCommandOptions {
  group?: string[];
  json?: boolean;
  only?: string[];
  verbose?: boolean;
}

const executeSetup = async (options: SetupCommandOptions): Promise<SetupRunSummary> => {
  const workspaceRoots: WorkspaceRepositoryRoots = await findConfiguredWorkspaceRoots(
    "setup",
  ).catch((error): never => {
    if (error instanceof ConfiguredWorkspaceRequiredError) {
      throw error;
    }
    throw new CliUsageError(
      'Not in an arashi workspace. Run "arashi init" to initialize a workspace',
    );
  });

  const repositoriesResult = await loadWorkspaceRepositories(workspaceRoots).catch(
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

  const selectedNames =
    filterResult.filters.only.length > ZERO || filterResult.filters.groups.length > ZERO
      ? filterResult.selected.map((repository) => repository.name)
      : undefined;
  const discovery = await discoverSetupTargets(repositoriesResult.repositories, selectedNames);

  const orderedTargets = orderSetupTargets(discovery.targets);
  const executableTargets = orderedTargets.filter((target) => isExecutableTarget(target));
  const timeoutMs = repositoriesResult.config.hooks?.timeout ?? DEFAULT_TIMEOUT_MS;

  const executions: SetupExecutionResult[] = [];
  let executionIndex = ZERO;
  for (const target of orderedTargets) {
    if (isExecutableTarget(target)) {
      executionIndex += ONE;
      if (!options.json) {
        info(formatProgress(target.name, executionIndex, executableTargets.length));
      }
      const result = await runSetupTarget(target, { timeoutMs });
      executions.push(result);

      if (options.verbose && result.output && !options.json) {
        console.log(result.output);
      }

      if (!options.json) {
        info(formatResultLine(result));
      }
    } else {
      const skippedResult: SetupExecutionResult = {
        detail: target.skipReason,
        durationMs: ZERO,
        repositoryName: target.name,
        status: "skipped",
      };
      executions.push(skippedResult);
      if (!options.json) {
        info(formatResultLine(skippedResult));
      }
    }
  }

  const filteredRun = Boolean(
    (options.only && options.only.length > ZERO) || (options.group && options.group.length > ZERO),
  );
  const summary = buildSummary(orderedTargets, executions);
  if (!options.json) {
    console.log(formatSummary(summary, filteredRun));
  }

  const hasFailures = summary.failedCount > ZERO || summary.timedOutCount > ZERO;
  if (hasFailures) {
    process.exitCode = ERROR_EXIT_CODE;
  }

  return summary;
};

export function createCommand(): Command {
  return new Command("setup")
    .description("Run setup scripts across workspace repositories")
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
    .option("-v, --verbose", "Show full setup script output")
    .option("--json", "Output result as JSON")
    .action(async (options: SetupCommandOptions) => {
      try {
        const summary = await executeSetup(options);
        if (options.json) {
          writeJsonEnvelope(createJsonSuccessEnvelope("setup", { ...summary }));
        }
      } catch (error) {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("setup", unknownErrorToJsonError(error)));
          process.exit(USAGE_EXIT_CODE);
        } else {
          logError(error instanceof Error ? error.message : String(error));
          process.exit(
            error instanceof CliUsageError || error instanceof EmptyRepositoryFiltersError
              ? USAGE_EXIT_CODE
              : ERROR_EXIT_CODE,
          );
        }
      }
    });
}
