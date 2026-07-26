import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const initDocs = readFileSync(join(import.meta.dirname, "../../docs/commands/init.md"), "utf8");
const configurationDocs = readFileSync(
  join(import.meta.dirname, "../../docs/configuration.md"),
  "utf8",
);

describe("init documentation contract", () => {
  test("documents repository-aware worktree defaults and bare ignore behavior", () => {
    expect(initDocs).toContain("Non-bare repositories default to `.arashi/worktrees`");
    expect(initDocs).toContain("bare repositories default to `..`");
    expect(initDocs).toContain("An explicit `--worktrees-dir` takes precedence");
    expect(initDocs).toContain("persisted as `worktreesDir` in `.arashi/config.json`");
    expect(initDocs).toContain("non-applicable to working-tree ignore rules");
    expect(initDocs).toContain("does not run `git check-ignore` or write ignore files");
  });

  test("configuration guidance limits automatic ignore rules to non-bare worktrees", () => {
    expect(configurationDocs).not.toContain(
      "Safe\nconfigured `reposDir` and `worktreesDir` paths default to repository-local Git excludes.",
    );
    expect(configurationDocs).toMatch(/In non-bare\s+worktrees/);
    expect(configurationDocs).toContain("Bare repository roots");
    expect(configurationDocs).toMatch(/non-applicable to\s+working-tree ignore rules/);
  });
});
