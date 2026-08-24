import { describe, expect, test } from "vitest";
import {
  analyzeLocalRefLoss,
  parseGitRefInventory,
  parsePorcelainV2StatusZ,
  type GitRefEvidence,
} from "../../src/lib/delete-git-loss.ts";

const oid = (value: string): string => value.repeat(40);

const ref = (overrides: Partial<GitRefEvidence>): GitRefEvidence => ({
  ref: "refs/heads/main",
  objectOid: oid("1"),
  objectType: "commit",
  peeledOid: null,
  peeledType: null,
  ...overrides,
});

describe("porcelain-v2 Git-loss evidence", () => {
  test("parses tracked, renamed, conflicted, untracked, and ignored NUL records", () => {
    const input = [
      `1 .M N... 100644 100644 100644 ${oid("1")} ${oid("1")} tracked.txt`,
      `2 R. N... 100644 100644 100644 ${oid("1")} ${oid("2")} R100 renamed.txt`,
      "old.txt",
      `u UU N... 100644 100644 100644 100644 ${oid("1")} ${oid("2")} ${oid("3")} conflict.txt`,
      "? untracked.txt",
      "! ignored.txt",
      "",
    ].join("\0");

    expect(parsePorcelainV2StatusZ(input)).toEqual([
      { kind: "tracked", path: "tracked.txt", status: ".M" },
      { kind: "tracked", path: "renamed.txt", status: "R." },
      { kind: "conflicted", path: "conflict.txt", status: "UU" },
      { kind: "untracked", path: "untracked.txt", status: "?" },
      { kind: "ignored", path: "ignored.txt", status: "!" },
    ]);
  });

  test.each([
    "1 malformed\0",
    "? missing-terminator",
    "x unknown\0",
    "2 R. N... 100644 100644 100644 a b R100 new\0",
  ])("rejects incomplete or unknown status evidence: %s", (input) =>
    expect(() => parsePorcelainV2StatusZ(input)).toThrow(/Git status evidence/u),
  );

  test("rejects invalid UTF-8 bytes before parsing status records", () => {
    const input = Buffer.from("? invalid\0");
    input[2] = 0xff;

    expect(() => parsePorcelainV2StatusZ(input)).toThrow(/valid UTF-8/u);
  });
});

describe("strict local ref inventory", () => {
  test("parses heads, remotes, stash, lightweight tags, and annotated tags", () => {
    const input = [
      `refs/heads/main\0${oid("1")}\0commit\0\0`,
      `refs/remotes/origin/main\0${oid("1")}\0commit\0\0`,
      `refs/stash\0${oid("2")}\0commit\0\0`,
      `refs/tags/light\0${oid("3")}\0commit\0\0`,
      `refs/tags/annotated\0${oid("4")}\0tag\0${oid("5")}\0commit`,
      "",
    ].join("\n");

    expect(parseGitRefInventory(input)).toHaveLength(5);
    expect(parseGitRefInventory(input).at(-1)).toEqual({
      ref: "refs/tags/annotated",
      objectOid: oid("4"),
      objectType: "tag",
      peeledOid: oid("5"),
      peeledType: "commit",
    });
  });

  test("rejects invalid UTF-8 bytes before parsing ref records", () => {
    const input = Buffer.from(`refs/heads/main\0${oid("1")}\0commit\0\0\n`);
    input["refs/heads/mai".length] = 0xff;

    expect(() => parseGitRefInventory(input)).toThrow(/valid UTF-8/u);
  });

  test.each([
    `refs/heads/main\0bad\0commit\0\0\n`,
    `refs/other/main\0${oid("1")}\0commit\0\0\n`,
    `refs/tags/t\0${oid("1")}\0tag\0\0\n`,
    `refs/heads/main\0${oid("1")}\0blob\0\0\n`,
  ])("rejects malformed or unusable ref evidence", (input) => {
    expect(() => parseGitRefInventory(input)).toThrow(/Git ref evidence/u);
  });
});

describe("deterministic local-ref planning", () => {
  test("uses remote-tracking refs only as reachability evidence and emits adjacent tag records", async () => {
    const refs = [
      ref({ ref: "refs/remotes/upstream/main", objectOid: oid("9") }),
      ref({ ref: "refs/heads/published", objectOid: oid("1") }),
      ref({ ref: "refs/heads/local", objectOid: oid("2") }),
      ref({ ref: "refs/stash", objectOid: oid("3") }),
      ref({ ref: "refs/tags/light", objectOid: oid("4") }),
      ref({
        ref: "refs/tags/annotated",
        objectOid: oid("5"),
        objectType: "tag",
        peeledOid: oid("6"),
        peeledType: "commit",
      }),
    ];
    const reachable = new Set([oid("1"), oid("4")]);

    const result = await analyzeLocalRefLoss({
      detachedCommits: [oid("7"), oid("7")],
      refs,
      isReachableFromRemote: async (candidate, remotes) => {
        expect(remotes).toEqual([oid("9")]);
        return reachable.has(candidate);
      },
    });

    expect(result.items.map(({ ref, oid: value }) => [ref, value])).toEqual([
      ["refs/heads/local", oid("2")],
      ["refs/heads/published", oid("1")],
      ["refs/stash", oid("3")],
      ["refs/tags/annotated", oid("5")],
      ["refs/tags/annotated^{}", oid("6")],
      ["refs/tags/light", oid("4")],
      ["refs/tags/light^{}", oid("4")],
      ["HEAD(detached)", oid("7")],
    ]);
    expect(result.items.some(({ ref: name }) => name?.startsWith("refs/remotes/"))).toBe(false);
    expect(result.warnings).toEqual([
      `DELETE_GIT_DATA_LOSS: HEAD(detached) ${oid("7")} is not reachable from local remote-tracking refs`,
      `DELETE_GIT_DATA_LOSS: refs/heads/local ${oid("2")} is not reachable from local remote-tracking refs`,
      `DELETE_GIT_DATA_LOSS: refs/stash ${oid("3")} is not reachable from local remote-tracking refs`,
      `DELETE_GIT_DATA_LOSS: refs/tags/annotated^{} ${oid("6")} is not reachable from local remote-tracking refs`,
      "DELETE_GIT_REFLOG_BOUNDARY: reflog-only unreachable objects are outside the local publication check",
      "DELETE_GIT_REMOTE_EVIDENCE: reachability uses local remote-tracking refs only; no fetch was performed",
    ]);
  });

  test("fails closed when no remote-tracking commit evidence exists", async () => {
    await expect(
      analyzeLocalRefLoss({
        detachedCommits: [],
        refs: [ref({ ref: "refs/heads/main" })],
        isReachableFromRemote: async () => false,
      }),
    ).rejects.toThrow(/remote-tracking commit evidence is unavailable/u);
  });

  test("fails closed when reachability comparison is unavailable", async () => {
    await expect(
      analyzeLocalRefLoss({
        detachedCommits: [],
        refs: [
          ref({ ref: "refs/heads/main" }),
          ref({ ref: "refs/remotes/origin/main", objectOid: oid("9") }),
        ],
        isReachableFromRemote: async () => {
          throw new Error("object unavailable");
        },
      }),
    ).rejects.toThrow(/Git reachability evidence is unavailable/u);
  });
});
