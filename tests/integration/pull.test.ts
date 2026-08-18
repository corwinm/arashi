import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SLOW_PULL_TEST_TIMEOUT = 30_000;

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
        groups: ["children"],
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

async function createRemoteBranchCommit(
  remotePath: string,
  baseDir: string,
  name: string,
  branch: string,
  fileName: string,
): Promise<void> {
  const workdir = join(baseDir, name);
  await runGit(baseDir, ["clone", remotePath, workdir]);
  await runGit(workdir, ["checkout", "-B", branch, "origin/main"]);
  await runGit(workdir, ["config", "user.email", "test@example.com"]);
  await runGit(workdir, ["config", "user.name", "Test User"]);
  await writeFile(join(workdir, fileName), `base update ${Date.now()}`);
  await runGit(workdir, ["add", "."]);
  await runGit(workdir, ["commit", "-m", `Update ${branch}`]);
  await runGit(workdir, ["push", "origin", `HEAD:${branch}`]);
}

async function runPullCommand(workspaceRoot: string, args: string[] = []): Promise<CommandResult> {
  const testFileDir = import.meta.dirname;
  const arashiRoot = join(testFileDir, "..", "..");
  const arashiBin = join(arashiRoot, "src", "index.ts");
  return runCommand(workspaceRoot, [
    process.execPath,

    arashiBin,
    "pull",
    ...args,
  ]);
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

  test(
    "pulls the configured base branch into the current branch",
    async () => {
      const { workspaceRoot, repoRemote, repoPath } = await createWorkspaceWithRepo(testDir);
      await createRemoteBranchCommit(
        repoRemote,
        testDir,
        "integration-update",
        "integration",
        "integration.txt",
      );
      await runGit(repoPath, ["checkout", "-b", "feature/from-integration"]);

      const configPath = join(workspaceRoot, ".arashi", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        repos: Record<string, Record<string, unknown>>;
      };
      config.repos["repo-a"]!.baseBranch = "integration";
      await writeFile(configPath, JSON.stringify(config, null, 2));

      const result = await runPullCommand(workspaceRoot, ["--only", "repo-a"]);

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("updated");
      expect(await readFile(join(repoPath, "integration.txt"), "utf8")).toContain("base update");
      expect(await runGit(repoPath, ["branch", "--show-current"])).toBe("feature/from-integration");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test(
    "skips a remote-behind bare workspace root while updating children",
    async () => {
      const mainRemote = await createBareRemote(testDir, "bare-main-remote");
      const repoRemote = await createBareRemote(testDir, "bare-child-remote");
      await seedRemote(mainRemote, testDir, "bare-main-seed");
      await seedRemote(repoRemote, testDir, "bare-child-seed");

      const workspaceRoot = join(testDir, "workspace.git");
      await runGit(testDir, ["clone", "--bare", mainRemote, workspaceRoot]);
      const repoPath = join(workspaceRoot, "repos", "repo-a");
      await mkdir(join(workspaceRoot, "repos"), { recursive: true });
      await runGit(join(workspaceRoot, "repos"), ["clone", repoRemote, repoPath]);
      await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".arashi", "config.json"),
        JSON.stringify(
          {
            repos: { "repo-a": { gitUrl: repoRemote, path: "./repos/repo-a" } },
            reposDir: "./repos",
            version: "1.0.0",
            worktreesDir: "..",
          },
          null,
          2,
        ),
      );

      const bareHeadBefore = await runGit(workspaceRoot, ["rev-parse", "refs/heads/main"]);
      await createRemoteCommit(mainRemote, testDir, "bare-main-update", "main-update.txt");
      await createRemoteCommit(repoRemote, testDir, "bare-child-update", "child-update.txt");
      const remoteHead = await runGit(testDir, ["ls-remote", mainRemote, "refs/heads/main"]);
      expect(remoteHead).not.toContain(bareHeadBefore);

      const result = await runPullCommand(workspaceRoot, ["--json"]);
      const envelope = JSON.parse(result.stdout) as {
        data: { results: { repositoryId: string; status: string }[] };
      };

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(envelope.data.results).toContainEqual({
        elapsedSeconds: 0,
        errorMessage: "Bare workspace root has no work tree; pull skipped.",
        repositoryId: "workspace.git",
        status: "skipped",
      });
      expect(envelope.data.results).toContainEqual(
        expect.objectContaining({ repositoryId: "repo-a", status: "updated" }),
      );
      expect(await runGit(workspaceRoot, ["rev-parse", "refs/heads/main"])).toBe(bareHeadBefore);
      expect(await readFile(join(repoPath, "child-update.txt"), "utf8")).toContain("update");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test(
    "reports manual-update and rolls back on conflicts or errors",
    async () => {
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
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

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

  test(
    "pulls the selected parent before tracked managed-ignore reconciliation",
    async () => {
      const { workspaceRoot, mainRemote } = await createWorkspaceWithRepo(testDir);
      await runGit(workspaceRoot, ["config", "--local", "arashi.ignoreScope", "tracked"]);
      await createRemoteCommit(mainRemote, testDir, "main-ignore-update", ".gitignore");

      const result = await runPullCommand(workspaceRoot, ["--only", "workspace"]);
      const trackedIgnore = await readFile(join(workspaceRoot, ".gitignore"), "utf8");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("updated");
      expect(trackedIgnore).toContain("update");
      expect(trackedIgnore).toContain("/repos/");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test(
    "reloads parent config and reconciles changed managed paths before child processing",
    async () => {
      const { workspaceRoot, mainRemote } = await createWorkspaceWithRepo(testDir);
      await runGit(workspaceRoot, ["add", ".arashi/config.json"]);
      await runGit(workspaceRoot, ["commit", "-m", "Track workspace config"]);
      await runGit(workspaceRoot, ["push", "origin", "HEAD:main"]);

      const updater = join(testDir, "main-config-update");
      await runGit(testDir, ["clone", mainRemote, updater]);
      await runGit(updater, ["checkout", "-B", "main", "origin/main"]);
      await runGit(updater, ["config", "user.email", "test@example.com"]);
      await runGit(updater, ["config", "user.name", "Test User"]);
      const config = JSON.parse(
        await readFile(join(updater, ".arashi", "config.json"), "utf8"),
      ) as Record<string, unknown>;
      config.reposDir = "./managed-repos";
      config.worktreesDir = "./managed-worktrees";
      (config.repos as Record<string, unknown>)["new-child"] = {
        gitUrl: "https://example.invalid/new-child.git",
        path: "./managed-repos/new-child",
      };
      await writeFile(join(updater, ".arashi", "config.json"), JSON.stringify(config, null, 2));
      await runGit(updater, ["add", ".arashi/config.json"]);
      await runGit(updater, ["commit", "-m", "Change managed paths"]);
      await runGit(updater, ["push", "origin", "HEAD:main"]);

      const result = await runPullCommand(workspaceRoot);
      const exclude = await readFile(join(workspaceRoot, ".git", "info", "exclude"), "utf8");

      expect(result.exitCode).toBe(0);
      expect(exclude).toContain("managed-repos/");
      expect(exclude).toContain("managed-worktrees/");
      expect(result.stdout).toContain("arashi clone");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test(
    "respects --group repository filtering",
    async () => {
      const { workspaceRoot, mainRemote, repoRemote } = await createWorkspaceWithRepo(testDir);

      await createRemoteCommit(mainRemote, testDir, "main-remote-update-group", "main-group.txt");
      await createRemoteCommit(repoRemote, testDir, "repo-remote-update-group", "repo-group.txt");

      const result = await runPullCommand(workspaceRoot, ["--group", "children"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("repo-a");
      expect(result.stdout).not.toContain("workspace");
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

  test(
    "includes verbose git output when --verbose is set",
    async () => {
      const { workspaceRoot, repoRemote } = await createWorkspaceWithRepo(testDir);

      await createRemoteCommit(
        repoRemote,
        testDir,
        "repo-remote-update-verbose",
        "repo-verbose.txt",
      );

      const result = await runPullCommand(workspaceRoot, ["--only", "repo-a", "--verbose"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Updating|Fast-forward/);
    },
    SLOW_PULL_TEST_TIMEOUT,
  );

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
import { spawn } from "../helpers/node-runtime.ts";
