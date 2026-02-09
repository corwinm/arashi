import type { SetupExecutionResult, SetupOverallStatus, SetupRunSummary, SetupTarget } from './setup-types.ts';

export function formatProgress(repositoryName: string, index: number, total: number): string {
  return `[${index}/${total}] ${repositoryName}`;
}

export function formatResultLine(result: SetupExecutionResult): string {
  const elapsed = formatElapsed(result.durationMs);
  const detailSuffix = result.detail ? ` - ${result.detail}` : '';
  return `${result.repositoryName}: ${result.status} (${elapsed})${detailSuffix}`;
}

export function buildSummary(targets: SetupTarget[], executions: SetupExecutionResult[]): SetupRunSummary {
  const successCount = executions.filter(result => result.status === 'success').length;
  const skippedCount = executions.filter(result => result.status === 'skipped').length;
  const failedCount = executions.filter(result => result.status === 'failed').length;
  const timedOutCount = executions.filter(result => result.status === 'timed-out').length;

  const selectedCount = targets.filter(target => target.selected).length;
  const excludedCount = targets.filter(target => !target.selected).length;
  const executedCount = successCount + failedCount + timedOutCount;

  let overallStatus: SetupOverallStatus = 'success';
  if (failedCount + timedOutCount > 0 && successCount > 0) {
    overallStatus = 'partial-failure';
  } else if (failedCount + timedOutCount > 0 && successCount === 0) {
    overallStatus = 'failure';
  }

  return {
    overallStatus,
    totalRepositoriesEvaluated: targets.length,
    executedCount,
    successCount,
    skippedCount,
    failedCount,
    timedOutCount,
    selectedCount,
    excludedCount,
    targets,
    executions,
  };
}

export function formatSummary(summary: SetupRunSummary, filteredRun: boolean): string {
  const lines = [
    '',
    'Summary:',
    `  total: ${summary.totalRepositoriesEvaluated}`,
    `  selected: ${summary.selectedCount}`,
    `  executed: ${summary.executedCount}`,
    `  success: ${summary.successCount}`,
    `  skipped: ${summary.skippedCount}`,
    `  failed: ${summary.failedCount}`,
    `  timed-out: ${summary.timedOutCount}`,
  ];

  if (filteredRun) {
    lines.push(`  excluded: ${summary.excludedCount}`);
  }

  lines.push(`  overall: ${summary.overallStatus}`);
  return lines.join('\n');
}

function formatElapsed(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(2)}s`;
}
