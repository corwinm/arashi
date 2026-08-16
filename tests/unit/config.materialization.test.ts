import { describe, expect, test } from "vitest";
import { ConfigValidationError, normalizeConfig, serializeConfig } from "../../src/lib/config.ts";

const workspace = (repository: Record<string, unknown>) => ({
  repos: { app: { path: "./repos/app", ...repository } },
  reposDir: "./repos",
  version: "1.0.0",
});

function validationErrors(repository: Record<string, unknown>): string[] {
  try {
    normalizeConfig(workspace(repository));
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as ConfigValidationError).context.errors;
  }
  throw new Error("Expected configuration validation to fail");
}

describe("repository worktree materialization configuration RED", () => {
  test("normalizes and persists direct copy and symlink arrays in declaration order", () => {
    const normalized = normalizeConfig(
      workspace({
        copy: ["./.env", String.raw`config\.\local.json`, "cafe\u0301/settings.json"],
        symlink: [".cache/sdk", ".turbo"],
      }),
    );

    expect(normalized.repos.app).toMatchObject({
      copy: [".env", "config/local.json", "caf\u00e9/settings.json"],
      path: "./repos/app",
      symlink: [".cache/sdk", ".turbo"],
    });
    expect(JSON.parse(serializeConfig(normalized)).repos.app).toEqual(normalized.repos.app);
  });

  test.each([
    ["copy", "not-an-array", "repos.app.copy: must be an array of non-empty strings if present"],
    ["symlink", ["ok", 42], "repos.app.symlink[1]: must be a non-empty string"],
  ] as const)("rejects invalid %s value shapes with entry context", (field, value, message) => {
    expect(validationErrors({ [field]: value })).toContain(message);
  });

  test.each([
    ["", "must not be empty after normalization"],
    [".", "must not be empty after normalization"],
    ["/absolute", "must be a relative path"],
    [String.raw`C:\absolute`, "must not be drive-qualified or absolute"],
    [String.raw`\\server\share`, "must not be a UNC or rooted path"],
    ["safe/../escape", "must not contain '..' segments"],
    ["name:stream", "must not contain ':'"],
    ["trailing./file", "components must not end in dot or space"],
    ["folder /file", "components must not end in dot or space"],
    ["aux.txt", "must not contain a Windows reserved device component"],
    ["nested/COM9/log", "must not contain a Windows reserved device component"],
    ["nul\u0000byte", "must not contain NUL"],
  ] as const)("rejects portable unsafe copy path %j", (path, reason) => {
    expect(validationErrors({ copy: [path] })).toContain(`repos.app.copy[0]: ${reason}`);
  });

  test.each([
    [["cache/data", String.raw`cache\.\data`], "copy", "duplicate normalized path"],
    [["Cafe\u0301/data", "CAF\u00c9/DATA"], "copy", "portable collision"],
    [["Σ/data", "ς/DATA"], "copy", "portable collision"],
    [["straße/cache", "STRASSE/CACHE"], "copy", "portable collision"],
  ] as const)("rejects same-mode normalized aliases", (paths, field, reason) => {
    expect(validationErrors({ [field]: paths })).toContain(`repos.app.${field}[1]: ${reason}`);
  });

  test("rejects cross-mode portable aliases instead of choosing declaration order", () => {
    expect(
      validationErrors({ copy: ["Cache/Data"], symlink: [String.raw`cache\.\data`] }),
    ).toContain(
      "repos.app.symlink[0]: portable collision with repos.app.copy[0] after normalization",
    );
  });
});
