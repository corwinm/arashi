import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { executeSwitch } from "../../src/commands/switch.ts";
import { discoverSwitchCandidates } from "../../src/core/switch.ts";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function createLinkedRepository(): Promise<{ linked: string; main: string }> {
  const root = await mkdtemp(join(tmpdir(), "arashi-herdr-source-"));
  roots.push(root);
  const main = join(root, "main source");
  const linked = join(root, "linked worktree");
  await mkdir(main);
  await run("git", ["init", "-b", "main"], { cwd: main });
  await run("git", ["config", "user.name", "Test"], { cwd: main });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: main });
  await run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: main });
  await run("git", ["worktree", "add", "-b", "feature/herdr", linked], { cwd: main });
  return { linked, main };
}

describe("Herdr source resolution", () => {
  test("resolves the non-bare main checkout from a configured linked repository", async () => {
    const { linked, main } = await createLinkedRepository();
    const result = await discoverSwitchCandidates([{ name: "repo", path: linked }], {
      discoverAllWorktrees: async () => [
        { branch: "main", isMain: false, path: main, repository: "repo" },
        { branch: "feature/herdr", isMain: true, path: linked, repository: "repo" },
      ],
    });
    const sourcePath = await realpath(main);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        herdrSource: { path: sourcePath, status: "available" },
        worktreePath: resolve(main),
      }),
      expect.objectContaining({
        herdrSource: { path: sourcePath, status: "available" },
        worktreePath: resolve(linked),
      }),
    ]);
  });

  test("records unavailable source state for a bare repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-herdr-bare-"));
    roots.push(root);
    const bare = join(root, "repo.git");
    await run("git", ["init", "--bare", bare]);
    const result = await discoverSwitchCandidates([{ name: "repo", path: bare }], {
      discoverAllWorktrees: async () => [
        { branch: "main", isMain: true, path: bare, repository: "repo" },
      ],
    });
    expect(result.candidates[0]?.herdrSource).toEqual({ status: "unavailable" });
  });

  test("records unavailable source state for a linked worktree backed by a bare repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-herdr-bare-linked-"));
    roots.push(root);
    const seed = join(root, "seed");
    const bare = join(root, "repo.git");
    const linked = join(root, "linked");
    await mkdir(seed);
    await run("git", ["init", "-b", "main"], { cwd: seed });
    await run("git", ["config", "user.name", "Test"], { cwd: seed });
    await run("git", ["config", "user.email", "test@example.com"], { cwd: seed });
    await run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: seed });
    await run("git", ["clone", "--bare", seed, bare]);
    await run("git", ["worktree", "add", linked, "main"], { cwd: bare });

    const result = await discoverSwitchCandidates([{ name: "repo", path: linked }], {
      discoverAllWorktrees: async () => [
        { branch: "main", isMain: false, path: linked, repository: "repo" },
      ],
    });

    expect(result.candidates[0]?.herdrSource).toEqual({ status: "unavailable" });
  });

  test("keeps distinct Herdr sources when repositories share a display name", async () => {
    const result = await discoverSwitchCandidates(
      [
        { name: "duplicate", path: "/sources/parent" },
        { name: "duplicate", path: "/sources/child" },
      ],
      {
        discoverAllWorktrees: async () => [
          {
            branch: "feature/parent",
            isMain: false,
            path: "/targets/parent",
            repository: "duplicate",
          },
          {
            branch: "feature/child",
            isMain: false,
            path: "/targets/child",
            repository: "duplicate",
          },
        ],
        resolveGitMainWorktree: async (path) => path.replace("/targets/", "/sources/"),
      },
    );

    expect(result.candidates).toEqual([
      expect.objectContaining({
        herdrSource: { path: "/sources/parent", status: "available" },
        worktreePath: "/targets/parent",
      }),
      expect.objectContaining({
        herdrSource: { path: "/sources/child", status: "available" },
        worktreePath: "/targets/child",
      }),
    ]);
  });

  test("resolves child repository source metadata for coordinated --all augmentation", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-herdr-all-source-"));
    roots.push(root);
    const workspaceRoot = join(root, "parent workspace");
    const childMain = join(root, "child main");
    const childLinked = join(workspaceRoot, "repos", "child");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(childMain);
    await run("git", ["init", "-b", "main"], { cwd: childMain });
    await run("git", ["config", "user.name", "Test"], { cwd: childMain });
    await run("git", ["config", "user.email", "test@example.com"], { cwd: childMain });
    await run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: childMain });
    await run("git", ["worktree", "add", "-b", "feature/child-herdr", childLinked], {
      cwd: childMain,
    });

    let launchedCandidate:
      | Awaited<ReturnType<typeof discoverSwitchCandidates>>["candidates"][number]
      | undefined;
    await executeSwitch(
      "feature/child-herdr",
      { all: true, herdr: true },
      {
        discoverSwitchCandidates: async () => ({
          candidates: [
            {
              branchName: "feature/parent",
              herdrSource: { path: workspaceRoot, status: "available" },
              repoName: basename(workspaceRoot),
              worktreePath: workspaceRoot,
            },
          ],
          skippedCount: 0,
        }),
        findWorkspaceRoot: async () => workspaceRoot,
        launchSwitchTarget: async (candidate) => {
          launchedCandidate = candidate;
          return { command: ["herdr"], mode: "herdr" };
        },
        loadWorkspaceRepositories: async () =>
          ({
            config: { repos: {}, reposDir: "repos", version: "1.0.0" },
            repositories: [
              { name: basename(workspaceRoot), path: workspaceRoot },
              { name: "child", path: childMain },
            ],
          }) as never,
        stdinIsTTY: false,
        stdoutIsTTY: false,
      },
    );

    expect(launchedCandidate).toMatchObject({
      branchName: "feature/child-herdr",
      herdrSource: { path: await realpath(childMain), status: "available" },
      repoName: "child",
      worktreePath: resolve(childLinked),
    });
  });
});
