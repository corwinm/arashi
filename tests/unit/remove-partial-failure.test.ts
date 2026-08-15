import { describe, expect, test } from "vitest";
import { formatStandaloneRemovePartialFailureHuman } from "../../src/commands/remove.ts";

describe("standalone remove partial failure diagnostics", () => {
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
