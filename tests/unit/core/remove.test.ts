import { describe, expect, test } from "bun:test";
import type { WorktreeEntry } from "../../../src/types/remove.ts";
import { groupWorktreesByParent } from "../../../src/core/remove.ts";

describe("groupWorktreesByParent", () => {
  test("groups children under parentPath and leaves orphans ungrouped", () => {
    const parent: WorktreeEntry = {
      branch: "main",
      childrenPaths: ["/workspace/parent/repos/repo-a"],
      isMain: false,
      parentPath: null,
      path: "/workspace/parent",
      repository: "root",
      status: "present",
    };

    const child: WorktreeEntry = {
      branch: "feature-a",
      childrenPaths: [],
      isMain: false,
      parentPath: "/workspace/parent",
      path: "/workspace/parent/repos/repo-a",
      repository: "repo-a",
      status: "present",
    };

    const orphan: WorktreeEntry = {
      branch: "orphan-branch",
      childrenPaths: [],
      isMain: false,
      parentPath: null,
      path: "/workspace/orphan",
      repository: "repo-orphan",
      status: "present",
    };

    const grouping = groupWorktreesByParent([parent, child, orphan]);

    expect(grouping.groups).toHaveLength(1);
    expect(grouping.groups[0].parent.path).toBe(parent.path);
    expect(grouping.groups[0].children).toHaveLength(1);
    expect(grouping.groups[0].children[0].path).toBe(child.path);
    expect(grouping.orphans.map((entry) => entry.path)).toContain(orphan.path);
  });

  test("treats entries with missing parents as orphans", () => {
    const child: WorktreeEntry = {
      branch: "feature-a",
      childrenPaths: [],
      isMain: false,
      parentPath: "/workspace/ghost",
      path: "/workspace/ghost/repos/repo-a",
      repository: "repo-a",
      status: "present",
    };

    const grouping = groupWorktreesByParent([child]);

    expect(grouping.groups).toHaveLength(0);
    expect(grouping.orphans).toHaveLength(1);
    expect(grouping.orphans[0].path).toBe(child.path);
  });
});
