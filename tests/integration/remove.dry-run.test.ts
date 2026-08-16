import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { basename, join } from "path";
import { chmod, mkdir, writeFile } from "fs/promises";
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
  markWorktreeDirty,
} from "../helpers/remove-test-workspace.ts";
import { existsSync, realpathSync } from "fs";
import { executeRemove } from "../../src/commands/remove.ts";

describe("remove command - dry-run preview", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a", "repo-b"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test("previews branch removal without removing worktrees or deleting branches", async () => {
    const branchName = "feature-dry-run-preview";
    const worktrees = await createWorktreesForBranch(workspace, branchName, true);

    const result = await runRemoveInWorkspace(workspace.rootPath, branchName, { dryRun: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dry run preview");
    expect(result.stdout).toContain("Planned worktree removals");
    expect(result.stdout).toContain("Planned branch deletions");
    for (const path of Object.values(worktrees)) {
      expect(existsSync(path)).toBe(true);
    }
    for (const repoPath of [workspace.rootPath, ...workspace.repos.map((repo) => repo.path)]) {
      expect(await gitBranchExists(repoPath, branchName)).toBe(true);
    }
  });

  test("JSON dry-run emits a structured plan and keeps stdout machine-readable", async () => {
    const branchName = "feature-dry-run-json";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);
    await markWorktreeDirty(worktrees["repo-a"]);

    const result = await runRemoveInWorkspace(workspace.rootPath, branchName, {
      dryRun: true,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("remove");
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repository: "repo-a",
          status: "pending",
          type: "worktree_remove",
        }),
        expect.objectContaining({ repository: "repo-a", status: "pending", type: "branch_delete" }),
      ]),
    );
    expect(envelope.data.missingBranches).toEqual({
      [branchName]: [basename(workspace.rootPath)],
    });
    expect(envelope.data.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repository: "repo-a", type: "dirty_worktree" }),
      ]),
    );
    expect(result.stdout).not.toContain("Dry run preview");
    expect(existsSync(worktrees["repo-a"])).toBe(true);
    expect(await gitBranchExists(workspace.repos[0].path, branchName)).toBe(true);
  });

  test("path-targeted dry-run previews only the selected worktree", async () => {
    const branchName = "feature-dry-run-path-target";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);

    const result = await runRemoveInWorkspace(
      workspace.rootPath,
      realpathSync.native(worktrees["repo-a"]),
      {
        dryRun: true,
        json: true,
        path: true,
      },
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.operations).toEqual([
      expect.objectContaining({
        branchName,
        repository: "repo-a",
        status: "pending",
        type: "worktree_remove",
        worktreePath: expect.stringContaining("repo-a-feature-dry-run-path-target"),
      }),
      expect.objectContaining({
        branchName,
        repository: "repo-a",
        status: "pending",
        type: "branch_delete",
      }),
    ]);
    expect(existsSync(worktrees["repo-a"])).toBe(true);
    expect(existsSync(worktrees["repo-b"])).toBe(true);
    expect(await gitBranchExists(workspace.repos[0].path, branchName)).toBe(true);
  });

  test("keep flags shape dry-run plans without mutation", async () => {
    const branchName = "feature-dry-run-keep-flags";
    const worktrees = await createWorktreesForBranch(workspace, branchName, false);

    const keepWorktrees = await runRemoveInWorkspace(workspace.rootPath, branchName, {
      dryRun: true,
      json: true,
      keepWorktrees: true,
    });
    const keepWorktreesEnvelope = JSON.parse(keepWorktrees.stdout);
    expect(keepWorktreesEnvelope.data.operations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "worktree_remove" })]),
    );
    expect(keepWorktreesEnvelope.data.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "branch_delete" })]),
    );

    const keepBranches = await runRemoveInWorkspace(workspace.rootPath, branchName, {
      dryRun: true,
      json: true,
      keepBranches: true,
    });
    const keepBranchesEnvelope = JSON.parse(keepBranches.stdout);
    expect(keepBranchesEnvelope.data.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "worktree_remove" })]),
    );
    expect(keepBranchesEnvelope.data.operations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "branch_delete" })]),
    );

    const noOp = await runRemoveInWorkspace(workspace.rootPath, branchName, {
      dryRun: true,
      json: true,
      keepBranches: true,
      keepWorktrees: true,
    });
    const noOpEnvelope = JSON.parse(noOp.stdout);
    expect(noOpEnvelope.data.operations).toEqual([]);
    expect(noOpEnvelope.data.summary.totalBranches).toBe(0);
    expect(noOpEnvelope.data.summary.totalWorktrees).toBe(0);

    for (const path of Object.values(worktrees)) {
      expect(existsSync(path)).toBe(true);
    }
    expect(await gitBranchExists(workspace.repos[0].path, branchName)).toBe(true);
  });

  test("previews configured remove hooks without executing them", async () => {
    if (process.platform === "win32") {
      return;
    }

    const branchName = "feature-dry-run-hooks";
    await createWorktreesForBranch(workspace, branchName, false);
    const markerPath = join(workspace.rootPath, ".arashi", "dry-run-hook-ran.log");
    await createWorkspaceHook(
      workspace.rootPath,
      "pre-remove",
      `echo "hook-ran" > "$ARASHI_MAIN_REPO_PATH/.arashi/dry-run-hook-ran.log"`,
    );

    const result = await runRemoveInWorkspace(workspace.rootPath, branchName, {
      dryRun: true,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.data.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookName: "pre-remove",
          repository: "repo-a",
          scope: "workspace",
          selectedInterpreter: null,
          sourceKind: "file",
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
        }),
      ]),
    );
    const human = await runRemoveInWorkspace(workspace.rootPath, branchName, { dryRun: true });
    expect(human.stdout).toContain(
      `sourceKind=file sourceOwnerKind=workspace sourceOwnerName=null target=repo-a filePath=${join(realpathSync(workspace.rootPath), ".arashi", "hooks", "pre-remove.sh")}`,
    );
    expect(existsSync(markerPath)).toBe(false);
  });
});

async function runRemoveInWorkspace(
  workspaceRoot: string,
  branchName: string,
  options: Parameters<typeof executeRemove>[1],
): Promise<{ exitCode: number; stdout: string }> {
  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  let stdout = "";
  process.chdir(workspaceRoot);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };

  try {
    const exitCode = await executeRemove(branchName, options);
    return { exitCode, stdout };
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
  }
}

async function gitBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  const proc = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
  return (await proc.exited) === 0;
}

async function createWorkspaceHook(
  workspaceRoot: string,
  hookName: "pre-remove" | "post-remove",
  body: string,
): Promise<void> {
  const hooksDir = join(workspaceRoot, ".arashi", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, `${hookName}.sh`);
  await writeFile(hookPath, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  await chmod(hookPath, 0o755);
}
import { spawn } from "../helpers/node-runtime.ts";
