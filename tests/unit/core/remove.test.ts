import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { WorktreeEntry } from "../../../src/types/remove.ts";
import {
  canonicalPhysicalPath,
  groupWorktreesByParent,
  pathExistsFailClosed,
} from "../../../src/core/remove.ts";

const inspectMissingPath = () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};

const canonicalizeToParent = () => "/workspace/parent";

describe("pathExistsFailClosed", () => {
  test("returns false only for missing paths", () => {
    expect(pathExistsFailClosed("/missing", inspectMissingPath)).toBe(false);
  });

  test("preserves filesystem inspection failures", () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const inspect = () => {
      throw failure;
    };

    expect(() => pathExistsFailClosed("/blocked", inspect)).toThrow(/permission denied/);
  });
});

describe("canonicalPhysicalPath", () => {
  test("uses the resolved filesystem identity instead of an alias spelling", () => {
    expect(canonicalPhysicalPath("/workspace/parent/repos/repo-a", canonicalizeToParent)).toBe(
      canonicalPhysicalPath("/workspace/parent", canonicalizeToParent),
    );
  });

  test("collapses a symlink cycle to the ancestor identity", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "arashi-remove-cycle-"));
    const aliasParent = join(root, "repos");
    const alias = join(aliasParent, "repo-a");
    try {
      await mkdir(aliasParent);
      await symlink(root, alias, "dir");
      expect(canonicalPhysicalPath(alias)).toBe(canonicalPhysicalPath(root));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

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
