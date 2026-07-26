import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises";
import type { RepoStatus } from "../../src/commands/status.ts";
import { join } from "path";
import { repositoryStatusToDoctorFindings } from "../../src/lib/doctor.ts";
import { tmpdir } from "os";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "arashi-doctor-"));
  tempDirs.push(path);
  return path;
};

const runCommand = async (cwd: string, args: string[]): Promise<CommandResult> => {
  const proc = runtime.spawn(args, { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const runArashi = async (cwd: string, args: string[]): Promise<CommandResult> =>
  runCommand(cwd, [
    process.execPath,

    CLI_ENTRY,
    ...args,
  ]);

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runCommand(cwd, ["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Git command failed");
  }
  return result.stdout.trim();
};

const parseSingleJsonDocument = (stdout: string): Record<string, unknown> => {
  expect(stdout.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(stdout);
  expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(stdout);
  return parsed as Record<string, unknown>;
};

const jsonData = (parsed: Record<string, unknown>): Record<string, unknown> => {
  if (parsed.ok === false) {
    return ((parsed.error as Record<string, unknown>).details ?? {}) as Record<string, unknown>;
  }
  return parsed.data as Record<string, unknown>;
};

const jsonFindings = (parsed: Record<string, unknown>): Record<string, unknown>[] => {
  const data = jsonData(parsed);
  expect(Array.isArray(data.findings)).toBe(true);
  return data.findings as Record<string, unknown>[];
};

const writeWorkspaceConfig = async (
  workspaceRoot: string,
  repos: Record<string, { path: string; gitUrl?: string }> = {},
): Promise<void> => {
  await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".arashi", "config.json"),
    JSON.stringify({ repos, reposDir: "./repos", version: "1.0.0" }, null, 2),
  );
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

const createBareRemote = async (baseDir: string, name: string): Promise<string> => {
  const remotePath = join(baseDir, `${name}.git`);
  await runGit(baseDir, ["init", "--bare", remotePath]);
  return remotePath;
};

const seedRemote = async (baseDir: string, remotePath: string, seedName: string): Promise<void> => {
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

const createHealthyRemoteBackedWorkspace = async (): Promise<string> => {
  const baseDir = await makeTempDir();
  const mainRemote = await createBareRemote(baseDir, "main-remote");
  const repoRemote = await createBareRemote(baseDir, "repo-a-remote");
  await seedRemote(baseDir, mainRemote, "main-seed");
  await seedRemote(baseDir, repoRemote, "repo-a-seed");

  const workspaceRoot = join(baseDir, "workspace");
  await runGit(baseDir, ["clone", mainRemote, workspaceRoot]);
  await runGit(workspaceRoot, ["checkout", "-B", "main", "origin/main"]);
  await runGit(workspaceRoot, ["config", "user.email", "test@example.com"]);
  await runGit(workspaceRoot, ["config", "user.name", "Test User"]);
  await mkdir(join(workspaceRoot, "repos"), { recursive: true });
  await runGit(join(workspaceRoot, "repos"), ["clone", repoRemote, "repo-a"]);
  await runGit(join(workspaceRoot, "repos", "repo-a"), ["checkout", "-B", "main", "origin/main"]);
  await writeWorkspaceConfig(workspaceRoot, {
    "repo-a": { gitUrl: repoRemote, path: "./repos/repo-a" },
  });
  await writeFile(join(workspaceRoot, ".gitignore"), "repos/\n.arashi/worktrees/\n");
  await runGit(workspaceRoot, ["add", ".arashi/config.json", ".gitignore"]);
  await runGit(workspaceRoot, ["commit", "-m", "Add Arashi config"]);
  await runGit(workspaceRoot, ["push", "origin", "HEAD:main"]);
  return workspaceRoot;
};

const createLocalWorkspace = async (): Promise<string> => {
  const workspaceRoot = await makeTempDir();
  await initializeGitRepository(workspaceRoot);
  await writeWorkspaceConfig(workspaceRoot, { "repo-a": { path: "./repos/repo-a" } });
  await runGit(workspaceRoot, ["add", ".arashi/config.json"]);
  await runGit(workspaceRoot, ["commit", "-m", "Add Arashi config"]);
  return workspaceRoot;
};

const baseStatus = (): RepoStatus => ({
  branch: {
    ahead: 0,
    behind: 0,
    isDetached: false,
    localBranch: "main",
    remoteBranch: "origin/main",
  },
  defaultBranch: { ahead: 0, behind: 0, branch: "main", state: "available" },
  error: null,
  files: [],
  name: "repo-a",
  path: "/tmp/repo-a",
  refreshWarning: null,
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("arashi doctor", () => {
  test("reports a healthy workspace in human and JSON modes", async () => {
    const workspaceRoot = await createHealthyRemoteBackedWorkspace();

    const human = await runArashi(workspaceRoot, ["doctor"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("No workspace health findings");

    const json = await runArashi(workspaceRoot, ["doctor", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(json.stdout);
    expect(parsed).toMatchObject({ command: "doctor", ok: true, schemaVersion: 1, warnings: [] });
    const data = jsonData(parsed);
    expect(data.workspaceRoot).toBe(await realpath(workspaceRoot));
    expect(data.summary).toMatchObject({ error: 0, info: 0, total: 0, warning: 0 });
    expect(data.findings).toEqual([]);
    expect(json.stdout).not.toContain("Arashi workspace doctor");
  });

  test("checks children but not work-tree status for a bare workspace root", async () => {
    const parent = await makeTempDir();
    const workspaceRoot = join(parent, "workspace.git");
    await runGit(parent, ["init", "--bare", workspaceRoot]);

    const init = await runArashi(workspaceRoot, ["init", "--no-discover", "--json"]);
    expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);

    const childPath = join(workspaceRoot, "repos", "repo-a");
    await initializeGitRepository(childPath);
    await writeFile(join(childPath, "dirty.txt"), "dirty\n");
    await writeWorkspaceConfig(workspaceRoot, { "repo-a": { path: "./repos/repo-a" } });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    const findings = jsonFindings(parseSingleJsonDocument(result.stdout));

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_DIRTY", scope: "repository:repo-a" }),
    );
    expect(findings).not.toContainEqual(
      expect.objectContaining({
        code: "REPOSITORY_STATUS_FAILED",
        details: expect.objectContaining({ path: workspaceRoot }),
      }),
    );
  });

  test("preserves repository findings when root Git metadata is broken", async () => {
    const workspaceRoot = await createLocalWorkspace();
    const childPath = join(workspaceRoot, "repos", "repo-a");
    await initializeGitRepository(childPath);
    await writeFile(join(childPath, "dirty.txt"), "dirty\n");
    await rm(join(workspaceRoot, ".git"), { force: true, recursive: true });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);
    const findings = jsonFindings(parseSingleJsonDocument(result.stdout));

    expect(result.exitCode).toBe(1);
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "REPOSITORY_STATUS_FAILED",
        details: expect.objectContaining({ path: await realpath(workspaceRoot) }),
        scope: "repository:Main Repository",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "REPOSITORY_DIRTY", scope: "repository:repo-a" }),
    );
  });

  test("returns a blocking finding outside a workspace", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "doctor",
      error: { code: "DOCTOR_BLOCKING_FINDINGS" },
      ok: false,
    });
    expect(jsonFindings(parsed)).toContainEqual(
      expect.objectContaining({ code: "DOCTOR_NOT_IN_WORKSPACE", severity: "error" }),
    );
  });

  test("reports invalid configuration as blocking", async () => {
    const workspaceRoot = await makeTempDir();
    await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
    await writeFile(join(workspaceRoot, ".arashi", "config.json"), "{ not json");

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(jsonFindings(parseSingleJsonDocument(result.stdout))).toContainEqual(
      expect.objectContaining({
        category: "configuration",
        code: "CONFIG_LOAD_FAILED",
        severity: "error",
      }),
    );
  });

  test("reports missing and dirty repositories", async () => {
    const workspaceRoot = await createLocalWorkspace();
    await mkdir(join(workspaceRoot, "repos", "repo-a"), { recursive: true });
    await initializeGitRepository(join(workspaceRoot, "repos", "repo-a"));
    await writeFile(join(workspaceRoot, "repos", "repo-a", "dirty.txt"), "dirty\n");
    await writeWorkspaceConfig(workspaceRoot, {
      "missing-repo": { path: "./repos/missing-repo" },
      "repo-a": { path: "./repos/repo-a" },
    });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const codes = jsonFindings(parseSingleJsonDocument(result.stdout)).map(
      (finding) => finding.code,
    );
    expect(codes).toContain("REPOSITORY_MISSING");
    expect(codes).toContain("REPOSITORY_DIRTY");
  });

  test("reports stale worktree metadata without pruning it", async () => {
    const workspaceRoot = await createHealthyRemoteBackedWorkspace();
    const stalePath = join(workspaceRoot, "../doctor-stale-worktree");
    await runGit(workspaceRoot, ["worktree", "add", stalePath, "-b", "feat/doctor-stale"]);
    await rm(stalePath, { force: true, recursive: true });

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(jsonFindings(parseSingleJsonDocument(result.stdout))).toContainEqual(
      expect.objectContaining({ code: "WORKTREE_STALE_METADATA", severity: "warning" }),
    );
    const listOutput = await runGit(workspaceRoot, ["worktree", "list", "--porcelain"]);
    expect(listOutput).toContain(stalePath);
    expect(listOutput).toContain("prunable");
  });

  test("reports hook diagnostics", async () => {
    const workspaceRoot = await createHealthyRemoteBackedWorkspace();
    const hookDir = join(workspaceRoot, ".arashi", "hooks");
    await mkdir(hookDir, { recursive: true });
    const hookPath = join(hookDir, "pre-create.sh");
    await writeFile(hookPath, "#!/bin/sh\nexit 0\n");
    await chmod(hookPath, 0o644);
    await writeFile(join(hookDir, "unsupported-hook.sh"), "#!/bin/sh\nexit 0\n");

    const result = await runArashi(workspaceRoot, ["doctor", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const codes = jsonFindings(parseSingleJsonDocument(result.stdout)).map(
      (finding) => finding.code,
    );
    expect(codes).toContain("HOOK_NOT_EXECUTABLE");
    expect(codes).toContain("HOOK_UNSUPPORTED_DEFINITION");
  });
});

describe("repositoryStatusToDoctorFindings", () => {
  test("classifies branch divergence and default branch drift", () => {
    const status = baseStatus();
    status.branch.ahead = 2;
    status.branch.behind = 1;
    status.defaultBranch = { ahead: 0, behind: 3, branch: "main", state: "available" };

    const codes = repositoryStatusToDoctorFindings(status).map((finding) => finding.code);

    expect(codes).toContain("REPOSITORY_DIVERGED");
    expect(codes).toContain("REPOSITORY_DEFAULT_BRANCH_BEHIND");
  });

  test("classifies detached heads and missing remote refs", () => {
    const detached = baseStatus();
    detached.branch = {
      ahead: 0,
      behind: 0,
      isDetached: true,
      localBranch: "",
      remoteBranch: null,
    };
    const missingRemote = baseStatus();
    missingRemote.refreshWarning = {
      kind: "missing-remote-ref",
      message: "couldn't find remote ref",
    };

    expect(repositoryStatusToDoctorFindings(detached).map((finding) => finding.code)).toContain(
      "REPOSITORY_DETACHED_HEAD",
    );
    expect(
      repositoryStatusToDoctorFindings(missingRemote).map((finding) => finding.code),
    ).toContain("REPOSITORY_MISSING_REMOTE_REF");
  });
});
