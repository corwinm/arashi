/**
 * Unit Tests: Status Command
 *
 * Tests for git status parsing, branch tracking parsing, and output formatting.
 */

import {
  checkRepoStatus,
  formatRepoSection,
  formatShortLine,
  formatVerboseOutput,
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

  test("refreshes tracked remote before parsing branch status", async () => {
    const callOrder: string[] = [];

    const status = await checkRepoStatus("repo-a", process.cwd(), {
      dependencies: {
        fetchRemoteTrackingTarget: async (_repoPath, target) => {
          callOrder.push(`fetch:${target.remote}/${target.branch}`);
          return { ok: true };
        },
        getFullGitStatus: async () => ({ error: null, output: "" }),
        getGitStatus: async () => {
          callOrder.push("status");
          return { error: null, output: "## main...origin/main [behind 2]" };
        },
        resolveRemoteTrackingTarget: async () => {
          callOrder.push("resolve");
          return {
            ok: true as const,
            target: {
              branch: "main",
              remote: "origin",
              upstream: "origin/main",
            },
          };
        },
      },
    });

    expect(callOrder).toEqual(["resolve", "fetch:origin/main", "status"]);
    expect(status.branch.behind).toBe(2);
    expect(status.error).toBeNull();
    expect(status.refreshWarning).toBeNull();
  });

  test("skips remote refresh when no tracking target can be resolved", async () => {
    let fetchCalled = false;

    const status = await checkRepoStatus("repo-a", process.cwd(), {
      dependencies: {
        fetchRemoteTrackingTarget: async () => {
          fetchCalled = true;
          return { ok: true };
        },
        getFullGitStatus: async () => ({ error: null, output: "" }),
        getGitStatus: async () => ({ error: null, output: "## main" }),
        resolveRemoteTrackingTarget: async () => ({
          error: "No remotes configured for repository",
          ok: false as const,
          upstream: null,
        }),
      },
    });

    expect(fetchCalled).toBe(false);
    expect(status.branch.localBranch).toBe("main");
    expect(status.error).toBeNull();
    expect(status.refreshWarning).toBeNull();
  });

  test("preserves local status when remote refresh fails", async () => {
    const status = await checkRepoStatus("repo-a", process.cwd(), {
      dependencies: {
        fetchRemoteTrackingTarget: async () => ({
          error: "Git command failed: authentication required",
          kind: "generic" as const,
          message: "Git command failed: authentication required",
          ok: false as const,
        }),
        getFullGitStatus: async () => ({ error: null, output: "" }),
        getGitStatus: async () => ({
          error: null,
          output: `## main...origin/main
 M src/file.ts`,
        }),
        resolveRemoteTrackingTarget: async () => ({
          ok: true as const,
          target: {
            branch: "main",
            remote: "origin",
            upstream: "origin/main",
          },
        }),
      },
    });

    expect(status.error).toBeNull();
    expect(status.files).toHaveLength(1);
    expect(status.refreshWarning).toMatchObject({
      kind: "stale-remote-tracking",
      message: expect.stringContaining("Remote tracking may be stale"),
    });
    expect(formatShortLine(status)).toContain("remote tracking stale");
  });

  test("preserves local status when resolved remote branch is missing", async () => {
    const status = await checkRepoStatus("repo-a", process.cwd(), {
      dependencies: {
        fetchRemoteTrackingTarget: async () => ({
          error: "Git command failed: fatal: couldn't find remote ref refs/heads/feature-123",
          kind: "missing-remote-ref" as const,
          message: "couldn't find remote ref refs/heads/feature-123",
          ok: false as const,
        }),
        getFullGitStatus: async () => ({ error: null, output: "On branch feature-123" }),
        getGitStatus: async () => ({
          error: null,
          output: `## feature-123...origin/feature-123
 M src/file.ts`,
        }),
        resolveRemoteTrackingTarget: async () => ({
          ok: true as const,
          target: {
            branch: "feature-123",
            remote: "origin",
            upstream: "origin/feature-123",
          },
        }),
      },
      verbose: true,
    });

    expect(status.error).toBeNull();
    expect(status.files).toHaveLength(1);
    expect(status.refreshWarning).toEqual({
      kind: "missing-remote-ref",
      message: "couldn't find remote ref refs/heads/feature-123",
    });
    expect(formatShortLine(status)).toContain("couldn't find remote ref refs/heads/feature-123");
  });
});

describe("status formatting", () => {
  test("renders missing remote branch inline on the branch line", () => {
    const section = formatRepoSection({
      branch: {
        ahead: 0,
        behind: 0,
        isDetached: false,
        localBranch: "feature-123",
        remoteBranch: "origin/feature-123",
      },
      error: null,
      files: [],
      name: "repo-a",
      path: "/tmp/repo-a",
      refreshWarning: {
        kind: "missing-remote-ref",
        message: "couldn't find remote ref refs/heads/feature-123",
      },
    });

    expect(section).toContain(
      "\u001B[33mBranch: feature-123 → couldn't find remote ref refs/heads/feature-123\u001B[0m",
    );
    expect(section).not.toContain("Remote tracking may be stale");
  });

  test("preserves generic stale remote-tracking warning in verbose output", () => {
    const output = formatVerboseOutput([
      {
        branch: {
          ahead: 0,
          behind: 0,
          isDetached: false,
          localBranch: "main",
          remoteBranch: "origin/main",
        },
        error: null,
        files: [],
        fullStatus: "On branch main",
        name: "repo-a",
        path: "/tmp/repo-a",
        refreshWarning: {
          kind: "stale-remote-tracking",
          message: "Remote tracking may be stale: Git command failed: authentication required",
        },
      },
    ]);

    expect(output).toContain(
      "Warning: Remote tracking may be stale: Git command failed: authentication required",
    );
    expect(output).toContain("Branch: \u001B[36mmain\u001B[0m → origin/main");
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
