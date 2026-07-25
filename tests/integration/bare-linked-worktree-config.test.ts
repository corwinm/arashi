import { afterEach, describe, expect, test } from "vitest";
import { mkdir, realpath } from "fs/promises";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { existsSync } from "fs";
import { findWorkspaceRoot } from "../../src/lib/config.ts";
import { join, resolve } from "path";
import { pathToFileURL } from "node:url";
import { runtime } from "../helpers/node-runtime.ts";

type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
let workspace: BareCreateWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

async function configureBareWorkspace(): Promise<BareCreateWorkspace> {
  const createdWorkspace = await createBareCreateWorkspace({ includeConfig: false });
  await mkdir(join(createdWorkspace.bareRepoPath, ".arashi"), { recursive: true });
  await mkdir(join(createdWorkspace.bareRepoPath, "repos"), { recursive: true });
  await runtime.write(
    join(createdWorkspace.bareRepoPath, ".arashi", "config.json"),
    JSON.stringify(
      {
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir: ".arashi/worktrees",
      },
      null,
      2,
    ),
  );
  return createdWorkspace;
}

async function execGit(args: string[], cwd: string): Promise<void> {
  const proc = runtime.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit=${exitCode}): ${stderr}`);
  }
}

describe("configured bare workspace discovery from linked worktrees", () => {
  test("finds the parent bare workspace from a nested child repository", async () => {
    workspace = await configureBareWorkspace();
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);

    await expect(findWorkspaceRoot(childPath)).resolves.toBe(
      await realpath(workspace.bareRepoPath),
    );
  });

  test("adds a repository when invoked from a linked worktree", async () => {
    workspace = await configureBareWorkspace();
    const sourcePath = join(workspace.rootPath, "source-repository");
    await mkdir(sourcePath, { recursive: true });
    await execGit(["init", "-b", "main"], sourcePath);
    await execGit(["config", "user.name", "Test User"], sourcePath);
    await execGit(["config", "user.email", "test@example.com"], sourcePath);
    await execGit(["config", "commit.gpgsign", "false"], sourcePath);
    await runtime.write(join(sourcePath, "README.md"), "# Source repository\n");
    await execGit(["add", "."], sourcePath);
    await execGit(["commit", "-m", "Initial content"], sourcePath);

    const command = runtime.spawn(
      [process.execPath, CLI_ENTRY, "add", pathToFileURL(sourcePath).href, "--force", "--json"],
      {
        cwd: workspace.worktreePath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(existsSync(join(workspace.bareRepoPath, "repos", "source-repository"))).toBe(true);
    const config = JSON.parse(
      await runtime.file(join(workspace.bareRepoPath, ".arashi", "config.json")).text(),
    ) as { repos: Record<string, { path: string }> };
    expect(resolve(workspace.bareRepoPath, config.repos["source-repository"]?.path ?? "")).toBe(
      resolve(workspace.bareRepoPath, "repos", "source-repository"),
    );
  });
});
