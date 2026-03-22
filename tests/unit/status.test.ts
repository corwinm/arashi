/**
 * Unit Tests: Status Command
 *
 * Tests for git status parsing, branch tracking parsing, and output formatting.
 */

import {
  checkRepoStatus,
  formatShortLine,
  parseBranchLine,
  parseGitStatus,
} from "../../src/commands/status.ts";
import { describe, expect, test } from "bun:test";

describe("parseGitStatus", () => {
  test("parses clean repository output", () => {
    const output = "## main...origin/main";
    const result = parseGitStatus(output);

    expect(result.files).toHaveLength(0);
    expect(result.branch.localBranch).toBe("main");
    expect(result.branch.remoteBranch).toBe("origin/main");
    expect(result.branch.ahead).toBe(0);
    expect(result.branch.behind).toBe(0);
    expect(result.branch.isDetached).toBe(false);
  });

  test("parses dirty repository with modified files", () => {
    const output = `## main
 M src/file.ts
M  staged-file.ts`;
    const result = parseGitStatus(output);

    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe("src/file.ts");
    expect(result.files[0].stagingStatus).toBe(" ");
    expect(result.files[0].workingStatus).toBe("M");
    expect(result.files[1].path).toBe("staged-file.ts");
    expect(result.files[1].stagingStatus).toBe("M");
    expect(result.files[1].workingStatus).toBe(" ");
  });

  test("parses untracked files", () => {
    const output = `## main
?? test.txt
?? newfile.md`;
    const result = parseGitStatus(output);

    expect(result.files).toHaveLength(2);
    expect(result.files[0].workingStatus).toBe("?");
    expect(result.files[0].path).toBe("test.txt");
    expect(result.files[1].workingStatus).toBe("?");
    expect(result.files[1].path).toBe("newfile.md");
  });

  test("parses multiple file types", () => {
    const output = `## feature-branch
M  staged.ts
 M modified.ts
A  added.ts
 D deleted.ts
?? untracked.txt`;
    const result = parseGitStatus(output);

    expect(result.files).toHaveLength(5);
    expect(result.files[0].stagingStatus).toBe("M"); // Staged modified
    expect(result.files[1].workingStatus).toBe("M"); // Unstaged modified
    expect(result.files[2].stagingStatus).toBe("A"); // Added
    expect(result.files[3].workingStatus).toBe("D"); // Deleted
    expect(result.files[4].workingStatus).toBe("?"); // Untracked
  });
});

describe("parseBranchLine", () => {
  test("parses branch with no remote", () => {
    const branch = parseBranchLine("## feature-branch");

    expect(branch.localBranch).toBe("feature-branch");
    expect(branch.remoteBranch).toBeNull();
    expect(branch.ahead).toBe(0);
    expect(branch.behind).toBe(0);
    expect(branch.isDetached).toBe(false);
  });

  test("parses branch with remote tracking", () => {
    const branch = parseBranchLine("## main...origin/main");

    expect(branch.localBranch).toBe("main");
    expect(branch.remoteBranch).toBe("origin/main");
    expect(branch.ahead).toBe(0);
    expect(branch.behind).toBe(0);
    expect(branch.isDetached).toBe(false);
  });

  test("parses ahead commits", () => {
    const branch = parseBranchLine("## main...origin/main [ahead 2]");

    expect(branch.localBranch).toBe("main");
    expect(branch.remoteBranch).toBe("origin/main");
    expect(branch.ahead).toBe(2);
    expect(branch.behind).toBe(0);
    expect(branch.isDetached).toBe(false);
  });

  test("parses behind commits", () => {
    const branch = parseBranchLine("## main...origin/main [behind 3]");

    expect(branch.ahead).toBe(0);
    expect(branch.behind).toBe(3);
  });

  test("parses ahead and behind (diverged)", () => {
    const branch = parseBranchLine("## main...origin/main [ahead 2, behind 1]");

    expect(branch.localBranch).toBe("main");
    expect(branch.remoteBranch).toBe("origin/main");
    expect(branch.ahead).toBe(2);
    expect(branch.behind).toBe(1);
    expect(branch.isDetached).toBe(false);
  });

  test("parses detached HEAD state", () => {
    const branch = parseBranchLine("## HEAD (no branch)");

    expect(branch.localBranch).toBe("");
    expect(branch.remoteBranch).toBeNull();
    expect(branch.ahead).toBe(0);
    expect(branch.behind).toBe(0);
    expect(branch.isDetached).toBe(true);
  });

  test("parses detached HEAD at commit", () => {
    const branch = parseBranchLine("## HEAD (detached at abc1234)");

    expect(branch.isDetached).toBe(true);
    expect(branch.localBranch).toBe("");
  });
});

describe("checkRepoStatus", () => {
  test("returns clone guidance when repository path is missing", async () => {
    const status = await checkRepoStatus("missing-repo", "/path/that/does/not/exist");

    expect(status.error).toContain("arashi clone");
    expect(status.files).toHaveLength(0);
  });
});

describe("formatShortLine", () => {
  test("includes clone guidance for missing repositories", () => {
    const line = formatShortLine({
      branch: {
        ahead: 0,
        behind: 0,
        isDetached: false,
        localBranch: "",
        remoteBranch: null,
      },
      error:
        "Repository is missing at /tmp/repo-a. Run `arashi clone` to clone missing repositories.",
      files: [],
      name: "repo-a",
      path: "/tmp/repo-a",
    });

    expect(line).toContain("arashi clone");
  });
});
