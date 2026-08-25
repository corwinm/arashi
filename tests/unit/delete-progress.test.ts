import { describe, expect, test } from "vitest";
import {
  createDeletePlan,
  createDeleteResult,
  markDeletePhaseFailure,
  type DeleteRepositoryItem,
} from "../../src/commands/delete.ts";

const item = (path: string): DeleteRepositoryItem => ({
  id: "",
  kind: "workspace-hook",
  ownership: "delete",
  path,
  ref: null,
  oid: null,
  planned: true,
  completed: false,
  state: "planned",
  reasonCode: null,
  message: null,
});

describe("delete partial-progress ledger", () => {
  test("reports the active hook as failed and later hooks as blocked", () => {
    const plan = createDeletePlan([item("/hooks/a"), item("/hooks/b"), item("/hooks/c")], [], {
      configDigest: "a".repeat(64),
    });
    const result = createDeleteResult(plan, "api", true);
    const phase = result.phases.find(({ name }) => name === "workspace-hooks")!;
    phase.state = "started";
    const [first, failed, blocked] = result.items;
    Object.assign(first!, { completed: true, state: "completed" });

    markDeletePhaseFailure(result, phase, new Error("persist failed"), failed!.id);

    expect(failed).toMatchObject({ completed: false, state: "failed" });
    expect(blocked).toMatchObject({
      completed: false,
      state: "blocked",
      reasonCode: "DELETE_BLOCKED_BY_PRIOR_FAILURE",
    });
  });

  test("blocks every pending worktree when phase revalidation fails before an item starts", () => {
    const worktreeItems = ["/wt/a", "/wt/b"].map((path) => ({
      ...item(path),
      kind: "linked-worktree" as const,
    }));
    const plan = createDeletePlan(worktreeItems, [], { configDigest: "a".repeat(64) });
    const result = createDeleteResult(plan, "api", true);
    const phase = result.phases.find(({ name }) => name === "worktrees")!;
    phase.state = "started";

    markDeletePhaseFailure(result, phase, new Error("topology changed"), null);

    expect(result.items.every(({ state }) => state === "blocked")).toBe(true);
  });

  test("blocks later hooks when the active hook was destroyed before receipt persistence failed", () => {
    const plan = createDeletePlan([item("/hooks/a"), item("/hooks/b")], [], {
      configDigest: "a".repeat(64),
    });
    const result = createDeleteResult(plan, "api", true);
    const phase = result.phases.find(({ name }) => name === "workspace-hooks")!;
    phase.state = "started";
    const [destroyed, blocked] = result.items;
    Object.assign(destroyed!, { completed: true, state: "completed" });

    markDeletePhaseFailure(result, phase, new Error("receipt write failed"), destroyed!.id);

    expect(destroyed).toMatchObject({ completed: true, state: "completed" });
    expect(blocked).toMatchObject({
      completed: false,
      state: "blocked",
      reasonCode: "DELETE_BLOCKED_BY_PRIOR_FAILURE",
    });
  });
});
