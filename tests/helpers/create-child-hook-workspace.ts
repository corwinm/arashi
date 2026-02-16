import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";

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
}

export async function createChildHookWorkspace(
  options: ChildHookWorkspaceOptions = {},
): Promise<ChildHookWorkspace> {
  const childRepoNames = options.childRepoNames ?? ["alpha", "beta"];
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

  const discoveredRepos: Record<
    string,
    { path: string; default_branch: string; is_bare: boolean }
  > = {};
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
      path: `./repos/${repoName}`,
      default_branch: "main",
      is_bare: false,
    };
  }

  await Bun.write(join(workspacePath, "README.md"), "# Child Hook Workspace\n");
  await Bun.write(
    join(workspacePath, ".arashi", "config.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        repos_dir: "./repos",
        auto_setup: true,
        hooks: {
          timeout: options.hookTimeoutMs ?? 1000,
        },
        discovered_repos: discoveredRepos,
      },
      null,
      2,
    ),
  );

  await execGit(["add", "README.md", ".arashi/config.json"], workspacePath);
  await execGit(["commit", "-m", "Initialize workspace"], workspacePath);

  const workspaceName = basename(workspacePath);
  const childInvocationPath = childRepoPaths[childRepoNames[0]];
  const nestedChildInvocationPath = join(childInvocationPath, "nested", "inside");
  await mkdir(nestedChildInvocationPath, { recursive: true });

  return {
    rootPath,
    workspacePath,
    reposDirPath,
    workspaceName,
    hookRootPath,
    childRepoNames,
    childRepoPaths,
    childInvocationPath,
    nestedChildInvocationPath,
    getMainWorktreePath: (branchName: string) => join(rootPath, `${workspaceName}-${branchName}`),
    getChildWorktreePath: (repoName: string, branchName: string) =>
      join(rootPath, `${workspaceName}-${branchName}`, "repos", repoName),
    cleanup: async () => {
      await rm(rootPath, { recursive: true, force: true });
    },
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
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return;
  }

  const stderr = await new Response(proc.stderr).text();
  throw new Error(`Git command failed: git ${args.join(" ")}\n${stderr}`);
}
