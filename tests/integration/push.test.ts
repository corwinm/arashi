import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const PUSH_TEST_TIMEOUT = process.platform === "win32" ? 30_000 : 10_000;

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

async function createWorkspaceWithRepo(baseDir: string): Promise<{
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
  await runGit(workspaceRoot, ["checkout", "-B", "main", "origin/main"]);
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
  await runGit(workspaceRoot, ["config", "user.name", "Test User"]);

  const reposDir = join(workspaceRoot, "repos");
  await mkdir(reposDir, { recursive: true });
  const repoPath = join(reposDir, "repo-a");
  await runGit(reposDir, ["clone", repoRemote, repoPath]);
  await runGit(repoPath, ["checkout", "-B", "main", "origin/main"]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test User"]);

  const configDir = join(workspaceRoot, ".arashi");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
  );

  return { mainRemote, repoPath, repoRemote, workspaceRoot };
}

async function commitFile(repoPath: string, fileName: string, content: string): Promise<void> {
  await writeFile(join(repoPath, fileName), content);
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, ["commit", "-m", `Update ${fileName}`]);
}

async function runPushCommand(workspaceRoot: string, args: string[] = []): Promise<CommandResult> {
  const arashiRoot = join(import.meta.dirname, "..", "..");
  const arashiBin = join(arashiRoot, "src", "index.ts");
  return runCommand(workspaceRoot, [
    process.execPath,
    "--import",
    "tsx",
    arashiBin,
    "push",
    ...args,
  ]);
}

describe("push command", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-push-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test(
    "pushes eligible repositories with upstream setup and skips untouched child repositories",
    async () => {
      const { workspaceRoot, mainRemote, repoRemote } = await createWorkspaceWithRepo(testDir);
      await runGit(workspaceRoot, ["checkout", "-b", "feature/push"]);
      await runGit(join(workspaceRoot, "repos", "repo-a"), ["checkout", "-b", "feature/push"]);
      await commitFile(workspaceRoot, "feature.txt", "main change");

      const result = await runPushCommand(workspaceRoot, ["--set-upstream"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("workspace: pushed");
      expect(result.stdout).toContain("repo-a: skipped");
      expect(await runGit(mainRemote, ["rev-parse", "refs/heads/feature/push"])).not.toBe("");
      const childRef = await runCommand(repoRemote, [
        "git",
        "rev-parse",
        "--verify",
        "refs/heads/feature/push",
      ]);
      expect(childRef.exitCode).not.toBe(0);
    },
    PUSH_TEST_TIMEOUT,
  );

  test(
    "respects --only filtering and emits one JSON document",
    async () => {
      const { workspaceRoot, repoPath, repoRemote } = await createWorkspaceWithRepo(testDir);
      await runGit(workspaceRoot, ["checkout", "-b", "feature/json"]);
      await runGit(repoPath, ["checkout", "-b", "feature/json"]);
      await commitFile(workspaceRoot, "main-only.txt", "main change");
      await commitFile(repoPath, "child-only.txt", "child change");

      const result = await runPushCommand(workspaceRoot, [
        "--only",
        "repo-a",
        "--set-upstream",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe("push");
      expect(envelope.data.totals.pushed).toBe(1);
      expect(envelope.data.results[0].repositoryId).toBe("repo-a");
      expect(await runGit(repoRemote, ["rev-parse", "refs/heads/feature/json"])).not.toBe("");
      expect(result.stdout.trim().split("\n")[0]).toBe("{");
    },
    PUSH_TEST_TIMEOUT,
  );

  test(
    "respects --group filtering",
    async () => {
      const { workspaceRoot, repoPath, repoRemote } = await createWorkspaceWithRepo(testDir);
      await runGit(workspaceRoot, ["checkout", "-b", "feature/group"]);
      await runGit(repoPath, ["checkout", "-b", "feature/group"]);
      await commitFile(workspaceRoot, "main-group.txt", "main change");
      await commitFile(repoPath, "child-group.txt", "child change");

      const result = await runPushCommand(workspaceRoot, [
        "--group",
        "children",
        "--set-upstream",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.totals.pushed).toBe(1);
      expect(
        envelope.data.results.map((entry: { repositoryId: string }) => entry.repositoryId),
      ).toEqual(["repo-a"]);
      expect(await runGit(repoRemote, ["rev-parse", "refs/heads/feature/group"])).not.toBe("");
    },
    PUSH_TEST_TIMEOUT,
  );

  test(
    "dry-run previews without mutating remotes and missing upstream skips with guidance",
    async () => {
      const { workspaceRoot, mainRemote } = await createWorkspaceWithRepo(testDir);
      await runGit(workspaceRoot, ["checkout", "-b", "feature/dry-run"]);
      await commitFile(workspaceRoot, "dry-run.txt", "preview");

      const skipped = await runPushCommand(workspaceRoot, []);
      expect(skipped.exitCode).toBe(0);
      expect(skipped.stdout).toContain("--set-upstream");

      const preview = await runPushCommand(workspaceRoot, [
        "--set-upstream",
        "--dry-run",
        "--json",
      ]);
      expect(preview.exitCode).toBe(0);
      const envelope = JSON.parse(preview.stdout);
      expect(envelope.data.dryRun).toBe(true);
      expect(envelope.data.totals.planned).toBe(1);
      const remoteRef = await runCommand(mainRemote, [
        "git",
        "rev-parse",
        "--verify",
        "refs/heads/feature/dry-run",
      ]);
      expect(remoteRef.exitCode).not.toBe(0);
    },
    PUSH_TEST_TIMEOUT,
  );
});
import { spawn } from "#test-runtime";
