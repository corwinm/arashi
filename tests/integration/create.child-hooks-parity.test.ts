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

function extractHookSummaryLine(output: string): string | undefined {
  return output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Hook results:"));
}

describe("create command hook parity between root and child invocation", () => {
  test("emits equivalent hook summaries from workspace root and child repository", async () => {
    workspace = await createChildHookWorkspace();

    for (const repoName of workspace.childRepoNames) {
      createRepoSpecificHookInRepo(
        workspace.hookRootPath,
        "post-create",
        repoName,
        `echo "\${ARASHI_HOOK_NAME}" >> "\${ARASHI_WORKTREE_PATH}/parity-hook.log"`,
      );
    }

    const rootBranch = "feature-hook-parity-root";
    const childBranch = "feature-hook-parity-child";

    const rootRun = runtime.spawn(
      [
        process.execPath,

        CLI_ENTRY,
        "create",
        rootBranch,
        "--no-progress",
      ],
      {
        cwd: workspace.workspacePath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const rootExitCode = await rootRun.exited;
    const rootOutput = `${await new Response(rootRun.stdout).text()}\n${await new Response(rootRun.stderr).text()}`;
    if (rootExitCode !== 0) {
      throw new Error(`root create failed (exit=${rootExitCode})\n${rootOutput}`);
    }
    expect(rootExitCode).toBe(0);

    const childRun = runtime.spawn(
      [
        process.execPath,

        CLI_ENTRY,
        "create",
        childBranch,
        "--no-progress",
      ],
      {
        cwd: workspace.childInvocationPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const childExitCode = await childRun.exited;
    const childOutput = `${await new Response(childRun.stdout).text()}\n${await new Response(childRun.stderr).text()}`;
    if (childExitCode !== 0) {
      throw new Error(`child create failed (exit=${childExitCode})\n${childOutput}`);
    }
    expect(childExitCode).toBe(0);

    const rootSummaryLine = extractHookSummaryLine(rootOutput);
    const childSummaryLine = extractHookSummaryLine(childOutput);

    expect(rootSummaryLine).toBe("Hook results: 2 succeeded, 4 skipped, 0 failed");
    expect(childSummaryLine).toBe(rootSummaryLine);
  });
});
