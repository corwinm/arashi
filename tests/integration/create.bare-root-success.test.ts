import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
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

describe("create command from bare root", () => {
  test("creates requested worktree successfully", async () => {
    workspace = await createBareCreateWorkspace();
    const branch = "feature-bare-success";

    const command = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"],
      {
        cwd: workspace.bareRepoPath,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const exitCode = await command.exited;
    const stderr = await new Response(command.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).toContain("worktree created");

    const expectedWorktreePath = join(workspace.rootPath, branch);
    expect(existsSync(expectedWorktreePath)).toBe(true);
  });
});
