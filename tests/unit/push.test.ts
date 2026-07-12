import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import type { PushResult } from "../../src/lib/push-types.ts";
import type { WorkspaceRepository } from "../../src/lib/config.ts";
import { buildPushSummary } from "../../src/lib/push-output.ts";
import { execFile } from "child_process";
import { join } from "path";
import { planPush } from "../../src/lib/push-runner.ts";
import { promisify } from "util";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function initRepo(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "main"]);
  await git(path, ["config", "user.email", "test@example.com"]);
  await git(path, ["config", "user.name", "Test User"]);
  await writeFile(join(path, "README.md"), "initial\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "initial"]);
}

async function addOrigin(repoPath: string, tempDir: string) {
  const remotePath = join(tempDir, "origin.git");
  await git(tempDir, ["init", "--bare", "origin.git"]);
  await git(repoPath, ["remote", "add", "origin", remotePath]);
  await git(repoPath, ["push", "--set-upstream", "origin", "main"]);
}

describe("push planning", () => {
  let tempDir: string | undefined;

  async function makeRepo(): Promise<{ path: string; repo: WorkspaceRepository }> {
    tempDir = await mkdtemp(join(tmpdir(), "arashi-push-unit-"));
    const repoPath = join(tempDir, "repo");
    await initRepo(repoPath);
    return { path: repoPath, repo: { name: "repo", path: repoPath } };
  }

  test("skips repositories on the default branch", async () => {
    const { path, repo } = await makeRepo();
    await addOrigin(path, tempDir!);

    const result = await planPush(repo, { dryRun: false, setUpstream: false });

    expect(result.result.status).toBe("skipped");
    expect(result.result.reason).toContain("no publishable commits");
  });

  test("requires upstream setup for new local branches unless requested", async () => {
    const { path, repo } = await makeRepo();
    await addOrigin(path, tempDir!);
    await git(path, ["checkout", "-b", "feature/push"]);
    await writeFile(join(path, "feature.txt"), "feature\n");
    await git(path, ["add", "feature.txt"]);
    await git(path, ["commit", "-m", "feature"]);

    const result = await planPush(repo, { dryRun: false, setUpstream: false });

    expect(result.result.status).toBe("skipped");
    expect(result.result.reason).toContain("no upstream");
    expect(result.result.upstreamSet).toBeUndefined();
  });

  test("plans a dry-run push with upstream setup", async () => {
    const { path, repo } = await makeRepo();
    await addOrigin(path, tempDir!);
    await git(path, ["checkout", "-b", "feature/push"]);
    await writeFile(join(path, "feature.txt"), "feature\n");
    await git(path, ["add", "feature.txt"]);
    await git(path, ["commit", "-m", "feature"]);

    const result = await planPush(repo, { dryRun: true, setUpstream: true });

    expect(result.result.status).toBe("planned");
    expect(result.result.command).toEqual([
      "git",
      "push",
      "--set-upstream",
      "origin",
      "feature/push",
    ]);
    expect(result.result.upstreamSet).toBe(true);
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { force: true, recursive: true });
      tempDir = undefined;
    }
  });
});

describe("push summary", () => {
  test("counts pushed, planned, skipped, and failed results", () => {
    const results: PushResult[] = [
      {
        branch: "feature",
        elapsedSeconds: 0.1,
        remote: "origin",
        repositoryId: "main",
        status: "pushed",
        upstreamSet: true,
      },
      {
        branch: "feature",
        elapsedSeconds: 0,
        remote: "origin",
        repositoryId: "docs",
        status: "planned",
        upstreamSet: false,
      },
      {
        branch: "main",
        elapsedSeconds: 0,
        reason: "default-branch",
        repositoryId: "skills",
        status: "skipped",
      },
      {
        branch: "feature",
        elapsedSeconds: 0,
        errorMessage: "rejected",
        remote: "origin",
        repositoryId: "cli",
        status: "failed",
        upstreamSet: false,
      },
    ];

    const summary = buildPushSummary(results, { dryRun: true, only: ["main"], setUpstream: true });

    expect(summary.totals).toEqual({ failed: 1, planned: 1, pushed: 1, skipped: 1, total: 4 });
    expect(summary.options).toEqual({ dryRun: true, only: ["main"], setUpstream: true });
    expect(summary.overallStatus).toBe("failure");
  });
});
