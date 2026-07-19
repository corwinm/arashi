import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "arashi-json-cli-"));
  tempDirs.push(path);
  return path;
};

const runArashi = async (cwd: string, args: string[]): Promise<CommandResult> => {
  const proc = runtime.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
};

const runCommand = async (cwd: string, args: string[]): Promise<CommandResult> => {
  const proc = runtime.spawn(args, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
};

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runCommand(cwd, ["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Git command failed");
  }

  return result.stdout.trim();
};

const parseSingleJsonDocument = (stdout: string): Record<string, unknown> => {
  expect(stdout.trim()).toBe(stdout.slice(0, -1));
  expect(stdout.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(stdout);
  expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(stdout);
  return parsed as Record<string, unknown>;
};

const jsonData = (parsed: Record<string, unknown>): Record<string, unknown> => {
  expect(parsed.data).toBeDefined();
  return parsed.data as Record<string, unknown>;
};

const jsonArray = (value: unknown): Record<string, unknown>[] => {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
};

const initializeGitRepository = async (repoPath: string): Promise<void> => {
  await mkdir(repoPath, { recursive: true });
  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test User"]);
  await writeFile(join(repoPath, "README.md"), `# ${repoPath}\n`);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", "Initial commit"]);
};

const writeWorkspaceConfig = async (workspaceRoot: string): Promise<void> => {
  await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".arashi", "config.json"),
    JSON.stringify(
      {
        repos: {
          "repo-a": {
            defaultBranch: "main",
            isBare: false,
            path: "./repos/repo-a",
            worktrees: [],
          },
          "repo-b": {
            defaultBranch: "main",
            isBare: false,
            path: "./repos/repo-b",
            worktrees: [],
          },
        },
        reposDir: "./repos",
        version: "1.0.0",
      },
      null,
      2,
    ),
  );
};

const createCommonWorkspace = async (): Promise<string> => {
  const workspaceRoot = await makeTempDir();
  await initializeGitRepository(workspaceRoot);
  await initializeGitRepository(join(workspaceRoot, "repos", "repo-a"));
  await initializeGitRepository(join(workspaceRoot, "repos", "repo-b"));
  await writeWorkspaceConfig(workspaceRoot);
  await writeFile(join(workspaceRoot, ".gitignore"), "repos/\n");
  await runGit(workspaceRoot, ["add", ".arashi/config.json", ".gitignore"]);
  await runGit(workspaceRoot, ["commit", "-m", "Add Arashi config"]);

  return workspaceRoot;
};

const writeExecutableSetupScript = async (repoPath: string, content: string): Promise<void> => {
  const scriptPath = join(repoPath, "setup.sh");
  await writeFile(scriptPath, content);
  await chmod(scriptPath, 0o755);
};

const createBareRemote = async (baseDir: string, name: string): Promise<string> => {
  const remotePath = join(baseDir, `${name}.git`);
  await runGit(baseDir, ["init", "--bare", remotePath]);
  return remotePath;
};

