import { runtime } from "#test-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { existsSync } from "fs";
import { join } from "path";

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

describe("create command from bare root", () => {
  test("creates requested worktree successfully", async () => {
    workspace = await createBareCreateWorkspace();
    const branch = "feature-bare-success";

    const command = runtime.spawn(
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

    const exitCode = await command.exited;
    const stdout = await new Response(command.stdout).text();
    const stderr = await new Response(command.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`create failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(exitCode).toBe(0);

    const expectedWorktreePath = join(workspace.bareRepoPath, ".arashi", "worktrees", branch);
    expect(existsSync(expectedWorktreePath)).toBe(true);
  });
});
