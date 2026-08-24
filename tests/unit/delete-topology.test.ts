import { describe, expect, test } from "vitest";
import { join, parse, resolve } from "node:path";
import {
  createWorktreeRemovalPlan,
  parseGitWorktreePorcelainZ,
  type GitWorktreeRecord,
} from "../../src/lib/delete-topology.ts";

const oid = "a".repeat(40);
const fixtureRoot = resolve(parse(process.cwd()).root, "repo");
const linkedRoot = resolve(parse(process.cwd()).root, "parents", "topic");
const primaryPath = fixtureRoot;
const commonDirectory = join(primaryPath, ".git");
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
        [`worktree ${primaryPath}`, `HEAD ${oid}`, "branch refs/heads/main"],
        [
          `worktree ${join(primaryPath, "wt", "topic")}`,
          `HEAD ${oid}`,
          "detached",
          "locked held by test",
        ],
        [
          `worktree ${join(primaryPath, "stale")}`,
          `HEAD ${oid}`,
          "branch refs/heads/stale",
          "prunable gitdir file points to non-existent location",
        ],
      ),
    );

    expect(parsed).toEqual([
      record(primaryPath),
      record(join(primaryPath, "wt", "topic"), {
        branch: null,
        detached: true,
        locked: "held by test",
      }),
      record(join(primaryPath, "stale"), {
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
    const activePath = join(linkedRoot, "repos", "api");
    const records = [record(primaryPath), record(activePath, { branch: "refs/heads/topic" })];

    const plan = createWorktreeRemovalPlan({
      commonDirectory,
      configuredActivePath: activePath,
      records,
    });

    expect(plan.configuredActivePath).toBe(activePath);
    expect(plan.primaryPath).toBe(primaryPath);
    expect(plan.canonicalClonePath).toBe(primaryPath);
    expect(plan.linkedWorktrees.map((entry) => entry.path)).toEqual([activePath]);
  });

  test("orders linked worktrees deepest-first and stale metadata after Git removals", () => {
    const activePath = join(linkedRoot, "repos", "api");
    const nestedPath = join(linkedRoot, "nested", "repos", "api");
    const stalePath = resolve(parse(process.cwd()).root, "gone", "api");
    const staleMetadataPath = join(commonDirectory, "worktrees", "api-stale");
    const records = [
      record(primaryPath),
      record(activePath),
      record(nestedPath, {
        metadataPath: join(commonDirectory, "worktrees", "api-nested"),
      }),
      record(stalePath, {
        metadataPath: staleMetadataPath,
        present: false,
        prunable: "gitdir file points to non-existent location",
      }),
    ];

    const plan = createWorktreeRemovalPlan({
      commonDirectory,
      configuredActivePath: activePath,
      records,
    });

    expect(plan.linkedWorktrees.map((entry) => entry.path)).toEqual([nestedPath, activePath]);
    expect(plan.staleMetadata).toEqual([{ path: staleMetadataPath, worktreePath: stalePath }]);
  });

  test("fails closed when the configured active path is not a member of the inventory", () => {
    expect(() =>
      createWorktreeRemovalPlan({
        commonDirectory,
        configuredActivePath: resolve(parse(process.cwd()).root, "other", "repo"),
        records: [record(primaryPath)],
      }),
    ).toThrow(/configured|inventory|topology/i);
  });
});
