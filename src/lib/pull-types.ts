/**
 * Types for pull command results and summaries.
 */

import type { ManagedIgnoreReconciliation } from "./managed-ignore.ts";
import type { ConfiguredBaseOutcome } from "./configured-base-outcome.ts";

export type PullStatus = "updated" | "skipped" | "failed" | "manual-update";

export interface PullResult {
  repositoryId: string;
  status: PullStatus;
  elapsedSeconds: number;
  errorMessage?: string;
  output?: string;
  configuredBase?: ConfiguredBaseOutcome;
}

export type PullOverallStatus = "success" | "partial-failure" | "failure";

export interface PullSummary {
  overallStatus: PullOverallStatus;
  results: PullResult[];
  managedIgnore?: ManagedIgnoreReconciliation;
}
