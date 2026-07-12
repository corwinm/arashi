import { runtime } from "#test-runtime";
/**
 * Integration Tests: Repository Discovery and Management
 *
 * Exercises real git repositories, clone operations, and workspace validation.
 */

import {
  CloneErrorCode,
  CloneStatus,
  cloneRepository,
  detectDefaultBranch,
  discoverRepositories,
  validateWorkspace,
} from "../../src/core/repository.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, rm, stat } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";

type CloneOperation = Awaited<ReturnType<typeof cloneRepository>>;
type CloneProgress = Parameters<
  NonNullable<NonNullable<Parameters<typeof cloneRepository>[2]>["onProgress"]>
>[0];
type RepositoryDiscoveryResult = Awaited<ReturnType<typeof discoverRepositories>>;
type ValidationResult = Awaited<ReturnType<typeof validateWorkspace>>;
type WorkspaceConfiguration = Parameters<typeof validateWorkspace>[0];

const TEST_WORKSPACE = join(import.meta.dirname, "..", "temp-integration-workspace", "repository");

function sortStringArray(values: string[]): string[] {
  const sortedValues = [...values];
  for (let index = 1; index < sortedValues.length; index += 1) {
    const currentValue = sortedValues[index];
    let insertIndex = index - 1;

    while (insertIndex >= 0 && sortedValues[insertIndex].localeCompare(currentValue) > 0) {
      sortedValues[insertIndex + 1] = sortedValues[insertIndex];
      insertIndex -= 1;
    }

    sortedValues[insertIndex + 1] = currentValue;
  }

  return sortedValues;
}

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

async function createGitRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await exec("git init -b main", path);
  await exec('git config user.name "Test"', path);
  await exec('git config user.email "test@test.com"', path);
  await exec("git commit --allow-empty -m 'Initial'", path);
}

