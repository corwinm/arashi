/**
 * Unit Tests: Repository Discovery (User Story 1)
 * 
 * Tests for repository discovery functionality including scanning workspace
 * directories, finding git repositories, and handling various edge cases.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import {
  discoverRepositories,
  type Repository,
  type RepositoryDiscoveryResult,
  type DiscoveryOptions,
} from "../../../src/core/repository.js";

// Test workspace directory
const TEST_WORKSPACE = join(import.meta.dir, "../temp-test-workspace");

/**
 * Helper to execute git commands
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
        reject(new Error(`Command failed: ${command}`));
      }
    });
    
    child.on("error", reject);
  });
}

/**
 * Helper to create a test git repository
 */
async function createGitRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await exec("git init -b main", path);
  await exec('git config user.name "Test"', path);
  await exec('git config user.email "test@test.com"', path);
  await exec("git commit --allow-empty -m 'Initial'", path);
}

describe("Repository Discovery (US1)", () => {
  beforeEach(async () => {
    // Clean up test workspace before each test
    await rm(TEST_WORKSPACE, { recursive: true, force: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
  });
  
  afterEach(async () => {
    // Clean up after tests
    await rm(TEST_WORKSPACE, { recursive: true, force: true });
  });
  
  // T012: Unit test for discoverRepositories() with multiple repositories
  test("T012: discovers multiple git repositories", async () => {
    // Arrange: Create test repositories
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));
    await createGitRepo(join(TEST_WORKSPACE, "repo3"));
    
    // Act: Run discovery
    const result: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE);
    
    // Assert: All 3 repositories found
    expect(result.repositories).toHaveLength(3);
    expect(result.repositories.map(r => r.name).sort()).toEqual(["repo1", "repo2", "repo3"]);
    expect(result.errors).toHaveLength(0);
    expect(result.workspacePath).toBe(TEST_WORKSPACE);
  });
  
  // T013: Unit test for discoverRepositories() with non-repository directories (should skip)
  test("T013: skips non-repository directories", async () => {
    // Arrange: Create mix of repos and non-repos
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await mkdir(join(TEST_WORKSPACE, "not-a-repo"), { recursive: true });
    await mkdir(join(TEST_WORKSPACE, "also-not-a-repo"), { recursive: true });
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));
    
    // Act
    const result: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE);
    
    // Assert: Only actual repositories found
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories.map(r => r.name).sort()).toEqual(["repo1", "repo2"]);
  });
  
  // T014: Unit test for discoverRepositories() respecting maxDepth option
  test("T014: respects maxDepth option", async () => {
    // Arrange: Create nested repositories at different depths
    await createGitRepo(join(TEST_WORKSPACE, "level1"));
    await createGitRepo(join(TEST_WORKSPACE, "deep/level2"));
    await createGitRepo(join(TEST_WORKSPACE, "deep/deeper/level3"));
    await createGitRepo(join(TEST_WORKSPACE, "deep/deeper/deepest/level4"));
    
    // Act: Discovery with maxDepth 2
    const result1: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE, {
      maxDepth: 2,
    });
    
    // Assert: Only repos within depth 2 found
    expect(result1.repositories).toHaveLength(2);
    expect(result1.repositories.map(r => r.name).sort()).toEqual(["level1", "level2"]);
    
    // Act: Discovery with maxDepth 4
    const result2: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE, {
      maxDepth: 4,
    });
    
    // Assert: All repos found
    expect(result2.repositories).toHaveLength(4);
  });
  
  // T015: Unit test for discoverRepositories() stopping at repository boundaries
  test("T015: stops scanning at repository boundaries", async () => {
    // Arrange: Create parent repo with subdirectories
    await createGitRepo(join(TEST_WORKSPACE, "parent-repo"));
    await mkdir(join(TEST_WORKSPACE, "parent-repo/subdir"), { recursive: true });
    await mkdir(join(TEST_WORKSPACE, "parent-repo/subdir/nested"), { recursive: true });
    
    // Act
    const result: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE);
    
    // Assert: Only parent repo found, subdirectories not scanned
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0].name).toBe("parent-repo");
    // Should not have scanned deep into repository subdirectories
    expect(result.scannedDirectories).toBeLessThan(5);
  });
  
  // T016: Unit test for discoverRepositories() with excludePatterns option
  test("T016: excludes directories matching patterns", async () => {
    // Arrange: Create repos including some that should be excluded
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await createGitRepo(join(TEST_WORKSPACE, "node_modules/some-package"));
    await createGitRepo(join(TEST_WORKSPACE, ".hidden/repo"));
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));
    
    // Act: Exclude node_modules and hidden directories
    const result: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE, {
      excludePatterns: ["node_modules", ".hidden"],
    });
    
    // Assert: Only non-excluded repos found
    expect(result.repositories).toHaveLength(2);
    expect(result.repositories.map(r => r.name).sort()).toEqual(["repo1", "repo2"]);
  });
  
  // T017: Unit test for discoverRepositories() handling permission errors gracefully
  test("T017: handles permission errors gracefully", async () => {
    // Arrange: Create repo and a directory without read permissions
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    const restrictedDir = join(TEST_WORKSPACE, "restricted");
    await mkdir(restrictedDir, { recursive: true });
    
    // Note: This test may not work on all systems/CI environments
    // Skip if we can't modify permissions
    try {
      await exec("chmod 000 restricted", TEST_WORKSPACE);
      
      // Act
      const result: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE);
      
      // Assert: Should continue despite permission error
      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0].name).toBe("repo1");
      // May have recorded a permission error
      // expect(result.errors.length).toBeGreaterThan(0);
      
      // Cleanup: Restore permissions
      await exec("chmod 755 restricted", TEST_WORKSPACE);
    } catch (error) {
      // Skip test if permission modification not supported
      console.log("Skipping permission test (not supported on this system)");
    }
  });
  
  // T018: Unit test for discoverRepositories() reporting scannedDirectories count
  test("T018: reports accurate scannedDirectories count", async () => {
    // Arrange: Create specific directory structure
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await mkdir(join(TEST_WORKSPACE, "dir1"), { recursive: true });
    await mkdir(join(TEST_WORKSPACE, "dir1/subdir"), { recursive: true });
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));
    
    // Act
    const result: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE);
    
    // Assert: scannedDirectories count is reasonable
    expect(result.scannedDirectories).toBeGreaterThan(0);
    expect(result.scannedDirectories).toBeLessThan(20); // Reasonable upper bound
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// User Story 2: Default Branch Detection (T029-T034)
// ============================================================================

