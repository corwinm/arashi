import { describe, expect, test } from "vitest";
import {
  createDeletePlan,
  createDeleteResult,
  renderDeleteHumanPreview,
  renderDeleteHumanSummary,
  type DeleteBatchEntry,
  type DeleteRepositoryItem,
} from "../../src/commands/delete.ts";

const item = (overrides: Partial<DeleteRepositoryItem>): DeleteRepositoryItem => ({
  id: "",
  kind: "canonical-clone",
  ownership: "delete",
  path: "/workspace/repos/api",
  ref: null,
  oid: null,
  planned: true,
  completed: false,
  state: "planned",
  reasonCode: null,
  message: null,
  ...overrides,
});

const planned = (repositoryKey: string) => ({
  repositoryKey,
  plan: createDeletePlan(
    [
      item({ kind: "canonical-clone", path: "/workspace/repos/api" }),
      item({ kind: "worktree-metadata", path: "/workspace/repos/api/.git/worktrees/topic" }),
      item({ kind: "linked-worktree", path: "/workspace/.arashi/worktrees/topic/repos/api" }),
      item({ kind: "local-ref", path: null, ref: "refs/heads/topic", oid: "a".repeat(40) }),
      item({ kind: "workspace-hook", path: "/workspace/.arashi/hooks/pre-create.api.sh" }),
      item({
        kind: "preserved-global-hook",
        ownership: "preserve",
        path: "/home/user/.arashi/hooks/api/pre-create.sh",
        planned: false,
        state: "preserved",
      }),
      item({
        kind: "config-entry",
        path: "/workspace/.arashi/config.json",
        ref: `repos.${repositoryKey}`,
      }),
      item({ kind: "resume-receipt", path: `/workspace/.git/receipts/${repositoryKey}.json` }),
    ],
    ["DELETE_GIT_DATA_LOSS: dirty\nterminal"],
    { configDigest: "d".repeat(64) },
  ),
});

describe("delete human output", () => {
  test("renders every accepted plan category deterministically and control-escapes text", () => {
    const output = renderDeleteHumanPreview([planned("api")]);

    expect(output).toContain("Repository: api");
    expect(output).toContain("Canonical clone:\n  - /workspace/repos/api");
    expect(output).toContain("Linked worktrees:\n  - /workspace/.arashi/worktrees/topic/repos/api");
    expect(output).toContain("Worktree metadata:\n  - /workspace/repos/api/.git/worktrees/topic");
    expect(output).toContain(`Local refs:\n  - refs/heads/topic @ ${"a".repeat(40)}`);
    expect(output).toContain("Workspace hooks:\n  - /workspace/.arashi/hooks/pre-create.api.sh");
    expect(output).toContain(
      "Configuration entry:\n  - repos.api in /workspace/.arashi/config.json",
    );
    expect(output).toContain(
      "Preserved global hooks:\n  - /home/user/.arashi/hooks/api/pre-create.sh",
    );
    expect(output).toContain("Warnings:\n  - DELETE_GIT_DATA_LOSS: dirty\\nterminal");
    expect(output).not.toContain('"ok":');
    expect(output).not.toContain("\nterminal\n");
  });

  test("separates completed, failing, and not-started repositories with literal retry vectors", () => {
    const alpha = planned("alpha");
    const beta = planned("beta");
    const zeta = planned("zeta");
    const alphaResult = createDeleteResult(alpha.plan, "alpha", false);
    for (const phase of alphaResult.phases) phase.state = "completed";
    alphaResult.retry = {
      safe: false,
      argv: null,
      guidance: "Deletion completed; no retry is required.",
    };
    const betaResult = createDeleteResult(beta.plan, "beta", false);
    betaResult.phases[0]!.state = "completed";
    betaResult.phases[1]!.state = "failed";
    betaResult.retry = {
      safe: true,
      argv: ["aw", "delete", "beta", "--force"],
      guidance: "Retry the exact configured repository.",
    };
    const zetaResult = createDeleteResult(zeta.plan, "zeta", false);
    zetaResult.retry = {
      safe: true,
      argv: ["aw", "delete", "zeta", "--force"],
      guidance: "Retry the exact configured repository.",
    };
    const entries: DeleteBatchEntry[] = [
      { ...alpha, result: alphaResult, state: "completed" },
      { ...beta, result: betaResult, state: "failed" },
      { ...zeta, result: zetaResult, state: "not-started" },
    ];

    const output = renderDeleteHumanSummary(entries);

    expect(output.indexOf("Completed repositories:")).toBeLessThan(
      output.indexOf("Failing repositories:"),
    );
    expect(output.indexOf("Failing repositories:")).toBeLessThan(
      output.indexOf("Not-started repositories:"),
    );
    expect(output).toContain("- alpha");
    expect(output).toContain("- beta");
    expect(output).toContain("- zeta");
    expect(output).toContain('Retry argv: ["aw","delete","beta","--force"]');
    expect(output).toContain('Retry argv: ["aw","delete","zeta","--force"]');
    expect(output).not.toContain("aw delete beta --force");
    expect(output).not.toContain('"schemaVersion":');
  });
});
