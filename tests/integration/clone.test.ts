import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { executeClone, resolveCoordinatedSourceWorkspaceRoot } from "../../src/commands/clone.ts";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import type { Config } from "../../src/lib/config.ts";
import { join } from "path";
import { tmpdir } from "os";

describe("clone command", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "arashi-clone-command-"));
    await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { force: true, recursive: true });
  });

  test("reports success when no repositories are missing", async () => {
    await mkdir(join(workspaceRoot, "repos", "repo-a"), { recursive: true });

    const config: Config = {
      repos: {
        "repo-a": {
          gitUrl: "git@github.com:team/repo-a.git",
          path: "./repos/repo-a",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const result = await executeClone(
      { all: true },
      {
        loadConfig: async () => config,
        saveConfig: async () => {},
        workspaceRoot,
      },
    );

    expect(result.status).toBe("success");
    expect(result.cloned).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test("supports interactive selection of missing repositories", async () => {
    const config: Config = {
      repos: {
        "repo-a": {
          gitUrl: "git@github.com:team/repo-a.git",
          path: "./repos/repo-a",
        },
        "repo-b": {
          gitUrl: "git@github.com:team/repo-b.git",
          path: "./repos/repo-b",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const cloned: string[] = [];
    const result = await executeClone(
      {},
      {
        cloneRepository: async (gitUrl, destinationPath) => {
          cloned.push(gitUrl);
          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, ".git"), "gitdir: ./.git/worktrees/main\n");
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        promptMultiSelect: async <T>() => ({
          status: "ok",
          value: ["repo-b"] as unknown as T[],
        }),
        saveConfig: async () => {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        workspaceRoot,
      },
    );

    expect(result.cloned).toEqual(["repo-b"]);
    expect(result.skipped).toEqual(["repo-a"]);
    expect(cloned).toHaveLength(1);
  });

  test("clones all missing repositories with --all", async () => {
    const config: Config = {
      repos: {
        "repo-a": {
          gitUrl: "https://github.com/team/repo-a.git",
          path: "./repos/repo-a",
        },
        "repo-b": {
          gitUrl: "https://github.com/team/repo-b.git",
          path: "./repos/repo-b",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const clonedDestinations: string[] = [];
    const result = await executeClone(
      { all: true },
      {
        cloneRepository: async (_gitUrl, destinationPath) => {
          clonedDestinations.push(destinationPath);
          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, ".git"), "gitdir: ./.git/worktrees/main\n");
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        saveConfig: async () => {},
        workspaceRoot,
      },
    );

    expect(result.cloned).toEqual(["repo-a", "repo-b"]);
    expect(clonedDestinations).toHaveLength(2);
  });

  test("completes missing repositories in coordinated worktrees using current branch", async () => {
    const coordinatedRoot = join(workspaceRoot, ".arashi", "worktrees", "meta-feat-demo");
    await mkdir(join(workspaceRoot, "repos", "repo-a"), { recursive: true });
    await mkdir(join(coordinatedRoot, "repos"), { recursive: true });

    const config: Config = {
      repos: {
        "repo-a": {
          gitUrl: "https://github.com/team/repo-a.git",
          path: "./repos/repo-a",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const addedWorktrees: {
      branchName: string;
      destinationPath: string;
      sourceRepositoryPath: string;
    }[] = [];
    let cloneCalled = false;

    const result = await executeClone(
      { all: true },
      {
        addWorktree: async (sourceRepositoryPath, destinationPath, branchName) => {
          addedWorktrees.push({ branchName, destinationPath, sourceRepositoryPath });
          await mkdir(destinationPath, { recursive: true });
        },
        cloneRepository: async () => {
          cloneCalled = true;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        pathExists: async (path) => path === join(workspaceRoot, "repos", "repo-a"),
        resolveCurrentBranch: async () => "feat/demo",
        saveConfig: async () => {},
        workspaceRoot: coordinatedRoot,
      },
    );

    expect(result.cloned).toEqual(["repo-a"]);
    expect(cloneCalled).toBe(false);
    expect(addedWorktrees).toEqual([
      {
        branchName: "feat/demo",
        destinationPath: join(coordinatedRoot, "repos", "repo-a"),
        sourceRepositoryPath: join(workspaceRoot, "repos", "repo-a"),
      },
    ]);
  });

  test("resolves coordinated worktree source root", () => {
    expect(
      resolveCoordinatedSourceWorkspaceRoot(
        "/workspace/arashi-arashi/.arashi/worktrees/arashi-arashi-feat-demo",
      ),
    ).toBe("/workspace/arashi-arashi/");
    expect(resolveCoordinatedSourceWorkspaceRoot("/workspace/arashi-arashi")).toBeNull();
  });

  test("continues cloning after partial failures", async () => {
    const config: Config = {
      repos: {
        "repo-a": {
          gitUrl: "git@github.com:team/repo-a.git",
          path: "./repos/repo-a",
        },
        "repo-b": {
          gitUrl: "git@github.com:team/repo-b.git",
          path: "./repos/repo-b",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const result = await executeClone(
      { all: true },
      {
        cloneRepository: async (gitUrl, destinationPath) => {
          if (gitUrl.includes("repo-a")) {
            throw new Error("simulated clone failure");
          }

          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, ".git"), "gitdir: ./.git/worktrees/main\n");
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        saveConfig: async () => {},
        workspaceRoot,
      },
    );

    expect(result.status).toBe("partial-failure");
    expect(result.cloned).toEqual(["repo-b"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe("repo-a");
  });

  test("does not prompt for unmanaged repositories in JSON mode", async () => {
    await mkdir(join(workspaceRoot, "repos", "extra-repo"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "repos", "extra-repo", ".git"),
      "gitdir: ./.git/worktrees/main\n",
    );

    const config: Config = {
      repos: {
        "repo-a": {
          gitUrl: "https://github.com/team/repo-a.git",
          path: "./repos/repo-a",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const result = await executeClone(
      { all: true, json: true },
      {
        cloneRepository: async (_gitUrl, destinationPath) => {
          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, ".git"), "gitdir: ./.git/worktrees/main\n");
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        promptSelect: async () => {
          throw new Error("JSON clone should not prompt for unmanaged repositories");
        },
        saveConfig: async () => {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        workspaceRoot,
      },
    );

    expect(result.status).toBe("success");
    expect(result.cloned).toEqual(["repo-a"]);
  });
});
