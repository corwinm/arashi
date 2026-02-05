/**
 * Test helper for creating temporary git repositories for worktree testing
 * 
 * This helper creates a multi-repository test workspace with various configurations
 * to test coordinated worktree creation scenarios.
 */

import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Repository } from "../../src/types.ts";

export interface TestWorkspace {
  /** Root directory of the test workspace */
  rootPath: string;
  
  /** List of created test repositories */
  repositories: Repository[];
  
  /** Cleanup function to remove the workspace */
  cleanup: () => Promise<void>;
}

export interface TestRepositoryConfig {
  name: string;
  defaultBranch?: string;
  hasSetupScript?: boolean;
  createExistingBranch?: string; // If set, creates this branch beforehand
}

/**
 * Creates a temporary test workspace with multiple git repositories
 * 
 * @param config Optional configuration for repositories
 * @returns TestWorkspace with repositories and cleanup function
 */
export async function createTestWorkspace(
  config?: TestRepositoryConfig[]
): Promise<TestWorkspace> {
  // Create unique temp directory
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  const rootPath = join(tmpdir(), `arashi-worktree-test-${timestamp}-${randomId}`);
  
  await mkdir(rootPath, { recursive: true });
  
  // Default configuration: 3 repositories with different default branches
  const repoConfigs = config || [
    { name: "repo-a", defaultBranch: "main" },
    { name: "repo-b", defaultBranch: "master" },
    { name: "repo-c", defaultBranch: "develop" },
  ];
  
  const repositories: Repository[] = [];
  
  for (const repoConfig of repoConfigs) {
    const repoPath = join(rootPath, repoConfig.name);
    await mkdir(repoPath, { recursive: true });
    
    // Initialize git repository
    const branch = repoConfig.defaultBranch || "main";
    await execGit(["init", "-b", branch], repoPath);
    
    // Configure git user for commits
    await execGit(["config", "user.name", "Test User"], repoPath);
    await execGit(["config", "user.email", "test@example.com"], repoPath);
    
    // Create initial commit
    await execGit(["commit", "--allow-empty", "-m", "Initial commit"], repoPath);
    
    // Create existing branch if specified (for conflict testing)
    if (repoConfig.createExistingBranch) {
      await execGit(["branch", repoConfig.createExistingBranch], repoPath);
    }
    
    // Create setup script if specified
    if (repoConfig.hasSetupScript) {
      const setupPath = join(repoPath, "setup.sh");
      await Bun.write(setupPath, "#!/bin/bash\necho 'Setup script'\n");
      await execGit(["add", "setup.sh"], repoPath);
      await execGit(["commit", "-m", "Add setup script"], repoPath);
    }
    
    repositories.push({
      name: repoConfig.name,
      path: repoPath,
      defaultBranch: branch,
      hasSetupScript: repoConfig.hasSetupScript || false,
    });
  }
  
  const cleanup = async () => {
    try {
      await rm(rootPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors in tests
      console.warn(`Failed to cleanup test workspace: ${error}`);
    }
  };
  
  return {
    rootPath,
    repositories,
    cleanup,
  };
}

/**
 * Execute git command in a specific directory
 */
async function execGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const exitCode = await proc.exited;
  
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Git command failed: git ${args.join(" ")}\n${stderr}`);
  }
}

/**
 * Create a standard 5-repository test workspace
 * Useful for testing typical multi-repo scenarios
 */
export async function createStandardWorkspace(): Promise<TestWorkspace> {
  return createTestWorkspace([
    { name: "repo-1", defaultBranch: "main" },
    { name: "repo-2", defaultBranch: "main" },
    { name: "repo-3", defaultBranch: "master" },
    { name: "repo-4", defaultBranch: "develop" },
    { name: "repo-5", defaultBranch: "main", hasSetupScript: true },
  ]);
}

/**
 * Create workspace with conflict scenarios
 * Repos 2 and 4 already have the specified branch
 */
export async function createConflictWorkspace(
  existingBranchName: string
): Promise<TestWorkspace> {
  return createTestWorkspace([
    { name: "repo-1", defaultBranch: "main" },
    { name: "repo-2", defaultBranch: "main", createExistingBranch: existingBranchName },
    { name: "repo-3", defaultBranch: "master" },
    { name: "repo-4", defaultBranch: "develop", createExistingBranch: existingBranchName },
    { name: "repo-5", defaultBranch: "main" },
  ]);
}
