import { afterEach, describe, expect, test } from "bun:test";
import { basename, join } from "path";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { createRepoSpecificHookInRepo } from "../helpers/hooks.ts";
import { existsSync } from "fs";
type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

let workspace: BareCreateWorkspace | null = null;
const CLI_ENTRY = join(import.meta.dir, "../../src/index.ts");

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("create command parity between non-bare and bare invocation", () => {
  test("creates equivalent worktree path from non-bare invocation", async () => {
    workspace = await createBareCreateWorkspace();
    const branch = "feature-non-bare-parity";
    const repoName = basename(workspace.worktreePath);

    createRepoSpecificHookInRepo(
      workspace.worktreePath,
      "post-create",
      repoName,
      `echo "parity" > "\${ARASHI_WORKTREE_PATH}/hook-parity.log"`,
    );

    const command = Bun.spawn(["bun", CLI_ENTRY, "create", branch, "--no-progress"], {
      cwd: workspace.worktreePath,
      stderr: "pipe",
      stdout: "pipe",
    });

    const exitCode = await command.exited;
    const stdout = await new Response(command.stdout).text();
    const stderr = await new Response(command.stderr).text();

    expect(exitCode).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain("Hook results:");

    const combinedOutput = `${stdout}\n${stderr}`;
    const escapedRepoName = repoName.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const match =
      combinedOutput.match(
        new RegExp(`Worktree locations:[\\s\\S]*?${escapedRepoName}:\\s+([^\\n]+)`),
      ) || combinedOutput.match(/worktree created at\s+(.+)/);
    expect(match).not.toBeNull();

    const expectedWorktreePath = match?.[1]?.trim() ?? "";
    expect(existsSync(expectedWorktreePath)).toBe(true);
    expect(existsSync(join(expectedWorktreePath, "hook-parity.log"))).toBe(true);
  });
});
