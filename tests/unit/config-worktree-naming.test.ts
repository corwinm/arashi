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
    { style: "repo-branch", branchSlashes: "flatten" },
  ])("accepts and preserves optional members: %j", (worktreeNaming) => {
    expect(normalizeConfig({ ...baseConfig, worktreeNaming }).worktreeNaming).toEqual(
      worktreeNaming,
    );
  });

  test("preserves omission rather than serializing effective defaults", () => {
    expect(normalizeConfig(baseConfig)).not.toHaveProperty("worktreeNaming");
  });

  test.each([
    null,
    [],
    "default",
    { style: null },
    { style: "other" },
    { branchSlashes: 1 },
    { branchSlashes: "other" },
    { unknown: true },
  ])("rejects invalid worktreeNaming shape before use: %j", (worktreeNaming) => {
    expect(() => normalizeConfig({ ...baseConfig, worktreeNaming })).toThrow(ConfigValidationError);
  });
});
