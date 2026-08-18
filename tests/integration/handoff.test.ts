import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { basename, join } from "path";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { createCommand } from "../../src/commands/handoff.ts";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "arashi-handoff-"));
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

const writeWorkspaceConfig = async (workspaceRoot: string, baseBranch?: string): Promise<void> => {
  await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".arashi", "config.json"),
    JSON.stringify(
      {
        baseBranch,
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
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(stdout);
  return parsed;
};

const captureWorkspaceGitState = async (workspaceRoot: string): Promise<string[]> =>
  await Promise.all(
    [
      workspaceRoot,
      join(workspaceRoot, "repos", "repo-a"),
      join(workspaceRoot, "repos", "repo-b"),
    ].map(async (repository) =>
      [
        await runGit(repository, ["rev-parse", "HEAD"]),
        await runGit(repository, ["branch", "--show-current"]),
        await runGit(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
      ].join("\n"),
    ),
  );

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("handoff command", () => {
  test("registers --markdown as hidden deprecated compatibility syntax and omits it from help", () => {
    const command = createCommand();
    expect(command.options.find((option) => option.long === "--markdown")).toMatchObject({
      deprecated: true,
      hidden: true,
    });

    let help = "";
    command.configureOutput({ writeOut: (value) => (help += value) }).outputHelp();
    expect(help).not.toContain("--markdown");
    expect(help).toContain("--json");
  });

  test("keeps explicit --markdown equivalent and non-mutating while warning only for deprecated syntax", async () => {
    const workspaceRoot = await createWorkspace();
    await writeFile(join(workspaceRoot, "repos", "repo-b", "dirty.txt"), "dirty\n");
    const before = await captureWorkspaceGitState(workspaceRoot);

    const omitted = await runArashi(workspaceRoot, ["handoff"]);
    const explicit = await runArashi(workspaceRoot, ["handoff", "--markdown"]);

    expect(omitted.exitCode).toBe(0);
    expect(explicit.exitCode).toBe(omitted.exitCode);
    expect(explicit.stdout).toBe(omitted.stdout);
    expect(omitted.stderr).toBe("");
    expect(explicit.stderr).toBe(
      "⚠ --markdown is deprecated; omit --markdown and use the default Markdown output.\n",
    );
    expect(await captureWorkspaceGitState(workspaceRoot)).toEqual(before);
  });

  test("gives JSON precedence over deprecated --markdown without human leakage", async () => {
    const workspaceRoot = await createWorkspace();
    const before = await captureWorkspaceGitState(workspaceRoot);

    const result = await runArashi(workspaceRoot, ["handoff", "--markdown", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("deprecated");
    expect(result.stdout).not.toContain("# Arashi Handoff Report");
    expect(parseJson(result.stdout)).toMatchObject({
      command: "handoff",
      ok: true,
      schemaVersion: 1,
    });
    expect(await captureWorkspaceGitState(workspaceRoot)).toEqual(before);
  });

  test("generates a Markdown workspace handoff report with supplied context", async () => {
    const workspaceRoot = await createWorkspace();
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    await writeFile(join(workspaceRoot, "repos", "repo-b", "dirty.txt"), "dirty\n");

    const result = await runArashi(join(workspaceRoot, "repos", "repo-b"), [
      "handoff",
      "--link",
      "https://github.com/corwinm/arashi-arashi/issues/186",
      "--link",
      "https://github.com/corwinm/arashi/pull/120",
      "--validation",
      "pnpm run test — passed",
      "--todo",
      "watch CI",
      "--risk",
      "Windows CI pending",
      "--risk",
      "Review pending",
      "--next-command",
      "gh pr checks 123 --repo corwinm/arashi",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Arashi Handoff Report");
    expect(result.stdout).toContain("- Path: ");
    expect(result.stdout).toContain(basename(resolvedWorkspaceRoot));
    expect(result.stdout).toContain("- Branch: main");
    expect(result.stdout).toContain("Current repository: repo-b (");
    expect(result.stdout.replaceAll("\\", "/")).toContain(
      `${basename(resolvedWorkspaceRoot)}/repos/repo-b`,
    );
    expect(result.stdout).toContain("repo-b: dirty; branch main; 1 changed file");
    expect(result.stdout).toContain("https://github.com/corwinm/arashi-arashi/issues/186");
    expect(result.stdout).toContain("https://github.com/corwinm/arashi/pull/120");
    expect(result.stdout).toContain("pnpm run test — passed");
    expect(result.stdout).toContain("- [ ] watch CI");
    expect(result.stdout).toContain("Windows CI pending");
    expect(result.stdout).toContain("Review pending");
    expect(result.stdout).toContain("`gh pr checks 123 --repo corwinm/arashi`");
    expect(result.stdout).toContain("`arashi status --verbose`");
  });

  test("emits one JSON envelope preserving supplied context and status data", async () => {
    const workspaceRoot = await createWorkspace();
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    await writeFile(join(workspaceRoot, "repos", "repo-a", "dirty.txt"), "dirty\n");

    const result = await runArashi(workspaceRoot, [
      "handoff",
      "--json",
      "--link",
      "https://example.test/pr/1",
      "--validation",
      "openspec validate add-agent-handoff-report — passed",
      "--todo",
      "finish docs",
      "--risk",
      "deploy preview pending",
      "--next-command",
      "arashi status",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("# Arashi Handoff Report");
    const parsed = parseJson(result.stdout);
    expect(parsed).toMatchObject({ command: "handoff", ok: true, schemaVersion: 1 });
    const data = parsed.data as Record<string, unknown>;
    expect(data.workspace).toMatchObject({ branch: "main" });
    expect((data.workspace as Record<string, unknown>).path).toEqual(
      expect.stringContaining(basename(resolvedWorkspaceRoot)),
    );
    expect(data.context).toMatchObject({
      links: ["https://example.test/pr/1"],
      nextCommands: ["arashi status"],
      risks: ["deploy preview pending"],
      todos: ["finish docs"],
      validations: ["openspec validate add-agent-handoff-report — passed"],
    });
    expect(data.summary).toMatchObject({ cleanCount: 2, dirtyCount: 1, total: 3, touchedCount: 1 });
    const repositories = data.repositories as Record<string, unknown>[];
    expect(repositories.find((repo) => repo.name === "repo-a")).toMatchObject({
      changeCount: 1,
      state: "dirty",
    });
  });

  test("reports configured-base drift in Markdown and structured handoff data", async () => {
    const workspaceRoot = await createWorkspace();
    await writeWorkspaceConfig(workspaceRoot, "main");
    await runGit(workspaceRoot, ["add", ".arashi/config.json"]);
    await runGit(workspaceRoot, ["commit", "-m", "Configure base branch"]);
    await runGit(workspaceRoot, ["checkout", "-b", "feature/handoff"]);
    await runGit(workspaceRoot, ["checkout", "main"]);
    await writeFile(join(workspaceRoot, "base-update.txt"), "base update\n");
    await runGit(workspaceRoot, ["add", "base-update.txt"]);
    await runGit(workspaceRoot, ["commit", "-m", "Advance configured base"]);
    await runGit(workspaceRoot, ["checkout", "feature/handoff"]);

    const markdown = await runArashi(workspaceRoot, ["handoff"]);
    const json = await runArashi(workspaceRoot, ["handoff", "--json"]);

    expect(markdown.exitCode).toBe(0);
    expect(markdown.stdout).toContain("base/default main behind by 1");
    expect(markdown.stdout).toContain("`arashi status --verbose`");
    const repositories = (parseJson(json.stdout).data as Record<string, unknown>)
      .repositories as Record<string, unknown>[];
    expect(repositories.find((repo) => repo.name === "Main Repository")).toMatchObject({
      baseBranch: { behind: 1, branch: "main", state: "available" },
      baseBranchSource: "workspace-config",
      defaultBranch: { behind: 1, branch: "main", state: "available" },
    });
  });

  test("returns a structured JSON error outside a workspace", async () => {
    const outside = await makeTempDir();

    const result = await runArashi(outside, ["handoff", "--json"]);

    expect(result.exitCode).toBe(2);
    const parsed = parseJson(result.stdout);
    expect(parsed).toMatchObject({
      command: "handoff",
      error: { code: "NOT_IN_WORKSPACE" },
      ok: false,
      schemaVersion: 1,
    });
  });
});
