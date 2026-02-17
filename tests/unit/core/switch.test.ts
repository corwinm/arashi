import { describe, test, expect } from "bun:test";
import {
  buildSwitchCandidates,
  filterSwitchCandidates,
  selectSwitchCandidate,
  type SwitchCandidate,
} from "../../../src/core/switch.ts";
import type { WorktreeInfo } from "../../../src/types/remove.ts";
import { SwitchCommandErrorCode } from "../../../src/types/switch.ts";

describe("buildSwitchCandidates", () => {
  test("normalizes valid entries and skips invalid worktrees", () => {
    const worktrees: WorktreeInfo[] = [
      {
        path: "/tmp/workspace-feature",
        branch: "feature/auth",
        repository: "workspace",
        isMain: false,
      },
      {
        path: "/tmp/workspace-main",
        branch: "",
        repository: "workspace",
        isMain: true,
      },
      {
        path: "",
        branch: "main",
        repository: "repo-a",
        isMain: false,
      },
    ];

    const result = buildSwitchCandidates(worktrees);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual({
      branchName: "feature/auth",
      worktreePath: "/tmp/workspace-feature",
      repoName: "workspace",
    });
    expect(result.skippedCount).toBe(2);
  });
});

describe("filterSwitchCandidates", () => {
  const candidates: SwitchCandidate[] = [
    {
      branchName: "feature/auth-refresh",
      worktreePath: "/workspace/feature-auth-refresh",
      repoName: "workspace",
    },
    {
      branchName: "bugfix/login",
      worktreePath: "/workspace/bugfix-login",
      repoName: "workspace",
    },
  ];

  test("matches on branch names", () => {
    const filtered = filterSwitchCandidates(candidates, "auth");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].branchName).toBe("feature/auth-refresh");
  });

  test("matches on worktree paths case-insensitively", () => {
    const filtered = filterSwitchCandidates(candidates, "BUGFIX-LOGIN");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].branchName).toBe("bugfix/login");
  });
});

describe("selectSwitchCandidate", () => {
  const first: SwitchCandidate = {
    branchName: "feature/a",
    worktreePath: "/workspace/feature-a",
    repoName: "workspace",
  };

  const second: SwitchCandidate = {
    branchName: "feature/b",
    worktreePath: "/workspace/feature-b",
    repoName: "workspace",
  };

  test("auto-selects when one candidate remains", async () => {
    const selected = await selectSwitchCandidate([first], { interactive: false });
    expect(selected).toEqual(first);
  });

  test("prompts in interactive mode when multiple candidates remain", async () => {
    const seenChoiceNames: string[] = [];
    const selected = await selectSwitchCandidate(
      [first, second],
      { interactive: true },
      {
        selectPrompt: async (_message, choices) => {
          seenChoiceNames.push(...choices.map((choice) => choice.name));
          return {
            status: "ok",
            value: choices[1].value,
          };
        },
      },
    );

    expect(seenChoiceNames).toEqual(["feature/a", "feature/b"]);
    expect(selected).toEqual(second);
  });

  test("shows repo prefix when candidates span multiple repositories", async () => {
    const crossRepoCandidates: SwitchCandidate[] = [
      {
        branchName: "feature/a",
        worktreePath: "/workspace/repo-a-feature-a",
        repoName: "repo-a",
      },
      {
        branchName: "feature/a",
        worktreePath: "/workspace/repo-b-feature-a",
        repoName: "repo-b",
      },
    ];
    const seenChoiceNames: string[] = [];

    await selectSwitchCandidate(
      crossRepoCandidates,
      { interactive: true },
      {
        selectPrompt: async (_message, choices) => {
          seenChoiceNames.push(...choices.map((choice) => choice.name));
          return {
            status: "ok",
            value: choices[0].value,
          };
        },
      },
    );

    expect(seenChoiceNames).toEqual(["repo-a (feature/a)", "repo-b (feature/a)"]);
  });

  test("omits workspace repo prefix in mixed-repository prompts", async () => {
    const mixedCandidates: SwitchCandidate[] = [
      {
        branchName: "main",
        worktreePath: "/workspace",
        repoName: "workspace",
      },
      {
        branchName: "feature/a",
        worktreePath: "/workspace-feature-a",
        repoName: "workspace",
      },
      {
        branchName: "feature/a",
        worktreePath: "/workspace/repos/docs",
        repoName: "docs",
      },
    ];
    const seenChoiceNames: string[] = [];

    await selectSwitchCandidate(
      mixedCandidates,
      { interactive: true, workspaceRepoName: "workspace" },
      {
        selectPrompt: async (_message, choices) => {
          seenChoiceNames.push(...choices.map((choice) => choice.name));
          return {
            status: "ok",
            value: choices[0].value,
          };
        },
      },
    );

    expect(seenChoiceNames).toEqual(["feature/a", "main", "docs (feature/a)"]);
  });

  test("throws on ambiguous non-interactive selection", async () => {
    await expect(
      selectSwitchCandidate([first, second], { interactive: false }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.AMBIGUOUS_NON_INTERACTIVE,
    });
  });

  test("throws on empty candidate set", async () => {
    await expect(selectSwitchCandidate([], { interactive: true })).rejects.toMatchObject({
      code: SwitchCommandErrorCode.NO_TARGETS,
    });
  });
});
