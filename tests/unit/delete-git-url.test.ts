import { afterEach, describe, expect, test } from "vitest";
import { canonicalizeGitFetchUrl, gitFetchUrlsMatch } from "../../src/lib/delete-git-url.ts";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { exec } from "../../src/lib/git.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];

const fixture = async (): Promise<string> => {
  const created = await mkdtemp(join(tmpdir(), "arashi-delete-git-url-"));
  roots.push(created);
  await exec(["init", "--initial-branch=main"], created);
  return realpath(created);
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("local Git fetch URL identity", () => {
  test("canonicalizes SCP and SSH syntax, host case, trailing slash, and .git", async () => {
    const cwd = await fixture();

    await expect(
      gitFetchUrlsMatch({
        configuredCwd: cwd,
        configuredUrl: "git@EXAMPLE.com:Org/Repo.git/",
        fetchUrls: ["ssh://git@example.COM/Org/Repo"],
      }),
    ).resolves.toBe(true);
  });

  test("uses local Git insteadOf rewrites without contacting a remote", async () => {
    const cwd = await fixture();
    await exec(["config", "url.ssh://git@Example.COM/.insteadOf", "corp:"], cwd);

    await expect(
      gitFetchUrlsMatch({
        configuredCwd: cwd,
        configuredUrl: "corp:Org/repo",
        fetchUrls: ["git@example.com:Org/repo.git"],
      }),
    ).resolves.toBe(true);
  });

  test("canonicalizes file and local URLs through physical realpaths", async () => {
    const cwd = await fixture();
    const repository = join(cwd, "remote.git");
    const alias = join(cwd, "alias.git");
    await mkdir(repository);
    await symlink(repository, alias, "dir");

    expect(await canonicalizeGitFetchUrl(alias, cwd)).toBe(
      await canonicalizeGitFetchUrl(`file://${repository}/`, cwd),
    );
  });

  test("accepts multiple well-formed fetch URLs when any matches", async () => {
    const cwd = await fixture();

    await expect(
      gitFetchUrlsMatch({
        configuredCwd: cwd,
        configuredUrl: "ssh://git@example.com/org/repo",
        fetchUrls: ["ssh://git@example.com/other/repo", "git@EXAMPLE.COM:org/repo.git"],
      }),
    ).resolves.toBe(true);
  });

  test.each([
    { fetchUrls: [] },
    { fetchUrls: ["https://["] },
    { fetchUrls: ["git@example.com:org/repo.git", "https://["] },
    { fetchUrls: ["ssh://git@example.com/other/repo"] },
  ])("rejects zero, malformed, or entirely nonmatching fetch URL sets", async ({ fetchUrls }) => {
    const cwd = await fixture();

    await expect(
      gitFetchUrlsMatch({
        configuredCwd: cwd,
        configuredUrl: "ssh://git@example.com/org/repo",
        fetchUrls,
      }),
    ).rejects.toThrow(/fetch URL|malformed|match/iu);
  });
});
