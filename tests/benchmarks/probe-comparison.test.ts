import { describe, expect, test } from "vitest";
import {
  comparisonCases,
  parseArguments,
  validateComparisonArtifact,
  type ProbeComparisonArtifact,
} from "../../scripts/benchmark/compare-probe-budget.ts";

const metric = (main: number, child: number, children: number, unattributed = 0) => ({
  available: true,
  count: main + child * children + unattributed,
  method: "git-trace2-event-root-sessions" as const,
  repositories: [
    { count: main, path: "/fixture/workspace" },
    ...Array.from({ length: children }, (_, index) => ({
      count: child,
      path: `/fixture/workspace/repos/repo-${String(index + 1).padStart(2, "0")}`,
    })),
  ],
  ...(unattributed
    ? { unattributed: { count: unattributed, reason: "fixture setup support session" } }
    : {}),
});

const artifact = (): ProbeComparisonArtifact => ({
  adapter: { argv: ["status", "--json"], sha256: "a".repeat(64) },
  base: { binarySha256: "b".repeat(64), commit: "b648825295a5c342b6920be0585711678377b452" },
  candidate: { binarySha256: "c".repeat(64), commit: "d".repeat(40) },
  cases: comparisonCases.flatMap(({ fixture, verbose }) => {
    const children = fixture === "small" ? 2 : 8;
    const extra = verbose ? 1 : 0;
    const behavior = {
      freshness: { mode: "refreshed", remoteRefsRefreshed: true },
      nativeStatus: verbose,
    };
    return [
      {
        behavior,
        binary: "base" as const,
        fixture,
        metric: metric(13 + extra, 9 + extra, children, 8),
        nativeOutputSha256: verbose ? "e".repeat(64) : null,
        verbose,
      },
      {
        behavior,
        binary: "candidate" as const,
        fixture,
        metric: metric(7 + extra, 6 + extra, children),
        nativeOutputSha256: verbose ? "e".repeat(64) : null,
        verbose,
      },
    ];
  }),
  fixture: { definitionVersion: 5, sourceSha256: "f".repeat(64) },
  provenance: { sameAdapterProcess: true },
  schemaVersion: 1,
});

describe("immutable probe comparison acceptance", () => {
  test("accepts pnpm's explicit argument separator", () => {
    expect(parseArguments(["--", "--candidate", "abc", "--output", "/tmp/result.json"])).toEqual({
      candidate: "abc",
      output: "/tmp/result.json",
    });
  });

  test("covers small and large normal and verbose through one adapter", () => {
    expect(comparisonCases).toEqual([
      { fixture: "small", verbose: false },
      { fixture: "small", verbose: true },
      { fixture: "large", verbose: false },
      { fixture: "large", verbose: true },
    ]);
    expect(() => validateComparisonArtifact(artifact())).not.toThrow();
  });

  test("rejects native verbose drift before budget acceptance", () => {
    const value = artifact();
    value.cases.find((entry) => entry.binary === "candidate" && entry.verbose)!.nativeOutputSha256 =
      "0".repeat(64);
    expect(() => validateComparisonArtifact(value)).toThrow("native verbose output differs");
  });

  test("compares semantic fields independent of JSON object insertion order", () => {
    const value = artifact();
    const base = value.cases.find(
      (entry) => entry.binary === "base" && entry.fixture === "small" && !entry.verbose,
    )!;
    const candidate = value.cases.find(
      (entry) => entry.binary === "candidate" && entry.fixture === "small" && !entry.verbose,
    )!;
    base.behavior = {
      ...base.behavior,
      statuses: [{ defaultBranch: { branch: "main", state: "available" } }],
    };
    candidate.behavior = {
      ...candidate.behavior,
      statuses: [{ defaultBranch: { state: "available", branch: "main" } }],
    };
    expect(() => validateComparisonArtifact(value)).not.toThrow();
  });

  test.each(["baseBranch", "defaultBranch"] as const)(
    "rejects full semantic status drift in %s",
    (field) => {
      const value = artifact();
      const candidate = value.cases.find(
        (entry) => entry.binary === "candidate" && entry.fixture === "small" && !entry.verbose,
      )!;
      candidate.behavior = {
        ...candidate.behavior,
        statuses: [{ [field]: { state: "skipped", reason: "drift" } }],
      };
      expect(() => validateComparisonArtifact(value)).toThrow("semantic status output differs");
    },
  );

  test("rejects incomplete or non-v5 fixture evidence", () => {
    const value = artifact();
    value.fixture.definitionVersion = 3;
    expect(() => validateComparisonArtifact(value)).toThrow("fixture definition v5");
  });
});
