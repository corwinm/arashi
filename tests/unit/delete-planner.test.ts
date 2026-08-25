import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  buildDeleteConfigChain,
  createDeletePlan,
  createDeleteResult,
  sortRepositoryKeys,
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

describe("delete planner closed projections", () => {
  test("sorts exact repository keys bytewise and deduplicates them", () => {
    expect(sortRepositoryKeys(["z", "ä", "A", "a", "A"])).toEqual(["A", "a", "z", "ä"]);
  });

  test("builds a deterministic config-byte handoff for every repository", () => {
    const initial = Buffer.from(
      '{\n  "version": "1.0.0",\n  "reposDir": "repos",\n  "repos": {\n    "z": { "path": "repos/z" },\n    "a": { "path": "repos/a" }\n  }\n}\n',
    );
    const chain = buildDeleteConfigChain(initial, ["z", "a"]);

    expect(chain.map((entry) => entry.repositoryKey)).toEqual(["a", "z"]);
    expect(chain[0]?.expectedBefore).toEqual(initial);
    expect(chain[1]?.expectedBefore).toEqual(chain[0]?.expectedAfter);
    expect(JSON.parse(Buffer.from(chain[1]!.expectedAfter).toString()).repos).toEqual({});
  });

  test("creates stable exact plan and result records in phase order", () => {
    const plan = createDeletePlan(
      [
        item({ kind: "config-entry", path: "/workspace/.arashi/config.json", ref: "repos.api" }),
        item({ kind: "local-ref", path: null, ref: "refs/heads/topic", oid: "a".repeat(40) }),
        item({ kind: "linked-worktree", path: "/workspace/deep/topic" }),
        item({ kind: "linked-worktree", path: "/workspace/deep/topic/nested" }),
        item({ kind: "resume-receipt", path: "/workspace/.git/.arashi-delete-receipts/api.json" }),
      ],
      ["z warning", "a warning", "z warning"],
      { configDigest: createHash("sha256").update("config").digest("hex") },
    );
    const second = createDeletePlan(plan.items, plan.warnings, {
      configDigest: createHash("sha256").update("config").digest("hex"),
    });

    expect(plan.id).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(plan);
    expect(plan.warnings).toEqual(["a warning", "z warning"]);
    expect(plan.items.map((entry) => entry.kind)).toEqual([
      "resume-receipt",
      "linked-worktree",
      "linked-worktree",
      "local-ref",
      "config-entry",
    ]);
    expect(plan.items[1]?.path).toBe("/workspace/deep/topic/nested");
    expect(Object.keys(plan.items[0]!)).toEqual([
      "id",
      "kind",
      "ownership",
      "path",
      "ref",
      "oid",
      "planned",
      "completed",
      "state",
      "reasonCode",
      "message",
    ]);

    const result = createDeleteResult(plan, "api", true);
    expect(Object.keys(plan)).toEqual(["id", "items", "warnings"]);
    expect(Object.keys(result)).toEqual(["items", "phases", "retry", "warnings"]);
    expect(Object.keys(result.retry)).toEqual(["safe", "argv", "guidance"]);
    expect(
      result.phases.every(
        (phase) =>
          JSON.stringify(Object.keys(phase)) ===
          JSON.stringify(["name", "state", "itemIds", "error", "startedOrder", "completedOrder"]),
      ),
    ).toBe(true);
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "provenance",
      "worktrees",
      "metadata",
      "canonical-clone",
      "workspace-hooks",
      "configuration",
      "verification",
    ]);
    expect(result.retry).toEqual({
      safe: false,
      argv: null,
      guidance: "No current durable receipt exists; inspect surviving state before retrying.",
    });
  });
});