const seedRemote = async (remotePath: string, baseDir: string, seedName: string): Promise<void> => {
  const seedPath = join(baseDir, seedName);
  await runGit(baseDir, ["clone", remotePath, seedPath]);
  await runGit(seedPath, ["config", "user.email", "test@example.com"]);
  await runGit(seedPath, ["config", "user.name", "Test User"]);
  await writeFile(join(seedPath, "README.md"), `# ${seedName}\n`);
  await runGit(seedPath, ["add", "."]);
  await runGit(seedPath, ["commit", "-m", "Initial commit"]);
  await runGit(seedPath, ["push", "origin", "HEAD:main"]);
  await runGit(remotePath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
};

const createRemoteBackedWorkspace = async (): Promise<string> => {
  const baseDir = await makeTempDir();
  const mainRemote = await createBareRemote(baseDir, "main-remote");
  const repoRemote = await createBareRemote(baseDir, "repo-a-remote");

  await seedRemote(mainRemote, baseDir, "main-seed");
  await seedRemote(repoRemote, baseDir, "repo-a-seed");

  const workspaceRoot = join(baseDir, "workspace");
  await runGit(baseDir, ["clone", mainRemote, workspaceRoot]);
  await runGit(workspaceRoot, ["checkout", "-B", "main"]);
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
  await runGit(workspaceRoot, ["config", "user.name", "Test User"]);
  await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  await runGit(join(workspaceRoot, "repos"), ["clone", repoRemote, "repo-a"]);
  await runGit(join(workspaceRoot, "repos", "repo-a"), ["checkout", "-B", "main"]);
  await initializeGitRepository(join(workspaceRoot, "repos", "repo-b"));
  await writeWorkspaceConfig(workspaceRoot);

  return workspaceRoot;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("CLI JSON output contract", () => {
  test("status --json covers a clean workspace with configured repositories", async () => {
    const workspaceRoot = await createCommonWorkspace();

    const result = await runArashi(workspaceRoot, ["status", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "status",
      ok: true,
      schemaVersion: 1,
    });
    const data = jsonData(parsed);
    expect(data.workspaceRoot).toBe(await realpath(workspaceRoot));
    expect(data.summary).toMatchObject({ cleanCount: 3, dirtyCount: 0, total: 3 });
    const repositories = jsonArray(data.repositories);
    expect(repositories.map((repo) => repo.name)).toEqual(["Main Repository", "repo-a", "repo-b"]);
  });

  test("setup --json covers common --only usage without progress noise", async () => {
    const workspaceRoot = await createCommonWorkspace();
    await writeExecutableSetupScript(
      join(workspaceRoot, "repos", "repo-a"),
      "#!/bin/sh\necho repo-a-json-setup > ../../setup-marker.txt\n",
    );

    const result = await runArashi(workspaceRoot, ["setup", "--only", "repo-a", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "setup",
      ok: true,
      schemaVersion: 1,
      warnings: [],
    });
    const data = jsonData(parsed);
    expect(data).toMatchObject({
      excludedCount: 2,
      executedCount: 1,
      overallStatus: "success",
      selectedCount: 1,
      successCount: 1,
    });
    const executions = jsonArray(data.executions);
    expect(executions).toContainEqual(
      expect.objectContaining({ repositoryName: "repo-a", status: "success" }),
    );
    expect(result.stdout).not.toContain("[1/1]");
    expect(await runtime.file(join(workspaceRoot, "setup-marker.txt")).text()).toBe(
      "repo-a-json-setup\n",
    );
  });

  test("pull --json covers common --only usage with a skipped up-to-date repository", async () => {
    const workspaceRoot = await createRemoteBackedWorkspace();

    const result = await runArashi(workspaceRoot, ["pull", "--only", "repo-a", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "pull",
      ok: true,
      schemaVersion: 1,
      warnings: [],
    });
    const data = jsonData(parsed);
    expect(data.managedIgnore).toMatchObject({ scope: "local" });
    expect(data.overallStatus).toBe("success");
    expect(jsonArray(data.results)).toEqual([
      expect.objectContaining({ repositoryId: "repo-a", status: "skipped" }),
    ]);
    expect(result.stdout).not.toContain("[1/1]");
  });

  test("agentic development workflow can create and remove coordinated worktrees with JSON", async () => {
    const workspaceRoot = await createCommonWorkspace();
    const branchName = "feat/agentic-json-loop";

    const createResult = await runArashi(workspaceRoot, [
      "create",
      branchName,
      "--no-launch",
      "--no-switch",
      "--json",
    ]);

    expect(createResult.exitCode).toBe(0);
    const createParsed = parseSingleJsonDocument(createResult.stdout);
    expect(createParsed).toMatchObject({
      command: "create",
      ok: true,
      schemaVersion: 1,
      warnings: [],
    });
    const createData = jsonData(createParsed);
    expect(createData).toMatchObject({
      branchName,
      failureCount: 0,
      managedIgnore: { changed: true, scope: "local" },
      mode: "configured",
      repositoriesBase: join(await realpath(workspaceRoot), "repos"),
      successCount: 3,
      totalRepositories: 3,
      workspaceRoot: await realpath(workspaceRoot),
      worktreesBase: join(await realpath(workspaceRoot), ".arashi", "worktrees"),
    });
    const createdRepositories = jsonArray(createData.repositories);
    expect(createdRepositories.map((repo) => repo.repositoryName).toSorted()).toEqual(
      ["repo-a", "repo-b", workspaceRoot.split("/").at(-1)].toSorted(),
    );
    for (const repo of createdRepositories) {
      expect(repo).toMatchObject({ branchName, status: "success" });
      expect(typeof repo.worktreePath).toBe("string");
      expect((await stat(repo.worktreePath as string)).isDirectory()).toBe(true);
    }
    expect(createResult.stdout).not.toContain("[1/3]");
    expect(createResult.stdout).not.toContain("Worktree locations");

    const removeResult = await runArashi(workspaceRoot, [
      "remove",
      branchName,
      "--force",
      "--json",
    ]);

    expect(removeResult.exitCode).toBe(0);
    const removeParsed = parseSingleJsonDocument(removeResult.stdout);
    expect(removeParsed).toMatchObject({
      command: "remove",
      ok: true,
      schemaVersion: 1,
      warnings: [],
    });
    const removeData = jsonData(removeParsed);
    expect(removeData).toMatchObject({
      mode: "configured",
      repositoriesBase: join(await realpath(workspaceRoot), "repos"),
      success: true,
      summary: {
        successfulBranches: 3,
        successfulWorktrees: 3,
        totalBranches: 3,
        totalWorktrees: 3,
      },
      workspaceRoot: await realpath(workspaceRoot),
      worktreesBase: join(await realpath(workspaceRoot), ".arashi", "worktrees"),
    });
    for (const repo of createdRepositories) {
      expect(await runtime.file(repo.worktreePath as string).exists()).toBe(false);
    }
    expect(removeResult.stdout).not.toContain("Successfully removed");
  });

  test("configured list JSON includes additive workspace path metadata", async () => {
    const workspaceRoot = await createCommonWorkspace();
    const canonicalRoot = await realpath(workspaceRoot);

    const result = await runArashi(workspaceRoot, ["list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(jsonData(parseSingleJsonDocument(result.stdout))).toMatchObject({
      mode: "configured",
      repositoriesBase: join(canonicalRoot, "repos"),
      workspaceRoot: canonicalRoot,
      worktreesBase: join(canonicalRoot, ".arashi", "worktrees"),
      worktrees: expect.any(Array),
    });
  });

  test("prune --json reports and removes stale worktree metadata", async () => {
    const workspaceRoot = await createCommonWorkspace();
    const stalePath = join(workspaceRoot, "../stale-worktree");
    await runGit(workspaceRoot, ["worktree", "add", stalePath, "-b", "feat/stale-prune"]);
    await rm(stalePath, { force: true, recursive: true });

    const dryRunResult = await runArashi(workspaceRoot, ["prune", "--dry-run", "--json"]);

    expect(dryRunResult.exitCode).toBe(0);
    const dryRunParsed = parseSingleJsonDocument(dryRunResult.stdout);
    expect(dryRunParsed).toMatchObject({ command: "prune", ok: true, schemaVersion: 1 });
    const dryRunData = jsonData(dryRunParsed);
    expect(dryRunData).toMatchObject({ dryRun: true, totalPrunable: 1, totalPruned: 0 });
    expect(JSON.stringify(dryRunData)).toContain(stalePath);
    expect(dryRunResult.stdout).not.toContain("Prunable worktree metadata");

    const pruneResult = await runArashi(workspaceRoot, ["prune", "--json"]);

    expect(pruneResult.exitCode).toBe(0);
    const pruneParsed = parseSingleJsonDocument(pruneResult.stdout);
    expect(pruneParsed).toMatchObject({ command: "prune", ok: true, schemaVersion: 1 });
    const pruneData = jsonData(pruneParsed);
    expect(pruneData).toMatchObject({ dryRun: false, totalPrunable: 1, totalPruned: 1 });
    const listOutput = await runGit(workspaceRoot, ["worktree", "list", "--porcelain"]);
    expect(listOutput).not.toContain(stalePath);
  });

  test("remove --json directs stale worktree metadata to prune", async () => {
    const workspaceRoot = await createCommonWorkspace();
    const stalePath = join(workspaceRoot, "../stale-remove-target");
    await runGit(workspaceRoot, ["worktree", "add", stalePath, "-b", "feat/stale-remove"]);
    await rm(stalePath, { force: true, recursive: true });

    const result = await runArashi(workspaceRoot, [
      "remove",
      "feat/stale-remove",
      "--force",
      "--json",
    ]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "remove",
      error: { code: "BRANCH_NOT_FOUND" },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
    expect(JSON.stringify(parsed)).toContain("arashi prune");
  });

  test("status --json returns exactly one failure envelope outside a workspace", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["status", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "status",
      error: { code: "NOT_IN_WORKSPACE" },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("list --json returns the shared envelope on command-level failure", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["list", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "list",
      error: { code: "NOT_IN_REPOSITORY" },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("shell init --json rejects shell-code output with a structured unsupported-mode error", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["shell", "init", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "shell",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "init" },
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
    expect(result.stdout).not.toContain("function ");
  });

  test("switch --json rejects launch/shell-control modes with a structured unsupported-mode error", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["switch", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "switch",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "launch" },
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("create --json --herdr rejects launch mode before repository mutation", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["create", "feature-herdr-json", "--json", "--herdr"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "create",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "interactive-or-launch" },
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("automation commands expose JSON envelopes or structured unsupported-mode errors", async () => {
    const cwd = await makeTempDir();

    const cases = [
      { args: ["clone", "--json"], code: "JSON_UNSUPPORTED_FOR_MODE", command: "clone" },
      {
        args: ["create", "feature-json", "--json"],
        code: "NOT_IN_REPOSITORY",
        command: "create",
      },
      { args: ["init", "--dry-run", "--json"], code: "INIT_1", command: "init" },
      { args: ["prune", "--json"], code: "NOT_IN_WORKSPACE", command: "prune" },
      { args: ["pull", "--json"], code: "UNKNOWN_ERROR", command: "pull" },
      { args: ["setup", "--json"], code: "UNKNOWN_ERROR", command: "setup" },
      { args: ["sync", "--json"], code: "UNKNOWN_ERROR", command: "sync" },
      { args: ["update", "--json", "--yes"], code: "JSON_UNSUPPORTED_FOR_MODE", command: "update" },
    ];

    for (const testCase of cases) {
      const result = await runArashi(cwd, testCase.args);
      expect(result.exitCode).not.toBe(0);
      const parsed = parseSingleJsonDocument(result.stdout);
      expect(parsed).toMatchObject({
        command: testCase.command,
        error: { code: testCase.code },
        ok: false,
        schemaVersion: 1,
        warnings: [],
      });
    }
  });

  test("install --json returns a structured success envelope", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["install", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "install",
      data: {
        releasesUrl: "https://github.com/corwinm/arashi/releases",
      },
      ok: true,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("init --json suppresses verbose human output", async () => {
    const cwd = await makeTempDir();
    await runGit(cwd, ["init", "-b", "main"]);

    const result = await runArashi(cwd, ["init", "--json", "--verbose", "--no-discover"]);

    expect(result.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "init",
      ok: true,
      schemaVersion: 1,
      warnings: [],
    });
    expect(result.stdout).not.toContain("[VERBOSE]");
  });

  test("add --json reports managed ignore reconciliation in one envelope", async () => {
    const baseDir = await makeTempDir();
    const remote = await createBareRemote(baseDir, "add-json-remote");
    await seedRemote(remote, baseDir, "add-json-seed");
    const workspaceRoot = await makeTempDir();
    await initializeGitRepository(workspaceRoot);
    await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
    await mkdir(join(workspaceRoot, "repos"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".arashi", "config.json"),
      JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }),
    );

    const result = await runArashi(workspaceRoot, ["add", remote, "--json", "--force"]);

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({ command: "add", ok: true, schemaVersion: 1 });
    expect(jsonData(parsed).managedIgnore).toMatchObject({ changed: true, scope: "local" });
    expect(result.stderr).toBe("");
  });

  test("remove --json rejects interactive selection mode with one envelope", async () => {
    const workspaceRoot = await createCommonWorkspace();

    const result = await runArashi(workspaceRoot, ["remove", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "remove",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "interactive-selection" },
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });
});
