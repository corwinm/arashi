import { afterEach, describe, expect, test } from "bun:test";
import { join } from "path";
import {
  createBareCreateWorkspace,
  type BareCreateWorkspace,
} from "../helpers/create-bare-create-workspace.ts";

let workspace: BareCreateWorkspace | null = null;
const CLI_ENTRY = join(import.meta.dir, "../../src/index.ts");

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

    const blockedPath = join(workspace.rootPath, branch);
    await Bun.write(blockedPath, "block worktree path");

    const proc = Bun.spawn(["bun", CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"], {
      cwd: workspace.bareRepoPath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const branchCheck = Bun.spawnSync(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: workspace.bareRepoPath,
      stdout: "ignore",
      stderr: "ignore",
    });

    expect(branchCheck.exitCode).not.toBe(0);
  });
});
