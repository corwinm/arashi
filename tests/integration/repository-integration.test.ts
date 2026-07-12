import { runtime } from "#test-runtime";
/**
 * Integration Tests: Repository Management MVP
 *
 * End-to-end tests for repository discovery and default branch detection
 * using real git repositories.
 */

import { CloneStatus, cloneRepository, discoverRepositories } from "../../src/core/repository.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdir, rm, stat } from "fs/promises";
import { createStandardTestRepos } from "../helpers/create-test-repos.js";
import { join } from "path";

const TEST_WORKSPACE = join(import.meta.dirname, "../temp-integration-workspace");

describe("Repository Management MVP Integration", () => {
  beforeAll(async () => {
    // Clean up and create fresh test workspace
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });

    // Create standard test repositories
    await createStandardTestRepos(TEST_WORKSPACE);
  });

  afterAll(async () => {
    // Clean up after all tests
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
  });

  // T042: Integration test - Discover multiple repos with different default branches
  test("T042: discovers multiple repositories with different default branches", async () => {
    // Act
    const result = await discoverRepositories(TEST_WORKSPACE);

    // Assert
    expect(result.repositories).toHaveLength(5);

    // Verify each repository was discovered with correct default branch
    const mainRepo = result.repositories.find((r) => r.name === "main-repo");
    const masterRepo = result.repositories.find((r) => r.name === "master-repo");
    const developRepo = result.repositories.find((r) => r.name === "develop-repo");

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

  // Note: Real test fixture discovery is not included as fixtures should be created
  // Dynamically by tests. Performance and functional tests below provide adequate coverage.

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
          const proc = runtime.spawn(["git", "init", "-b", "main"], {
            cwd: repoPath,
            stderr: "ignore",
            stdout: "ignore",
          });
          await proc.exited;

          const proc2 = runtime.spawn(["git", "config", "user.name", "Test"], {
            cwd: repoPath,
            stderr: "ignore",
            stdout: "ignore",
          });
          await proc2.exited;

          const proc3 = runtime.spawn(["git", "config", "user.email", "test@test.com"], {
            cwd: repoPath,
            stderr: "ignore",
            stdout: "ignore",
          });
          await proc3.exited;

          const proc4 = runtime.spawn(["git", "commit", "--allow-empty", "-m", "Initial"], {
            cwd: repoPath,
            stderr: "ignore",
            stdout: "ignore",
          });
          await proc4.exited;
        })(),
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
    await rm(perfTestPath, { force: true, recursive: true });
  }, 30_000);
});

// ============================================================================
// User Story 3: Setup Script Detection Integration (T056)
// ============================================================================

describe("Integration: Setup Script Detection", () => {
  test("T056: discovers repositories and correctly identifies setup scripts", async () => {
    // Arrange: Create test workspace with mixed repos
    const workspaceDir = join(TEST_WORKSPACE, "setup-test-workspace");
    await mkdir(workspaceDir, { recursive: true });

    // Create repo with setup.sh
    const repo1Path = join(workspaceDir, "has-setup");
    await mkdir(repo1Path, { recursive: true });
    const proc1 = runtime.spawn(["git", "init", "-b", "main"], {
      cwd: repo1Path,
      stdout: "ignore",
    });
    await proc1.exited;
    await runtime.write(join(repo1Path, "setup.sh"), "#!/bin/bash\necho 'Setup'");

    // Create repo with setup.bash
    const repo2Path = join(workspaceDir, "has-bash-setup");
    await mkdir(repo2Path, { recursive: true });
    const proc2 = runtime.spawn(["git", "init", "-b", "main"], {
      cwd: repo2Path,
      stdout: "ignore",
    });
    await proc2.exited;
    await runtime.write(join(repo2Path, "setup.bash"), "#!/bin/bash\necho 'Bash Setup'");

    // Create repo with .arashi/setup.sh
    const repo3Path = join(workspaceDir, "has-arashi-setup");
    await mkdir(join(repo3Path, ".arashi"), { recursive: true });
    const proc3 = runtime.spawn(["git", "init", "-b", "main"], {
      cwd: repo3Path,
      stdout: "ignore",
    });
    await proc3.exited;
    await runtime.write(join(repo3Path, ".arashi", "setup.sh"), "#!/bin/bash\necho 'Arashi Setup'");

    // Create repo without setup script
    const repo4Path = join(workspaceDir, "no-setup");
    await mkdir(repo4Path, { recursive: true });
    const proc4 = runtime.spawn(["git", "init", "-b", "main"], {
      cwd: repo4Path,
      stdout: "ignore",
    });
    await proc4.exited;

    // Act: Discover repositories
    const result = await discoverRepositories(workspaceDir);

    // Assert: All repos discovered
    expect(result.repositories).toHaveLength(4);

    // Find each repo and verify setup script detection
    const hasSetupRepo = result.repositories.find((r) => r.name === "has-setup");
    expect(hasSetupRepo).toBeDefined();
    expect(hasSetupRepo!.hasSetupScript).toBe(true);
    expect(hasSetupRepo!.setupScriptPath).toBe(join(repo1Path, "setup.sh"));

    const hasBashSetupRepo = result.repositories.find((r) => r.name === "has-bash-setup");
    expect(hasBashSetupRepo).toBeDefined();
    expect(hasBashSetupRepo!.hasSetupScript).toBe(true);
    expect(hasBashSetupRepo!.setupScriptPath).toBe(join(repo2Path, "setup.bash"));

    const hasArashiSetupRepo = result.repositories.find((r) => r.name === "has-arashi-setup");
    expect(hasArashiSetupRepo).toBeDefined();
    expect(hasArashiSetupRepo!.hasSetupScript).toBe(true);
    expect(hasArashiSetupRepo!.setupScriptPath).toBe(join(repo3Path, ".arashi", "setup.sh"));

    const noSetupRepo = result.repositories.find((r) => r.name === "no-setup");
    expect(noSetupRepo).toBeDefined();
    expect(noSetupRepo!.hasSetupScript).toBe(false);
    expect(noSetupRepo!.setupScriptPath).toBeUndefined();

    // Clean up
    await rm(workspaceDir, { force: true, recursive: true });
  });
});