describe("Repository Discovery", () => {
  beforeEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
  });

  test("discovers multiple git repositories", async () => {
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));
    await createGitRepo(join(TEST_WORKSPACE, "repo3"));

    const result: RepositoryDiscoveryResult = await discoverRepositories(TEST_WORKSPACE);

    expect(result.repositories).toHaveLength(3);
    expect(sortStringArray(result.repositories.map((repository) => repository.name))).toEqual([
      "repo1",
      "repo2",
      "repo3",
    ]);
    expect(result.errors).toHaveLength(0);
  });

  test("skips non-repository directories", async () => {
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await mkdir(join(TEST_WORKSPACE, "not-a-repo"), { recursive: true });
    await mkdir(join(TEST_WORKSPACE, "also-not-a-repo"), { recursive: true });
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));

    const result = await discoverRepositories(TEST_WORKSPACE);

    expect(result.repositories).toHaveLength(2);
    expect(sortStringArray(result.repositories.map((repository) => repository.name))).toEqual([
      "repo1",
      "repo2",
    ]);
  });

  test("respects maxDepth option", async () => {
    await createGitRepo(join(TEST_WORKSPACE, "level1"));
    await createGitRepo(join(TEST_WORKSPACE, "deep", "level2"));
    await createGitRepo(join(TEST_WORKSPACE, "deep", "deeper", "level3"));
    await createGitRepo(join(TEST_WORKSPACE, "deep", "deeper", "deepest", "level4"));

    const shallowResult = await discoverRepositories(TEST_WORKSPACE, { maxDepth: 2 });
    expect(shallowResult.repositories).toHaveLength(2);
    expect(
      sortStringArray(shallowResult.repositories.map((repository) => repository.name)),
    ).toEqual(["level1", "level2"]);

    const deepResult = await discoverRepositories(TEST_WORKSPACE, { maxDepth: 4 });
    expect(deepResult.repositories).toHaveLength(4);
  });

  test("stops scanning at repository boundaries", async () => {
    await createGitRepo(join(TEST_WORKSPACE, "parent-repo"));
    await mkdir(join(TEST_WORKSPACE, "parent-repo", "subdir", "nested"), { recursive: true });

    const result = await discoverRepositories(TEST_WORKSPACE);

    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]?.name).toBe("parent-repo");
    expect(result.scannedDirectories).toBeLessThan(5);
  });

  test("excludes directories matching patterns", async () => {
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await createGitRepo(join(TEST_WORKSPACE, "node_modules", "some-package"));
    await createGitRepo(join(TEST_WORKSPACE, ".hidden", "repo"));
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));

    const result = await discoverRepositories(TEST_WORKSPACE, {
      excludePatterns: ["node_modules", ".hidden"],
    });

    expect(result.repositories).toHaveLength(2);
    expect(sortStringArray(result.repositories.map((repository) => repository.name))).toEqual([
      "repo1",
      "repo2",
    ]);
  });

  test("reports scannedDirectories count", async () => {
    await createGitRepo(join(TEST_WORKSPACE, "repo1"));
    await mkdir(join(TEST_WORKSPACE, "dir1", "subdir"), { recursive: true });
    await createGitRepo(join(TEST_WORKSPACE, "repo2"));

    const result = await discoverRepositories(TEST_WORKSPACE);

    expect(result.scannedDirectories).toBeGreaterThan(0);
    expect(result.scannedDirectories).toBeLessThan(20);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

describe("Default Branch Detection", () => {
  beforeEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
  });

  test("detects main from remote HEAD", async () => {
    const repoPath = join(TEST_WORKSPACE, "main-repo");
    await createGitRepo(repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", repoPath);

    const branch = await detectDefaultBranch(repoPath);
    expect(branch).toBe("main");
  });

  test("detects master from remote HEAD", async () => {
    const repoPath = join(TEST_WORKSPACE, "master-repo");
    await mkdir(repoPath, { recursive: true });
    await exec("git init -b master", repoPath);
    await exec('git config user.name "Test"', repoPath);
    await exec('git config user.email "test@test.com"', repoPath);
    await exec("git commit --allow-empty -m 'Initial'", repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master", repoPath);

    const branch = await detectDefaultBranch(repoPath);
    expect(branch).toBe("master");
  });

  test("detects develop from remote HEAD", async () => {
    const repoPath = join(TEST_WORKSPACE, "develop-repo");
    await mkdir(repoPath, { recursive: true });
    await exec("git init -b develop", repoPath);
    await exec('git config user.name "Test"', repoPath);
    await exec('git config user.email "test@test.com"', repoPath);
    await exec("git commit --allow-empty -m 'Initial'", repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop", repoPath);

    const branch = await detectDefaultBranch(repoPath);
    expect(branch).toBe("develop");
  });

  test("handles detached HEAD state", async () => {
    const repoPath = join(TEST_WORKSPACE, "detached-repo");
    await createGitRepo(repoPath);
    await exec("git remote add origin https://github.com/test/repo.git", repoPath);
    await exec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", repoPath);

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

    const branch = await detectDefaultBranch(repoPath);
    expect(branch).toBe("main");
  });

  test("falls back when repository has no remote", async () => {
    const repoPath = join(TEST_WORKSPACE, "no-remote-repo");
    await createGitRepo(repoPath);

    const branch = await detectDefaultBranch(repoPath);
    expect(branch).toBe("main");
  });
});

describe("Workspace Validation", () => {
  beforeEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
    await mkdir(TEST_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_WORKSPACE, { force: true, recursive: true });
  });

  test("returns valid result when all configured repos exist", async () => {
    const workspacePath = join(TEST_WORKSPACE, "validation-all-present");
    await mkdir(workspacePath, { recursive: true });

    for (const name of ["repo-1", "repo-2", "repo-3"]) {
      await createGitRepo(join(workspacePath, name));
    }

    const config: WorkspaceConfiguration = {
      repositories: [{ name: "repo-1" }, { name: "repo-2" }, { name: "repo-3" }],
      workspacePath,
    };

    const result: ValidationResult = await validateWorkspace(config);

    expect(result.isValid).toBe(true);
    expect(result.present).toHaveLength(3);
    expect(result.missing).toHaveLength(0);
    expect(result.extra).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("identifies missing repositories", async () => {
    const workspacePath = join(TEST_WORKSPACE, "validation-missing");
    await mkdir(workspacePath, { recursive: true });
    await createGitRepo(join(workspacePath, "repo-1"));
    await createGitRepo(join(workspacePath, "repo-2"));

    const config: WorkspaceConfiguration = {
      repositories: [
        { name: "repo-1" },
        { name: "repo-2" },
        { name: "repo-3" },
        { name: "repo-4" },
        { name: "repo-5" },
      ],
      workspacePath,
    };

    const result = await validateWorkspace(config);

    expect(result.isValid).toBe(false);
    expect(result.present).toHaveLength(2);
    expect(result.missing).toHaveLength(3);
    expect(result.missing.map((repository) => repository.name)).toEqual([
      "repo-3",
      "repo-4",
      "repo-5",
    ]);
  });

  test("identifies extra repositories", async () => {
    const workspacePath = join(TEST_WORKSPACE, "validation-extra");
    await mkdir(workspacePath, { recursive: true });

    for (const name of ["repo-1", "repo-2", "extra-1", "extra-2", "extra-3"]) {
      await createGitRepo(join(workspacePath, name));
    }

    const config: WorkspaceConfiguration = {
      repositories: [{ name: "repo-1" }, { name: "repo-2" }],
      workspacePath,
    };

    const result = await validateWorkspace(config);

    expect(result.isValid).toBe(true);
    expect(result.present).toHaveLength(2);
    expect(result.missing).toHaveLength(0);
    expect(sortStringArray(result.extra.map((repository) => repository.name))).toEqual([
      "extra-1",
      "extra-2",
      "extra-3",
    ]);
  });

  test("preserves missing repository details", async () => {
    const workspacePath = join(TEST_WORKSPACE, "validation-details");
    await mkdir(workspacePath, { recursive: true });
    await createGitRepo(join(workspacePath, "present-repo"));

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

    const result = await validateWorkspace(config);

    expect(result.isValid).toBe(false);
    expect(result.missing).toHaveLength(2);
    expect(result.missing.find((repository) => repository.name === "missing-repo-1")).toEqual({
      name: "missing-repo-1",
      path: "custom/path/repo1",
      url: "https://github.com/example/repo1.git",
    });
    expect(result.missing.find((repository) => repository.name === "missing-repo-2")).toEqual({
      name: "missing-repo-2",
      url: "https://github.com/example/repo2.git",
    });
  });
});

describe("Repository Cloning", () => {
  const cloneWorkspace = join(TEST_WORKSPACE, "clone-tests");

  beforeEach(async () => {
    await rm(cloneWorkspace, { force: true, recursive: true });
    await mkdir(cloneWorkspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(cloneWorkspace, { force: true, recursive: true });
  });

  test("successfully clones a repository from URL", async () => {
    const sourceRepo = join(cloneWorkspace, "source");
    await createGitRepo(sourceRepo);
    await runtime.write(join(sourceRepo, "README.md"), "# Test Repo");
    await exec("git add .", sourceRepo);
    await exec("git commit -m 'Add README'", sourceRepo);

    const targetPath = join(cloneWorkspace, "cloned");
    const result: CloneOperation = await cloneRepository(sourceRepo, targetPath);

    expect(result.status).toBe(CloneStatus.COMPLETED);
    expect(result.url).toBe(sourceRepo);
    expect(result.targetPath).toBe(targetPath);
    expect(result.error).toBeUndefined();

    const gitDirStats = await stat(join(targetPath, ".git"));
    expect(gitDirStats.isDirectory()).toBe(true);
    expect(await runtime.file(join(targetPath, "README.md")).text()).toBe("# Test Repo");
  }, 10_000);

  test("fails when target path already exists", async () => {
    const sourceRepo = join(cloneWorkspace, "source");
    await createGitRepo(sourceRepo);

    const targetPath = join(cloneWorkspace, "existing");
    await mkdir(targetPath, { recursive: true });
    await runtime.write(join(targetPath, "file.txt"), "existing content");

    const result = await cloneRepository(sourceRepo, targetPath);

    expect(result.status).toBe(CloneStatus.FAILED);
    expect(result.error?.code).toBe(CloneErrorCode.TARGET_EXISTS);
    expect(result.error?.message).toContain("already exists");
  });

  test("fails with invalid URL", async () => {
    const targetPath = join(cloneWorkspace, "target");
    const result = await cloneRepository(
      "https://invalid-git-url-that-does-not-exist.com/repo.git",
      targetPath,
      { timeout: 5000 },
    );

    expect(result.status).toBe(CloneStatus.FAILED);
    expect(result.error).toBeDefined();
    expect([
      CloneErrorCode.NETWORK_ERROR,
      CloneErrorCode.INVALID_URL,
      CloneErrorCode.TIMEOUT,
      CloneErrorCode.UNKNOWN,
    ]).toContain(result.error!.code);
  }, 10_000);

  test("reports progress during clone", async () => {
    const sourceRepo = join(cloneWorkspace, "source");
    await createGitRepo(sourceRepo);

    for (let index = 1; index <= 5; index += 1) {
      await runtime.write(join(sourceRepo, `file${index}.txt`), `Content ${index}`);
      await exec("git add .", sourceRepo);
      await exec(`git commit -m 'Add file ${index}'`, sourceRepo);
    }

    const targetPath = join(cloneWorkspace, "cloned-with-progress");
    const progressUpdates: CloneProgress[] = [];

    const result = await cloneRepository(sourceRepo, targetPath, {
      onProgress: (progress) => {
        progressUpdates.push({ ...progress });
      },
    });

    expect(result.status).toBe(CloneStatus.COMPLETED);
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[0]).toHaveProperty("phase");
    expect(progressUpdates[0]).toHaveProperty("percentage");
    expect(progressUpdates[0]).toHaveProperty("message");
  }, 10_000);
});
