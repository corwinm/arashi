/**
 * Test helpers for remove command
 */

import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "bun";
import { tmpdir } from "os";

export interface RemoveTestRepository {
  name: string;
  path: string;
}

export interface RemoveTestWorkspace {
  rootPath: string;
  repos: RemoveTestRepository[];
  cleanup: () => Promise<void>;
}

export async function createRemoveWorkspace(
  repoNames: string[] = ["repo-a", "repo-b"],
): Promise<RemoveTestWorkspace> {
  const rootPath = await mkdtemp(join(tmpdir(), "arashi-remove-test-"));
  await initGitRepo(rootPath, "main");

  const reposDir = join(rootPath, "repos");
  await mkdir(reposDir, { recursive: true });

  const repos: RemoveTestRepository[] = [];
  for (const name of repoNames) {
    const repoPath = join(reposDir, name);
    await mkdir(repoPath, { recursive: true });
    await initGitRepo(repoPath, "main");
    repos.push({ name, path: repoPath });
  }

  const config = {
    repos: Object.fromEntries(
      repos.map((repo) => [
        repo.name,
        {
          defaultBranch: "main",
          isBare: false,
          path: `./repos/${repo.name}`,
          worktrees: [],
        },
      ]),
    ),
    reposDir: "./repos",
    version: "1.0.0",
  };

  await mkdir(join(rootPath, ".arashi"), { recursive: true });
  await writeFile(join(rootPath, ".arashi", "config.json"), JSON.stringify(config, null, 2));

  const cleanup = async () => {
    await rm(rootPath, { force: true, recursive: true });
  };

  return { cleanup, repos, rootPath };
}

export async function createWorktree(
  repoPath: string,
  branchName: string,
  worktreePath: string,
): Promise<void> {
  await ensureBranch(repoPath, branchName);
  await spawn(["git", "worktree", "add", worktreePath, branchName], { cwd: repoPath }).exited;
}

export async function createWorktreesForBranch(
  workspace: RemoveTestWorkspace,
  branchName: string,
  includeMain = true,
): Promise<Record<string, string>> {
  const worktrees: Record<string, string> = {};
  const baseDir = join(workspace.rootPath, "worktrees");
  await mkdir(baseDir, { recursive: true });

  if (includeMain) {
    const mainWorktree = join(baseDir, `main-${branchName}`);
    await createWorktree(workspace.rootPath, branchName, mainWorktree);
    worktrees["main"] = mainWorktree;
  }

  for (const repo of workspace.repos) {
    const wtPath = join(baseDir, `${repo.name}-${branchName}`);
    await createWorktree(repo.path, branchName, wtPath);
    worktrees[repo.name] = wtPath;
  }

  return worktrees;
}

export async function createNestedWorktrees(
  workspace: RemoveTestWorkspace,
  parentBranch: string,
  childBranches: Record<string, string>,
): Promise<{ parentPath: string; childPaths: Record<string, string> }> {
  const baseDir = join(workspace.rootPath, "worktrees");
  await mkdir(baseDir, { recursive: true });

  const parentPath = join(baseDir, `parent-${parentBranch}`);
  await createWorktree(workspace.rootPath, parentBranch, parentPath);

  const childBase = join(parentPath, "repos");
  await mkdir(childBase, { recursive: true });

  const childPaths: Record<string, string> = {};
  for (const repo of workspace.repos) {
    const branchName = childBranches[repo.name] ?? parentBranch;
    const worktreePath = join(childBase, repo.name);
    await createWorktree(repo.path, branchName, worktreePath);
    childPaths[repo.name] = worktreePath;
  }

  return { childPaths, parentPath };
}

export async function markWorktreeDirty(worktreePath: string): Promise<void> {
  const filePath = join(worktreePath, "dirty.txt");
  await writeFile(filePath, "dirty");
}

async function initGitRepo(repoPath: string, branch: string): Promise<void> {
  await runGit(repoPath, ["init", "-b", branch]);
  await runGit(repoPath, ["config", "user.email", "test@example.com"]);
  await runGit(repoPath, ["config", "user.name", "Test User"]);
  await writeFile(join(repoPath, "README.md"), "# Test Repo");
  await runGit(repoPath, ["add", "."]);
  await runGit(repoPath, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-m",
    "Initial commit",
  ]);
}

async function ensureBranch(repoPath: string, branchName: string): Promise<void> {
  const check = spawn(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
  const exitCode = await check.exited;
  if (exitCode !== 0) {
    await runGit(repoPath, ["branch", branchName]);
  }
}

async function runGit(repoPath: string, args: string[]): Promise<void> {
  const proc = spawn(["git", ...args], { cwd: repoPath, stderr: "pipe", stdout: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`git ${args.join(" ")} failed in ${repoPath}: ${detail}`);
  }
}
