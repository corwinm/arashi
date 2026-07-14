import { runtime } from "./node-runtime.ts";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export interface BareCreateWorkspace {
  rootPath: string;
  bareRepoPath: string;
  worktreePath: string;
  cleanup: () => Promise<void>;
}

export interface BareCreateWorkspaceOptions {
  createLinkedWorktree?: boolean;
  includeConfig?: boolean;
  configReposDir?: string;
  configWorktreesDir?: string;
}

export async function createBareCreateWorkspace(
  options: BareCreateWorkspaceOptions = {},
): Promise<BareCreateWorkspace> {
  const createLinkedWorktree = options.createLinkedWorktree ?? true;
  const includeConfig = options.includeConfig ?? true;
  const configReposDir = options.configReposDir ?? "./repos";
  const configWorktreesDir = options.configWorktreesDir ?? ".arashi/worktrees";
  const rootPath = join(
    tmpdir(),
    `arashi-bare-create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const bareRepoPath = join(rootPath, "main.git");
  const seedPath = join(rootPath, "seed");
  const worktreePath = join(rootPath, "main-worktree");

  await mkdir(rootPath, { recursive: true });
  await execGit(["init", "--bare", bareRepoPath], rootPath);

  await mkdir(seedPath, { recursive: true });
  await execGit(["init", "-b", "main"], seedPath);
  await execGit(["config", "user.name", "Test User"], seedPath);
  await execGit(["config", "user.email", "test@example.com"], seedPath);
  await execGit(["config", "commit.gpgsign", "false"], seedPath);

  await runtime.write(join(seedPath, "README.md"), "# Bare Create Test\n");
  if (includeConfig) {
    await mkdir(join(seedPath, ".arashi"), { recursive: true });
    await runtime.write(
      join(seedPath, ".arashi", "config.json"),
      JSON.stringify(
        {
          repos: {},
          reposDir: configReposDir,
          version: "1.0.0",
          worktreesDir: configWorktreesDir,
        },
        null,
        2,
      ),
    );
  }

  await execGit(["add", "."], seedPath);
  await execGit(["commit", "-m", "Initial content"], seedPath);
  await execGit(["remote", "add", "origin", bareRepoPath], seedPath);
  await execGit(["push", "origin", "main"], seedPath);

  if (createLinkedWorktree) {
    await execGit(["worktree", "add", worktreePath, "main"], bareRepoPath);
  } else {
    await execGit(["symbolic-ref", "HEAD", "refs/heads/unborn"], bareRepoPath);
  }

  return {
    bareRepoPath,
    cleanup: async () => {
      await rm(rootPath, { force: true, recursive: true });
    },
    rootPath,
    worktreePath,
  };
}

async function execGit(args: string[], cwd: string): Promise<void> {
  const proc = runtime.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode === 0) {
    return;
  }

  const stderr = new TextDecoder().decode(proc.stderr);
  throw new Error(`Git command failed: git ${args.join(" ")}\n${stderr}`);
}
