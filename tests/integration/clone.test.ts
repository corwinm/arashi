import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { executeClone, resolveCoordinatedSourceWorkspaceRoot } from "../../src/commands/clone.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import type { Config } from "../../src/lib/config.ts";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "../helpers/node-runtime.ts";

describe("clone command", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "arashi-clone-command-"));
    await spawn(["git", "init"], { cwd: workspaceRoot }).exited;
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

  test("preserves exact SSH alias URLs when HTTPS is selected for a mixed run", async () => {
    const aliasUrl = "ssh://deploy@work-github/team/repo-a.git";
    const config: Config = {
      repos: {
        "repo-a": { gitUrl: aliasUrl, path: "./repos/repo-a" },
        "repo-b": {
          gitUrl: "https://github.com/team/repo-b.git",
          path: "./repos/repo-b",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };
    const clonedUrls: string[] = [];

    const result = await executeClone(
      { all: true },
      {
        cloneRepository: async (gitUrl, destinationPath) => {
          clonedUrls.push(gitUrl);
          await mkdir(destinationPath, { recursive: true });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        promptSelect: async <T>() => ({ status: "ok", value: "https" as T }),
        saveConfig: async () => {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        workspaceRoot,
      },
    );

    expect(result).toMatchObject({ cloned: ["repo-a", "repo-b"], failed: [], status: "success" });
    expect(clonedUrls).toEqual([aliasUrl, "https://github.com/team/repo-b.git"]);
    expect(config.repos["repo-a"]?.gitUrl).toBe(aliasUrl);
  });

  test("uses the exact SSH alias remote when a coordinated local source is unavailable", async () => {
    const coordinatedRoot = join(workspaceRoot, ".arashi", "worktrees", "meta-feat-demo");
    await mkdir(join(coordinatedRoot, "repos"), { recursive: true });
    const aliasUrl = "work-github:team/repo-a.git";
    const config: Config = {
      repos: { "repo-a": { gitUrl: aliasUrl, path: "./repos/repo-a" } },
      reposDir: "./repos",
      version: "1.0.0",
    };
    const clonedUrls: string[] = [];

    const result = await executeClone(
      { all: true, json: true },
      {
        cloneRepository: async (gitUrl, destinationPath) => {
          clonedUrls.push(gitUrl);
          await mkdir(destinationPath, { recursive: true });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        pathExists: async (path) => path === join(coordinatedRoot, "repos"),
        resolveCurrentBranch: async () => "feat/demo",
        saveConfig: async () => {},
        workspaceRoot: coordinatedRoot,
      },
    );

    expect(result).toMatchObject({ cloned: ["repo-a"], failed: [], status: "success" });
    expect(clonedUrls).toEqual([aliasUrl]);
  });

  test("reconciles local ignore rules before cloning a configured repository", async () => {
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
      { all: true },
      {
        cloneRepository: async (_gitUrl, destinationPath) => {
          const exclude = await readFile(join(workspaceRoot, ".git", "info", "exclude"), "utf8");
          expect(exclude).toContain("repos/");
          await mkdir(destinationPath, { recursive: true });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        saveConfig: async () => {},
        workspaceRoot,
      },
    );

    expect(result.managedIgnore).toMatchObject({ changed: true, scope: "local" });
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

  test("repairs a legacy gitUrl from the configuration-root clone when the linked child is missing", async () => {
    const executionRoot = join(workspaceRoot, ".arashi", "worktrees", "meta-feat-demo");
    const centralRepository = join(workspaceRoot, "repos", "repo-a");
    await mkdir(centralRepository, { recursive: true });
    await mkdir(join(executionRoot, "repos"), { recursive: true });
    await spawn(["git", "init"], { cwd: centralRepository }).exited;
    await spawn(["git", "remote", "add", "origin", "https://github.com/team/repo-a.git"], {
      cwd: centralRepository,
    }).exited;

    const config: Config = {
      repos: {
        "repo-a": {
          path: "./repos/repo-a",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };
    const addedWorktrees: string[] = [];
    let savedGitUrl: string | undefined;

    const result = await executeClone(
      { all: true },
      {
        addWorktree: async (_sourceRepositoryPath, destinationPath) => {
          addedWorktrees.push(destinationPath);
          await mkdir(destinationPath, { recursive: true });
        },
        loadConfig: async () => config,
        resolveCurrentBranch: async () => "feat/demo",
        resolveSourceWorkspaceRoot: () => workspaceRoot,
        saveConfig: async (_root, savedConfig) => {
          savedGitUrl = savedConfig.repos["repo-a"]?.gitUrl;
        },
        workspaceRoots: {
          configurationRoot: workspaceRoot,
          executionRoot,
        },
      },
    );

    expect(result.cloned).toEqual(["repo-a"]);
    expect(addedWorktrees).toEqual([join(executionRoot, "repos", "repo-a")]);
    expect(savedGitUrl).toBe("https://github.com/team/repo-a.git");
  });

  test("resolves coordinated worktree source root", () => {
    expect(
      resolveCoordinatedSourceWorkspaceRoot(
        "/workspace/arashi-arashi/.arashi/worktrees/arashi-arashi-feat-demo",
      ),
    ).toBe("/workspace/arashi-arashi/");
    expect(resolveCoordinatedSourceWorkspaceRoot("/workspace/arashi-arashi")).toBeNull();
  });

  test("retains managed ignore coverage when failed clone cleanup leaves a destination", async () => {
    const destination = join(workspaceRoot, "repos", "repo-a");
    let materialized = false;
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
      { all: true },
      {
        cloneRepository: async () => {
          materialized = true;
          throw new Error("simulated partial clone");
        },
        loadConfig: async () => config,
        pathExists: async (path) => path === destination && materialized,
        removeDir: async () => {
          throw new Error("simulated cleanup failure");
        },
        saveConfig: async () => {},
        workspaceRoot,
      },
    );

    expect(result.status).toBe("partial-failure");
    expect(result.managedIgnore).toMatchObject({ changed: true, restored: false });
    expect(await readFile(join(workspaceRoot, ".git", "info", "exclude"), "utf8")).toContain(
      "/repos/",
    );
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
