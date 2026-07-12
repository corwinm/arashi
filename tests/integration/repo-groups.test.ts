import { runtime } from "#test-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
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
  const path = await mkdtemp(join(tmpdir(), "arashi-repo-groups-"));
  tempDirs.push(path);
  return path;
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

const runArashi = async (cwd: string, args: string[]): Promise<CommandResult> =>
  await runCommand(cwd, [
    process.execPath,
    "--no-warnings",
    "--experimental-transform-types",
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
          "repo-a": { groups: ["core", "shared"], path: "./repos/repo-a" },
          "repo-b": { groups: ["docs", "shared"], path: "./repos/repo-b" },
        },
        reposDir: "./repos",
        version: "1.0.0",
      },
      null,
      2,
    ),
  );
};

const createWorkspace = async (): Promise<string> => {
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

const parseJson = (stdout: string): Record<string, unknown> => {
  expect(stdout.endsWith("\n")).toBe(true);
  return JSON.parse(stdout) as Record<string, unknown>;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("repository group command integration", () => {
  test("status --group filters human and JSON output and reports unknown groups", async () => {
    const workspaceRoot = await createWorkspace();

    const human = await runArashi(workspaceRoot, ["status", "--group", "core"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("repo-a");
    expect(human.stdout).not.toContain("repo-b");
    expect(human.stdout).toContain("Summary: 2 clean, 0 dirty (2 total)");

    const json = await runArashi(workspaceRoot, ["status", "--group", "docs", "--json"]);
    expect(json.exitCode).toBe(0);
    const envelope = parseJson(json.stdout);
    expect(envelope).toMatchObject({ command: "status", ok: true });
    expect(envelope.data).toMatchObject({
      filters: { groups: ["docs"], only: [] },
      summary: { cleanCount: 2, dirtyCount: 0, total: 2 },
    });
    const jsonRepositoryNames = (
      envelope.data as { repositories: { name: string }[] }
    ).repositories.map((repo) => repo.name);
    expect(jsonRepositoryNames).toContain("repo-b");
    expect(jsonRepositoryNames).not.toContain("repo-a");

    const unknown = await runArashi(workspaceRoot, ["status", "--group", "missing", "--json"]);
    expect(unknown.exitCode).toBe(2);
    expect(parseJson(unknown.stdout)).toMatchObject({
      command: "status",
      error: {
        code: "UNKNOWN_REPOSITORY_GROUPS",
        details: { groups: ["missing"], unknownGroups: ["missing"] },
      },
      ok: false,
    });
  });

  test("create --group supports dry-run planning and rejects empty intersections before mutation", async () => {
    const workspaceRoot = await createWorkspace();

    const dryRun = await runArashi(workspaceRoot, [
      "create",
      "feature/group-dry-run",
      "--group",
      "core",
      "--dry-run",
    ]);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain("Planning worktrees in 1 repository");
    expect(dryRun.stdout).toContain("repo-a: feature/group-dry-run");
    expect(dryRun.stdout).not.toContain("repo-b: feature/group-dry-run");
    expect(
      await runGit(join(workspaceRoot, "repos", "repo-a"), [
        "branch",
        "--list",
        "feature/group-dry-run",
      ]),
    ).toBe("");

    const empty = await runArashi(workspaceRoot, [
      "create",
      "feature/group-empty",
      "--only",
      "repo-b",
      "--group",
      "core",
    ]);
    expect(empty.exitCode).not.toBe(0);
    expect(empty.stderr + empty.stdout).toContain(
      "No repositories matched the combined --only/--group filters",
    );
    expect(
      await runGit(join(workspaceRoot, "repos", "repo-b"), [
        "branch",
        "--list",
        "feature/group-empty",
      ]),
    ).toBe("");
  });

  test("exec --group supports multi-group selection and --only intersections", async () => {
    const workspaceRoot = await createWorkspace();

    const multiGroup = await runArashi(workspaceRoot, [
      "exec",
      "--group",
      "core,docs",
      "--",
      "pwd",
    ]);
    expect(multiGroup.exitCode).toBe(0);
    expect(multiGroup.stdout).toContain("[repo-a] ok (0)");
    expect(multiGroup.stdout).toContain("[repo-b] ok (0)");
    expect(multiGroup.stdout).toContain("Summary: 2 passed, 0 failed, 0 skipped, 2 total");

    const intersection = await runArashi(workspaceRoot, [
      "exec",
      "--group",
      "shared",
      "--only",
      "repo-a",
      "--",
      "pwd",
    ]);
    expect(intersection.exitCode).toBe(0);
    expect(intersection.stdout).toContain("[repo-a] ok (0)");
    expect(intersection.stdout).not.toContain("[repo-b]");
  });
});
