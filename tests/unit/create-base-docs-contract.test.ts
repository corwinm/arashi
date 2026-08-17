import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const readRepositoryDoc = (path: string): string =>
  readFileSync(join(import.meta.dirname, "../..", path), "utf8");

const readme = readRepositoryDoc("README.md");
const configuration = readRepositoryDoc("docs/configuration.md");

describe("create base repository documentation contract", () => {
  test("exposes the one-off base option in the command surface and example", () => {
    expect(readme).toContain("aw create <branch> [--base <branch>]");
    expect(readme).toContain("aw create feature-auth-refresh --base feature/auth");
  });

  test("documents generic configuration, precedence, normalization, and standalone scope", () => {
    expect(configuration).toContain('"baseBranch": "feature/auth"');
    expect(configuration).toContain("`--base` → `defaults.create.baseBranch` → legacy behavior");
    expect(configuration).toContain("removes at most one leading `origin/`");
    expect(configuration).toContain("Standalone create accepts only the invocation-level `--base`");
  });
});
