import { describe, expect, test } from "vitest";
import type { Repository } from "../../src/core/repository.ts";
import { calculateChildWorktreePath } from "../../src/core/worktree.ts";
import { join } from "path";

describe("calculateChildWorktreePath", () => {
  test("nests child repositories inside the parent worktree path", () => {
    const repo: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "child-repo",
      path: join("workspace-root", "meta-repo", "repos", "child-repo"),
    };

    expect(calculateChildWorktreePath(repo, "parent-feature", "repos")).toBe(
      join("workspace-root", "parent-feature", "repos", "child-repo"),
    );
  });

  test("supports custom repository directory names", () => {
    const repo: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "frontend",
      path: join("workspace-root", "meta-repo", "packages", "frontend"),
    };

    expect(calculateChildWorktreePath(repo, "mono-feature", "packages")).toBe(
      join("workspace-root", "mono-feature", "packages", "frontend"),
    );
  });
});
