import { expect, test } from "vitest";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/lib/git.ts";
import { checkRepoStatus } from "../../src/commands/status.ts";
import {
  compareCurrentBranchToDefaultBranch,
  fetchRemoteTrackingTarget,
  resolveDefaultBranchTarget,
} from "../../src/lib/git-remote.ts";

test("refreshes a no-upstream default target once and still compares it", async () => {
  const root = await mkdtemp(join(tmpdir(), "arashi-status-no-upstream-"));
  const remote = join(root, "remote.git");
  const path = join(root, "repo");
  const tracePath = join(root, "fetch-trace.json");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    await exec(["init", "--bare", remote], root);
    await exec(["init", "-b", "main", path], root);
    await exec(["config", "user.name", "Test"], path);
    await exec(["config", "user.email", "test@example.com"], path);
    await exec(["commit", "--allow-empty", "-m", "initial", "--no-gpg-sign"], path);
    await exec(["remote", "add", "origin", remote], path);
    await exec(["push", "-u", "origin", "main"], path);
    await exec(["remote", "set-head", "origin", "main"], path);
    await exec(["config", "--unset", "branch.main.remote"], path);
    await exec(["config", "--unset", "branch.main.merge"], path);

    let initialFetches = 0;
    process.env.GIT_TRACE2_EVENT = tracePath;
    const status = await checkRepoStatus("repo", path, {
      dependencies: {
        fetchRemoteTrackingTarget: async (repoPath, target) => {
          initialFetches += 1;
          const result = await fetchRemoteTrackingTarget(repoPath, target);
          if (result.ok) {
            await rename(remote, `${remote}.offline`);
          }
          return result;
        },
      },
    });

    const fetchStarts = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv?: string[]; event?: string; sid?: string })
      .filter(
        (event) =>
          event.event === "start" &&
          event.argv?.[1] === "fetch" &&
          typeof event.sid === "string" &&
          !event.sid.includes("/"),
      );
    expect(initialFetches).toBe(1);
    expect(fetchStarts).toHaveLength(1);
    expect(status.defaultBranch).toMatchObject({
      ahead: 0,
      behind: 0,
      branch: "main",
      compareRef: "refs/remotes/origin/main",
      state: "available",
    });
    expect(status.freshness).toEqual({ mode: "refreshed", remoteRefsRefreshed: true });
  } finally {
    if (previousTrace === undefined) {
      delete process.env.GIT_TRACE2_EVENT;
    } else {
      process.env.GIT_TRACE2_EVENT = previousTrace;
    }
    await rm(root, { force: true, recursive: true });
  }
});

test("dangling remote HEAD retains its intended missing default target", async () => {
  const path = await mkdtemp(join(tmpdir(), "arashi-status-dangling-"));
  try {
    await exec(["init", "-b", "main"], path);
    await exec(["config", "user.name", "Test"], path);
    await exec(["config", "user.email", "test@example.com"], path);
    await writeFile(join(path, "file"), "content");
    await exec(["add", "file"], path);
    await exec(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], path);
    await exec(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"], path);
    const expected = await compareCurrentBranchToDefaultBranch(path, "main", false, [], {
      refresh: false,
    });
    expect(expected).toMatchObject({ branch: "develop", reason: "unresolved", state: "skipped" });
    const status = await checkRepoStatus("repo", path, { local: true });
    expect(status.error).toBeNull();
    expect(status.defaultBranch).toEqual(expected);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("uses the tracking remote HEAD before the current branch for a non-origin remote", async () => {
  const path = await mkdtemp(join(tmpdir(), "arashi-status-team-default-"));
  try {
    await exec(["init", "-b", "trunk"], path);
    await exec(["config", "user.name", "Test"], path);
    await exec(["config", "user.email", "test@example.com"], path);
    await writeFile(join(path, "file"), "content");
    await exec(["add", "file"], path);
    await exec(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], path);
    await exec(["branch", "feature"], path);
    await exec(["remote", "add", "team", path], path);
    await exec(["remote", "add", "origin", `${path}-origin`], path);
    await exec(["update-ref", "refs/remotes/team/trunk", "refs/heads/trunk"], path);
    await exec(["update-ref", "refs/remotes/team/feature", "refs/heads/feature"], path);
    await exec(["update-ref", "refs/remotes/origin/trunk", "refs/heads/trunk"], path);
    await exec(["symbolic-ref", "refs/remotes/team/HEAD", "refs/remotes/team/trunk"], path);
    await exec(["switch", "feature"], path);
    await exec(["config", "branch.feature.remote", "team"], path);
    await exec(["config", "branch.feature.merge", "refs/heads/feature"], path);

    const status = await checkRepoStatus("repo", path, { local: true });

    expect(status.branch).toMatchObject({
      localBranch: "feature",
      remoteBranch: "team/feature",
    });
    expect(status.defaultBranch).toMatchObject({
      branch: "trunk",
      compareRef: "refs/remotes/team/trunk",
      remote: "team",
      remoteRef: "team/trunk",
      state: "available",
    });

    await exec(["config", "--unset", "branch.feature.remote"], path);
    await exec(["config", "--unset", "branch.feature.merge"], path);
    await expect(resolveDefaultBranchTarget(path)).resolves.toMatchObject({
      ok: true,
      target: {
        branch: "trunk",
        compareRef: "refs/remotes/team/trunk",
        refreshTarget: { remote: "team" },
      },
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("does not select an arbitrary remote when multiple HEADs name the same branch", async () => {
  const path = await mkdtemp(join(tmpdir(), "arashi-status-ambiguous-default-"));
  try {
    await exec(["init", "-b", "trunk"], path);
    await exec(["config", "user.name", "Test"], path);
    await exec(["config", "user.email", "test@example.com"], path);
    await exec(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], path);
    await exec(["switch", "-c", "feature"], path);
    await exec(["remote", "add", "alpha", `${path}-alpha`], path);
    await exec(["remote", "add", "beta", `${path}-beta`], path);
    await exec(["update-ref", "refs/remotes/alpha/trunk", "trunk"], path);
    await exec(["update-ref", "refs/remotes/beta/trunk", "feature"], path);
    await exec(["symbolic-ref", "refs/remotes/alpha/HEAD", "refs/remotes/alpha/trunk"], path);
    await exec(["symbolic-ref", "refs/remotes/beta/HEAD", "refs/remotes/beta/trunk"], path);
    await exec(["branch", "-D", "trunk"], path);

    const resolution = await resolveDefaultBranchTarget(path);

    expect(resolution).toMatchObject({
      ok: true,
      target: { branch: "feature", compareRef: "refs/heads/feature", refreshTarget: null },
    });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
