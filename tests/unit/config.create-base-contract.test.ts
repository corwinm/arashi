import { describe, expect, test } from "vitest";
import { normalizeConfig } from "../../src/lib/config.ts";

const rawConfig = (defaults?: Record<string, unknown>) => ({
  ...(defaults === undefined ? {} : { defaults }),
  repos: {},
  reposDir: "./repos",
  version: "1.0.0",
});

describe("configurable create base branch", () => {
  test("accepts a generic defaults.create.baseBranch", () => {
    expect(
      normalizeConfig(rawConfig({ create: { baseBranch: "feature/integration" } })).defaults
        ?.create,
    ).toEqual({ baseBranch: "feature/integration" });
  });

  test.each(["", "   ", 42, false, null])("rejects invalid generic baseBranch %#", (baseBranch) => {
    expect(() => normalizeConfig(rawConfig({ create: { baseBranch } }))).toThrow(
      "defaults.create.baseBranch: must be a valid Git branch name",
    );
  });

  test.each([
    "feature branch",
    "-feature",
    "/feature",
    "feature/",
    "feature.",
    ".feature",
    "feature.lock",
    "feature.lock/child",
    "feature..child",
    "feature@{child",
    "feature//child",
    "feature\u0000child",
    "feature\u001Fchild",
    String.raw`feature\child`,
    "feature~child",
    "feature^child",
    "feature:child",
    "feature?child",
    "feature*child",
    "feature[child",
    "HEAD",
    "origin/HEAD",
    "origin/-feature",
  ])("rejects Git-invalid generic baseBranch %j", (baseBranch) => {
    expect(() => normalizeConfig(rawConfig({ create: { baseBranch } }))).toThrow(
      "defaults.create.baseBranch: must be a valid Git branch name",
    );
  });

  test("validates one origin prefix logically while preserving the configured value", () => {
    expect(
      normalizeConfig(rawConfig({ create: { baseBranch: "origin/feature/integration" } })).defaults
        ?.create?.baseBranch,
    ).toBe("origin/feature/integration");
  });

  test.each(["vscode", "cursor", "kiro"] as const)(
    "rejects baseBranch in the %s editor-scoped create defaults",
    (host) => {
      expect(() =>
        normalizeConfig(
          rawConfig({ editors: { [host]: { create: { baseBranch: "feature/editor" } } } }),
        ),
      ).toThrow(`defaults.editors.${host}.create.baseBranch: unknown property`);
    },
  );
});
