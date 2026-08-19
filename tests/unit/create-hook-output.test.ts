import { describe, expect, test } from "vitest";
import { formatCreateHookSummary } from "../../src/lib/create-hook-output.ts";
import type { LifecycleHookOutcome } from "../../src/lib/hooks.ts";

const outcome = (
  overrides: Partial<LifecycleHookOutcome> &
    Pick<LifecycleHookOutcome, "hookName" | "hookStatus" | "repositoryId">,
): LifecycleHookOutcome => ({
  executionPath: "/workspace",
  message:
    overrides.hookStatus === "success"
      ? "Hook completed"
      : overrides.hookStatus === "skipped"
        ? "Hook script not found"
        : "Hook exited with code 19",
  reasonCode:
    overrides.hookStatus === "success"
      ? "none"
      : overrides.hookStatus === "skipped"
        ? "not_found"
        : "exit_non_zero",
  scope: "repository",
  sourceKind: "file",
  sourceOwnerKind: "repository",
  sourceOwnerName: overrides.repositoryId,
  sourceScriptPath: null,
  targetRepositoryName: overrides.repositoryId,
  targetRepositoryPath: `/workspace/repos/${overrides.repositoryId}`,
  targetWorktreePath: `/workspace/worktrees/${overrides.repositoryId}`,
  workspaceMode: "configured",
  ...overrides,
});

describe("formatCreateHookSummary", () => {
  test("collapses routine successes and skips into deterministic counts", () => {
    const lines = formatCreateHookSummary([
      outcome({ hookName: "pre-create", hookStatus: "skipped", repositoryId: "workspace" }),
      outcome({ hookName: "pre-create.alpha", hookStatus: "success", repositoryId: "alpha" }),
      outcome({ hookName: "post-create.alpha", hookStatus: "success", repositoryId: "alpha" }),
    ]);

    expect(lines).toEqual(["Hook results: 2 succeeded, 1 skipped, 0 failed"]);
    expect(lines.join("\n")).not.toContain("pre-create.alpha");
  });

  test("reports skip-only and success-only ledgers without individual rows", () => {
    expect(
      formatCreateHookSummary([
        outcome({ hookName: "pre-create", hookStatus: "skipped", repositoryId: "workspace" }),
      ]),
    ).toEqual(["Hook results: 0 succeeded, 1 skipped, 0 failed"]);

    expect(
      formatCreateHookSummary([
        outcome({ hookName: "post-create.alpha", hookStatus: "success", repositoryId: "alpha" }),
      ]),
    ).toEqual(["Hook results: 1 succeeded, 0 skipped, 0 failed"]);
  });

  test("renders every failure as a fully attributed vertical detail block", () => {
    const filePath = "/workspace/.arashi/hooks/post-create.alpha.sh";
    const lines = formatCreateHookSummary([
      outcome({ hookName: "pre-create", hookStatus: "skipped", repositoryId: "workspace" }),
      outcome({ hookName: "pre-create.alpha", hookStatus: "success", repositoryId: "alpha" }),
      outcome({
        hookName: "post-create.alpha",
        hookStatus: "failure",
        repositoryId: "alpha",
        sourceScriptPath: filePath,
      }),
      outcome({
        hookName: "post-create",
        hookStatus: "failure",
        message: "Hook timed out after configured limit",
        reasonCode: "timeout",
        repositoryId: "workspace",
        scope: "workspace",
        sourceKind: "inline-config",
        sourceOwnerKind: "workspace",
        sourceOwnerName: null,
        targetRepositoryName: null,
        targetRepositoryPath: null,
        targetWorktreePath: null,
      }),
    ]);

    expect(lines).toEqual([
      "Hook results: 1 succeeded, 1 skipped, 2 failed",
      "  - FAILED",
      "    Repository: alpha",
      "    Hook: post-create.alpha",
      "    Scope: repository",
      "    Source: file (repository:alpha)",
      "    Reason: exit_non_zero",
      `    Script: ${filePath}`,
      "  - FAILED",
      "    Repository: workspace",
      "    Hook: post-create",
      "    Scope: workspace",
      "    Source: inline-config (workspace)",
      "    Reason: timeout",
    ]);
  });

  test("keeps long failure identity, diagnostics, and path on separately labelled lines", () => {
    const repositoryId = `repository-${"x".repeat(80)}`;
    const hookName = `post-create.${repositoryId}`;
    const scriptPath = `/workspace/${"nested/".repeat(20)}hook.sh`;
    const message = `Validation failed: ${"detail ".repeat(20).trim()}`;
    const lines = formatCreateHookSummary([
      outcome({
        hookName,
        hookStatus: "failure",
        message,
        reasonCode: "validation_failed",
        repositoryId,
        sourceScriptPath: scriptPath,
      }),
    ]);

    expect(lines).toContain(`    Repository: ${repositoryId}`);
    expect(lines).toContain(`    Hook: ${hookName}`);
    expect(lines).toContain("    Reason: validation_failed");
    expect(lines).toContain(`    Message: ${message}`);
    expect(lines).toContain(`    Script: ${scriptPath}`);
    expect(lines.some((line) => line.includes(repositoryId) && line.includes(scriptPath))).toBe(
      false,
    );
    expect(lines.join("\n")).not.toContain("\u001B[");
  });

  test("labels every line of a multiline failure diagnostic", () => {
    const lines = formatCreateHookSummary([
      outcome({
        hookName: "post-create.alpha",
        hookStatus: "failure",
        message: "\u001B[31mfirst diagnostic\u001B[0m\r\nScript: diagnostic text\nthird diagnostic",
        reasonCode: "validation_failed",
        repositoryId: "alpha",
      }),
    ]);

    expect(lines).toContain("    Message: first diagnostic");
    expect(lines).toContain("    Message: Script: diagnostic text");
    expect(lines).toContain("    Message: third diagnostic");
    expect(lines).not.toContain(
      "    Message: first diagnostic\r\nScript: diagnostic text\nthird diagnostic",
    );
  });

  test("does not duplicate executed hook stderr into the human summary stream", () => {
    const lines = formatCreateHookSummary([
      outcome({
        hookName: "post-create.alpha",
        hookStatus: "failure",
        message: "sensitive hook stderr",
        reasonCode: "exit_non_zero",
        repositoryId: "alpha",
      }),
      outcome({
        hookName: "post-create.beta",
        hookStatus: "failure",
        message: "timeout hook stderr",
        reasonCode: "timeout",
        repositoryId: "beta",
      }),
    ]);

    expect(lines).toContain("    Reason: exit_non_zero");
    expect(lines).toContain("    Reason: timeout");
    expect(lines.join("\n")).not.toContain("sensitive hook stderr");
    expect(lines.join("\n")).not.toContain("timeout hook stderr");
  });
});
