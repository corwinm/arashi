/**
 * Types for pull command results and summaries.
 */

export type PullStatus = "updated" | "skipped" | "failed" | "manual-update";

export interface PullResult {
  repositoryId: string;
  status: PullStatus;
  elapsedSeconds: number;
  errorMessage?: string;
  output?: string;
}

export type PullOverallStatus = "success" | "partial-failure" | "failure";

export interface PullSummary {
  overallStatus: PullOverallStatus;
  results: PullResult[];
}
