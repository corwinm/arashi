import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../../src/lib/git.ts";
import {
  checkRepoStatus,
  formatFreshnessNotice,
  parseGitStatus,
} from "../../src/commands/status.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repo(commit = false) {
  const path = await mkdtemp(join(tmpdir(), "status-regression-"));
  roots.push(path);
  await exec(["init", "-b", "main"], path);
  await exec(["config", "user.name", "Test"], path);
  await exec(["config", "user.email", "test@example.com"], path);
  if (commit) {
    await writeFile(join(path, "file"), "content\n");
    await exec(["add", "."], path);
    await exec(["-c", "commit.gpgsign=false", "commit", "-m", "initial"], path);
  }
  return path;
}

test("unborn real repository retains branch and untracked path", async () => {
  const path = await repo();
  await writeFile(join(path, "new"), "new");
  const status = await checkRepoStatus("repo", path, { local: true });
  expect(status.error).toBeNull();
  expect(status.branch.localBranch).toBe("main");
  expect(status.files).toEqual([{ path: "new", stagingStatus: "?", workingStatus: "?" }]);
});

test("NUL v2 records preserve arbitrary paths, rename/copy origins and conflicts", () => {
  const path = " space\t雪\nend ";
  const parsed = parseGitStatus(
    [
      "# branch.head main",
      `1 .M N... 100644 100644 100644 abc def ${path}`,
      `2 R. N... 100644 100644 100644 abc def R100 ${path}`,
      "old\nname",
      "2 C. N... 100644 100644 100644 abc def C100 copy",
      "source\tname",
      `u UU N... 100644 100644 100644 100644 abc def abc ${path}`,
      `? ${path}`,
      "! ignored",
      "",
    ].join("\0"),
  );
  expect(parsed.files).toEqual([
    { path, stagingStatus: " ", workingStatus: "M" },
    { path, originalPath: "old\nname", stagingStatus: "R", workingStatus: " " },
    { path: "copy", originalPath: "source\tname", stagingStatus: "C", workingStatus: " " },
    { path, stagingStatus: "U", workingStatus: "U" },
    { path, stagingStatus: "?", workingStatus: "?" },
    { path: "ignored", stagingStatus: "!", workingStatus: "!" },
  ]);
});

test.skipIf(process.platform === "win32")(
  "real Git paths and native verbose rename diagnostics survive",
  async () => {
    const path = await repo(true);
    const destination = "new\t雪\nname ";
    await exec(["mv", "file", destination], path);
    const status = await checkRepoStatus("repo", path, { local: true, verbose: true });
    expect(status.error).toBeNull();
    expect(status.files).toEqual([
      { path: destination, originalPath: "file", stagingStatus: "R", workingStatus: " " },
    ]);
    expect(status.fullStatus).toBe((await exec(["status"], path)).stdout.trim());
  },
);

test("configured missing remote target never substitutes a local branch", async () => {
  const path = await repo(true);
  await exec(["remote", "add", "upstream", path], path);
  const status = await checkRepoStatus("repo", path, { local: true, baseBranch: "main" });
  expect(status.baseBranch).toMatchObject({
    state: "unavailable",
    compareRef: "refs/remotes/upstream/main",
    reason: "comparison-failed",
  });
});

test("no remote or missing repository cannot claim refreshed refs", async () => {
  const path = await repo(true);
  expect((await checkRepoStatus("repo", path)).freshness?.remoteRefsRefreshed).toBe(false);
  expect(
    (await checkRepoStatus("missing", join(path, "absent"))).freshness?.remoteRefsRefreshed,
  ).toBe(false);
  expect(formatFreshnessNotice(false)).not.toBe("Freshness: remote-tracking refs refreshed");
});

test("failed status after successful fetch reports no achieved repository freshness", async () => {
  const path = await repo(true);
  const status = await checkRepoStatus("repo", path, {
    dependencies: {
      resolveRemoteTrackingTarget: async () => ({
        ok: true,
        target: { remote: "origin", branch: "main", upstream: "origin/main" },
      }),
      fetchRemoteTrackingTarget: async () => ({ ok: true }),
      getGitStatus: async () => ({ error: "status failed", output: "" }),
    },
  });
  expect(status.error).toBe("status failed");
  expect(status.freshness?.remoteRefsRefreshed).toBe(false);
});

test("real unmerged and deleted paths preserve native verbose diagnostics", async () => {
  const path = await repo(true);
  await exec(["checkout", "-b", "other"], path);
  await writeFile(join(path, "file"), "other\n");
  await exec(["commit", "-am", "other"], path);
  await exec(["checkout", "main"], path);
  await writeFile(join(path, "file"), "main\n");
  await exec(["commit", "-am", "main"], path);
  await expect(exec(["merge", "other"], path)).rejects.toThrow();
  const status = await checkRepoStatus("repo", path, { local: true, verbose: true });
  expect(status.files).toEqual([{ path: "file", stagingStatus: "U", workingStatus: "U" }]);
  expect(status.fullStatus).toBe((await exec(["status"], path)).stdout.trim());
  expect(status.fullStatus).toContain("Unmerged paths");
  await exec(["merge", "--abort"], path);
  await exec(["rm", "file"], path);
  const deleted = await checkRepoStatus("repo", path, { local: true, verbose: true });
  expect(deleted.files).toEqual([{ path: "file", stagingStatus: "D", workingStatus: " " }]);
  expect(deleted.fullStatus).toBe((await exec(["status"], path)).stdout.trim());
});

test.skipIf(process.platform === "win32")(
  "real ignored and type-change records keep paths and native advice",
  async () => {
    const path = await repo(true);
    await writeFile(join(path, ".gitignore"), "ignored*\n");
    const ignored = "ignored\t雪\nfile";
    await writeFile(join(path, ignored), "ignored");
    await rm(join(path, "file"));
    await symlink("target", join(path, "file"));
    const records = parseGitStatus(
      (await exec(["status", "--porcelain=v2", "--branch", "-z", "--ignored"], path)).stdout,
    ).files;
    expect(records).toContainEqual({ path: ignored, stagingStatus: "!", workingStatus: "!" });
    expect(records).toContainEqual({ path: "file", stagingStatus: " ", workingStatus: "T" });
    const status = await checkRepoStatus("repo", path, { local: true, verbose: true });
    expect(status.fullStatus).toBe((await exec(["status"], path)).stdout.trim());
    expect(status.fullStatus).toContain("typechange:");
    expect(status.fullStatus).toContain("git add");
  },
);
