import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "bun";
import { executeRemove } from "../../src/commands/remove.ts";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";

describe("remove command - lifecycle hooks", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a", "repo-b"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test("runs pre-remove before removal and post-remove after removal", async () => {
    if (process.platform === "win32") {
      return;
    }

    const branchName = "feature-remove-hooks-order";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);
    const orderLogPath = join(workspace.rootPath, ".arashi", "remove-hooks-order.log");

    await createWorkspaceHook(
      workspace.rootPath,
      "pre-remove",
      `if [ ! -d "$ARASHI_WORKTREE_PATH" ]; then
  echo "worktree missing before removal" >&2
  exit 11
fi
echo "pre" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-order.log"`,
    );

    await createWorkspaceHook(
      workspace.rootPath,
      "post-remove",
      `if [ -d "$ARASHI_WORKTREE_PATH" ]; then
  echo "worktree still exists after removal" >&2
  exit 12
fi
echo "post" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-order.log"`,
    );

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);
    try {
      const exitCode = await executeRemove(branchName, { force: true });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    expect(existsSync(worktrees["repo-a"])).toBe(false);
    const orderLog = (await Bun.file(orderLogPath).text()).trim();
    expect(orderLog).toBe("pre\npost");
  });

  test("aborts removal when pre-remove fails", async () => {
    if (process.platform === "win32") {
      return;
    }

    const branchName = "feature-remove-hooks-pre-fail";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);
    const preMarkerPath = join(workspace.rootPath, ".arashi", "pre-remove-ran.log");
    const postMarkerPath = join(workspace.rootPath, ".arashi", "post-remove-ran.log");

    await createWorkspaceHook(
      workspace.rootPath,
      "pre-remove",
      `echo "pre-ran" > "$ARASHI_MAIN_REPO_PATH/.arashi/pre-remove-ran.log"
exit 5`,
    );
    await createWorkspaceHook(
      workspace.rootPath,
      "post-remove",
      `echo "post-ran" > "$ARASHI_MAIN_REPO_PATH/.arashi/post-remove-ran.log"`,
    );

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);
    let exitCode = 0;
    try {
      exitCode = await executeRemove(branchName, { force: true });
    } finally {
      process.chdir(originalCwd);
    }

    expect(exitCode).toBe(1);
    expect(existsSync(worktrees["repo-a"])).toBe(true);
    expect(existsSync(preMarkerPath)).toBe(true);
    expect(existsSync(postMarkerPath)).toBe(false);
    expect(await gitBranchExists(workspace.repos[0].path, branchName)).toBe(true);
  });

  test("runs post-remove even when remove operations partially fail", async () => {
    if (process.platform === "win32") {
      return;
    }

    const branchName = "feature-remove-hooks-post-on-failure";
    const orderLogPath = join(workspace.rootPath, ".arashi", "remove-hooks-partial.log");

    await createWorkspaceHook(
      workspace.rootPath,
      "pre-remove",
      `echo "pre" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-partial.log"`,
    );
    await createWorkspaceHook(
      workspace.rootPath,
      "post-remove",
      `echo "post" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-partial.log"`,
    );

    await spawn(["git", "branch", branchName], { cwd: workspace.repos[0].path }).exited;
    await spawn(["git", "branch", branchName], { cwd: workspace.repos[1].path }).exited;
    await spawn(["git", "checkout", branchName], { cwd: workspace.repos[0].path }).exited;

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);
    let exitCode = 0;
    try {
      exitCode = await executeRemove(branchName, { force: true, keepWorktrees: true });
    } finally {
      process.chdir(originalCwd);
    }

    expect(exitCode).toBe(1);
    expect(await gitBranchExists(workspace.repos[0].path, branchName)).toBe(true);
    expect(await gitBranchExists(workspace.repos[1].path, branchName)).toBe(false);
    const orderLog = (await Bun.file(orderLogPath).text()).trim();
    expect(orderLog).toBe("pre\npost");
  });

  test("skips missing pre-remove hook and fails command when post-remove fails", async () => {
    if (process.platform === "win32") {
      return;
    }

    const branchName = "feature-remove-hooks-post-fail";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);

    await createWorkspaceHook(
      workspace.rootPath,
      "post-remove",
      `echo "post-failed" > "$ARASHI_MAIN_REPO_PATH/.arashi/post-remove-failed.log"
exit 9`,
    );

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);
    let exitCode = 0;
    try {
      exitCode = await executeRemove(branchName, { force: true });
    } finally {
      process.chdir(originalCwd);
    }

    expect(exitCode).toBe(1);
    expect(existsSync(worktrees["repo-a"])).toBe(false);
    expect(await gitBranchExists(workspace.repos[0].path, branchName)).toBe(false);
  });
});

async function createWorkspaceHook(
  workspaceRoot: string,
  hookName: string,
  scriptBody: string,
): Promise<void> {
  const hooksDir = join(workspaceRoot, ".arashi", "hooks");
  await mkdir(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, `${hookName}.sh`);
  await writeFile(hookPath, `#!/usr/bin/env bash\nset -e\n${scriptBody}\n`);
  if (process.platform !== "win32") {
    await chmod(hookPath, 0o755);
  }
}

async function gitBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const proc = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: repoPath,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}
