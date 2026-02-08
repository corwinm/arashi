export type SyncStatus = 'success' | 'failure' | 'timeout';

export interface SyncResult {
  repositoryName: string;
  targetBranch: string;
  status: SyncStatus;
  durationMs: number;
  createdBranch: boolean;
  errorMessage?: string;
}

export interface SyncSummary {
  successCount: number;
  failureCount: number;
  results: SyncResult[];
}
