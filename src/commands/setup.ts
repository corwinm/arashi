import {
  buildSummary,
  formatProgress,
  formatResultLine,
  formatSummary,
} from "../lib/setup-output.ts";
import {
  discoverSetupTargets,
  isExecutableTarget,
  orderSetupTargets,
} from "../lib/setup-targets.ts";
import { findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import { info, error as logError } from "../lib/logger.ts";
import { Command } from "commander";
import type { SetupExecutionResult } from "../lib/setup-types.ts";
import { runSetupTarget } from "../lib/setup-runner.ts";

const ZERO = 0;
const ONE = 1;
const SUCCESS_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const DEFAULT_TIMEOUT_MS = 300_000;

export interface SetupCommandOptions {
  only?: string[];
  verbose?: boolean;
}

const executeSetup = async (options: SetupCommandOptions): Promise<void> => {
  let workspaceRoot = "";
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    logError("Not in an arashi workspace");
    info('Run "arashi init" to initialize a workspace');
    process.exit(USAGE_EXIT_CODE);
  }

  const repositoriesResult = await loadWorkspaceRepositories(workspaceRoot).catch(
    (error): never => {
      logError("Failed to load workspace configuration");
      logError(error instanceof Error ? error.message : String(error));
      process.exit(USAGE_EXIT_CODE);
    },
  );

  const discovery = await discoverSetupTargets(repositoriesResult.repositories, options.only);
  if (discovery.missing.length > ZERO) {
    logError("Unknown repositories in --only filter:");
    for (const name of discovery.missing) {
      info(`  - ${name}`);
    }
    process.exit(USAGE_EXIT_CODE);
  }

  const orderedTargets = orderSetupTargets(discovery.targets);
  const executableTargets = orderedTargets.filter((target) => isExecutableTarget(target));
  const timeoutMs = repositoriesResult.config.hooks?.timeout ?? DEFAULT_TIMEOUT_MS;

  const executions: SetupExecutionResult[] = [];
  let executionIndex = ZERO;
  for (const target of orderedTargets) {
    if (isExecutableTarget(target)) {
      executionIndex += ONE;
      info(formatProgress(target.name, executionIndex, executableTargets.length));
      const result = await runSetupTarget(target, { timeoutMs });
      executions.push(result);

      if (options.verbose && result.output) {
        console.log(result.output);
      }

      info(formatResultLine(result));
    } else {
      const skippedResult: SetupExecutionResult = {
        detail: target.skipReason,
        durationMs: ZERO,
        repositoryName: target.name,
        status: "skipped",
      };
      executions.push(skippedResult);
      info(formatResultLine(skippedResult));
    }
  }

  const filteredRun = Boolean(options.only && options.only.length > ZERO);
  const summary = buildSummary(orderedTargets, executions);
  console.log(formatSummary(summary, filteredRun));

  const hasFailures = summary.failedCount > ZERO || summary.timedOutCount > ZERO;
  if (hasFailures) {
    process.exit(ERROR_EXIT_CODE);
  }

  process.exit(SUCCESS_EXIT_CODE);
};

export function createCommand(): Command {
  return new Command("setup")
    .description("Run setup scripts across workspace repositories")
    .option(
      "--only <repo>",
      "Only include a specific repository (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option("-v, --verbose", "Show full setup script output")
    .action(async (options: SetupCommandOptions) => {
      try {
        await executeSetup(options);
      } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        process.exit(ERROR_EXIT_CODE);
      }
    });
}
