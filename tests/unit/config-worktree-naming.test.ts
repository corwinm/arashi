import { describe, expect, test } from "vitest";
import {
  ConfigValidationError,
  normalizeConfig,
  type WorktreeNamingConfig,
} from "../../src/lib/config.ts";

const baseConfig = { repos: {}, reposDir: "./repos", version: "1.0.0" };

describe("worktreeNaming configuration", () => {
  test.each<WorktreeNamingConfig>([
    {},
    { style: "default" },
    { style: "branch" },
    { style: "repo-branch" },
    { branchSlashes: "preserve" },
    { branchSlashes: "flatten" },
    { maxPathLength: 1 },
    { maxPathLength: 2_147_483_647 },
    { style: "repo-branch", branchSlashes: "flatten" },
    { style: "repo-branch", branchSlashes: "flatten", maxPathLength: 180 },
  ])("accepts and preserves optional members: %j", (worktreeNaming) => {
    expect(normalizeConfig({ ...baseConfig, worktreeNaming }).worktreeNaming).toEqual(
      worktreeNaming,
    );
  });

  test("preserves omission rather than serializing effective defaults", () => {
    expect(normalizeConfig(baseConfig)).not.toHaveProperty("worktreeNaming");
  });

  test.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxPathLength before use: %j",
    (maxPathLength) => {
      expect(() => normalizeConfig({ ...baseConfig, worktreeNaming: { maxPathLength } })).toThrow(
        ConfigValidationError,
      );
    },
  );

  test.each([
    null,
    [],
    "default",
    { style: null },
    { style: "other" },
    { branchSlashes: 1 },
    { branchSlashes: "other" },
    { maxPathLength: "180" },
    { unknown: true },
  ])("rejects invalid worktreeNaming shape before use: %j", (worktreeNaming) => {
    expect(() => normalizeConfig({ ...baseConfig, worktreeNaming })).toThrow(ConfigValidationError);
  });
});
