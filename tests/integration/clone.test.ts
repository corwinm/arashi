import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createCommand,
  executeClone,
  resolveCoordinatedSourceWorkspaceRoot,
  resolveOptionalCommit,
} from "../../src/commands/clone.ts";
import { ArashiError } from "../../src/lib/errors.ts";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import type { Config } from "../../src/lib/config.ts";
import { basename, join } from "path";
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

  test("registers shared and repeatable repository base options", () => {
    const command = createCommand();
    expect(command.options.find((option) => option.long === "--base")?.flags).toBe(
      "--base <branch>",
    );
    expect(command.options.find((option) => option.long === "--repo-base")?.flags).toBe(
      "--repo-base <repository=branch>",
    );
  });

  test("preflights all selected bases before managed-ignore and uses branch-aware clone", async () => {
    const config: Config = {
      baseBranch: "main",
      repos: {
        "repo-a": {
          baseBranch: "integration",
          gitUrl: "https://example/a.git",
          path: "./repos/repo-a",
        },
        "repo-b": { gitUrl: "https://example/b.git", path: "./repos/repo-b" },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };
    const events: string[] = [];
    const cloneCalls: unknown[] = [];
    const result = await executeClone(
      { all: true, repoBase: ["repo-b=release"] },
      {
        cloneRepository: async (...args) => {
          cloneCalls.push(args);
          await mkdir(args[1], { recursive: true });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => config,
        preflightRemoteBranch: async (url, branch) => {
          events.push(`preflight:${url}:${branch}`);
          return `${branch}-oid`;
        },
        reconcileManagedIgnore: async () => {
          events.push("managed-ignore");
          return {
            appliedRules: [],
            attempted: false,
            changed: false,
            fileChanges: { local: false, preference: false, tracked: false },
            localExcludePath: "",
            paths: [],
            plannedRules: [],
            restored: false,
            scope: "local",
            staleRules: [],
            storedPreference: null,
            trackedIgnorePath: "",
            warnings: [],
          };
        },
        saveConfig: async () => {},
        workspaceRoot,
      },
    );

    expect(events).toEqual([
      "preflight:https://example/a.git:integration",
      "preflight:https://example/b.git:release",
      "managed-ignore",
    ]);
    expect(cloneCalls).toEqual([
      ["https://example/a.git", join(workspaceRoot, "repos", "repo-a"), { branch: "integration" }],
      ["https://example/b.git", join(workspaceRoot, "repos", "repo-b"), { branch: "release" }],
    ]);
    expect(result.base).toEqual([
      {
        repositoryIdentity: "repo-a",
        repositoryName: "repo-a",
        requestedBranch: "integration",
        source: "repository-config",
      },
      {
        repositoryIdentity: "repo-b",
        repositoryName: "repo-b",
        requestedBranch: "release",
        source: "repository-cli",
      },
    ]);
  });

  test("preflights omitted remote reachability when any selected clone policy applies", async () => {
    const events: string[] = [];
    await executeClone(
      { all: true },
      {
        cloneRepository: async (_url, destination) => {
          await mkdir(destination, { recursive: true });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => ({
          repos: {
            a: { baseBranch: "integration", gitUrl: "https://example/a.git", path: "./repos/a" },
            b: { gitUrl: "https://example/b.git", path: "./repos/b" },
          },
          reposDir: "./repos",
          version: "1.0.0",
        }),
        preflightRemoteBranch: async (_url, branch) => {
          events.push(`branch:${branch}`);
          return "branch-oid";
        },
        preflightRemoteDefault: async (url) => {
          events.push(`default:${url}`);
        },
        reconcileManagedIgnore: async () => {
          events.push("mutation");
          return {
            appliedRules: [],
            attempted: false,
            changed: false,
            fileChanges: { local: false, preference: false, tracked: false },
            localExcludePath: "",
            paths: [],
            plannedRules: [],
            restored: false,
            scope: "local",
            staleRules: [],
            storedPreference: null,
            trackedIgnorePath: "",
            warnings: [],
          };
        },
        saveConfig: async () => {},
        workspaceRoot,
      },
    );
    expect(events).toEqual(["branch:integration", "default:https://example/b.git", "mutation"]);
  });

  test("validates a configured base even when the coordinated target already exists", async () => {
    const sourceRoot = join(workspaceRoot, "existing-target-source");
    const executionRoot = join(workspaceRoot, ".arashi", "worktrees", "existing-target");
    const sourceRepo = join(sourceRoot, "repos", "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await mkdir(join(executionRoot, "repos"), { recursive: true });
    await spawn(["git", "init"], { cwd: sourceRepo }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: sourceRepo }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: sourceRepo }).exited;
    await writeFile(join(sourceRepo, "README.md"), "target\n");
    await spawn(["git", "add", "README.md"], { cwd: sourceRepo }).exited;
    await spawn(["git", "commit", "-m", "target"], { cwd: sourceRepo }).exited;
    await spawn(["git", "branch", "feature/existing"], { cwd: sourceRepo }).exited;
    let mutated = false;
    const failure = await executeClone(
      { all: true },
      {
        loadConfig: async () => ({
          repos: {
            "repo-a": { baseBranch: "missing/base", gitUrl: sourceRepo, path: "./repos/repo-a" },
          },
          reposDir: "./repos",
          version: "1.0.0",
        }),
        reconcileManagedIgnore: async () => {
          mutated = true;
          throw new Error("must not mutate");
        },
        resolveCurrentBranch: async () => "feature/existing",
        resolveSourceWorkspaceRoot: () => sourceRoot,
        saveConfig: async () => {},
        workspaceRoots: { configurationRoot: workspaceRoot, executionRoot },
      },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "CLONE_BASE_PREFLIGHT_FAILED" });
    expect(mutated).toBe(false);
    expect(await spawn(["git", "rev-parse", "feature/existing"], { cwd: sourceRepo }).exited).toBe(
      0,
    );
  });

  test("propagates operational Git errors instead of treating them as missing refs", async () => {
    const operational = new ArashiError("permission denied", {
      args: ["rev-parse"],
      cwd: workspaceRoot,
      exitCode: 128,
      stderr: "denied",
      stdout: "",
    });
    await expect(
      resolveOptionalCommit(workspaceRoot, "refs/heads/main", async () => {
        throw operational;
      }),
    ).rejects.toBe(operational);
  });

  test("rolls back earlier selected destinations after a later policy clone fails", async () => {
    const first = join(workspaceRoot, "repos", "a");
    const result = await executeClone(
      { all: true },
      {
        cloneRepository: async (url, destination) => {
          if (url.endsWith("b.git")) throw new Error("second clone failed");
          await mkdir(destination, { recursive: true });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        loadConfig: async () => ({
          baseBranch: "main",
          repos: {
            a: { gitUrl: "https://example/a.git", path: "./repos/a" },
            b: { gitUrl: "https://example/b.git", path: "./repos/b" },
          },
          reposDir: "./repos",
          version: "1.0.0",
        }),
        preflightRemoteBranch: async () => "oid",
        saveConfig: async () => {},
        workspaceRoot,
      },
    );
    expect(result.status).toBe("partial-failure");
    expect(result.cloned).toEqual([]);
    await expect(access(first)).rejects.toThrow();
  });

  test("rolls back earlier real-Git coordinated worktree and target ownership after later failure", async () => {
    const sourceRoot = join(workspaceRoot, "transaction-source");
    const executionRoot = join(workspaceRoot, ".arashi", "worktrees", "transaction-target");
    await mkdir(join(executionRoot, "repos"), { recursive: true });
    const config: Config = {
      baseBranch: "integration",
      repos: {
        a: { gitUrl: join(sourceRoot, "repos", "a"), path: "./repos/a" },
        b: { gitUrl: join(sourceRoot, "repos", "b"), path: "./repos/b" },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };
    for (const name of ["a", "b"]) {
      const repository = join(sourceRoot, "repos", name);
      await mkdir(repository, { recursive: true });
      await spawn(["git", "init"], { cwd: repository }).exited;
      await spawn(["git", "config", "user.email", "test@example.com"], { cwd: repository }).exited;
      await spawn(["git", "config", "user.name", "Test"], { cwd: repository }).exited;
      await writeFile(join(repository, "README.md"), `${name}\n`);
      await spawn(["git", "add", "README.md"], { cwd: repository }).exited;
      await spawn(["git", "commit", "-m", "base"], { cwd: repository }).exited;
      await spawn(["git", "branch", "integration"], { cwd: repository }).exited;
    }

    const result = await executeClone(
      { all: true },
      {
        addWorktree: async (source, destination, branch) => {
          if (basename(source) === "b") throw new Error("later coordinated failure");
          const operation = await spawn(["git", "worktree", "add", destination, branch], {
            cwd: source,
          });
          if ((await operation.exited) !== 0) throw new Error("unexpected worktree add failure");
        },
        loadConfig: async () => config,
        resolveCurrentBranch: async () => "feature/transaction",
        resolveSourceWorkspaceRoot: () => sourceRoot,
        saveConfig: async () => {},
        workspaceRoots: { configurationRoot: workspaceRoot, executionRoot },
      },
    );

    expect(result.cloned).toEqual([]);
    for (const name of ["a", "b"]) {
      const repository = join(sourceRoot, "repos", name);
      expect(
        await spawn(["git", "show-ref", "--verify", "refs/heads/feature/transaction"], {
          cwd: repository,
        }).exited,
      ).not.toBe(0);
      expect(
        await spawn(["git", "show-ref", "--verify", "refs/heads/integration"], {
          cwd: repository,
        }).exited,
      ).toBe(0);
      await expect(access(join(executionRoot, "repos", name))).rejects.toThrow();
    }
  });

  test("creates a missing coordinated target from the effective base and checks out the target", async () => {
    const sourceRoot = join(workspaceRoot, "source");
    const executionRoot = join(workspaceRoot, ".arashi", "worktrees", "feature-demo");
    const sourceRepo = join(sourceRoot, "repos", "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await mkdir(join(executionRoot, "repos"), { recursive: true });
    await spawn(["git", "init"], { cwd: sourceRepo }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: sourceRepo }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: sourceRepo }).exited;
    await writeFile(join(sourceRepo, "README.md"), "base\n");
    await spawn(["git", "add", "README.md"], { cwd: sourceRepo }).exited;
    await spawn(["git", "commit", "-m", "base"], { cwd: sourceRepo }).exited;
    await spawn(["git", "branch", "integration"], { cwd: sourceRepo }).exited;

    const config: Config = {
      repos: {
        "repo-a": { baseBranch: "integration", gitUrl: sourceRepo, path: "./repos/repo-a" },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };
    const result = await executeClone(
      { all: true },
      {
        loadConfig: async () => config,
        resolveCurrentBranch: async () => "feature/demo",
        resolveSourceWorkspaceRoot: () => sourceRoot,
        saveConfig: async () => {},
        workspaceRoots: { configurationRoot: workspaceRoot, executionRoot },
      },
    );

    expect(result.status).toBe("success");
    const destination = join(executionRoot, "repos", "repo-a");
    const branch = await spawn(["git", "branch", "--show-current"], { cwd: destination });
    expect((await new Response(branch.stdout).text()).trim()).toBe("feature/demo");
    const ancestry = await spawn(
      ["git", "merge-base", "--is-ancestor", "integration", "feature/demo"],
      { cwd: sourceRepo },
    );
    expect(await ancestry.exited).toBe(0);
  });

  test("materializes a remote-only coordinated child on the target rather than its base", async () => {
    const seed = join(workspaceRoot, "seed");
    const remote = join(workspaceRoot, "repo-a.git");
    const executionRoot = join(workspaceRoot, ".arashi", "worktrees", "feature-remote");
    await mkdir(seed, { recursive: true });
    await mkdir(join(executionRoot, "repos"), { recursive: true });
    await spawn(["git", "init"], { cwd: seed }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: seed }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: seed }).exited;
    await writeFile(join(seed, "README.md"), "remote base\n");
    await spawn(["git", "add", "README.md"], { cwd: seed }).exited;
    await spawn(["git", "commit", "-m", "base"], { cwd: seed }).exited;
    await spawn(["git", "branch", "integration"], { cwd: seed }).exited;
    await spawn(["git", "clone", "--bare", seed, remote], { cwd: workspaceRoot }).exited;

    const config: Config = {
      repos: {
        "repo-a": { baseBranch: "integration", gitUrl: remote, path: "./repos/repo-a" },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };
    const result = await executeClone(
      { all: true },
      {
        loadConfig: async () => config,
        resolveCurrentBranch: async () => "feature/remote",
        resolveSourceWorkspaceRoot: () => join(workspaceRoot, "missing-source"),
        saveConfig: async () => {},
        workspaceRoots: { configurationRoot: workspaceRoot, executionRoot },
      },
    );

    expect(result.status).toBe("success");
    const destination = join(executionRoot, "repos", "repo-a");
    const branch = await spawn(["git", "branch", "--show-current"], { cwd: destination });
    expect((await new Response(branch.stdout).text()).trim()).toBe("feature/remote");
  });

  test("reuses the cloned base when a remote-only coordinated target has the same name", async () => {
    const seed = join(workspaceRoot, "same-base-seed");
    const remote = join(workspaceRoot, "same-base.git");
    const executionRoot = join(workspaceRoot, ".arashi", "worktrees", "same-base");
    await mkdir(seed, { recursive: true });
    await mkdir(join(executionRoot, "repos"), { recursive: true });
    await spawn(["git", "init", "-b", "main"], { cwd: seed }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: seed }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: seed }).exited;
    await spawn(["git", "config", "commit.gpgSign", "false"], { cwd: seed }).exited;
    await writeFile(join(seed, "README.md"), "same base\n");
    await spawn(["git", "add", "README.md"], { cwd: seed }).exited;
    await spawn(["git", "commit", "-m", "base"], { cwd: seed }).exited;
    await spawn(["git", "branch", "integration"], { cwd: seed }).exited;
    await spawn(["git", "clone", "--bare", seed, remote], { cwd: workspaceRoot }).exited;

    const result = await executeClone(
      { all: true },
      {
        loadConfig: async () => ({
          repos: {
            "repo-a": { baseBranch: "integration", gitUrl: remote, path: "./repos/repo-a" },
          },
          reposDir: "./repos",
          version: "1.0.0",
        }),
        resolveCurrentBranch: async () => "integration",
        resolveSourceWorkspaceRoot: () => join(workspaceRoot, "missing-source"),
        saveConfig: async () => {},
        workspaceRoots: { configurationRoot: workspaceRoot, executionRoot },
      },
    );

    expect(result.status).toBe("success");
    const destination = join(executionRoot, "repos", "repo-a");
    const branch = await spawn(["git", "branch", "--show-current"], { cwd: destination });
    expect((await new Response(branch.stdout).text()).trim()).toBe("integration");
  });

  test("rolls back an invocation-created coordinated target when worktree add fails", async () => {
    const sourceRoot = join(workspaceRoot, "rollback-source");
    const executionRoot = join(workspaceRoot, ".arashi", "worktrees", "feature-rollback");
    const sourceRepo = join(sourceRoot, "repos", "repo-a");
    const destination = join(executionRoot, "repos", "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await mkdir(join(executionRoot, "repos"), { recursive: true });
    await spawn(["git", "init"], { cwd: sourceRepo }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: sourceRepo }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: sourceRepo }).exited;
    await writeFile(join(sourceRepo, "README.md"), "base\n");
    await spawn(["git", "add", "README.md"], { cwd: sourceRepo }).exited;
    await spawn(["git", "commit", "-m", "base"], { cwd: sourceRepo }).exited;
    await spawn(["git", "branch", "integration"], { cwd: sourceRepo }).exited;
    const config: Config = {
      repos: {
        "repo-a": { baseBranch: "integration", gitUrl: sourceRepo, path: "./repos/repo-a" },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    const result = await executeClone(
      { all: true },
      {
        addWorktree: async () => {
          await mkdir(destination, { recursive: true });
          throw new Error("simulated add failure");
        },
        loadConfig: async () => config,
        resolveCurrentBranch: async () => "feature/rollback",
        resolveSourceWorkspaceRoot: () => sourceRoot,
        saveConfig: async () => {},
        workspaceRoots: { configurationRoot: workspaceRoot, executionRoot },
      },
    );

    expect(result.status).toBe("partial-failure");
    const target = await spawn(["git", "show-ref", "--verify", "refs/heads/feature/rollback"], {
      cwd: sourceRepo,
    });
    expect(await target.exited).not.toBe(0);
    expect(
      await spawn(["git", "show-ref", "--verify", "refs/heads/integration"], { cwd: sourceRepo })
        .exited,
    ).toBe(0);
    await expect(access(destination)).rejects.toThrow();
  });

  test("rejects invalid base selectors before deleting unmanaged repositories", async () => {
    const unmanaged = join(workspaceRoot, "repos", "unmanaged");
    await mkdir(join(unmanaged, ".git"), { recursive: true });
    let confirmedDelete = false;

    const failure = await executeClone(
      { all: true, repoBase: ["missing=main"] },
      {
        loadConfig: async () => ({
          repos: {
            configured: {
              gitUrl: "https://example/configured.git",
              path: "./repos/configured",
            },
          },
          reposDir: "./repos",
          version: "1.0.0",
        }),
        promptConfirm: async () => {
          confirmedDelete = true;
          return { status: "ok", value: true };
        },
        promptSelect: async <T>() => ({ status: "ok", value: "delete" as T }),
        saveConfig: async () => {},
        stdinIsTTY: true,
        stdoutIsTTY: true,
        workspaceRoot,
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "BASE_BRANCH_POLICY_INVALID" });
    expect(confirmedDelete).toBe(false);
    await expect(access(unmanaged)).resolves.toBeUndefined();
  });

  test("aggregates selected remote failures before managed-ignore mutation", async () => {
    const config: Config = {
      baseBranch: "main",
      repos: {
        a: { gitUrl: "https://example/a.git", path: "./repos/a" },
        b: { gitUrl: "https://example/b.git", path: "./repos/b" },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };
    let mutated = false;
    const failure = await executeClone(
      { all: true },
      {
        loadConfig: async () => config,
        preflightRemoteBranch: async (_url, branch) => {
          throw new Error(`missing ${branch}`);
        },
        reconcileManagedIgnore: async () => {
          mutated = true;
          throw new Error("must not mutate");
        },
        saveConfig: async () => {},
        workspaceRoot,
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "CLONE_BASE_PREFLIGHT_FAILED",
      failures: [
        { repositoryName: "a", requestedBranch: "main", source: "workspace-config" },
        { repositoryName: "b", requestedBranch: "main", source: "workspace-config" },
      ],
    });
    expect(mutated).toBe(false);
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
