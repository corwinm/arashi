import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadWorkspaceRepositories } from "../../src/lib/config.ts";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test User");
  await git(root, "config", "commit.gpgSign", "false");
  await writeFile(join(root, "README.md"), `${prefix}\n`);
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function writeConfig(
  root: string,
  childPath: string,
  materialization: Record<string, unknown> = { copy: [".env"] },
): Promise<void> {
  await mkdir(join(root, ".arashi"), { recursive: true });
  await writeFile(
    join(root, ".arashi", "config.json"),
    JSON.stringify({
      repos: { child: { path: childPath, ...materialization } },
      reposDir: "./repos",
      version: "1.0.0",
    }),
  );
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots
      .splice(0)
      .toReversed()
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Git-primary materialization source projection RED", () => {
  test("keeps linked-parent child execution and canonical source paths distinct", async () => {
    const parent = await repository("arashi-materialization-parent-");
    const child = await repository("arashi-materialization-child-");
    const linkedParent = `${parent}-linked`;
    const linkedChild = join(linkedParent, "repos", "child");
    cleanupRoots.push(linkedParent);
    await writeConfig(parent, "./repos/child");
    await git(parent, "add", ".arashi/config.json");
    await git(parent, "commit", "-m", "configure child");
    await git(parent, "worktree", "add", "-b", "feature-parent", linkedParent);
    await mkdir(dirname(linkedChild), { recursive: true });
    await git(child, "worktree", "add", "-b", "feature-child", linkedChild);

    const projected = await loadWorkspaceRepositories({
      configurationRoot: linkedParent,
      executionRoot: linkedParent,
    });

    expect(projected.repositories.find(({ name }) => name === "child")).toMatchObject({
      copy: [".env"],
      name: "child",
      path: await realpath(linkedChild),
      sourcePath: await realpath(child),
      symlink: undefined,
    });
  });

  test("resolves an absolute configured linked child from its own Git topology", async () => {
    const configurationRoot = await repository("arashi-materialization-config-");
    const child = await repository("arashi-materialization-absolute-child-");
    const linkedChild = `${child}-linked`;
    cleanupRoots.push(linkedChild);
    await git(child, "worktree", "add", "-b", "absolute-feature", linkedChild);
    await writeConfig(configurationRoot, linkedChild, { symlink: [".cache"] });

    const projected = await loadWorkspaceRepositories({
      configurationRoot,
      executionRoot: configurationRoot,
    });

    expect(projected.repositories.find(({ name }) => name === "child")).toMatchObject({
      name: "child",
      path: await realpath(linkedChild),
      sourcePath: await realpath(child),
      symlink: [".cache"],
    });
  });

  test("uses child Git topology independently when the configured parent root is bare", async () => {
    const parent = await repository("arashi-materialization-bare-parent-source-");
    const bareParent = `${parent}.git`;
    const linkedParent = `${parent}-linked`;
    cleanupRoots.push(bareParent, linkedParent);
    await git(dirname(parent), "clone", "--bare", parent, bareParent);
    await git(bareParent, "worktree", "add", "-b", "bare-feature", linkedParent);
    const child = await repository("arashi-materialization-bare-child-");
    const linkedChild = join(linkedParent, "repos", "child");
    await mkdir(dirname(linkedChild), { recursive: true });
    await git(child, "worktree", "add", "-b", "bare-child-feature", linkedChild);
    await writeConfig(bareParent, "./repos/child", { copy: ["local.json"] });

    const projected = await loadWorkspaceRepositories({
      configurationRoot: bareParent,
      executionRoot: linkedParent,
    });

    expect(projected.repositories.find(({ name }) => name === "child")).toMatchObject({
      copy: ["local.json"],
      path: await realpath(linkedChild),
      sourcePath: await realpath(child),
    });
  });

  test("fails instead of substituting a linked worktree for a bare repository primary", async () => {
    const configurationRoot = await repository("arashi-materialization-bare-linked-config-");
    const source = await repository("arashi-materialization-bare-linked-source-");
    const bareChild = `${source}.git`;
    const linkedChild = `${source}-linked-only`;
    cleanupRoots.push(bareChild, linkedChild);
    await git(dirname(source), "clone", "--bare", source, bareChild);
    await git(bareChild, "worktree", "add", "-b", "linked-only", linkedChild);
    await writeConfig(configurationRoot, linkedChild);

    await expect(
      loadWorkspaceRepositories({ configurationRoot, executionRoot: configurationRoot }),
    ).rejects.toThrow(/child.*canonical.*source checkout/i);
  });

  test("fails actionably instead of substituting an active or bare path when no primary checkout exists", async () => {
    const configurationRoot = await repository("arashi-materialization-no-primary-config-");
    const bareChild = `${configurationRoot}-child.git`;
    cleanupRoots.push(bareChild);
    await git(dirname(configurationRoot), "init", "--bare", bareChild);
    await writeConfig(configurationRoot, bareChild);

    await expect(
      loadWorkspaceRepositories({ configurationRoot, executionRoot: configurationRoot }),
    ).rejects.toThrow(/child.*canonical.*source checkout/i);
  });
});
