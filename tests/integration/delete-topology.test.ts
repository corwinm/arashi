import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  executeWorktreeRemovalPlan,
  inspectGitWorktreeTopology,
} from "../../src/lib/delete-topology.ts";

const roots: string[] = [];
const env = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "topology@example.test",
  GIT_AUTHOR_NAME: "Topology Test",
  GIT_COMMITTER_EMAIL: "topology@example.test",
  GIT_COMMITTER_NAME: "Topology Test",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgSign",
  GIT_CONFIG_VALUE_0: "false",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" });

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arashi-delete-topology-")));
  roots.push(root);
  const primary = join(root, "primary");
  const configuredActive = join(root, "linked-parent", "repos", "api");
  mkdirSync(primary);
  git(primary, "init", "--initial-branch=main");
  git(primary, "config", "user.email", "topology@example.test");
  git(primary, "config", "user.name", "Topology Test");
  writeFileSync(join(primary, "README.md"), "api\n");
  git(primary, "add", "README.md");
  git(primary, "commit", "-m", "initial");
  mkdirSync(join(root, "linked-parent", "repos"), { recursive: true });
  git(primary, "worktree", "add", configuredActive, "-b", "linked-parent");
  return { configuredActive, primary, root };
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("real Git linked-worktree topology", () => {
  test("resolves canonical primary and common-directory membership from a linked active path", async () => {
    const { configuredActive, primary } = fixture();

    const plan = await inspectGitWorktreeTopology(configuredActive);

    expect(plan.configuredActivePath).toBe(configuredActive);
    expect(plan.primaryPath).toBe(primary);
    expect(plan.canonicalClonePath).toBe(primary);
    expect(plan.linkedWorktrees.map((entry) => entry.path)).toEqual([configuredActive]);
    expect(plan.commonDirectory).toBe(join(primary, ".git"));
  });

  test("removes a registered active linked worktree through Git before clone quarantine", async () => {
    const { configuredActive, primary } = fixture();
    const plan = await inspectGitWorktreeTopology(configuredActive);

    await executeWorktreeRemovalPlan(plan);

    expect(existsSync(configuredActive)).toBe(false);
    expect(existsSync(primary)).toBe(true);
    expect(git(primary, "worktree", "list", "--porcelain", "-z")).not.toContain(configuredActive);
  });

  test("plans exact stale metadata and removes it only with git worktree prune", async () => {
    const { configuredActive, primary, root } = fixture();
    const stale = join(root, "stale");
    git(primary, "worktree", "add", stale, "-b", "stale");
    rmSync(stale, { recursive: true });

    const plan = await inspectGitWorktreeTopology(configuredActive);
    const staleItem = plan.staleMetadata.find((entry) => entry.worktreePath === stale);
    expect(staleItem?.path).toMatch(/\.git[/\\]worktrees[/\\]/u);

    await executeWorktreeRemovalPlan(plan);

    expect(staleItem && existsSync(staleItem.path)).toBe(false);
    expect(existsSync(primary)).toBe(true);
  });

  test("fails closed when a registered missing worktree path is occupied by a symlink", async () => {
    const { configuredActive, primary, root } = fixture();
    const registered = join(root, "replaced");
    const outside = join(root, "outside");
    git(primary, "worktree", "add", registered, "-b", "replaced");
    rmSync(registered, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, registered, "dir");

    await expect(inspectGitWorktreeTopology(configuredActive)).rejects.toThrow(
      /occupied|symbolic|topology|plain directory/iu,
    );
    expect(existsSync(join(primary, ".git", "worktrees"))).toBe(true);
  });

  test("fails closed when a registered missing worktree path is occupied by a file", async () => {
    const { configuredActive, primary, root } = fixture();
    const registered = join(root, "replaced-by-file");
    git(primary, "worktree", "add", registered, "-b", "replaced-by-file");
    rmSync(registered, { recursive: true });
    writeFileSync(registered, "occupied\n");

    await expect(inspectGitWorktreeTopology(configuredActive)).rejects.toThrow(
      /occupied|topology|plain directory/iu,
    );
  });

  test("fails closed when a registered path is replaced by a different Git checkout", async () => {
    const { configuredActive, primary, root } = fixture();
    const registered = join(root, "replaced-by-repository");
    git(primary, "worktree", "add", registered, "-b", "replaced-by-repository");
    rmSync(registered, { recursive: true });
    mkdirSync(registered);
    git(registered, "init", "--initial-branch=main");

    await expect(inspectGitWorktreeTopology(configuredActive)).rejects.toThrow(
      /identity|common directory|topology/iu,
    );
  });
});
