import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const configuration = readFileSync(
  join(import.meta.dirname, "..", "..", "docs", "configuration.md"),
  "utf8",
);

describe("configured worktree path budget documentation", () => {
  test("documents the exact authored setting and validation scope", () => {
    expect(configuration).toContain('"worktreeNaming": {');
    expect(configuration).toContain('"maxPathLength": 180');
    expect(configuration).toContain("positive integer from 1 through 2147483647");
    expect(configuration).toContain("UTF-16 code units");
    expect(configuration).toContain("absolute newly planned configured worktree destination");
    expect(configuration).toContain("Omitting `maxPathLength`");
  });

  test("documents deterministic fitting, coordinated children, failure, and boundaries", () => {
    expect(configuration).toMatch(/first eight lowercase\s+hexadecimal characters of SHA-256/);
    expect(configuration).toContain("portable `/`-separated ordinary generated parent namespace");
    expect(configuration).toContain("longest selected child path");
    expect(configuration).toContain("`WORKTREE_PATH_LENGTH_EXCEEDED`");
    expect(configuration).toContain("Git branch name stays exact");
    expect(configuration).toMatch(/Existing registered worktrees are not\s+renamed/);
    expect(configuration).toContain("standalone `.worktrees/<branch>` remains unchanged");
    expect(configuration).toContain("does not guarantee that files inside a repository fit");
  });
});