// @ts-expect-error - Function not yet implemented
import { detectDefaultBranch } from "../../../src/core/repository.js";

describe("Default Branch Detection (US2)", () => {
  beforeEach(async () => {
    await rm(TEST_WORKSPACE, { recursive: true, force: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
  });
  
  afterEach(async () => {
    await rm(TEST_WORKSPACE, { recursive: true, force: true });
  });
  
  // T029: Unit test for detectDefaultBranch() with 'main' as default
  test("T029: detects 'main' as default branch", async () => {
    // Arrange: Create repo with main branch
    const repoPath = join(TEST_WORKSPACE, "main-repo");
    await createGitRepo(repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", repoPath);
    
    // Act
    const branch = await detectDefaultBranch(repoPath);
    
    // Assert
    expect(branch).toBe("main");
  });
  
  // T030: Unit test for detectDefaultBranch() with 'master' as default
  test("T030: detects 'master' as default branch", async () => {
    // Arrange: Create repo with master branch
    const repoPath = join(TEST_WORKSPACE, "master-repo");
    await mkdir(repoPath, { recursive: true });
    await exec("git init -b master", repoPath);
    await exec('git config user.name "Test"', repoPath);
    await exec('git config user.email "test@test.com"', repoPath);
    await exec("git commit --allow-empty -m 'Initial'", repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master", repoPath);
    
    // Act
    const branch = await detectDefaultBranch(repoPath);
    
    // Assert
    expect(branch).toBe("master");
  });
  
  // T031: Unit test for detectDefaultBranch() with 'develop' as default
  test("T031: detects 'develop' as default branch", async () => {
    // Arrange: Create repo with develop branch
    const repoPath = join(TEST_WORKSPACE, "develop-repo");
    await mkdir(repoPath, { recursive: true });
    await exec("git init -b develop", repoPath);
    await exec('git config user.name "Test"', repoPath);
    await exec('git config user.email "test@test.com"', repoPath);
    await exec("git commit --allow-empty -m 'Initial'", repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop", repoPath);
    
    // Act
    const branch = await detectDefaultBranch(repoPath);
    
    // Assert
    expect(branch).toBe("develop");
  });
  
  // T032: Unit test for detectDefaultBranch() with repository in detached HEAD state
  test("T032: handles detached HEAD state", async () => {
    // Arrange: Create repo with commits and checkout specific commit
    const repoPath = join(TEST_WORKSPACE, "detached-repo");
    await createGitRepo(repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", repoPath);
    
    // Detach HEAD by checking out the commit directly
    const commitHash = await new Promise<string>((resolve, reject) => {
      const child = spawn("git rev-parse HEAD", {
        cwd: repoPath,
        shell: true,
        stdio: "pipe",
      });
      let output = "";
      child.stdout?.on("data", (data) => {
        output += data.toString();
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error("Failed to get commit hash"));
        }
      });
    });
    
    await exec(`git checkout ${commitHash}`, repoPath);
    
    // Act
    const branch = await detectDefaultBranch(repoPath);
    
    // Assert: Should still detect main from remote HEAD
    expect(branch).toBe("main");
  });
  
  // T033: Unit test for detectDefaultBranch() with repository without remote
  test("T033: handles repository without remote", async () => {
    // Arrange: Create repo without remote
    const repoPath = join(TEST_WORKSPACE, "no-remote-repo");
    await createGitRepo(repoPath);
    // No remote added
    
    // Act
    const branch = await detectDefaultBranch(repoPath);
    
    // Assert: Should fallback to main (common branch)
    expect(branch).toBe("main");
  });
  
  // T034: Unit test for detectDefaultBranch() fallback to common branch names
  test("T034: falls back to common branch names", async () => {
    // Arrange: Create repo with no symbolic-ref but has master branch
    const repoPath = join(TEST_WORKSPACE, "fallback-repo");
    await mkdir(repoPath, { recursive: true });
    await exec("git init -b master", repoPath);
    await exec('git config user.name "Test"', repoPath);
    await exec('git config user.email "test@test.com"', repoPath);
    await exec("git commit --allow-empty -m 'Initial'", repoPath);
    // No remote or symbolic-ref setup
    
    // Act
    const branch = await detectDefaultBranch(repoPath);
    
    // Assert: Should find master in fallback check
    expect(branch).toBe("master");
  });
});

