import { runtime, spawn } from "#test-runtime";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";
import { executeRemove } from "../../src/commands/remove.ts";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("remove command - lifecycle hooks", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;
  let homePath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a", "repo-b"]);
    originalHome = process.env.HOME;
    homePath = await mkdtemp(join(tmpdir(), "arashi-remove-home-"));
    process.env.HOME = homePath;
  });

  afterEach(async () => {
    await workspace.cleanup();
    await rm(homePath, { force: true, recursive: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
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
echo "pre:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-order.log"`,
    );

    await createWorkspaceHook(
      workspace.rootPath,
      "post-remove",
      `if [ -d "$ARASHI_WORKTREE_PATH" ]; then
  echo "worktree still exists after removal" >&2
  exit 12
fi
echo "post:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-order.log"`,
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
    const orderLog = (await runtime.file(orderLogPath).text()).trim();
    expect(orderLog).toBe("pre:repo-a\npre:repo-b\npost:repo-a\npost:repo-b");
  });

  test("runs scoped pre-remove hooks in repository -> workspace -> global order", async () => {
    if (process.platform === "win32") {
      return;
    }

    const branchName = "feature-remove-hooks-scope-order";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);
    const scopeLogPath = join(workspace.rootPath, ".arashi", "remove-hooks-scope-order.log");
    const repoAPath = workspace.repos.find((repo) => repo.name === "repo-a")?.path;
    expect(repoAPath).toBeTruthy();

    await createRepositoryHook(
      repoAPath as string,
      "pre-remove",
      `echo "repository:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-scope-order.log"`,
    );
    await createWorkspaceHook(
      workspace.rootPath,
      "pre-remove",
      `echo "workspace:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-scope-order.log"`,
    );
    await createGlobalHook(
      homePath,
      "pre-remove",
      `echo "global-repository:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-scope-order.log"`,
      "repo-a",
    );
    await createGlobalHook(
      homePath,
      "pre-remove",
      `echo "global-shared:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-scope-order.log"`,
    );

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);
    try {
      const exitCode = await executeRemove(worktrees["repo-a"], {
        force: true,
        keepBranches: true,
        path: true,
      });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const scopeLog = (await runtime.file(scopeLogPath).text()).trim();
    expect(scopeLog).toBe(
      "repository:repo-a\nworkspace:repo-a\nglobal-repository:repo-a\nglobal-shared:repo-a",
    );
  });

  test("runs repository-targeted global hook before shared global hook", async () => {
    if (process.platform === "win32") {
      return;
    }

    const branchName = "feature-remove-hooks-global-order";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);
    const globalLogPath = join(workspace.rootPath, ".arashi", "remove-hooks-global-order.log");

    await createGlobalHook(
      homePath,
      "pre-remove",
      `echo "targeted:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-global-order.log"`,
      "repo-a",
    );
    await createGlobalHook(
      homePath,
      "pre-remove",
      `echo "targeted-other:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-global-order.log"`,
      "repo-b",
    );
    await createGlobalHook(
      homePath,
      "pre-remove",
      `echo "shared:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-global-order.log"`,
    );

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);
    try {
      const exitCode = await executeRemove(worktrees["repo-a"], {
        force: true,
        keepBranches: true,
        path: true,
      });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const globalLog = (await runtime.file(globalLogPath).text()).trim();
    expect(globalLog).toBe("targeted:repo-a\nshared:repo-a");
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
      `echo "pre:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-partial.log"`,
    );
    await createWorkspaceHook(
      workspace.rootPath,
      "post-remove",
      `echo "post:$ARASHI_REPO_NAME" >> "$ARASHI_MAIN_REPO_PATH/.arashi/remove-hooks-partial.log"`,
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
    const orderLog = (await runtime.file(orderLogPath).text()).trim();
    expect(orderLog).toBe("pre:repo-a\npre:repo-b\npost:repo-a\npost:repo-b");
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

async function createRepositoryHook(
  repositoryPath: string,
  hookName: string,
  scriptBody: string,
): Promise<void> {
  const hooksDir = join(repositoryPath, ".arashi", "hooks");
  await mkdir(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, `${hookName}.sh`);
  await writeFile(hookPath, `#!/usr/bin/env bash\nset -e\n${scriptBody}\n`);
  if (process.platform !== "win32") {
    await chmod(hookPath, 0o755);
  }
}

async function createGlobalHook(
  ...args: [homeRoot: string, hookName: string, scriptBody: string, repositoryName?: string]
): Promise<void> {
  const [homeRoot, hookName, scriptBody, repositoryName] = args;
  const baseDir = repositoryName
    ? join(homeRoot, ".arashi", "hooks", repositoryName)
    : join(homeRoot, ".arashi", "hooks");
  await mkdir(baseDir, { recursive: true });

  const hookPath = join(baseDir, `${hookName}.sh`);
  await writeFile(hookPath, `#!/usr/bin/env bash\nset -e\n${scriptBody}\n`);
  if (process.platform !== "win32") {
    await chmod(hookPath, 0o755);
  }
}

async function gitBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const proc = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}
