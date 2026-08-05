import { readFile } from "fs/promises";
import { join } from "path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFile(join(root, path), "utf8");

describe("canonical lifecycle-hook documentation", () => {
  test("documents timing, native discovery, timeout, outcomes, and compatibility", async () => {
    const hooks = await read("docs/hooks.md");
    expect(hooks).toContain("300000");
    expect(hooks).toContain("ARASHI_HOOK_EXECUTION_PATH");
    expect(hooks).toContain("ARASHI_HOOK_TARGET_WORKTREE_PATH");
    expect(hooks).toContain("ARASHI_REMOVE_TARGETS_JSON");
    expect(hooks).toMatch(/\.ps1.*\.cmd.*\.bat/s);
    expect(hooks).toMatch(/workspace `pre-create`.*before.*mutation/is);
    expect(hooks).toMatch(/repository-specific `pre-create\.<repo>`.*after.*materialized/is);
    expect(hooks).toMatch(/1\.x.*no earlier than 2\.0/is);
    expect(hooks).toContain(
      "`ARASHI_BRANCH` and `ARASHI_BASE_BRANCH` are not compatibility aliases",
    );
    expect(hooks).not.toMatch(/(?:use|read|set) `?ARASHI_(?:BRANCH|BASE_BRANCH)`?/i);
    expect(hooks).not.toContain("does not abort operation");
  });

  test("documents safe activation and configured timeout", async () => {
    const [init, configuration, readme] = await Promise.all([
      read("docs/commands/init.md"),
      read("docs/configuration.md"),
      read("README.md"),
    ]);
    expect(init).toContain("install -m 755");
    expect(init).toContain("setup.sh.example");
    expect(configuration).toMatch(/hooks[\s\S]*timeout[\s\S]*300000/);
    expect(readme).toContain("docs/hooks.md");
  });
});
