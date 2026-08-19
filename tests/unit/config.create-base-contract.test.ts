import { describe, expect, test } from "vitest";
import { normalizeConfig } from "../../src/lib/config.ts";

const rawConfig = (overrides: Record<string, unknown> = {}) => ({
  repos: {},
  reposDir: "./repos",
  version: "1.0.0",
  ...overrides,
});

describe("configured base branch ownership", () => {
  test.each(["feature/integration", "origin/feature/integration", "", 42, false, null])(
    "rejects removed defaults.create.baseBranch value %# with migration guidance",
    (baseBranch) => {
      expect(() => normalizeConfig(rawConfig({ defaults: { create: { baseBranch } } }))).toThrow(
        /defaults\.create\.baseBranch.*removed.*root baseBranch/i,
      );
    },
  );

  test("accepts the canonical root baseBranch", () => {
    expect(
      normalizeConfig(rawConfig({ baseBranch: "origin/feature/integration" })).baseBranch,
    ).toBe("origin/feature/integration");
  });

  test.each(["vscode", "cursor", "kiro"] as const)(
    "rejects baseBranch in the %s editor-scoped create defaults",
    (host) => {
      expect(() =>
        normalizeConfig(
          rawConfig({
            defaults: { editors: { [host]: { create: { baseBranch: "feature/editor" } } } },
          }),
        ),
      ).toThrow(`defaults.editors.${host}.create.baseBranch: unknown property`);
    },
  );
});
