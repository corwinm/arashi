import { describe, expect, test } from "vitest";
import {
  createWorktreeRemovalPlan,
  parseGitWorktreePorcelainZ,
  type GitWorktreeRecord,
} from "../../src/lib/delete-topology.ts";

const oid = "a".repeat(40);
const porcelain = (...records: string[][]): Buffer =>
  Buffer.from(`${records.map((record) => record.join("\0")).join("\0\0")}\0\0`);

const record = (path: string, overrides: Partial<GitWorktreeRecord> = {}): GitWorktreeRecord => ({
  path,
  head: oid,
  branch: "refs/heads/main",
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  metadataPath: null,
  present: true,
  ...overrides,
});

describe("strict git worktree porcelain -z parsing", () => {
  test("retains primary, linked, detached, locked, and prunable records", () => {
    const parsed = parseGitWorktreePorcelainZ(
      porcelain(
        ["worktree /repo", `HEAD ${oid}`, "branch refs/heads/main"],
        ["worktree /repo/wt/topic", `HEAD ${oid}`, "detached", "locked held by test"],
        [
          "worktree /repo/stale",
          `HEAD ${oid}`,
          "branch refs/heads/stale",
          "prunable gitdir file points to non-existent location",
        ],
      ),
    );

    expect(parsed).toEqual([
      record("/repo"),
      record("/repo/wt/topic", { branch: null, detached: true, locked: "held by test" }),
      record("/repo/stale", {
        branch: "refs/heads/stale",
        prunable: "gitdir file points to non-existent location",
      }),
    ]);
  });

  test.each([
    ["not NUL terminated", Buffer.from(`worktree /repo\0HEAD ${oid}\0branch refs/heads/main`)],
    [
      "missing record separator",
      Buffer.from(`worktree /repo\0HEAD ${oid}\0branch refs/heads/main\0`),
    ],
    ["unknown field", porcelain(["worktree /repo", `HEAD ${oid}`, "mystery value"])],
    ["duplicate field", porcelain(["worktree /repo", `HEAD ${oid}`, `HEAD ${oid}`, "detached"])],
    [
      "branch and detached",
      porcelain(["worktree /repo", `HEAD ${oid}`, "branch refs/heads/main", "detached"]),
    ],
    ["missing HEAD", porcelain(["worktree /repo", "branch refs/heads/main"])],
    ["relative path", porcelain(["worktree relative", `HEAD ${oid}`, "detached"])],
  ])("fails closed for malformed input: %s", (_name, input) => {
    expect(() => parseGitWorktreePorcelainZ(input)).toThrow(/worktree|porcelain|topology/i);
  });

  test("fails closed for invalid UTF-8 bytes before parsing fields", () => {
    const input = porcelain(["worktree /repo", `HEAD ${oid}`, "branch refs/heads/main"]);
    input["worktree /repo".length - 1] = 0xff;

    expect(() => parseGitWorktreePorcelainZ(input)).toThrow(/valid UTF-8/u);
  });
});

describe("linked-worktree deletion planning", () => {
  test("distinguishes the configured active linked path from the canonical primary", () => {
    const records = [
      record("/repo"),
      record("/parents/topic/repos/api", { branch: "refs/heads/topic" }),
    ];

    const plan = createWorktreeRemovalPlan({
      commonDirectory: "/repo/.git",
      configuredActivePath: "/parents/topic/repos/api",
      records,
    });

    expect(plan.configuredActivePath).toBe("/parents/topic/repos/api");
    expect(plan.primaryPath).toBe("/repo");
    expect(plan.canonicalClonePath).toBe("/repo");
    expect(plan.linkedWorktrees.map((entry) => entry.path)).toEqual(["/parents/topic/repos/api"]);
  });

  test("orders linked worktrees deepest-first and stale metadata after Git removals", () => {
    const records = [
      record("/repo"),
      record("/parents/topic/repos/api"),
      record("/parents/topic/nested/repos/api", {
        metadataPath: "/repo/.git/worktrees/api-nested",
      }),
      record("/gone/api", {
        metadataPath: "/repo/.git/worktrees/api-stale",
        present: false,
        prunable: "gitdir file points to non-existent location",
      }),
    ];

    const plan = createWorktreeRemovalPlan({
      commonDirectory: "/repo/.git",
      configuredActivePath: "/parents/topic/repos/api",
      records,
    });

    expect(plan.linkedWorktrees.map((entry) => entry.path)).toEqual([
      "/parents/topic/nested/repos/api",
      "/parents/topic/repos/api",
    ]);
    expect(plan.staleMetadata).toEqual([
      { path: "/repo/.git/worktrees/api-stale", worktreePath: "/gone/api" },
    ]);
  });

  test("fails closed when the configured active path is not a member of the inventory", () => {
    expect(() =>
      createWorktreeRemovalPlan({
        commonDirectory: "/repo/.git",
        configuredActivePath: "/other/repo",
        records: [record("/repo")],
      }),
    ).toThrow(/configured|inventory|topology/i);
  });
});
