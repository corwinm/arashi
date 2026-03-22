/**
 * Test helper utilities for creating and managing temporary git repositories
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Creates a temporary directory for test git repositories
 */
export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "arashi-test-"));
}

/**
 * Removes a temporary directory and all its contents
 */
export function removeTempDir(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch (error) {
    // Ignore errors during cleanup
    console.warn(`Failed to remove temp dir ${path}:`, error);
  }
}

/**
 * Initializes a git repository in the specified directory
 */
export function initGitRepo(repoPath: string): void {
  Bun.spawnSync(["git", "init"], { cwd: repoPath, stderr: "ignore", stdout: "ignore" });
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
  Bun.spawnSync(["git", "config", "user.name", "Test User"], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
}

/**
 * Initializes a bare git repository in the specified directory
 */
export function initBareGitRepo(repoPath: string): void {
  Bun.spawnSync(["git", "init", "--bare"], { cwd: repoPath, stderr: "ignore", stdout: "ignore" });
}

/**
 * Creates an initial commit in a repository
 */
export async function createInitialCommit(repoPath: string): Promise<void> {
  const filePath = join(repoPath, "README.md");
  await Bun.write(filePath, "# Test Repository\n");

  Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stderr: "ignore", stdout: "ignore" });
  Bun.spawnSync(["git", "commit", "-m", "Initial commit"], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
}

/**
 * Creates a file with content in a repository
 */
export async function createFile(
  repoPath: string,
  filename: string,
  content: string,
): Promise<void> {
  const filePath = join(repoPath, filename);
  await Bun.write(filePath, content);
}

/**
 * Stages and commits changes in a repository
 */
export function commitChanges(repoPath: string, message: string): void {
  Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stderr: "ignore", stdout: "ignore" });
  Bun.spawnSync(["git", "commit", "-m", message], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
}

/**
 * Creates a new branch in a repository
 */
export function createTestBranch(repoPath: string, branchName: string, fromBranch?: string): void {
  const args = ["branch", branchName];
  if (fromBranch) {
    args.push(fromBranch);
  }
  Bun.spawnSync(["git", ...args], { cwd: repoPath, stderr: "ignore", stdout: "ignore" });
}

/**
 * Checks out a branch in a repository
 */
export function checkoutBranch(repoPath: string, branchName: string): void {
  Bun.spawnSync(["git", "checkout", branchName], {
    cwd: repoPath,
    stderr: "ignore",
    stdout: "ignore",
  });
}

/**
 * Gets the current commit SHA in a repository
 */
export function getCurrentCommit(repoPath: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoPath });
  return new TextDecoder().decode(proc.stdout).trim();
}

/**
 * Test fixture that creates and cleans up a temporary git repository
 */
export class GitTestRepo {
  public readonly path: string;

  constructor() {
    this.path = createTempDir();
    initGitRepo(this.path);
  }

  /**
   * Initialize with a commit
   */
  async withInitialCommit(): Promise<this> {
    await createInitialCommit(this.path);
    return this;
  }

  /**
   * Create a file
   */
  async addFile(filename: string, content: string = ""): Promise<this> {
    await createFile(this.path, filename, content);
    return this;
  }

  /**
   * Commit changes
   */
  commit(message: string): this {
    commitChanges(this.path, message);
    return this;
  }

  /**
   * Create a branch
   */
  branch(name: string, from?: string): this {
    createTestBranch(this.path, name, from);
    return this;
  }

  /**
   * Checkout a branch
   */
  checkout(name: string): this {
    checkoutBranch(this.path, name);
    return this;
  }

  /**
   * Clean up the test repository
   */
  cleanup(): void {
    removeTempDir(this.path);
  }
}
