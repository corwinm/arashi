import { describe, expect, test } from "vitest";
import {
  isValidGitBranchNameLiteral,
  isValidRequestedBaseBranch,
  normalizeLogicalBranchName,
} from "../../src/lib/git-branch-name.ts";

describe("Git branch name validation scopes", () => {
  test("validates ordinary target names literally", () => {
    expect(isValidGitBranchNameLiteral("HEAD")).toBe(false);
    expect(isValidGitBranchNameLiteral("-feature")).toBe(false);
    expect(isValidGitBranchNameLiteral("origin/HEAD")).toBe(true);
    expect(isValidGitBranchNameLiteral("origin/-feature")).toBe(true);
  });

  test("normalizes exactly one origin prefix for requested bases", () => {
    expect(normalizeLogicalBranchName("origin/feature/base")).toBe("feature/base");
    expect(normalizeLogicalBranchName("origin/origin/feature/base")).toBe("origin/feature/base");
    expect(isValidRequestedBaseBranch("origin/feature/base")).toBe(true);
    expect(isValidRequestedBaseBranch("origin/HEAD")).toBe(false);
    expect(isValidRequestedBaseBranch("origin/-feature")).toBe(false);
  });
});
