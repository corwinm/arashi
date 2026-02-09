import { describe, expect, test } from 'bun:test';
import { buildSummary, formatResultLine, formatSummary } from '../../src/lib/setup-output.ts';
import type { SetupExecutionResult, SetupTarget } from '../../src/lib/setup-types.ts';

function createTarget(name: string, selected = true): SetupTarget {
  return {
    name,
    path: `/tmp/${name}`,
    scopeType: name === 'workspace' ? 'main' : 'sub',
    selected,
    hasSetupTask: selected,
  };
}

describe('setup output formatting', () => {
  test('builds success summary counts', () => {
    const targets = [createTarget('workspace'), createTarget('repo-a')];
    const executions: SetupExecutionResult[] = [
      { repositoryName: 'workspace', status: 'success', durationMs: 500 },
      { repositoryName: 'repo-a', status: 'skipped', durationMs: 0, detail: 'no setup script found' },
    ];

    const summary = buildSummary(targets, executions);

    expect(summary.overallStatus).toBe('success');
    expect(summary.executedCount).toBe(1);
    expect(summary.successCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
    expect(summary.timedOutCount).toBe(0);
  });

  test('builds failure summary counts', () => {
    const targets = [createTarget('workspace'), createTarget('repo-a')];
    const executions: SetupExecutionResult[] = [
      { repositoryName: 'workspace', status: 'failed', durationMs: 1000, detail: 'boom' },
      { repositoryName: 'repo-a', status: 'timed-out', durationMs: 1000, detail: 'timed out' },
    ];

    const summary = buildSummary(targets, executions);

    expect(summary.overallStatus).toBe('failure');
    expect(summary.executedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.timedOutCount).toBe(1);
  });

  test('formats result and filtered summary output', () => {
    const line = formatResultLine({
      repositoryName: 'repo-a',
      status: 'failed',
      durationMs: 2100,
      detail: 'script error',
    });

    expect(line).toBe('repo-a: failed (2.10s) - script error');

    const targets = [createTarget('workspace'), createTarget('repo-a', false)];
    const summary = buildSummary(targets, [
      { repositoryName: 'workspace', status: 'success', durationMs: 100 },
      { repositoryName: 'repo-a', status: 'skipped', durationMs: 0, detail: 'excluded by --only filter' },
    ]);

    const text = formatSummary(summary, true);
    expect(text).toContain('selected: 1');
    expect(text).toContain('excluded: 1');
    expect(text).toContain('overall: success');
  });
});
