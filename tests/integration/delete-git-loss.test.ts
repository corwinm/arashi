import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { inspectRepositoryGitLoss } from "../../src/lib/delete-git-loss.ts";
import { inspectGitWorktreeTopology } from "../../src/lib/delete-topology.ts";

const roots: string[] = [];
const env = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "loss@example.test",
  GIT_AUTHOR_NAME: "Loss Test",
  GIT_COMMITTER_EMAIL: "loss@example.test",
  GIT_COMMITTER_NAME: "Loss Test",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgSign",
  GIT_CONFIG_VALUE_0: "false",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arashi-delete-loss-")));
  roots.push(root);
  const remote = join(root, "remote.git");
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  mkdirSync(remote);
  git(remote, "init", "--bare", "--initial-branch=main");
  git(root, "clone", remote, primary);
  writeFileSync(join(primary, "tracked.txt"), "base\n");
  git(primary, "add", "tracked.txt");
  git(primary, "commit", "-m", "base");
  git(primary, "push", "-u", "origin", "main");
  git(primary, "worktree", "add", "--detach", linked, "HEAD");
  return { linked, primary, remote, root };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real Git loss inspection", () => {
  test("permits a valid empty clone without refs", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "arashi-delete-empty-loss-")));
    roots.push(root);
    const remote = join(root, "remote.git");
    const primary = join(root, "primary");
    mkdirSync(remote);
    git(remote, "init", "--bare", "--initial-branch=main");
    git(root, "clone", remote, primary);

    const loss = await inspectRepositoryGitLoss(await inspectGitWorktreeTopology(primary));

    expect(loss.items).toEqual([]);
    expect(loss.warnings.some((warning) => warning.startsWith("DELETE_GIT_DATA_LOSS:"))).toBe(
      false,
    );
  });

  test("fails closed on an invalid UTF-8 status path emitted by Git", async () => {
    const { primary } = fixture();
    const blob = git(primary, "rev-parse", "HEAD:tracked.txt");
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: primary,
      env,
      input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0xff, 0])]),
    });

    await expect(
      inspectRepositoryGitLoss(await inspectGitWorktreeTopology(primary)),
    ).rejects.toThrow(/status|evidence|UTF-8/iu);
  });

  test("inspects every present registered worktree with porcelain v2 including ignored files", async () => {
    const { linked, primary } = fixture();
    writeFileSync(join(primary, "tracked.txt"), "unstaged\n");
    writeFileSync(join(primary, "staged.txt"), "staged\n");
    git(primary, "add", "staged.txt");
    writeFileSync(join(primary, "untracked.txt"), "untracked\n");
    writeFileSync(join(linked, ".gitignore"), "ignored.log\n");
    writeFileSync(join(linked, "ignored.log"), "ignored\n");

    const topology = await inspectGitWorktreeTopology(primary);
    const loss = await inspectRepositoryGitLoss(topology);
    const physicalLinked = await realpath(linked);
    const physicalPrimary = await realpath(primary);

    expect(loss.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${physicalPrimary}: tracked .M tracked.txt`),
        expect.stringContaining(`${physicalPrimary}: tracked A. staged.txt`),
        expect.stringContaining(`${physicalPrimary}: untracked ? untracked.txt`),
        expect.stringContaining(`${physicalLinked}: ignored ! ignored.log`),
      ]),
    );
  });

  test("detects conflicted worktree evidence from a registered linked checkout", async () => {
    const { linked, primary } = fixture();
    git(linked, "switch", "-c", "side");
    writeFileSync(join(linked, "tracked.txt"), "side\n");
    git(linked, "commit", "-am", "side");
    writeFileSync(join(primary, "tracked.txt"), "main\n");
    git(primary, "commit", "-am", "main");
    try {
      git(linked, "merge", "main");
    } catch {
      // The unresolved merge is the fixture state.
    }

    const loss = await inspectRepositoryGitLoss(await inspectGitWorktreeTopology(primary));

    expect(loss.warnings).toContain(
      `DELETE_GIT_DATA_LOSS: ${await realpath(linked)}: conflicted UU tracked.txt`,
    );
  });

  test("plans heads, stash, detached commits, and exact lightweight/annotated tag pairs", async () => {
    const { linked, primary } = fixture();
    writeFileSync(join(primary, "local.txt"), "local\n");
    git(primary, "add", "local.txt");
    git(primary, "commit", "-m", "local-only");
    const localOid = git(primary, "rev-parse", "HEAD");
    git(primary, "branch", "topic/local", localOid);
    git(primary, "tag", "light", localOid);
    git(primary, "tag", "-a", "annotated", "-m", "metadata", localOid);
    const annotatedObject = git(primary, "rev-parse", "refs/tags/annotated");
    writeFileSync(join(primary, "stash.txt"), "stash\n");
    git(primary, "stash", "push", "-u", "-m", "secret message must not leak");
    const stashOid = git(primary, "rev-parse", "refs/stash");
    const detachedOid = git(linked, "rev-parse", "HEAD");

    const loss = await inspectRepositoryGitLoss(await inspectGitWorktreeTopology(primary));
    const pairs = loss.items.map(({ ref, oid }) => [ref, oid]);

    expect(pairs).toContainEqual(["refs/heads/topic/local", localOid]);
    expect(pairs).toContainEqual(["refs/stash", stashOid]);
    expect(pairs).toContainEqual(["refs/tags/light", localOid]);
    expect(pairs).toContainEqual(["refs/tags/light^{}", localOid]);
    const annotatedIndex = pairs.findIndex(([name]) => name === "refs/tags/annotated");
    expect(pairs.slice(annotatedIndex, annotatedIndex + 2)).toEqual([
      ["refs/tags/annotated", annotatedObject],
      ["refs/tags/annotated^{}", localOid],
    ]);
    expect(pairs).toContainEqual(["HEAD(detached)", detachedOid]);
    expect(pairs.some(([name]) => name?.startsWith("refs/remotes/"))).toBe(false);
    expect(loss.warnings.join("\n")).not.toContain("secret message");
    expect(loss.warnings).toContain(
      "DELETE_GIT_REFLOG_BOUNDARY: reflog-only unreachable objects are outside the local publication check",
    );
  });

  test("treats refs reachable from any of multiple local remotes as published without fetching", async () => {
    const { primary, remote, root } = fixture();
    const second = join(root, "second.git");
    git(root, "clone", "--bare", remote, second);
    git(primary, "remote", "add", "backup", second);
    git(primary, "fetch", "backup");
    const before = git(
      primary,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/remotes",
    );

    const loss = await inspectRepositoryGitLoss(await inspectGitWorktreeTopology(primary));
    const after = git(primary, "for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes");

    expect(
      loss.warnings.some((warning) => warning.startsWith("DELETE_GIT_DATA_LOSS: refs/heads/main")),
    ).toBe(false);
    expect(after).toBe(before);
  });

  test("inventories a custom local ref even when it points at a published commit", async () => {
    const { primary } = fixture();
    const published = git(primary, "rev-parse", "HEAD");
    git(primary, "update-ref", "refs/archive/release", published);

    const loss = await inspectRepositoryGitLoss(await inspectGitWorktreeTopology(primary));

    expect(loss.items).toContainEqual(
      expect.objectContaining({ ref: "refs/archive/release", oid: published }),
    );
    expect(loss.warnings).toContain(
      `DELETE_GIT_DATA_LOSS: refs/archive/release ${published} is not reachable from local remote-tracking refs`,
    );
  });
});
