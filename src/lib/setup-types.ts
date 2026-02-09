import type { WorkspaceRepository } from './config.ts';

export type SetupScopeType = 'main' | 'sub';

export type SetupExecutionStatus = 'success' | 'skipped' | 'failed' | 'timed-out';

export type SetupOverallStatus = 'success' | 'partial-failure' | 'failure';

export interface SetupTarget extends WorkspaceRepository {
  scopeType: SetupScopeType;
  selected: boolean;
  hasSetupTask: boolean;
  setupScriptPath?: string;
  skipReason?: string;
}

export interface SetupExecutionResult {
  repositoryName: string;
  status: SetupExecutionStatus;
  durationMs: number;
  detail?: string;
  output?: string;
}

export interface SetupRunSummary {
  overallStatus: SetupOverallStatus;
  totalRepositoriesEvaluated: number;
  executedCount: number;
  successCount: number;
  skippedCount: number;
  failedCount: number;
  timedOutCount: number;
  selectedCount: number;
  excludedCount: number;
  targets: SetupTarget[];
  executions: SetupExecutionResult[];
}
