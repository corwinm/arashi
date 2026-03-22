import type { SetupExecutionResult, SetupTarget } from "../../src/lib/setup-types.ts";
import { buildSummary, formatResultLine, formatSummary } from "../../src/lib/setup-output.ts";
import { describe, expect, test } from "bun:test";

function createTarget(name: string, selected = true): SetupTarget {
  return {
    hasSetupTask: selected,
    name,
    path: `/tmp/${name}`,
    scopeType: name === "workspace" ? "main" : "sub",
    selected,
  };
}

describe("setup output formatting", () => {
  test("builds success summary counts", () => {
    const targets = [createTarget("workspace"), createTarget("repo-a")];
    const executions: SetupExecutionResult[] = [
      { durationMs: 500, repositoryName: "workspace", status: "success" },
      {
        detail: "no setup script found",
        durationMs: 0,
        repositoryName: "repo-a",
        status: "skipped",
      },
    ];

    const summary = buildSummary(targets, executions);

    expect(summary.overallStatus).toBe("success");
    expect(summary.executedCount).toBe(1);
    expect(summary.successCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
    expect(summary.timedOutCount).toBe(0);
  });

  test("builds failure summary counts", () => {
    const targets = [createTarget("workspace"), createTarget("repo-a")];
    const executions: SetupExecutionResult[] = [
      { detail: "boom", durationMs: 1000, repositoryName: "workspace", status: "failed" },
      { detail: "timed out", durationMs: 1000, repositoryName: "repo-a", status: "timed-out" },
    ];

    const summary = buildSummary(targets, executions);

    expect(summary.overallStatus).toBe("failure");
    expect(summary.executedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.timedOutCount).toBe(1);
  });

  test("formats result and filtered summary output", () => {
    const line = formatResultLine({
      detail: "script error",
      durationMs: 2100,
      repositoryName: "repo-a",
      status: "failed",
    });

    expect(line).toBe("repo-a: failed (2.10s) - script error");

    const targets = [createTarget("workspace"), createTarget("repo-a", false)];
    const summary = buildSummary(targets, [
      { durationMs: 100, repositoryName: "workspace", status: "success" },
      {
        detail: "excluded by --only filter",
        durationMs: 0,
        repositoryName: "repo-a",
        status: "skipped",
      },
    ]);

    const text = formatSummary(summary, true);
    expect(text).toContain("selected: 1");
    expect(text).toContain("excluded: 1");
    expect(text).toContain("overall: success");
  });
});
