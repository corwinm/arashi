import { describe, expect, test } from "vitest";
import { win32 } from "path";
import {
  createConfiguredWorktreeRemovalPlan,
  isDescendantWorktreePath,
} from "../../../src/core/remove.ts";
import type { WorktreeEntry } from "../../../src/types/remove.ts";

describe("configured worktree removal plan", () => {
  test("closes transitively over mixed branches and orders every descendant first", () => {
    const parent = entry("meta", "/workspace/feature", "parent");
    const child = entry("child", "/workspace/feature/repos/child", "mixed-child");
    const grandchild = entry(
      "grandchild",
      "/workspace/feature/repos/child/repos/grandchild",
      "deep-child",
    );
    const unrelated = entry("other", "/workspace/other", "other");

    const plan = createConfiguredWorktreeRemovalPlan(
      [parent],
      [parent, child, grandchild, unrelated],
    );

    expect(plan.worktrees).toEqual([grandchild, child, parent]);
  });

  test("preserves discovery order for unrelated and sibling-prefix paths", () => {
    const first = entry("first", "/workspace/feature-a", "first");
    const siblingPrefix = entry("second", "/workspace/feature-ab", "second");
    const unrelated = entry("third", "/workspace/other", "third");

    const plan = createConfiguredWorktreeRemovalPlan(
      [first, siblingPrefix, unrelated],
      [first, siblingPrefix, unrelated],
    );

    expect(plan.worktrees).toEqual([first, siblingPrefix, unrelated]);
  });

  test("keeps an earlier selected ancestor group ahead of a later unrelated target", () => {
    const parent = entry("meta", "/workspace/feature", "parent");
    const unrelated = entry("other", "/workspace/unrelated", "unrelated");
    const child = entry("child", "/workspace/feature/repos/child", "child");

    const plan = createConfiguredWorktreeRemovalPlan(
      [parent, unrelated],
      [parent, unrelated, child],
    );

    expect(plan.worktrees).toEqual([child, parent, unrelated]);
  });

  test("uses Windows separators and case-insensitive path-component ancestry", () => {
    const semantics = {
      caseSensitive: false,
      isAbsolute: win32.isAbsolute,
      relative: win32.relative,
      resolve: win32.resolve,
      sep: win32.sep,
    };

    expect(
      isDescendantWorktreePath(
        "C:\\Workspace\\Feature",
        "c:\\workspace\\feature\\repos\\child",
        semantics,
      ),
    ).toBe(true);
    expect(
      isDescendantWorktreePath("C:\\Workspace\\Feature", "C:\\Workspace\\Feature-Other", semantics),
    ).toBe(false);
    expect(
      isDescendantWorktreePath(
        "C:\\Workspace\\Feature",
        "D:\\Workspace\\Feature\\child",
        semantics,
      ),
    ).toBe(false);
  });
});

function entry(repository: string, path: string, branch: string): WorktreeEntry {
  return {
    branch,
    childrenPaths: [],
    isMain: false,
    parentPath: null,
    path,
    repository,
    status: "present",
  };
}
