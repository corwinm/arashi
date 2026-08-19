import { describe, expect, test } from "vitest";
import { ConfigValidationError, normalizeConfig, serializeConfig } from "../../src/lib/config.ts";

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

  test("rejects the reserved @meta child repository identifier", () => {
    expect(() =>
      normalizeConfig({
        ...minimal,
        repos: { "@meta": { path: "./repos/meta-child" } },
      }),
    ).toThrow(/repos\.@meta.*reserved/i);
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

  test("rejects the removed create-specific base branch and points to root baseBranch", () => {
    expect(() =>
      normalizeConfig({
        ...minimal,
        defaults: { create: { baseBranch: "integration" } },
        repos: {},
      }),
    ).toThrow(/defaults\.create\.baseBranch.*removed.*root baseBranch/i);
  });

  test("preserves the supported create launch and switch defaults", () => {
    expect(
      normalizeConfig({
        ...minimal,
        defaults: { create: { launch: "herdr", switch: true } },
        repos: {},
      }).defaults?.create,
    ).toEqual({ launch: "herdr", switch: true });
  });
});
