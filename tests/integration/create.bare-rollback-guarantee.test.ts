import { runtime } from "#test-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { join } from "path";
import { mkdir } from "node:fs/promises";
type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

let workspace: BareCreateWorkspace | null = null;
const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("create rollback guarantees in bare context", () => {
  test("removes partially created branch when worktree creation fails", async () => {
    workspace = await createBareCreateWorkspace();
    const branch = "feature-bare-rollback";

    const blockedPath = join(workspace.bareRepoPath, ".arashi", "worktrees", branch);
    await mkdir(join(workspace.bareRepoPath, ".arashi", "worktrees"), { recursive: true });
    await runtime.write(blockedPath, "block worktree path");

    const proc = runtime.spawn(
      [
        process.execPath,
        "--no-warnings",
        "--experimental-transform-types",

        CLI_ENTRY,
        "create",
        branch,
        "--no-hooks",
        "--no-progress",
      ],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const branchCheck = runtime.spawnSync(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: workspace.bareRepoPath,
      stderr: "ignore",
      stdout: "ignore",
    });

    expect(branchCheck.exitCode).not.toBe(0);
  });
});
