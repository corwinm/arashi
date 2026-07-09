export type PushResultStatus = "pushed" | "skipped" | "failed" | "planned";

export interface PushOptionsSummary {
  dryRun: boolean;
  setUpstream: boolean;
  only?: string[];
}

export interface PushResult {
  repositoryId: string;
  status: PushResultStatus;
  branch?: string;
  remote?: string;
  upstream?: string;
  command?: string[];
  reason?: string;
  errorMessage?: string;
  stdout?: string;
  stderr?: string;
  elapsedSeconds: number;
  upstreamSet?: boolean;
}

export interface PushTotals {
  total: number;
  pushed: number;
  planned: number;
  skipped: number;
  failed: number;
}

export interface PushSummary {
  dryRun: boolean;
  options: PushOptionsSummary;
  results: PushResult[];
  totals: PushTotals;
  overallStatus: "success" | "failure";
}
