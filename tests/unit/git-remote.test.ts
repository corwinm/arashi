import { runtime } from "../helpers/node-runtime.ts";
import {
  classifyRemoteTrackingFetchFailure,
  compareCurrentBranchToDefaultBranch,
  resolveDefaultBranchTarget,
} from "../../src/lib/git-remote.ts";
import { createTempDir, initBareGitRepo, removeTempDir } from "../helpers/git-test-utils";
import { describe, expect, test } from "vitest";
import { join } from "path";
import { writeFileSync } from "fs";

const textDecoder = new TextDecoder();

function runGit(cwd: string, args: string[]): string {
  const proc = runtime.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(textDecoder.decode(proc.stderr) || textDecoder.decode(proc.stdout));
  }

  return textDecoder.decode(proc.stdout).trim();
}

function initWorkingRepo(repoPath: string, branch = "main"): void {
  runGit(repoPath, ["init", "-b", branch]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Test User"]);
}

function writeCommit(
  repoPath: string,
  commit: { path: string; content: string; message: string },
): void {
  writeFileSync(join(repoPath, commit.path), commit.content);
  runGit(repoPath, ["add", commit.path]);
  runGit(repoPath, ["commit", "-m", commit.message]);
}

describe("classifyRemoteTrackingFetchFailure", () => {
  test("classifies missing remote refs and normalizes the message", () => {
    const result = classifyRemoteTrackingFetchFailure(
      "Git command failed: fatal: couldn't find remote ref refs/heads/feature-123",
      {
        branch: "feature-123",
        remote: "origin",
        upstream: "origin/feature-123",
      },
    );

    expect(result).toEqual({
      error: "Git command failed: fatal: couldn't find remote ref refs/heads/feature-123",
      kind: "missing-remote-ref",
      message: "couldn't find remote ref refs/heads/feature-123",
      ok: false,
    });
  });

  test("keeps generic fetch failures as generic warnings", () => {
    const result = classifyRemoteTrackingFetchFailure(
      "Git command failed: authentication required",
      {
        branch: "main",
        remote: "origin",
        upstream: "origin/main",
      },
    );

    expect(result).toEqual({
      error: "Git command failed: authentication required",
      kind: "generic",
      message: "Git command failed: authentication required",
      ok: false,
    });
  });
});

describe("resolveDefaultBranchTarget", () => {
  test("resolves a refreshable origin default branch target when a remote ref exists", async () => {
    const bareRepoPath = createTempDir();
    const seedPath = createTempDir();
    const cloneParent = createTempDir();
    const clonePath = join(cloneParent, "workspace-clone");

    try {
      initBareGitRepo(bareRepoPath);
      initWorkingRepo(seedPath);
      writeCommit(seedPath, {
        content: "# seed\n",
        message: "seed main",
        path: "README.md",
      });
      runGit(seedPath, ["remote", "add", "origin", bareRepoPath]);
      runGit(seedPath, ["push", "origin", "main"]);
      runGit(bareRepoPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      runGit(cloneParent, ["clone", bareRepoPath, clonePath]);

      const resolution = await resolveDefaultBranchTarget(clonePath);

      expect(resolution).toEqual({
        ok: true,
        target: {
          branch: "main",
          compareRef: "refs/remotes/origin/main",
          refreshTarget: {
            branch: "main",
            remote: "origin",
            upstream: "origin/main",
          },
        },
      });
    } finally {
      removeTempDir(cloneParent);
      removeTempDir(seedPath);
      removeTempDir(bareRepoPath);
    }
  });
});

describe("compareCurrentBranchToDefaultBranch", () => {
  test("returns behind-default counts after refreshing the remote default branch", async () => {
    const bareRepoPath = createTempDir();
    const seedPath = createTempDir();
    const cloneParent = createTempDir();
    const clonePath = join(cloneParent, "workspace-clone");

    try {
      initBareGitRepo(bareRepoPath);
      initWorkingRepo(seedPath);
      writeCommit(seedPath, {
        content: "# seed\n",
        message: "seed main",
        path: "README.md",
      });
      runGit(seedPath, ["remote", "add", "origin", bareRepoPath]);
      runGit(seedPath, ["push", "origin", "main"]);
      runGit(bareRepoPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      runGit(cloneParent, ["clone", bareRepoPath, clonePath]);
      runGit(clonePath, ["config", "user.email", "test@example.com"]);
      runGit(clonePath, ["config", "user.name", "Test User"]);
      runGit(clonePath, ["checkout", "-b", "feature/demo"]);
      writeCommit(seedPath, {
        content: "# seed\n\nnew line\n",
        message: "advance main",
        path: "README.md",
      });
      runGit(seedPath, ["push", "origin", "main"]);

      const result = await compareCurrentBranchToDefaultBranch(clonePath, "feature/demo");

      expect(result).toEqual({
        ahead: 0,
        behind: 1,
        branch: "main",
        state: "available",
      });
    } finally {
      removeTempDir(cloneParent);
      removeTempDir(seedPath);
      removeTempDir(bareRepoPath);
    }
  });

  test("falls back to comparing against the local default branch when no remote ref exists", async () => {
    const repoPath = createTempDir();

    try {
      initWorkingRepo(repoPath);
      writeCommit(repoPath, {
        content: "# local\n",
        message: "seed main",
        path: "README.md",
      });
      runGit(repoPath, ["checkout", "-b", "feature/demo"]);
      runGit(repoPath, ["checkout", "main"]);
      writeCommit(repoPath, {
        content: "# local\n\nmain only\n",
        message: "advance main",
        path: "README.md",
      });
      runGit(repoPath, ["checkout", "feature/demo"]);

      const result = await compareCurrentBranchToDefaultBranch(repoPath, "feature/demo");

      expect(result).toEqual({
        ahead: 0,
        behind: 1,
        branch: "main",
        state: "available",
      });
    } finally {
      removeTempDir(repoPath);
    }
  });

  test("skips comparison when the current branch is already the default branch", async () => {
    const repoPath = createTempDir();

    try {
      initWorkingRepo(repoPath);
      writeCommit(repoPath, {
        content: "# local\n",
        message: "seed main",
        path: "README.md",
      });

      const result = await compareCurrentBranchToDefaultBranch(repoPath, "main");

      expect(result).toEqual({
        branch: "main",
        reason: "on-default-branch",
        state: "skipped",
      });
    } finally {
      removeTempDir(repoPath);
    }
  });
});
