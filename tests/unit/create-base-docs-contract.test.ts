import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const readRepositoryDoc = (path: string): string =>
  readFileSync(join(import.meta.dirname, "../..", path), "utf8");

const configuration = readRepositoryDoc("docs/configuration.md");

describe("create base repository documentation contract", () => {
  test("exposes shared and repeatable repository base options", () => {
    expect(configuration).toContain(
      "Create and clone also accept a one-off `--base <branch>` and repeatable",
    );
    expect(configuration).toContain("`--repo-base <selector=branch>` overrides");
    expect(configuration).toContain("Create accepts the explicit `@meta` selector");
  });

  test("documents canonical shared configuration, precedence, migration, and standalone scope", () => {
    expect(configuration).toContain('"baseBranch": "main"');
    expect(configuration).toContain("`meta.baseBranch`");
    expect(configuration).toContain("`repos.<name>.baseBranch`");
    expect(configuration).toContain(
      "repository CLI → invocation CLI → repository config → workspace config",
    );
    expect(configuration).toContain("`defaults.create.baseBranch` is unsupported");
    expect(configuration).toContain("before repository discovery, hooks, network");
    expect(configuration).toContain("`status`, `pull`, no-upstream `push` comparison");
    expect(configuration).toMatch(/Standalone create accepts only invocation-level\s+`--base`/);
  });
});
