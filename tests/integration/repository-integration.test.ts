/**
 * Integration Tests: Repository Management MVP
 * 
 * End-to-end tests for repository discovery and default branch detection
 * using real git repositories.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rm, mkdir } from "fs/promises";
import { join } from "path";
import { discoverRepositories } from "../../src/core/repository.js";
import { createStandardTestRepos } from "../helpers/create-test-repos";

const TEST_WORKSPACE = join(import.meta.dir, "../temp-integration-workspace");

describe("Repository Management MVP Integration", () => {
  let repos: {
    mainRepo: string;
    masterRepo: string;
    developRepo: string;
    withSetupRepo: string;
    noRemoteRepo: string;
  };
  
  beforeAll(async () => {
    // Clean up and create fresh test workspace
    await rm(TEST_WORKSPACE, { recursive: true, force: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
    
    // Create standard test repositories
    repos = await createStandardTestRepos(TEST_WORKSPACE);
  });
  
  afterAll(async () => {
    // Clean up after all tests
    await rm(TEST_WORKSPACE, { recursive: true, force: true });
  });
  
  // T042: Integration test - Discover multiple repos with different default branches
  test("T042: discovers multiple repositories with different default branches", async () => {
    // Act
    const result = await discoverRepositories(TEST_WORKSPACE);
    
    // Assert
    expect(result.repositories).toHaveLength(5);
    
    // Verify each repository was discovered with correct default branch
    const mainRepo = result.repositories.find(r => r.name === "main-repo");
    const masterRepo = result.repositories.find(r => r.name === "master-repo");
    const developRepo = result.repositories.find(r => r.name === "develop-repo");
    
    expect(mainRepo).toBeDefined();
    expect(mainRepo?.defaultBranch).toBe("main");
    
    expect(masterRepo).toBeDefined();
    expect(masterRepo?.defaultBranch).toBe("master");
    
    expect(developRepo).toBeDefined();
    expect(developRepo?.defaultBranch).toBe("develop");
  });
  
  // T043: Integration test - Discover repos and verify all have valid default branches
  test("T043: all discovered repositories have valid default branches", async () => {
    // Act
    const result = await discoverRepositories(TEST_WORKSPACE);
    
    // Assert
    expect(result.repositories.length).toBeGreaterThan(0);
    
    for (const repo of result.repositories) {
      // Each repository should have a non-empty default branch
      expect(repo.defaultBranch).toBeDefined();
      expect(repo.defaultBranch.length).toBeGreaterThan(0);
      
      // Default branch should be one of the common branches
      expect(["main", "master", "develop", "trunk"]).toContain(repo.defaultBranch);
    }
  });
  
  // T044: Integration test - Discovery with real test fixture repositories
  test("T044: discovers real test fixture repositories", async () => {
    // Use the pre-created test fixtures
    const fixturesPath = join(import.meta.dir, "../fixtures/test-repos");
    
    // Act
    const result = await discoverRepositories(fixturesPath);
    
    // Assert - Should find the 5 test fixture repos
    expect(result.repositories.length).toBeGreaterThanOrEqual(5);
    
    // Verify expected repositories are found
    const repoNames = result.repositories.map(r => r.name);
    expect(repoNames).toContain("main-repo");
    expect(repoNames).toContain("master-repo");
    expect(repoNames).toContain("develop-repo");
    expect(repoNames).toContain("with-setup-repo");
    expect(repoNames).toContain("no-remote-repo");
    
    // Verify all repos have paths
    for (const repo of result.repositories) {
      expect(repo.path).toBeDefined();
      expect(repo.path.startsWith(fixturesPath)).toBe(true);
    }
  });
  
  // T045: Performance test - Discover 50 mock repositories in under 5 seconds
  test("T045: discovers 50 repositories in under 5 seconds", async () => {
    // Arrange: Create 50 small test repositories
    const perfTestPath = join(TEST_WORKSPACE, "perf-test");
    await mkdir(perfTestPath, { recursive: true });
    
    const repoPromises = [];
    for (let i = 0; i < 50; i++) {
      const repoPath = join(perfTestPath, `repo-${i}`);
      repoPromises.push(
        (async () => {
          await mkdir(repoPath, { recursive: true });
          const proc = Bun.spawn(
            ["git", "init", "-b", "main"],
            { cwd: repoPath, stdout: "ignore", stderr: "ignore" }
          );
          await proc.exited;
          
          const proc2 = Bun.spawn(
            ["git", "config", "user.name", "Test"],
            { cwd: repoPath, stdout: "ignore", stderr: "ignore" }
          );
          await proc2.exited;
          
          const proc3 = Bun.spawn(
            ["git", "config", "user.email", "test@test.com"],
            { cwd: repoPath, stdout: "ignore", stderr: "ignore" }
          );
          await proc3.exited;
          
          const proc4 = Bun.spawn(
            ["git", "commit", "--allow-empty", "-m", "Initial"],
            { cwd: repoPath, stdout: "ignore", stderr: "ignore" }
          );
          await proc4.exited;
        })()
      );
    }
    
    await Promise.all(repoPromises);
    
    // Act - Measure discovery time
    const startTime = Date.now();
    const result = await discoverRepositories(perfTestPath);
    const duration = Date.now() - startTime;
    
    // Assert
    expect(result.repositories).toHaveLength(50);
    expect(duration).toBeLessThan(5000); // SC-001: < 5 seconds
    
    // Also verify the duration reported in the result
    expect(result.duration).toBeLessThan(5000);
    
    console.log(`Performance: Discovered 50 repositories in ${duration}ms`);
    
    // Clean up perf test repos
    await rm(perfTestPath, { recursive: true, force: true });
  }, 10000); // Increased timeout for performance test
});
