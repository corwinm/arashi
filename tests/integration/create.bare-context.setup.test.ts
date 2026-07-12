import { runtime } from "#test-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

let workspace: BareCreateWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("bare create integration harness", () => {
  test("creates reusable bare + worktree fixture", async () => {
    workspace = await createBareCreateWorkspace();

    const bareCheck = runtime.spawnSync(["git", "rev-parse", "--is-bare-repository"], {
      cwd: workspace.bareRepoPath,
    });
    const bareValue = new TextDecoder().decode(bareCheck.stdout).trim();

    const worktreeCheck = runtime.spawnSync(["git", "rev-parse", "--is-bare-repository"], {
      cwd: workspace.worktreePath,
    });
    const worktreeValue = new TextDecoder().decode(worktreeCheck.stdout).trim();

    expect(bareValue).toBe("true");
    expect(worktreeValue).toBe("false");
  });
});
