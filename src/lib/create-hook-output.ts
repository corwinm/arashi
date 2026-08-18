import type { LifecycleHookOutcome } from "./hooks.ts";
import { stripVTControlCharacters } from "node:util";

const formatSourceOwner = (outcome: LifecycleHookOutcome): string =>
  outcome.sourceOwnerName
    ? `${outcome.sourceOwnerKind}:${outcome.sourceOwnerName}`
    : outcome.sourceOwnerKind;

export const formatCreateHookSummary = (
  hookOutcomes: readonly LifecycleHookOutcome[],
): string[] => {
  if (hookOutcomes.length === 0) {
    return [];
  }

  const succeeded = hookOutcomes.filter((outcome) => outcome.hookStatus === "success").length;
  const skipped = hookOutcomes.filter((outcome) => outcome.hookStatus === "skipped").length;
  const failed = hookOutcomes.filter((outcome) => outcome.hookStatus === "failure").length;
  const lines = [`Hook results: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed`];

  for (const outcome of hookOutcomes) {
    if (outcome.hookStatus !== "failure") {
      continue;
    }

    lines.push(
      "  - FAILED",
      `    Repository: ${outcome.repositoryId}`,
      `    Hook: ${outcome.hookName}`,
      `    Scope: ${outcome.scope}`,
      `    Source: ${outcome.sourceKind} (${formatSourceOwner(outcome)})`,
      `    Reason: ${outcome.reasonCode}`,
    );
    for (const messageLine of stripVTControlCharacters(outcome.message).split(/\r\n?|\n/)) {
      lines.push(`    Message: ${messageLine}`);
    }
    if (outcome.sourceScriptPath) {
      lines.push(`    Script: ${outcome.sourceScriptPath}`);
    }
  }

  return lines;
};
