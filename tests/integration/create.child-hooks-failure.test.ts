import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { createRepoSpecificHookInRepo } from "../helpers/hooks.ts";
import { join } from "path";
type ChildHookWorkspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
let workspace: ChildHookWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("create command child-repo hook failure reporting", () => {
  test("reports failing repo-specific hook with repository-level status", async () => {
    workspace = await createChildHookWorkspace();
    const branch = "feature-child-hooks-failure";
    const [failingRepo] = workspace.childRepoNames;

    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "post-create",
      failingRepo,
      `echo "forced failure for \${ARASHI_REPO_NAME}" >&2
exit 19`,
    );

    const proc = runtime.spawn(
      [
        process.execPath,

        CLI_ENTRY,
        "create",
        branch,
        "--no-progress",
      ],
      {
        cwd: workspace.childInvocationPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("Hook results:");
    expect(output).toContain(
      `file repository:${failingRepo} pre-create.${failingRepo} [${failingRepo}] -> skipped (not_found)`,
    );
    expect(output).toContain(
      `file repository:${failingRepo} post-create.${failingRepo} [${failingRepo}] -> failure (exit_non_zero)`,
    );
    expect(output).toContain("Next steps:");
    expect(output).toContain(`Inspect hook output for ${failingRepo}`);
  });

  test("reports timeout and skipped hook statuses with actionable guidance", async () => {
    workspace = await createChildHookWorkspace({ hookTimeoutMs: 100 });
    const branch = "feature-child-hooks-timeout";
    const [timeoutRepo] = workspace.childRepoNames;

    createRepoSpecificHookInRepo(workspace.hookRootPath, "post-create", timeoutRepo, "sleep 1");

    const proc = runtime.spawn(
      [
        process.execPath,

        CLI_ENTRY,
        "create",
        branch,
        "--no-progress",
      ],
      {
        cwd: workspace.childInvocationPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain(
      `file repository:${timeoutRepo} pre-create.${timeoutRepo} [${timeoutRepo}] -> skipped (not_found)`,
    );
    expect(output).toContain(
      `file repository:${timeoutRepo} post-create.${timeoutRepo} [${timeoutRepo}] -> failure (timeout)`,
    );
    expect(output).toContain("timed out");
    expect(output).toContain("Next steps:");
  });
});
