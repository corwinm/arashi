import { afterEach, describe, expect, test } from "bun:test";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { createRepoSpecificHookInRepo } from "../helpers/hooks.ts";
import { join } from "path";
type ChildHookWorkspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;

const CLI_ENTRY = join(import.meta.dir, "../../src/index.ts");
let workspace: ChildHookWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

function extractHookOutcomeLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") && line.includes("->"))
    .toSorted();
}

describe("create command hook parity between root and child invocation", () => {
  test("emits equivalent hook outcomes from workspace root and child repository", async () => {
    workspace = await createChildHookWorkspace();

    for (const repoName of workspace.childRepoNames) {
      createRepoSpecificHookInRepo(
        workspace.hookRootPath,
        "post-create",
        repoName,
        'echo "${ARASHI_HOOK_NAME}" >> "${ARASHI_WORKTREE_PATH}/parity-hook.log"',
      );
    }

    const rootBranch = "feature-hook-parity-root";
    const childBranch = "feature-hook-parity-child";

    const rootRun = Bun.spawn(["bun", CLI_ENTRY, "create", rootBranch, "--no-progress"], {
      cwd: workspace.workspacePath,
      stderr: "pipe",
      stdout: "pipe",
    });

    const rootExitCode = await rootRun.exited;
    const rootOutput = `${await new Response(rootRun.stdout).text()}\n${await new Response(rootRun.stderr).text()}`;
    expect(rootExitCode).toBe(0);

    const childRun = Bun.spawn(["bun", CLI_ENTRY, "create", childBranch, "--no-progress"], {
      cwd: workspace.childInvocationPath,
      stderr: "pipe",
      stdout: "pipe",
    });

    const childExitCode = await childRun.exited;
    const childOutput = `${await new Response(childRun.stdout).text()}\n${await new Response(childRun.stderr).text()}`;
    expect(childExitCode).toBe(0);

    const rootOutcomeLines = extractHookOutcomeLines(rootOutput);
    const childOutcomeLines = extractHookOutcomeLines(childOutput);

    expect(rootOutcomeLines.length).toBeGreaterThan(0);
    expect(rootOutcomeLines).toEqual(childOutcomeLines);
  });
});
