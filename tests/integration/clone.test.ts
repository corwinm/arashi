import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Config } from "../../src/lib/config.ts";
import { executeClone } from "../../src/commands/clone.ts";

describe("clone command", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "arashi-clone-command-"));
    await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("reports success when no repositories are missing", async () => {
    await mkdir(join(workspaceRoot, "repos", "repo-a"), { recursive: true });

    const config: Config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "repo-a": {
          path: "./repos/repo-a",
          gitUrl: "git@github.com:team/repo-a.git",
        },
      },
    };

    const result = await executeClone(
      { all: true },
      {
        workspaceRoot,
        loadConfig: async () => config,
        saveConfig: async () => {},
      },
    );

    expect(result.status).toBe("success");
    expect(result.cloned).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test("supports interactive selection of missing repositories", async () => {
    const config: Config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "repo-a": {
          path: "./repos/repo-a",
          gitUrl: "git@github.com:team/repo-a.git",
        },
        "repo-b": {
          path: "./repos/repo-b",
          gitUrl: "git@github.com:team/repo-b.git",
        },
      },
    };

    const cloned: string[] = [];
    const result = await executeClone(
      {},
      {
        workspaceRoot,
        loadConfig: async () => config,
        saveConfig: async () => {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        promptMultiSelect: async <T>() => ({
          status: "ok",
          value: ["repo-b"] as unknown as T[],
        }),
        cloneRepository: async (gitUrl, destinationPath) => {
          cloned.push(gitUrl);
          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, ".git"), "gitdir: ./.git/worktrees/main\n");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );

    expect(result.cloned).toEqual(["repo-b"]);
    expect(result.skipped).toEqual(["repo-a"]);
    expect(cloned).toHaveLength(1);
  });

  test("clones all missing repositories with --all", async () => {
    const config: Config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "repo-a": {
          path: "./repos/repo-a",
          gitUrl: "https://github.com/team/repo-a.git",
        },
        "repo-b": {
          path: "./repos/repo-b",
          gitUrl: "https://github.com/team/repo-b.git",
        },
      },
    };

    const clonedDestinations: string[] = [];
    const result = await executeClone(
      { all: true },
      {
        workspaceRoot,
        loadConfig: async () => config,
        saveConfig: async () => {},
        cloneRepository: async (_gitUrl, destinationPath) => {
          clonedDestinations.push(destinationPath);
          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, ".git"), "gitdir: ./.git/worktrees/main\n");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );

    expect(result.cloned).toEqual(["repo-a", "repo-b"]);
    expect(clonedDestinations).toHaveLength(2);
  });

  test("continues cloning after partial failures", async () => {
    const config: Config = {
      version: "1.0.0",
      reposDir: "./repos",
      repos: {
        "repo-a": {
          path: "./repos/repo-a",
          gitUrl: "git@github.com:team/repo-a.git",
        },
        "repo-b": {
          path: "./repos/repo-b",
          gitUrl: "git@github.com:team/repo-b.git",
        },
      },
    };

    const result = await executeClone(
      { all: true },
      {
        workspaceRoot,
        loadConfig: async () => config,
        saveConfig: async () => {},
        cloneRepository: async (gitUrl, destinationPath) => {
          if (gitUrl.includes("repo-a")) {
            throw new Error("simulated clone failure");
          }

          await mkdir(destinationPath, { recursive: true });
          await writeFile(join(destinationPath, ".git"), "gitdir: ./.git/worktrees/main\n");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    );

    expect(result.status).toBe("partial-failure");
    expect(result.cloned).toEqual(["repo-b"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe("repo-a");
  });
});
