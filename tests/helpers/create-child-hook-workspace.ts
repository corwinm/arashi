import { basename, join, resolve } from "path";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";

export interface ChildHookWorkspace {
  rootPath: string;
  workspacePath: string;
  reposDirPath: string;
  workspaceName: string;
  hookRootPath: string;
  childRepoNames: string[];
  childRepoPaths: Record<string, string>;
  childInvocationPath: string;
  nestedChildInvocationPath: string;
  getMainWorktreePath: (branchName: string) => string;
  getChildWorktreePath: (repoName: string, branchName: string) => string;
  cleanup: () => Promise<void>;
}

export interface ChildHookWorkspaceOptions {
  childRepoNames?: string[];
  hookTimeoutMs?: number;
  worktreesDir?: string;
}

export async function createChildHookWorkspace(
  options: ChildHookWorkspaceOptions = {},
): Promise<ChildHookWorkspace> {
  const childRepoNames = options.childRepoNames ?? ["alpha", "beta"];
  const worktreesDir = options.worktreesDir ?? ".arashi/worktrees";
  const rootPath = join(
    tmpdir(),
    `arashi-child-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const workspacePath = join(rootPath, "workspace");
  const reposDirPath = join(workspacePath, "repos");
  const hookRootPath = workspacePath;

  await mkdir(workspacePath, { recursive: true });
  await mkdir(reposDirPath, { recursive: true });
  await mkdir(join(workspacePath, ".arashi", "hooks"), { recursive: true });

  await initGitRepo(workspacePath, "main");

  const discoveredRepos: Record<string, { path: string; defaultBranch: string; isBare: boolean }> =
    {};
  const childRepoPaths: Record<string, string> = {};

  for (const repoName of childRepoNames) {
    const repoPath = join(reposDirPath, repoName);
    await mkdir(repoPath, { recursive: true });
    await initGitRepo(repoPath, "main");
    await Bun.write(join(repoPath, "README.md"), `# ${repoName}\n`);
    await execGit(["add", "README.md"], repoPath);
    await execGit(["commit", "-m", "Initial child commit"], repoPath);

    childRepoPaths[repoName] = repoPath;
    discoveredRepos[repoName] = {
      defaultBranch: "main",
      isBare: false,
      path: `./repos/${repoName}`,
    };
  }

  await Bun.write(join(workspacePath, "README.md"), "# Child Hook Workspace\n");
  await Bun.write(
    join(workspacePath, ".arashi", "config.json"),
    JSON.stringify(
      {
        hooks: {
          timeout: options.hookTimeoutMs ?? 1000,
        },
        repos: discoveredRepos,
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir,
      },
      null,
      2,
    ),
  );

  await execGit(["add", "README.md", ".arashi/config.json"], workspacePath);
  await execGit(["commit", "-m", "Initialize workspace"], workspacePath);

  const workspaceName = basename(workspacePath);
  const worktreesRootPath = resolve(workspacePath, worktreesDir);
  const childInvocationPath = childRepoPaths[childRepoNames[0]];
  const nestedChildInvocationPath = join(childInvocationPath, "nested", "inside");
  await mkdir(nestedChildInvocationPath, { recursive: true });

  return {
    childInvocationPath,
    childRepoNames,
    childRepoPaths,
    cleanup: async () => {
      await rm(rootPath, { force: true, recursive: true });
    },
    getChildWorktreePath: (repoName: string, branchName: string) =>
      join(worktreesRootPath, `${workspaceName}-${branchName}`, "repos", repoName),
    getMainWorktreePath: (branchName: string) =>
      join(worktreesRootPath, `${workspaceName}-${branchName}`),
    hookRootPath,
    nestedChildInvocationPath,
    reposDirPath,
    rootPath,
    workspaceName,
    workspacePath,
  };
}

async function initGitRepo(repoPath: string, branch: string): Promise<void> {
  await execGit(["init", "-b", branch], repoPath);
  await execGit(["config", "user.name", "Test User"], repoPath);
  await execGit(["config", "user.email", "test@example.com"], repoPath);
}

async function execGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return;
  }

  const stderr = await new Response(proc.stderr).text();
  throw new Error(`Git command failed: git ${args.join(" ")}\n${stderr}`);
}
