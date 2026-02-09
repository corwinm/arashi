import { Command } from 'commander';
import * as logger from '../lib/logger.ts';
import { findWorkspaceRoot, loadWorkspaceRepositories } from '../lib/config.ts';
import { buildSummary, formatProgress, formatResultLine, formatSummary } from '../lib/setup-output.ts';
import { discoverSetupTargets, isExecutableTarget, orderSetupTargets } from '../lib/setup-targets.ts';
import { runSetupTarget } from '../lib/setup-runner.ts';
import type { SetupExecutionResult } from '../lib/setup-types.ts';

export interface SetupCommandOptions {
  only?: string[];
  verbose?: boolean;
}

async function executeSetup(options: SetupCommandOptions): Promise<void> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    logger.error('Not in an arashi workspace');
    logger.info('Run "arashi init" to initialize a workspace');
    process.exit(2);
  }

  let repositoriesResult;
  try {
    repositoriesResult = await loadWorkspaceRepositories(workspaceRoot);
  } catch (error) {
    logger.error('Failed to load workspace configuration');
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const discovery = await discoverSetupTargets(repositoriesResult.repositories, options.only);
  if (discovery.missing.length > 0) {
    logger.error('Unknown repositories in --only filter:');
    for (const name of discovery.missing) {
      logger.info(`  - ${name}`);
    }
    process.exit(2);
  }

  const orderedTargets = orderSetupTargets(discovery.targets);
  const executableTargets = orderedTargets.filter(isExecutableTarget);
  const timeoutMs = repositoriesResult.config.hooks?.timeout ?? 300000;

  const executions: SetupExecutionResult[] = [];
  let executionIndex = 0;
  for (const target of orderedTargets) {
    if (!isExecutableTarget(target)) {
      const skippedResult: SetupExecutionResult = {
        repositoryName: target.name,
        status: 'skipped',
        durationMs: 0,
        detail: target.skipReason,
      };
      executions.push(skippedResult);
      logger.info(formatResultLine(skippedResult));
      continue;
    }

    executionIndex += 1;
    logger.info(formatProgress(target.name, executionIndex, executableTargets.length));
    const result = await runSetupTarget(target, { timeoutMs });
    executions.push(result);

    if (options.verbose && result.output) {
      console.log(result.output);
    }

    logger.info(formatResultLine(result));
  }

  const filteredRun = Boolean(options.only && options.only.length > 0);
  const summary = buildSummary(orderedTargets, executions);
  console.log(formatSummary(summary, filteredRun));

  const hasFailures = summary.failedCount > 0 || summary.timedOutCount > 0;
  process.exit(hasFailures ? 1 : 0);
}

export function createCommand(): Command {
  return new Command('setup')
    .description('Run setup scripts across workspace repositories')
    .option('--only <repo>', 'Only include a specific repository (repeatable)', (value, previous: string[] = []) => {
      return previous.concat(value);
    })
    .option('-v, --verbose', 'Show full setup script output')
    .action(async (options: SetupCommandOptions) => {
      try {
        await executeSetup(options);
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}
