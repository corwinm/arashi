import {
  branchStateAfterShowRefExistsFailure,
  formatStandaloneRemovePartialFailureHuman,
  pathStateAfterInspectionFailure,
} from "../../src/commands/remove.ts";
import { describe, expect, test } from "vitest";
import { ArashiError } from "../../src/lib/errors.ts";

describe("standalone remove partial failure diagnostics", () => {
  test("distinguishes a missing branch from an uninspectable branch", () => {
    const missingRef = new ArashiError("missing ref", {
      args: ["show-ref", "--exists", "refs/heads/missing"],
      cwd: "/repo",
      exitCode: 2,
      stderr: "",
      stdout: "",
    });
    const corruptRef = new ArashiError("corrupt ref", {
      args: ["show-ref", "--exists", "refs/heads/corrupt"],
      cwd: "/repo",
      exitCode: 1,
      stderr: "error: failed to look up reference: Invalid argument",
      stdout: "",
    });
    const repositoryFailure = new ArashiError("not a repository", {
      args: ["show-ref", "--verify", "refs/heads/unknown"],
      cwd: "/repo",
      exitCode: 128,
      stderr: "fatal: not a git repository",
      stdout: "",
    });

    expect(branchStateAfterShowRefExistsFailure(missingRef)).toBe(false);
    expect(branchStateAfterShowRefExistsFailure(corruptRef)).toBeNull();
    expect(branchStateAfterShowRefExistsFailure(repositoryFailure)).toBeNull();
    expect(branchStateAfterShowRefExistsFailure(new Error("spawn failed"))).toBeNull();
  });

  test("distinguishes a missing worktree path from an uninspectable path", () => {
    expect(pathStateAfterInspectionFailure({ code: "ENOENT" })).toBe(false);
    expect(pathStateAfterInspectionFailure({ code: "EACCES" })).toBeNull();
    expect(pathStateAfterInspectionFailure(new Error("inspection failed"))).toBeNull();
  });

  test("reports an unknown worktree path state without claiming removal", () => {
    const output = formatStandaloneRemovePartialFailureHuman({
      finalState: { branchExists: false, worktreeExists: null },
      hookFailures: [],
      operationFailures: [{ message: "Permission denied", operation: "remove-worktree" }],
    });

    expect(output).toContain("Could not determine whether the worktree directory remains");
    expect(output).not.toContain("Worktree directory was removed");
    expect(output).not.toContain("Close terminals or editors");
  });

  test("explains a Windows directory left behind after Git cleanup", () => {
    const output = formatStandaloneRemovePartialFailureHuman({
      finalState: { branchExists: false, worktreeExists: true },
      hookFailures: [],
      operationFailures: [
        {
          message:
            "Git command failed: error: failed to delete 'C:/repo/.worktrees/cm/test': Permission denied",
          operation: "remove-worktree",
        },
      ],
    });

    expect(output).toContain("Standalone removal completed with incomplete cleanup");
    expect(output).toContain("Worktree directory remains");
    expect(output).toContain("Branch was deleted");
    expect(output).toContain(
      "remove-worktree: Git command failed: error: failed to delete 'C:/repo/.worktrees/cm/test': Permission denied",
    );
    expect(output).toContain("Close terminals or editors using the worktree directory");
    expect(output).toContain("If Git still lists the worktree, retry removal");
    expect(output).toContain("remove the leftover directory only after Git no longer lists it");
    expect(output).not.toContain("Unexpected error");
  });

  test("reports detached worktrees without claiming that a branch was deleted", () => {
    const output = formatStandaloneRemovePartialFailureHuman({
      finalState: { branchExists: null, worktreeExists: false },
      hookFailures: [{ hookName: "post-remove", message: "Hook exited with code 23" }],
      operationFailures: [],
    });

    expect(output).toContain("No branch was associated with this worktree");
    expect(output).not.toContain("Branch was deleted");
  });

  test("reports an associated branch as unknown when inspection fails", () => {
    const output = formatStandaloneRemovePartialFailureHuman(
      {
        finalState: { branchExists: null, worktreeExists: false },
        hookFailures: [{ hookName: "post-remove", message: "Hook exited with code 23" }],
        operationFailures: [],
      },
      "remove",
    );

    expect(output).toContain("Could not determine whether the branch still exists");
    expect(output).not.toContain("No branch was associated");
    expect(output).not.toContain("Branch was deleted");
  });

  test("does not claim deletion when an unborn branch never had a ref", () => {
    const output = formatStandaloneRemovePartialFailureHuman({
      finalState: { branchExists: false, worktreeExists: false },
      hookFailures: [],
      operationFailures: [
        { message: "error: branch 'unborn' not found", operation: "delete-branch" },
      ],
    });

    expect(output).toContain("Branch does not exist");
    expect(output).not.toContain("Branch was deleted");
  });

  test("does not claim deletion when an unborn branch was explicitly kept", () => {
    const output = formatStandaloneRemovePartialFailureHuman(
      {
        finalState: { branchExists: false, worktreeExists: false },
        hookFailures: [{ hookName: "post-remove", message: "Hook exited with code 23" }],
        operationFailures: [],
      },
      "keep",
    );

    expect(output).toContain("Branch does not exist");
    expect(output).not.toContain("Branch was deleted");
  });

  test("does not suggest deleting a deliberately kept worktree after a hook failure", () => {
    const output = formatStandaloneRemovePartialFailureHuman({
      finalState: { branchExists: false, worktreeExists: true },
      hookFailures: [{ hookName: "post-remove", message: "Hook exited with code 23" }],
      operationFailures: [],
    });

    expect(output).toContain("Worktree directory remains");
    expect(output).not.toContain("Close terminals or editors");
  });

  test("reports hook failures without suggesting directory cleanup when the path is gone", () => {
    const output = formatStandaloneRemovePartialFailureHuman({
      finalState: { branchExists: false, worktreeExists: false },
      hookFailures: [{ hookName: "post-remove", message: "Hook exited with code 23" }],
      operationFailures: [],
    });

    expect(output).toContain("post-remove: Hook exited with code 23");
    expect(output).toContain("Worktree directory was removed");
    expect(output).not.toContain("Close terminals or editors");
  });
});
