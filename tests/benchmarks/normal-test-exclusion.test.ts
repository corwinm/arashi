import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("benchmark execution policy", () => {
  test("keeps benchmarks opt-in from the normal test runner", async () => {
    const runner = await readFile(resolve(repositoryRoot, "scripts/test/run-tests.ts"), "utf8");
    expect(runner).toContain('join(workspaceRoot, "tests", "unit")');
    expect(runner).toContain('join(workspaceRoot, "tests", "integration")');
    expect(runner).not.toContain('join(workspaceRoot, "tests", "benchmarks")');
  });

  test("provides one contributor command and an informational artifact-only workflow", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const documentation = await readFile(
      resolve(repositoryRoot, "docs", "performance-benchmarks.md"),
      "utf8",
    );
    const workflow = await readFile(
      resolve(repositoryRoot, ".github", "workflows", "benchmarks.yml"),
      "utf8",
    );

    expect(packageJson.scripts.benchmark).toBe(
      "node --experimental-strip-types scripts/benchmark/orchestrate.ts",
    );
    expect(packageJson.scripts["benchmark:test"]).toContain("tests/benchmarks");
    expect(documentation).toContain("pnpm benchmark");
    expect(documentation).toContain("benchmark-core");
    expect(documentation).toContain("completion-repository");
    expect(documentation).toContain("completion-group");
    expect(documentation).toContain("completion-worktree");
    expect(documentation).toContain("aw status --local --json");
    expect(documentation).toContain("status-local-verbose");
    expect(documentation).not.toContain("checkAllRepos-without-fetch");
    expect(documentation).toContain("same tracked-remote fixture");
    expect(documentation).toContain("SHA-256");
    expect(documentation).toContain("compiler provenance unavailable");
    expect(documentation).toContain("Git-heavy CLI");
    expect(documentation).toContain("bounded retries");
    expect(documentation).toContain("No wall-clock threshold");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("actions/upload-artifact");
    expect(workflow).not.toContain("pull_request:");
  });
});
