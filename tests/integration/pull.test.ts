import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "bun";
import { tmpdir } from "os";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SLOW_PULL_TEST_TIMEOUT = process.platform === "win32" ? 15_000 : 5000;

async function runCommand(cwd: string, args: string[]): Promise<CommandResult> {
  const proc = spawn(args, { cwd, stderr: "pipe", stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr, stdout };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand(cwd, ["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Git command failed");
  }
  return result.stdout.trim();
}

async function createBareRemote(baseDir: string, name: string): Promise<string> {
  const remotePath = join(baseDir, `${name}.git`);
  await runGit(baseDir, ["init", "--bare", remotePath]);
  return remotePath;
}

async function seedRemote(remotePath: string, baseDir: string, seedName: string): Promise<void> {
  const seedPath = join(baseDir, seedName);
  await runGit(baseDir, ["clone", remotePath, seedPath]);
  await runGit(seedPath, ["config", "user.email", "test@example.com"]);
  await runGit(seedPath, ["config", "user.name", "Test User"]);
  await writeFile(join(seedPath, "README.md"), `# ${seedName}`);
  await runGit(seedPath, ["add", "."]);
  await runGit(seedPath, ["commit", "-m", "Initial commit"]);
  await runGit(seedPath, ["push", "origin", "HEAD:main"]);
  await runGit(remotePath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
}

async function createWorkspaceWithRepo(
  baseDir: string,
  options?: { hooksTimeoutMs?: number },
): Promise<{
  workspaceRoot: string;
  mainRemote: string;
  repoRemote: string;
  repoPath: string;
}> {
  const mainRemote = await createBareRemote(baseDir, "main-remote");
  const repoRemote = await createBareRemote(baseDir, "child-remote");

  await seedRemote(mainRemote, baseDir, "main-seed");
  await seedRemote(repoRemote, baseDir, "child-seed");

  const workspaceRoot = join(baseDir, "workspace");
  await runGit(baseDir, ["clone", mainRemote, workspaceRoot]);
  await runGit(workspaceRoot, ["checkout", "-B", "main"]);
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
  await runGit(workspaceRoot, ["config", "user.name", "Test User"]);

  const reposDir = join(workspaceRoot, "repos");
  await mkdir(reposDir, { recursive: true });

  const repoPath = join(reposDir, "repo-a");
  await runGit(reposDir, ["clone", repoRemote, repoPath]);
  await runGit(repoPath, ["checkout", "-B", "main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test User"]);

  const configDir = join(workspaceRoot, ".arashi");
  await mkdir(configDir, { recursive: true });
  const config: Record<string, unknown> = {
    repos: {
      "repo-a": {
        defaultBranch: "main",
        isBare: false,
        path: "./repos/repo-a",
        worktrees: [],
      },
    },
    reposDir: "./repos",
    version: "1.0.0",
  };
  if (options?.hooksTimeoutMs !== undefined) {
    config.hooks = { timeout: options.hooksTimeoutMs };
  }

  await writeFile(join(configDir, "config.json"), JSON.stringify(config, null, 2));

  return { mainRemote, repoPath, repoRemote, workspaceRoot };
}

async function createRemoteCommit(
  ...args: [remotePath: string, baseDir: string, name: string, fileName: string]
): Promise<void> {
  const [remotePath, baseDir, name, fileName] = args;
  const workdir = join(baseDir, name);
  await runGit(baseDir, ["clone", remotePath, workdir]);
  await runGit(workdir, ["fetch", "origin", "main"]);
  await runGit(workdir, ["checkout", "-B", "main", "origin/main"]);
  await runGit(workdir, ["config", "user.email", "test@example.com"]);
  await runGit(workdir, ["config", "user.name", "Test User"]);
  await writeFile(join(workdir, fileName), `update ${Date.now()}`);
  await runGit(workdir, ["add", "."]);
  await runGit(workdir, ["commit", "-m", "Update remote"]);
  await runGit(workdir, ["push", "origin", "HEAD:main"]);
}

async function runPullCommand(workspaceRoot: string, args: string[] = []): Promise<CommandResult> {
  const testFileDir = import.meta.dir;
  const arashiRoot = join(testFileDir, "..", "..");
  const arashiBin = join(arashiRoot, "src", "index.ts");
  return runCommand(workspaceRoot, ["bun", arashiBin, "pull", ...args]);
}

describe("pull command", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-pull-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test(
    "pulls remote changes across multiple repositories",
    async () => {
      const { workspaceRoot, mainRemote, repoRemote } = await createWorkspaceWithRepo(testDir);

      await createRemoteCommit(mainRemote, testDir, "main-remote-update", "main.txt");
      await createRemoteCommit(repoRemote, testDir, "repo-remote-update", "repo.txt");

      const result = await runPullCommand(workspaceRoot);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("updated");
      expect(result.stdout).toContain("repo-a");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test("reports manual-update and rolls back on conflicts or errors", async () => {
    const { workspaceRoot, repoRemote, repoPath } = await createWorkspaceWithRepo(testDir);

    await writeFile(join(repoPath, "README.md"), "local change");
    const headBefore = await runGit(repoPath, ["rev-parse", "HEAD"]);

    await createRemoteCommit(repoRemote, testDir, "repo-remote-update-2", "README.md");

    const result = await runPullCommand(workspaceRoot);

    const headAfter = await runGit(repoPath, ["rev-parse", "HEAD"]);
    const statusAfter = await runGit(repoPath, ["status", "--porcelain"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("manual-update");
    expect(headAfter).toBe(headBefore);
    expect(statusAfter).toContain("README.md");
  });

  test(
    "respects --only repository filtering",
    async () => {
      const { workspaceRoot, mainRemote, repoRemote } = await createWorkspaceWithRepo(testDir);

      await createRemoteCommit(mainRemote, testDir, "main-remote-update-only", "main-only.txt");
      await createRemoteCommit(repoRemote, testDir, "repo-remote-update-only", "repo-only.txt");

      const result = await runPullCommand(workspaceRoot, ["--only", "repo-a"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("repo-a");
      expect(result.stdout).not.toContain("workspace");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test("includes verbose git output when --verbose is set", async () => {
    const { workspaceRoot, repoRemote } = await createWorkspaceWithRepo(testDir);

    await createRemoteCommit(repoRemote, testDir, "repo-remote-update-verbose", "repo-verbose.txt");

    const result = await runPullCommand(workspaceRoot, ["--only", "repo-a", "--verbose"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Updating|Fast-forward/);
  });

  test(
    "reports per-repository timing output",
    async () => {
      const { workspaceRoot, repoRemote } = await createWorkspaceWithRepo(testDir);

      await createRemoteCommit(repoRemote, testDir, "repo-remote-update-timing", "repo-timing.txt");

      const result = await runPullCommand(workspaceRoot, ["--only", "repo-a"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(
        /repo-a: (updated|skipped|failed|manual-update) \(\d+\.\d{2}s\)/,
      );
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test(
    "reports timeout failures in the summary",
    async () => {
      const { workspaceRoot, repoRemote } = await createWorkspaceWithRepo(testDir, {
        hooksTimeoutMs: 1,
      });

      await createRemoteCommit(
        repoRemote,
        testDir,
        "repo-remote-update-timeout",
        "repo-timeout.txt",
      );

      const result = await runPullCommand(workspaceRoot, ["--only", "repo-a"]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("Timed out");
      expect(result.stdout).toContain("overall: failure");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );
});
