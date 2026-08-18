import { describe, expect, test } from "vitest";
import {
  ConfigValidationError,
  normalizeConfig,
  normalizeConfigWithDiagnostics,
  serializeConfig,
} from "../../src/lib/config.ts";

const minimal = {
  reposDir: "./repos",
  version: "1.0.0",
};

describe("base branch configuration", () => {
  test("normalizes root, meta, and child base branches", () => {
    expect(
      normalizeConfig({
        ...minimal,
        baseBranch: "main",
        meta: { baseBranch: "meta/integration" },
        repos: {
          api: { baseBranch: "api/integration", path: "./repos/api" },
        },
      }),
    ).toMatchObject({
      baseBranch: "main",
      meta: { baseBranch: "meta/integration" },
      repos: { api: { baseBranch: "api/integration", path: "./repos/api" } },
    });
  });

  test("persists root, meta, and child base branches during config rewrites", () => {
    const serialized = JSON.parse(
      serializeConfig(
        normalizeConfig({
          ...minimal,
          baseBranch: "main",
          meta: { baseBranch: "meta/integration" },
          repos: {
            api: { baseBranch: "api/integration", path: "./repos/api" },
          },
        }),
      ),
    );

    expect(serialized).toMatchObject({
      baseBranch: "main",
      meta: { baseBranch: "meta/integration" },
      repos: { api: { baseBranch: "api/integration", path: "./repos/api" } },
    });
  });

  test.each([
    ["baseBranch", { baseBranch: "bad branch", repos: {} }],
    ["meta.baseBranch", { meta: { baseBranch: "" }, repos: {} }],
    ["repos.api.baseBranch", { repos: { api: { baseBranch: 7, path: "./repos/api" } } }],
    ["meta.extra", { meta: { extra: true }, repos: {} }],
    ["repos.api.extra", { repos: { api: { extra: true, path: "./repos/api" } } }],
  ])("reports the exact invalid path %s", (path, value) => {
    expect(() => normalizeConfig({ ...minimal, ...value })).toThrowError(ConfigValidationError);
    try {
      normalizeConfig({ ...minimal, ...value });
    } catch (error) {
      expect(
        (error as ConfigValidationError).context.errors.some((item) => item.startsWith(path)),
      ).toBe(true);
    }
  });

  test("keeps the legacy create key and emits one actionable migration diagnostic", () => {
    const result = normalizeConfigWithDiagnostics({
      ...minimal,
      defaults: { create: { baseBranch: "integration" } },
      repos: {},
    });
    expect(result.config.defaults?.create?.baseBranch).toBe("integration");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "DEPRECATED_CREATE_BASE_BRANCH",
        fields: ["defaults.create.baseBranch"],
        replacementPath: "baseBranch",
      }),
    ]);
  });

  test("rejects conflicting canonical and legacy values but accepts matching values", () => {
    expect(() =>
      normalizeConfig({
        ...minimal,
        baseBranch: "main",
        defaults: { create: { baseBranch: "develop" } },
        repos: {},
      }),
    ).toThrow(/baseBranch.*defaults\.create\.baseBranch/);

    const matching = normalizeConfigWithDiagnostics({
      ...minimal,
      baseBranch: "main",
      defaults: { create: { baseBranch: "main" } },
      repos: {},
    });
    expect(matching.config.baseBranch).toBe("main");
    expect(
      matching.diagnostics.filter((item) => item.code === "DEPRECATED_CREATE_BASE_BRANCH"),
    ).toHaveLength(1);
  });

  test("compares canonical and legacy values after logical branch normalization", () => {
    const matching = normalizeConfigWithDiagnostics({
      ...minimal,
      baseBranch: "origin/main",
      defaults: { create: { baseBranch: "main" } },
      repos: {},
    });

    expect(matching.config.baseBranch).toBe("origin/main");
    expect(matching.config.defaults?.create?.baseBranch).toBe("main");
    expect(
      matching.diagnostics.filter((item) => item.code === "DEPRECATED_CREATE_BASE_BRANCH"),
    ).toHaveLength(1);
  });
});
