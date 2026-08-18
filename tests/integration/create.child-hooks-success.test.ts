import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync, realpathSync } from "fs";
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

describe("create command child-repo hook success flows", () => {
  test("runs configured repo hooks when invoked from managed child repository", async () => {
    workspace = await createChildHookWorkspace();
    const branch = "feature-child-hooks-success";

    for (const repoName of workspace.childRepoNames) {
      createRepoSpecificHookInRepo(
        workspace.hookRootPath,
        "pre-create",
        repoName,
        `echo "\${ARASHI_REPO_NAME}:\${ARASHI_HOOK_NAME}" >> "\${ARASHI_WORKTREE_PATH}/hook-events.log"`,
      );
      createRepoSpecificHookInRepo(
        workspace.hookRootPath,
        "post-create",
        repoName,
        `echo "\${ARASHI_REPO_NAME}:\${ARASHI_HOOK_NAME}" >> "\${ARASHI_WORKTREE_PATH}/hook-events.log"`,
      );
    }

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

    if (exitCode !== 0) {
      throw new Error(`create failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(exitCode).toBe(0);
    const output = `${stdout}\n${stderr}`;
    expect(output).toContain("Hook results: 4 succeeded, 2 skipped, 0 failed");
    expect(output).not.toContain("pre-create.alpha [alpha]");
    expect(output).not.toContain(`${workspace.hookRootPath}/.arashi/hooks/post-create.alpha.sh`);

    for (const repoName of workspace.childRepoNames) {
      const childWorktreePath = workspace.getChildWorktreePath(repoName, branch);
      const markerPath = join(childWorktreePath, "hook-events.log");

      expect(existsSync(childWorktreePath)).toBe(true);
      expect(existsSync(markerPath)).toBe(true);

      const markerContent = readFileSync(markerPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);

      expect(markerContent).toEqual([
        `${repoName}:pre-create.${repoName}`,
        `${repoName}:post-create.${repoName}`,
      ]);
    }
  });

  test("normalizes nested child-directory invocation to workspace root hook context", async () => {
    workspace = await createChildHookWorkspace();
    const branch = "feature-child-hooks-nested";

    for (const repoName of workspace.childRepoNames) {
      createRepoSpecificHookInRepo(
        workspace.hookRootPath,
        "post-create",
        repoName,
        `echo "\${ARASHI_MAIN_REPO_PATH}" > "\${ARASHI_WORKTREE_PATH}/hook-main-path.log"`,
      );
    }

    const proc = runtime.spawn(
      [
        process.execPath,

        CLI_ENTRY,
        "create",
        branch,
        "--no-progress",
      ],
      {
        cwd: workspace.nestedChildInvocationPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`create failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(exitCode).toBe(0);

    for (const repoName of workspace.childRepoNames) {
      const childWorktreePath = workspace.getChildWorktreePath(repoName, branch);
      const recordedMainPath = readFileSync(
        join(childWorktreePath, "hook-main-path.log"),
        "utf8",
      ).trim();

      expect(realpathSync(recordedMainPath)).toBe(realpathSync(workspace.workspacePath));
      expect(`${stdout}\n${stderr}`).toContain(repoName);
    }
  });
});
