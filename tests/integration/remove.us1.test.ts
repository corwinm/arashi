/**
 * Integration test: User Story 1 - remove single branch
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { spawn } from "bun";
import { executeRemove } from "../../src/commands/remove.ts";
import {
  createNestedWorktrees,
  createRemoveWorkspace,
  createWorktreesForBranch,
} from "../helpers/remove-test-workspace.ts";

describe("remove command - US1 single branch", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a", "repo-b"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test("removes worktrees and deletes branches across repositories", async () => {
    const branchName = "feature-us1";
    const worktrees = await createWorktreesForBranch(workspace, branchName, true);

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(branchName, { force: true });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    for (const path of Object.values(worktrees)) {
      expect(existsSync(path)).toBe(false);
    }

    const reposToCheck = [workspace.rootPath, ...workspace.repos.map((r) => r.path)];
    for (const repoPath of reposToCheck) {
      const proc = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
        cwd: repoPath,
        stderr: "ignore",
        stdout: "ignore",
      });
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
    }
  });

  test("groups mixed-branch children under their parent worktree", async () => {
    const parentBranch = "parent-main";
    const childBranches = {
      "repo-a": "child-a",
      "repo-b": "child-b",
    };
    const { parentPath, childPaths } = await createNestedWorktrees(
      workspace,
      parentBranch,
      childBranches,
    );

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    let observedChoices: { value: string; name: string }[] = [];

    try {
      const exitCode = await executeRemove(
        undefined,
        { force: false },
        {
          confirm: async () => ({ status: "ok", value: true }),
          multiSelect: async (_message, choices) => {
            observedChoices = choices.map((choice) => ({ value: choice.value, name: choice.name }));
            return { status: "ok", value: [] };
          },
        },
      );
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const childChoice = observedChoices.find((choice) => choice.value === childPaths["repo-a"]);
    expect(childChoice).toBeUndefined();

    const parentChoice =
      observedChoices.find((choice) => choice.value === parentPath) ??
      observedChoices.find((choice) => choice.name.includes("repo-a=child-a"));
    expect(parentChoice?.name).toContain("repo-a=child-a");
    expect(parentChoice?.name).toContain("repo-b=child-b");
  });
});
