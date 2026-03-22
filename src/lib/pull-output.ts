import type { PullOverallStatus, PullResult, PullSummary } from "./pull-types.ts";

export function formatProgress(repoName: string, index: number, total: number): string {
  return `[${index}/${total}] ${repoName}`;
}

export function formatResultLine(result: PullResult): string {
  const elapsed = formatElapsed(result.elapsedSeconds);
  const suffix = result.errorMessage ? ` - ${result.errorMessage}` : "";
  return `${result.repositoryId}: ${result.status} (${elapsed})${suffix}`;
}

export function buildSummary(results: PullResult[]): PullSummary {
  const failures = results.filter((r) => r.status === "failed" || r.status === "manual-update");
  const successes = results.filter((r) => r.status === "updated" || r.status === "skipped");

  let overallStatus: PullOverallStatus = "success";
  if (failures.length > 0 && successes.length > 0) {
    overallStatus = "partial-failure";
  } else if (failures.length > 0 && successes.length === 0) {
    overallStatus = "failure";
  }

  return { overallStatus, results };
}

export function formatSummary(summary: PullSummary): string {
  const updated = summary.results.filter((r) => r.status === "updated").length;
  const skipped = summary.results.filter((r) => r.status === "skipped").length;
  const failed = summary.results.filter((r) => r.status === "failed").length;
  const manual = summary.results.filter((r) => r.status === "manual-update").length;
  const total = summary.results.length;

  return [
    "",
    "Summary:",
    `  total: ${total}`,
    `  updated: ${updated}`,
    `  skipped: ${skipped}`,
    `  failed: ${failed}`,
    `  manual-update: ${manual}`,
    `  overall: ${summary.overallStatus}`,
  ].join("\n");
}

function formatElapsed(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}
