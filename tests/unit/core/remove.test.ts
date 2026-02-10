import { describe, test, expect } from "bun:test";
import { groupWorktreesByParent } from "../../../src/core/remove.ts";
import type { WorktreeEntry } from "../../../src/types/remove.ts";

describe("groupWorktreesByParent", () => {
  test("groups children under parentPath and leaves orphans ungrouped", () => {
    const parent: WorktreeEntry = {
      path: "/workspace/parent",
      branch: "main",
      repository: "root",
      isMain: false,
      status: "present",
      parentPath: null,
      childrenPaths: ["/workspace/parent/repos/repo-a"],
    };

    const child: WorktreeEntry = {
      path: "/workspace/parent/repos/repo-a",
      branch: "feature-a",
      repository: "repo-a",
      isMain: false,
      status: "present",
      parentPath: "/workspace/parent",
      childrenPaths: [],
    };

    const orphan: WorktreeEntry = {
      path: "/workspace/orphan",
      branch: "orphan-branch",
      repository: "repo-orphan",
      isMain: false,
      status: "present",
      parentPath: null,
      childrenPaths: [],
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
      path: "/workspace/ghost/repos/repo-a",
      branch: "feature-a",
      repository: "repo-a",
      isMain: false,
      status: "present",
      parentPath: "/workspace/ghost",
      childrenPaths: [],
    };

    const grouping = groupWorktreesByParent([child]);

    expect(grouping.groups).toHaveLength(0);
    expect(grouping.orphans).toHaveLength(1);
    expect(grouping.orphans[0].path).toBe(child.path);
  });
});
