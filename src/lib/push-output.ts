import type { PushResult, PushSummary, PushTotals } from "./push-types.ts";

export const buildPushSummary = (
  results: PushResult[],
  options: { dryRun: boolean; only?: string[]; setUpstream: boolean },
): PushSummary => {
  const totals: PushTotals = {
    failed: results.filter((result) => result.status === "failed").length,
    planned: results.filter((result) => result.status === "planned").length,
    pushed: results.filter((result) => result.status === "pushed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    total: results.length,
  };

  return {
    dryRun: options.dryRun,
    options: { dryRun: options.dryRun, only: options.only, setUpstream: options.setUpstream },
    overallStatus: totals.failed > 0 ? "failure" : "success",
    results,
    totals,
  };
};

export const formatPushProgress = (repositoryId: string, index: number, total: number): string =>
  `[${index}/${total}] ${repositoryId}`;

export const formatPushResultLine = (result: PushResult): string => {
  const detail = result.errorMessage ?? result.reason;
  const detailSuffix = detail ? ` - ${detail}` : "";
  return `${result.repositoryId}: ${result.status} (${result.elapsedSeconds.toFixed(2)}s)${detailSuffix}`;
};

export const formatPushSummary = (summary: PushSummary): string => {
  const lines = [
    "",
    summary.dryRun ? "Preview summary:" : "Summary:",
    `  total: ${summary.totals.total}`,
    `  pushed: ${summary.totals.pushed}`,
    `  planned: ${summary.totals.planned}`,
    `  skipped: ${summary.totals.skipped}`,
    `  failed: ${summary.totals.failed}`,
    `  overall: ${summary.overallStatus}`,
  ];
  return lines.join("\n");
};
