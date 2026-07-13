import { runtime } from "./node-runtime.ts";
/**
 * Test helper for creating temporary git repositories for testing
 */

import { join } from "path";
import { mkdir } from "fs/promises";
import { spawn } from "child_process";

export interface TestRepoOptions {
  name: string;
  defaultBranch?: string;
  hasSetupScript?: boolean;
  hasRemote?: boolean;
  remoteUrl?: string;
}

/**
 * Creates a temporary test git repository
 */
export async function createTestRepo(basePath: string, options: TestRepoOptions): Promise<string> {
  const repoPath = join(basePath, options.name);

  // Create directory
  await mkdir(repoPath, { recursive: true });

  // Initialize git repo with specified default branch
  const branch = options.defaultBranch || "main";
  await exec(`git init -b ${branch}`, repoPath);

  // Configure git user for commits
  await exec('git config user.name "Test User"', repoPath);
  await exec('git config user.email "test@example.com"', repoPath);
  await exec("git config commit.gpgsign false", repoPath);

  // Create initial commit
  await exec('git commit --allow-empty -m "Initial commit"', repoPath);

  // Add remote if specified
  if (options.hasRemote && options.remoteUrl) {
    await exec(`git remote add origin ${options.remoteUrl}`, repoPath);
    // Set up remote HEAD reference
    await exec(`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${branch}`, repoPath);
  }

  // Create setup script if specified
  if (options.hasSetupScript) {
    const setupPath = join(repoPath, "setup.sh");
    await runtime.write(setupPath, "#!/bin/bash\necho 'Setup script'\n");
    await exec("chmod +x setup.sh", repoPath);
  }

  return repoPath;
}

/**
 * Execute a command in a specific directory
 */
async function exec(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "ignore",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command} (exit code ${code})`));
      }
    });

    child.on("error", reject);
  });
}

/**
 * Create a standard set of test repositories
 */
export async function createStandardTestRepos(basePath: string): Promise<{
  mainRepo: string;
  masterRepo: string;
  developRepo: string;
  withSetupRepo: string;
  noRemoteRepo: string;
}> {
  const mainRepo = await createTestRepo(basePath, {
    defaultBranch: "main",
    hasRemote: true,
    name: "main-repo",
    remoteUrl: "https://github.com/test/main-repo.git",
  });

  const masterRepo = await createTestRepo(basePath, {
    defaultBranch: "master",
    hasRemote: true,
    name: "master-repo",
    remoteUrl: "https://github.com/test/master-repo.git",
  });

  const developRepo = await createTestRepo(basePath, {
    defaultBranch: "develop",
    hasRemote: true,
    name: "develop-repo",
    remoteUrl: "https://github.com/test/develop-repo.git",
  });

  const withSetupRepo = await createTestRepo(basePath, {
    defaultBranch: "main",
    hasRemote: true,
    hasSetupScript: true,
    name: "with-setup-repo",
    remoteUrl: "https://github.com/test/with-setup-repo.git",
  });

  const noRemoteRepo = await createTestRepo(basePath, {
    defaultBranch: "main",
    hasRemote: false,
    name: "no-remote-repo",
  });

  return {
    developRepo,
    mainRepo,
    masterRepo,
    noRemoteRepo,
    withSetupRepo,
  };
}
