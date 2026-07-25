import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
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

  test("creates with stored tracked scope and no linked worktree without ignore-file writes", async () => {
    workspace = await createBareCreateWorkspace({ createLinkedWorktree: false });
    const branch = "feature-tracked-bare-worktree";
    for (const args of [
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      ["config", "--local", "arashi.ignoreScope", "tracked"],
    ]) {
      const git = runtime.spawnSync(["git", ...args], {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(git.exitCode).toBe(0);
    }

    const command = runtime.spawn(
      [process.execPath, CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    const worktreePath = join(workspace.bareRepoPath, ".arashi", "worktrees", branch);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(workspace.bareRepoPath, ".gitignore"))).toBe(false);
    expect(existsSync(join(worktreePath, ".gitignore"))).toBe(false);
  });

  test("creates the first worktree when the bare repository has no linked worktrees", async () => {
    workspace = await createBareCreateWorkspace({ createLinkedWorktree: false });
    const branch = "feature-first-bare-worktree";

    const command = runtime.spawn(
      [process.execPath, CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"],
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

    expect(existsSync(join(workspace.bareRepoPath, ".arashi", "worktrees", branch))).toBe(true);
    const localExclude = await readFile(join(workspace.bareRepoPath, "info", "exclude"), "utf8");
    expect(localExclude).toContain("/.arashi/worktrees/");
  });
});
