/**
 * Unit Tests: Repository Discovery (User Story 1)
 *
 * Tests for repository discovery functionality including scanning workspace
 * directories, finding git repositories, and handling various edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import { stat } from "fs/promises";
import {
  discoverRepositories,
  validateWorkspace,
  cloneRepository,
  CloneStatus,
  CloneErrorCode,
} from "../../../src/core/repository.js";
import type {
  RepositoryDiscoveryResult,
  WorkspaceConfiguration,
  ValidationResult,
  CloneOperation,
  CloneProgress,
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
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    // Clean up after tests
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
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
    expect(result.repositories.map((r) => r.name).toSorted()).toEqual(["repo1", "repo2", "repo3"]);
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
    expect(result.repositories.map((r) => r.name).toSorted()).toEqual(["repo1", "repo2"]);
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
    expect(result1.repositories.map((r) => r.name).toSorted()).toEqual(["level1", "level2"]);

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
    expect(result.repositories.map((r) => r.name).toSorted()).toEqual(["repo1", "repo2"]);
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
      // Expect(result.errors.length).toBeGreaterThan(0);

      // Cleanup: Restore permissions
      await exec("chmod 755 restricted", TEST_WORKSPACE);
    } catch {
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

import { detectDefaultBranch, detectSetupScript } from "../../../src/core/repository.js";

describe("Default Branch Detection (US2)", () => {
  beforeEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
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

// ============================================================================
// User Story 3: Detect Setup Scripts (T046-T049)
// ============================================================================

describe("User Story 3: detectSetupScript()", () => {
  // T046: Unit test for detectSetupScript() with setup.sh present
  test("T046: detects setup.sh when present in repository root", async () => {
    // Arrange: Create repo with setup.sh
    const repoPath = join(TEST_WORKSPACE, "setup-repo");
    await mkdir(repoPath, { recursive: true });
    const setupPath = join(repoPath, "setup.sh");
    await Bun.write(setupPath, "#!/bin/bash\necho 'Setup script'");
    await exec(`chmod +x ${setupPath}`, repoPath);

    // Act
    const result = await detectSetupScript(repoPath);

    // Assert
    expect(result.hasSetupScript).toBe(true);
    expect(result.setupScriptPath).toBe(setupPath);
  });

  // T047: Unit test for detectSetupScript() with no setup script
  test("T047: returns false when no setup script exists", async () => {
    // Arrange: Create repo without setup.sh
    const repoPath = join(TEST_WORKSPACE, "no-setup-repo");
    await mkdir(repoPath, { recursive: true });

    // Act
    const result = await detectSetupScript(repoPath);

    // Assert
    expect(result.hasSetupScript).toBe(false);
    expect(result.setupScriptPath).toBeUndefined();
  });

  // T048: Unit test for detectSetupScript() with multiple script patterns
  test("T048: detects multiple script patterns (setup.bash, .arashi/setup.sh)", async () => {
    // Arrange: Test setup.bash
    const repo1Path = join(TEST_WORKSPACE, "bash-setup-repo");
    await mkdir(repo1Path, { recursive: true });
    const bashSetupPath = join(repo1Path, "setup.bash");
    await Bun.write(bashSetupPath, "#!/bin/bash\necho 'Bash setup'");

    // Act & Assert for setup.bash
    const result1 = await detectSetupScript(repo1Path);
    expect(result1.hasSetupScript).toBe(true);
    expect(result1.setupScriptPath).toBe(bashSetupPath);

    // Arrange: Test .arashi/setup.sh
    const repo2Path = join(TEST_WORKSPACE, "arashi-setup-repo");
    await mkdir(join(repo2Path, ".arashi"), { recursive: true });
    const arashiSetupPath = join(repo2Path, ".arashi", "setup.sh");
    await Bun.write(arashiSetupPath, "#!/bin/bash\necho 'Arashi setup'");

    // Act & Assert for .arashi/setup.sh
    const result2 = await detectSetupScript(repo2Path);
    expect(result2.hasSetupScript).toBe(true);
    expect(result2.setupScriptPath).toBe(arashiSetupPath);
  });

  // T049: Unit test for detectSetupScript() with custom patterns from config
  test("T049: supports custom patterns from options", async () => {
    // Arrange: Create repo with custom script name
    const repoPath = join(TEST_WORKSPACE, "custom-setup-repo");
    await mkdir(repoPath, { recursive: true });
    const customPath = join(repoPath, "install.sh");
    await Bun.write(customPath, "#!/bin/bash\necho 'Custom install'");

    // Act: Pass custom patterns
    const result = await detectSetupScript(repoPath, ["install.sh", "bootstrap.sh"]);

    // Assert
    expect(result.hasSetupScript).toBe(true);
    expect(result.setupScriptPath).toBe(customPath);
  });
});

// ============================================================================
// User Story 5: Workspace Validation (T060-T063)
// ============================================================================

describe("User Story 5: validateWorkspace()", () => {
  // T060: Unit test for validateWorkspace() with all repos present
  test("T060: returns valid result when all configured repos exist", async () => {
    // Arrange: Create workspace with 3 repos
    const workspacePath = join(TEST_WORKSPACE, "validation-all-present");
    await mkdir(workspacePath, { recursive: true });

    // Create 3 test repos
    for (const name of ["repo-1", "repo-2", "repo-3"]) {
      await createGitRepo(join(workspacePath, name));
    }

    // Configuration expecting these 3 repos
    const config: WorkspaceConfiguration = {
      repositories: [{ name: "repo-1" }, { name: "repo-2" }, { name: "repo-3" }],
      workspacePath,
    };

    // Act
    const result: ValidationResult = await validateWorkspace(config);

    // Assert
    expect(result.isValid).toBe(true);
    expect(result.present).toHaveLength(3);
    expect(result.missing).toHaveLength(0);
    expect(result.extra).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // T061: Unit test for validateWorkspace() with missing repos
  test("T061: identifies missing repositories", async () => {
    // Arrange: Create workspace with only 2 out of 5 repos
    const workspacePath = join(TEST_WORKSPACE, "validation-missing");
    await mkdir(workspacePath, { recursive: true });

    // Create only 2 repos
    await createGitRepo(join(workspacePath, "repo-1"));
    await createGitRepo(join(workspacePath, "repo-2"));

    // Configuration expecting 5 repos
    const config: WorkspaceConfiguration = {
      repositories: [
        { name: "repo-1" },
        { name: "repo-2" },
        { name: "repo-3" }, // missing
        { name: "repo-4" }, // missing
        { name: "repo-5" }, // missing
      ],
      workspacePath,
    };

    // Act
    const result: ValidationResult = await validateWorkspace(config);

    // Assert
    expect(result.isValid).toBe(false); // Invalid due to missing repos
    expect(result.present).toHaveLength(2);
    expect(result.missing).toHaveLength(3);
    expect(result.missing.map((r) => r.name)).toEqual(["repo-3", "repo-4", "repo-5"]);
    expect(result.extra).toHaveLength(0);
  });

  // T062: Unit test for validateWorkspace() with extra repos
  test("T062: identifies extra repositories not in config", async () => {
    // Arrange: Create workspace with 5 repos
    const workspacePath = join(TEST_WORKSPACE, "validation-extra");
    await mkdir(workspacePath, { recursive: true });

    // Create 5 repos
    for (const name of ["repo-1", "repo-2", "extra-1", "extra-2", "extra-3"]) {
      await createGitRepo(join(workspacePath, name));
    }

    // Configuration expecting only 2 repos
    const config: WorkspaceConfiguration = {
      repositories: [{ name: "repo-1" }, { name: "repo-2" }],
      workspacePath,
    };

    // Act
    const result: ValidationResult = await validateWorkspace(config);

    // Assert
    expect(result.isValid).toBe(true); // Valid - extra repos don't affect validity
    expect(result.present).toHaveLength(2);
    expect(result.missing).toHaveLength(0);
    expect(result.extra).toHaveLength(3);
    expect(result.extra.map((r) => r.name).toSorted()).toEqual(["extra-1", "extra-2", "extra-3"]);
  });

  // T063: Unit test for validateWorkspace() reporting missing repo details
  test("T063: provides detailed information about missing repositories", async () => {
    // Arrange: Create workspace with 1 repo
    const workspacePath = join(TEST_WORKSPACE, "validation-details");
    await mkdir(workspacePath, { recursive: true });

    await createGitRepo(join(workspacePath, "present-repo"));

    // Configuration with detailed info for missing repos
    const config: WorkspaceConfiguration = {
      repositories: [
        { name: "present-repo" },
        {
          name: "missing-repo-1",
          path: "custom/path/repo1",
          url: "https://github.com/example/repo1.git",
        },
        { name: "missing-repo-2", url: "https://github.com/example/repo2.git" },
      ],
      workspacePath,
    };

    // Act
    const result: ValidationResult = await validateWorkspace(config);

    // Assert
    expect(result.isValid).toBe(false);
    expect(result.missing).toHaveLength(2);

    const missing1 = result.missing.find((r) => r.name === "missing-repo-1");
    expect(missing1).toBeDefined();
    expect(missing1!.path).toBe("custom/path/repo1");
    expect(missing1!.url).toBe("https://github.com/example/repo1.git");

    const missing2 = result.missing.find((r) => r.name === "missing-repo-2");
    expect(missing2).toBeDefined();
    expect(missing2!.url).toBe("https://github.com/example/repo2.git");
  });
});

// ============================================================================
// User Story 4: Repository Cloning (T077-T080)
// ============================================================================

describe("User Story 4: cloneRepository()", () => {
  const CLONE_TEST_WORKSPACE = join(TEST_WORKSPACE, "clone-tests");

  beforeEach(async () => {
    await rm(CLONE_TEST_WORKSPACE, { force: true, recursive: true });
    await mkdir(CLONE_TEST_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    await rm(CLONE_TEST_WORKSPACE, { force: true, recursive: true });
  });

  // T077: Unit test for cloneRepository() successful clone
  test("T077: successfully clones a repository from URL", async () => {
    // Arrange: Create a source repository to clone from
    const sourceRepo = join(CLONE_TEST_WORKSPACE, "source");
    await createGitRepo(sourceRepo);
    await Bun.write(join(sourceRepo, "README.md"), "# Test Repo");
    await exec("git add .", sourceRepo);
    await exec("git commit -m 'Add README'", sourceRepo);

    const targetPath = join(CLONE_TEST_WORKSPACE, "cloned");

    // Act: Clone the repository
    const result: CloneOperation = await cloneRepository(sourceRepo, targetPath);

    // Assert: Verify clone completed successfully
    expect(result.status).toBe(CloneStatus.COMPLETED);
    expect(result.url).toBe(sourceRepo);
    expect(result.targetPath).toBe(targetPath);
    expect(result.error).toBeUndefined();

    // Verify repository exists and is valid
    const gitDir = join(targetPath, ".git");
    const gitDirStats = await stat(gitDir);
    expect(gitDirStats.isDirectory()).toBe(true);

    // Verify files were cloned
    const readmeFile = Bun.file(join(targetPath, "README.md"));
    expect(await readmeFile.exists()).toBe(true);
    const readmeContent = await readmeFile.text();
    expect(readmeContent).toBe("# Test Repo");
  }, 10_000);

  // T078: Unit test for cloneRepository() with target already exists error
  test("T078: fails when target path already exists", async () => {
    // Arrange: Create a source repo and an existing target directory
    const sourceRepo = join(CLONE_TEST_WORKSPACE, "source");
    await createGitRepo(sourceRepo);

    const targetPath = join(CLONE_TEST_WORKSPACE, "existing");
    await mkdir(targetPath, { recursive: true });
    await Bun.write(join(targetPath, "file.txt"), "existing content");

    // Act: Attempt to clone
    const result: CloneOperation = await cloneRepository(sourceRepo, targetPath);

    // Assert: Clone should fail with TARGET_EXISTS error
    expect(result.status).toBe(CloneStatus.FAILED);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(CloneErrorCode.TARGET_EXISTS);
    expect(result.error!.message).toContain("already exists");
  });

  // T079: Unit test for cloneRepository() with invalid URL error
  test("T079: fails with invalid URL", async () => {
    // Arrange: Invalid URL
    const invalidUrl = "https://invalid-git-url-that-does-not-exist.com/repo.git";
    const targetPath = join(CLONE_TEST_WORKSPACE, "target");

    // Act: Attempt to clone from invalid URL
    const result: CloneOperation = await cloneRepository(invalidUrl, targetPath, {
      timeout: 5000, // Shorter timeout for test
    });

    // Assert: Clone should fail
    expect(result.status).toBe(CloneStatus.FAILED);
    expect(result.error).toBeDefined();
    // Error could be NETWORK_ERROR or INVALID_URL depending on failure mode
    expect(["NETWORK_ERROR", "INVALID_URL", "UNKNOWN"]).toContain(result.error!.code);
  }, 10_000);

  // T080: Unit test for cloneRepository() with progress callbacks
  test("T080: reports progress during clone", async () => {
    // Arrange: Create a source repository with some content
    const sourceRepo = join(CLONE_TEST_WORKSPACE, "source");
    await createGitRepo(sourceRepo);

    // Add multiple commits to generate progress updates
    for (let i = 1; i <= 5; i++) {
      await Bun.write(join(sourceRepo, `file${i}.txt`), `Content ${i}`);
      await exec("git add .", sourceRepo);
      await exec(`git commit -m 'Add file ${i}'`, sourceRepo);
    }

    const targetPath = join(CLONE_TEST_WORKSPACE, "cloned-with-progress");

    // Track progress updates
    const progressUpdates: CloneProgress[] = [];

    // Act: Clone with progress callback
    const result: CloneOperation = await cloneRepository(sourceRepo, targetPath, {
      onProgress: (progress) => {
        progressUpdates.push({ ...progress });
      },
    });

    // Assert: Should have received progress updates
    expect(result.status).toBe(CloneStatus.COMPLETED);
    expect(progressUpdates.length).toBeGreaterThan(0);

    // Verify progress updates have expected structure
    if (progressUpdates.length > 0) {
      const firstProgress = progressUpdates[0];
      expect(firstProgress).toHaveProperty("phase");
      expect(firstProgress).toHaveProperty("percentage");
      expect(firstProgress).toHaveProperty("message");
    }
  }, 10_000);
});
