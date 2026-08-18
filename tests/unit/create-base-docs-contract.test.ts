import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const readRepositoryDoc = (path: string): string =>
  readFileSync(join(import.meta.dirname, "../..", path), "utf8");

const readme = readRepositoryDoc("README.md");
const configuration = readRepositoryDoc("docs/configuration.md");

describe("create base repository documentation contract", () => {
  test("exposes shared and repeatable repository base options", () => {
    expect(readme).toContain(
      "aw clone [--all] [--base <branch>] [--repo-base <repository=branch>]",
    );
    expect(readme).toContain(
      "aw create <branch> [--base <branch>] [--repo-base <repository=branch>]",
    );
    expect(readme).toContain("aw create feature-auth-refresh --repo-base @meta=develop");
    expect(readme).toContain("aw create feature-auth-refresh --base feature/auth");
  });

  test("documents canonical shared configuration, precedence, migration, and standalone scope", () => {
    expect(configuration).toContain('"baseBranch": "main"');
    expect(configuration).toContain("`meta.baseBranch`");
    expect(configuration).toContain("`repos.<name>.baseBranch`");
    expect(configuration).toContain(
      "repository CLI → invocation CLI → repository config → workspace config",
    );
    expect(configuration).toContain("deprecated create-only compatibility input");
    expect(configuration).toContain("clone never reads `defaults.create.baseBranch`");
    expect(configuration).toMatch(
      /Standalone create accepts only the\s+invocation-level\s+`--base`/,
    );
  });
});