// ============================================================================
// User Story 4: Repository Cloning Integration (T081)
// ============================================================================

describe("Integration: Repository Cloning", () => {
  // T081: Integration test for cloneRepository() with real Git URL
  test("T081: clones repository from local git path", async () => {
    // Arrange: Create a source repository with content
    const sourceRepo = join(TEST_WORKSPACE, "clone-source");
    await rm(sourceRepo, { force: true, recursive: true });
    await mkdir(sourceRepo, { recursive: true });

    // Initialize git repo
    await runtime.spawn(["git", "init", "-b", "main"], { cwd: sourceRepo, stdout: "ignore" })
      .exited;
    await runtime.spawn(["git", "config", "user.name", "Test"], {
      cwd: sourceRepo,
      stdout: "ignore",
    }).exited;
    await runtime.spawn(["git", "config", "user.email", "test@test.com"], {
      cwd: sourceRepo,
      stdout: "ignore",
    }).exited;

    // Add some content
    await runtime.write(join(sourceRepo, "README.md"), "# Test Repository\n\nThis is a test.");
    await runtime.write(join(sourceRepo, "code.ts"), "export const version = '1.0.0';");

    await runtime.spawn(["git", "add", "."], { cwd: sourceRepo, stdout: "ignore" }).exited;
    await runtime.spawn(["git", "commit", "-m", "Initial commit"], {
      cwd: sourceRepo,
      stdout: "ignore",
    }).exited;

    const targetPath = join(TEST_WORKSPACE, "clone-target");
    await rm(targetPath, { force: true, recursive: true });

    // Act: Clone the repository
    const result = await cloneRepository(sourceRepo, targetPath);

    // Assert: Clone completed successfully
    expect(result.status).toBe(CloneStatus.COMPLETED);
    expect(result.url).toBe(sourceRepo);
    expect(result.targetPath).toBe(targetPath);
    expect(result.error).toBeUndefined();
    expect(result.duration).toBeGreaterThan(0);

    // Verify cloned repository structure
    const gitDir = join(targetPath, ".git");
    const gitDirStat = await stat(gitDir);
    expect(gitDirStat.isDirectory()).toBe(true);

    // Verify files were cloned
    const readmeFile = runtime.file(join(targetPath, "README.md"));
    expect(await readmeFile.exists()).toBe(true);
    const readmeContent = await readmeFile.text();
    expect(readmeContent).toContain("Test Repository");

    const codeFile = runtime.file(join(targetPath, "code.ts"));
    expect(await codeFile.exists()).toBe(true);
    const codeContent = await codeFile.text();
    expect(codeContent).toContain("version = '1.0.0'");

    // Clean up
    await rm(sourceRepo, { force: true, recursive: true });
    await rm(targetPath, { force: true, recursive: true });
  }, 15_000);
});
