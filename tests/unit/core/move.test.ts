import { describe, expect, test } from "bun:test";
import {
  MovePlanningError,
  buildDirtyGuidance,
  buildMovePlan,
  emptyDirtyDetails,
  type WorkspaceSelection,
} from "../../../src/core/move.ts";

const dirtyDetails = {
  deletedFiles: 0,
  modifiedFiles: 1,
  stagedFiles: 0,
  summary: "1 modified",
  totalFiles: 1,
  untrackedFiles: 0,
};

const workspace = (overrides: Partial<WorkspaceSelection>): WorkspaceSelection => ({
  branch: "main",
  dirtyRepositories: [],
  label: "main",
  primaryPath: "/workspace/main",
  ref: "main",
  repositories: [],
  ...overrides,
});

describe("move planning", () => {
  test("plans compatible dirty repositories and skips clean repositories", () => {
    const source = workspace({
      dirtyRepositories: [
        {
          branch: "main",
          dirty: true,
          dirtyDetails,
          isMain: true,
          path: "/workspace/main",
          repositoryName: "meta",
        },
      ],
      repositories: [
        {
          branch: "main",
          dirty: true,
          dirtyDetails,
          isMain: true,
          path: "/workspace/main",
          repositoryName: "meta",
        },
        {
          branch: "main",
          dirty: false,
          dirtyDetails: emptyDirtyDetails(),
          isMain: false,
          path: "/workspace/main/repos/child",
          repositoryName: "child",
        },
      ],
    });
    const target = workspace({
      branch: "feature",
      label: "feature",
      primaryPath: "/workspace/.arashi/worktrees/meta-feature",
      ref: "feature",
      repositories: [
        {
          branch: "feature",
          dirty: false,
          dirtyDetails: emptyDirtyDetails(),
          isMain: false,
          path: "/workspace/.arashi/worktrees/meta-feature",
          repositoryName: "meta",
        },
        {
          branch: "feature",
          dirty: false,
          dirtyDetails: emptyDirtyDetails(),
          isMain: false,
          path: "/workspace/.arashi/worktrees/meta-feature/repos/child",
          repositoryName: "child",
        },
      ],
    });

    const plan = buildMovePlan(source, target);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      repositoryName: "meta",
      sourcePath: "/workspace/main",
      targetPath: "/workspace/.arashi/worktrees/meta-feature",
    });
    expect(plan.skipped).toEqual([
      expect.objectContaining({ repositoryName: "child", status: "skipped" }),
    ]);
  });

  test("blocks moving into dirty target repositories", () => {
    const source = workspace({
      repositories: [
        {
          branch: "main",
          dirty: true,
          dirtyDetails,
          isMain: true,
          path: "/workspace/main",
          repositoryName: "meta",
        },
      ],
    });
    const target = workspace({
      branch: "feature",
      label: "feature",
      primaryPath: "/workspace/feature",
      repositories: [
        {
          branch: "feature",
          dirty: true,
          dirtyDetails,
          isMain: false,
          path: "/workspace/feature",
          repositoryName: "meta",
        },
      ],
    });

    expect(() => buildMovePlan(source, target)).toThrow(MovePlanningError);
  });

  test("builds structured dirty guidance for create JSON output", () => {
    const source = workspace({
      dirtyRepositories: [
        {
          branch: "main",
          dirty: true,
          dirtyDetails,
          isMain: true,
          path: "/workspace/main",
          repositoryName: "meta",
        },
      ],
      repositories: [
        {
          branch: "main",
          dirty: true,
          dirtyDetails,
          isMain: true,
          path: "/workspace/main",
          repositoryName: "meta",
        },
      ],
    });
    const target = workspace({
      branch: "feature",
      label: "feature",
      primaryPath: "/workspace/feature",
      repositories: [
        {
          branch: "feature",
          dirty: false,
          dirtyDetails: emptyDirtyDetails(),
          isMain: false,
          path: "/workspace/feature",
          repositoryName: "meta",
        },
      ],
    });

    expect(buildDirtyGuidance(source, target)).toEqual({
      changedRepositories: [
        {
          path: "/workspace/main",
          repositoryName: "meta",
          summary: "1 modified",
        },
      ],
      command: "arashi move --to feature",
      target: "feature",
    });
  });
});
