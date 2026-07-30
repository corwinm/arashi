import { runtime } from "../helpers/node-runtime.ts";
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
  const path = await mkdtemp(join(tmpdir(), "arashi-exec-"));
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
          "repo-a": { path: "./repos/repo-a" },
          "repo-b": { path: "./repos/repo-b" },
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

const jsonData = (parsed: Record<string, unknown>): Record<string, unknown> => {
  expect(parsed.data).toBeDefined();
  return parsed.data as Record<string, unknown>;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("exec command", () => {
  test("runs a passing command once per selected repository with cwd set to repository path", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await runArashi(workspaceRoot, [
      "exec",
      "--only",
      "repo-a",
      "--only",
      "repo-b",
      "--",
      "pwd",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[repo-a] ok (0)");
    expect(result.stdout).toContain(join(workspaceRoot, "repos", "repo-a"));
    expect(result.stdout).toContain("[repo-b] ok (0)");
    expect(result.stdout).toContain(join(workspaceRoot, "repos", "repo-b"));
    expect(result.stdout).toContain("Summary: 2 passed, 0 failed, 0 skipped, 2 total");
  });

  test("returns a non-zero aggregate exit when any selected repository fails", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await runArashi(workspaceRoot, [
      "exec",
      "--only",
      "repo-a",
      "--",
      "sh",
      "-c",
      "echo nope >&2; exit 7",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[repo-a] failed (7)");
    expect(result.stdout).toContain("nope");
    expect(result.stdout).toContain("Summary: 0 passed, 1 failed, 0 skipped, 1 total");
  });

  test("filters with --only and reports unknown repositories as usage errors", async () => {
    const workspaceRoot = await createWorkspace();

    const filtered = await runArashi(workspaceRoot, ["exec", "--only", "repo-b", "--", "pwd"]);
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).not.toContain("[repo-a]");
    expect(filtered.stdout).toContain("[repo-b] ok (0)");

    const commaSeparated = await runArashi(workspaceRoot, [
      "exec",
      "--only",
      "repo-a,repo-b",
      "--",
      "pwd",
    ]);
    expect(commaSeparated.exitCode).toBe(0);
    expect(commaSeparated.stdout).toContain("[repo-a] ok (0)");
    expect(commaSeparated.stdout).toContain("[repo-b] ok (0)");

    const missing = await runArashi(workspaceRoot, ["exec", "--only", "missing", "--", "pwd"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("Unknown repositories in --only filter: missing");
  });

  test("supports --dirty and no-match cases", async () => {
    const workspaceRoot = await createWorkspace();

    const clean = await runArashi(workspaceRoot, ["exec", "--dirty", "--", "pwd"]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain("No repositories selected for exec");

    await writeFile(join(workspaceRoot, "repos", "repo-b", "dirty.txt"), "dirty\n");
    const dirty = await runArashi(workspaceRoot, ["exec", "--dirty", "--", "pwd"]);
    expect(dirty.exitCode).toBe(0);
    expect(dirty.stdout).not.toContain("[repo-a]");
    expect(dirty.stdout).toContain("[repo-b] ok (0)");
  });

  test("--json emits one envelope on stdout and isolates child stdout", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await runArashi(workspaceRoot, [
      "exec",
      "--only",
      "repo-a",
      "--json",
      "--",
      "sh",
      "-c",
      "echo child-stdout; echo child-stderr >&2",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = parseJson(result.stdout);
    expect(parsed).toMatchObject({ command: "exec", ok: true, schemaVersion: 1, warnings: [] });
    const data = jsonData(parsed);
    expect(data).toMatchObject({ failed: 0, passed: 1, skipped: 0, total: 1 });
    const results = data.results as Record<string, unknown>[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      repositoryId: "repo-a",
      stderr: "child-stderr\n",
      stdout: "child-stdout\n",
    });
  });

  test("--json emits an error envelope with per-repository details on child failures", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await runArashi(workspaceRoot, [
      "exec",
      "--only",
      "repo-a",
      "--json",
      "--",
      "sh",
      "-c",
      "echo bad >&2; exit 4",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = parseJson(result.stdout);
    expect(parsed).toMatchObject({
      command: "exec",
      error: { code: "EXEC_COMMAND_FAILED" },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
    const details = (parsed.error as Record<string, unknown>).details as Record<string, unknown>;
    expect(details).toMatchObject({ failed: 1, passed: 0, skipped: 0, total: 1 });
    const results = details.results as Record<string, unknown>[];
    expect(results[0]).toMatchObject({ exitCode: 4, repositoryId: "repo-a", stderr: "bad\n" });
  });

  test("--jobs runs selected repositories concurrently", async () => {
    const workspaceRoot = await createWorkspace();
    const startedAt = Date.now();

    const result = await runArashi(workspaceRoot, [
      "exec",
      "--only",
      "repo-a",
      "--only",
      "repo-b",
      "--jobs",
      "2",
      "--",
      "sh",
      "-c",
      "sleep 1.5; echo done",
    ]);

    const elapsedMs = Date.now() - startedAt;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Summary: 2 passed, 0 failed, 0 skipped, 2 total");
    expect(elapsedMs).toBeLessThan(2900);
  });

  test("--fail-fast stops starting repositories after the first failure", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await runArashi(workspaceRoot, [
      "exec",
      "--only",
      "repo-a",
      "--only",
      "repo-b",
      "--fail-fast",
      "--",
      "sh",
      "-c",
      'test "$(basename "$PWD")" = repo-a && exit 3 || echo should-not-run',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[repo-a] failed (3)");
    expect(result.stdout).toContain("[repo-b] not-started (n/a)");
    expect(result.stdout).toContain("Summary: 0 passed, 1 failed, 1 skipped, 2 total");
  });
});
