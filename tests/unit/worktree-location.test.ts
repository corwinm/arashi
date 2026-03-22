import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import {
  DEFAULT_WORKTREES_DIR,
  WorktreeLocationValidationError,
  isDefaultWorktreesDir,
  normalizeWorktreesDir,
  normalizeWorktreesDirWithDefault,
  resolveWorktreesBasePath,
} from "../../src/lib/worktree-location.ts";

describe("worktree location normalization", () => {
  test("normalizes supported variants", () => {
    expect(normalizeWorktreesDir("./")).toBe(".");
    expect(normalizeWorktreesDir("../")).toBe("..");
    expect(normalizeWorktreesDir(".arashi/worktrees/")).toBe(DEFAULT_WORKTREES_DIR);
  });

  test("uses default when omitted", () => {
    expect(normalizeWorktreesDirWithDefault()).toBe(DEFAULT_WORKTREES_DIR);
  });

  test("rejects absolute path", () => {
    expect(() => normalizeWorktreesDir("/tmp/worktrees")).toThrow(WorktreeLocationValidationError);
  });
});

describe("worktree location resolution", () => {
  test("resolves base path from workspace root", () => {
    const workspaceRoot = join("/tmp", "workspace");

    expect(resolveWorktreesBasePath(workspaceRoot, "../")).toBe(resolve(workspaceRoot, ".."));
    expect(resolveWorktreesBasePath(workspaceRoot, "./")).toBe(resolve(workspaceRoot));
    expect(resolveWorktreesBasePath(workspaceRoot, ".arashi/worktrees/")).toBe(
      resolve(workspaceRoot, DEFAULT_WORKTREES_DIR),
    );
  });

  test("detects default directory", () => {
    expect(isDefaultWorktreesDir(DEFAULT_WORKTREES_DIR)).toBe(true);
    expect(isDefaultWorktreesDir(".arashi/worktrees/")).toBe(true);
    expect(isDefaultWorktreesDir("../")).toBe(false);
  });
});
