import { runtime, spawn } from "#test-runtime";
/**
 * Integration Tests for Init Command
 *
 * Tests the complete init workflow including file system operations,
 * git validation, error handling, and rollback behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { fileExists, readTextFile, writeTextFile } from "../../src/lib/filesystem";
import { getConfigPath, loadConfig, saveConfig } from "../../src/lib/config";
import { executeInit } from "../../src/commands/init.ts";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Helper to create a temporary git repository for testing
 */
async function createTempGitRepo(): Promise<string> {
  const testDir = await mkdtemp(join(tmpdir(), "arashi-init-test-"));

  // Initialize git repository
  const gitInit = spawn(["git", "init"], {
    cwd: testDir,
    stderr: "pipe",
    stdout: "pipe",
  });
  await gitInit.exited;

  // Configure git (required for commits)
  await spawn(["git", "config", "user.email", "test@example.com"], { cwd: testDir }).exited;
  await spawn(["git", "config", "user.name", "Test User"], { cwd: testDir }).exited;

  return testDir;
}

/**
 * Helper to create a temporary non-git directory
 */
async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "arashi-init-test-"));
}

/**
 * Helper to clean up test directory
 */
async function cleanup(testDir: string): Promise<void> {
  await rm(testDir, { force: true, recursive: true });
}

/**
 * Helper to execute arashi init command
 */
async function runInitCommand(
  cwd: string,
  args: string[] = [],
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  // Find arashi binary - start from test file and go up to find repos/arashi
  const testFileDir = import.meta.dirname;
  const arashiRoot = join(testFileDir, "..", "..");
  const arashiBin = join(arashiRoot, "src", "index.ts");

  const proc = spawn(
    [
      process.execPath,
      "--no-warnings",
      "--experimental-transform-types",
      arashiBin,
      "init",
      ...args,
    ],
    {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stderr, stdout };
}

describe("init command - success cases", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("basic initialization creates all required files and directories", async () => {
    const result = await runInitCommand(testDir);

    // Verify exit code
    expect(result.exitCode).toBe(0);

    // Verify output contains success message
    expect(result.stdout).toContain("Initialized Arashi workspace");

    // Verify .arashi directory created
    expect(await fileExists(join(testDir, ".arashi"))).toBe(true);

    // Verify config file created
    const configPath = getConfigPath(testDir);
    expect(await fileExists(configPath)).toBe(true);

    // Verify config content
    const loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.version).toBe("1.0.0");
    expect(loadedConfig.reposDir).toBe("./repos");
    expect(loadedConfig.repos).toEqual({});

    // Verify hooks directory created
    const hooksDir = join(testDir, ".arashi", "hooks");
    expect(await fileExists(hooksDir)).toBe(true);

    // Verify hook templates created
    expect(await fileExists(join(hooksDir, "pre-create.sh.example"))).toBe(true);
    expect(await fileExists(join(hooksDir, "post-create.sh.example"))).toBe(true);
    expect(await fileExists(join(hooksDir, "pre-remove.sh.example"))).toBe(true);
    expect(await fileExists(join(hooksDir, "post-remove.sh.example"))).toBe(true);
    expect(await fileExists(join(hooksDir, "setup.sh.example"))).toBe(true);

    // Verify repos directory created
    expect(await fileExists(join(testDir, "repos"))).toBe(true);

    // Verify .gitignore updated
    const gitignorePath = join(testDir, ".gitignore");
    expect(await fileExists(gitignorePath)).toBe(true);
    const gitignoreContent = await readTextFile(gitignorePath);
    expect(gitignoreContent).toContain("repos/");
    expect(gitignoreContent).toContain(".arashi/worktrees/");
  });

  test("init with custom repos directory", async () => {
    const result = await runInitCommand(testDir, ["--repos-dir", "./custom-repos"]);

    expect(result.exitCode).toBe(0);

    // Verify custom directory created
    expect(await fileExists(join(testDir, "custom-repos"))).toBe(true);

    // Verify config uses custom path
    const loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.reposDir).toBe("./custom-repos");

    // Verify .gitignore updated with custom path
    const gitignoreContent = await readTextFile(join(testDir, ".gitignore"));
    expect(gitignoreContent).toContain("custom-repos/");
    expect(gitignoreContent).toContain(".arashi/worktrees/");
  });

  test("init with custom managed subdirectory adds normalized worktrees ignore entry", async () => {
    const result = await runInitCommand(testDir, ["--worktrees-dir", "./workspace-worktrees/"]);

    expect(result.exitCode).toBe(0);

    const loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.worktreesDir).toBe("workspace-worktrees");

    const gitignoreContent = await readTextFile(join(testDir, ".gitignore"));
    expect(gitignoreContent).toContain("repos/");
    expect(gitignoreContent).toContain("workspace-worktrees/");
    expect(gitignoreContent).not.toContain(".arashi/worktrees/");
    expect(result.stdout).toContain("workspace-worktrees/");
  });

  test("init with parent worktrees directory does not auto-ignore unsafe path", async () => {
    const result = await runInitCommand(testDir, ["--worktrees-dir", "../workspace-worktrees"]);

    expect(result.exitCode).toBe(0);

    const loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.worktreesDir).toBe("../workspace-worktrees");

    const gitignoreContent = await readTextFile(join(testDir, ".gitignore"));
    expect(gitignoreContent).toContain("repos/");
    expect(gitignoreContent).not.toContain("../workspace-worktrees/");
    expect(gitignoreContent).not.toContain(".arashi/worktrees/");
  });

  test("init with dot worktrees directory does not auto-ignore workspace root", async () => {
    const result = await runInitCommand(testDir, ["--worktrees-dir", "."]);

    expect(result.exitCode).toBe(0);

    const loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.worktreesDir).toBe(".");

    const gitignoreContent = await readTextFile(join(testDir, ".gitignore"));
    const gitignoreLines = gitignoreContent.split("\n").map((line) => line.trim());
    expect(gitignoreContent).toContain("repos/");
    expect(gitignoreLines).not.toContain(".");
    expect(gitignoreLines).not.toContain("./");
    expect(gitignoreContent).not.toContain(".arashi/worktrees/");
  });

  test("init with --no-discover skips repository discovery", async () => {
    // Create a repo in repos directory first
    await mkdir(join(testDir, "repos", "test-repo", ".git"), { recursive: true });

    const result = await runInitCommand(testDir, ["--no-discover"]);

    expect(result.exitCode).toBe(0);
    // When --no-discover is used, output should not show repository discovery
    // But should indicate discovery was skipped or show 0 repositories

    // Verify no repositories discovered in config
    const loadedConfig = await loadConfig(testDir);
    expect(Object.keys(loadedConfig.repos)).toHaveLength(0);
  });

  test("init with --force overwrites existing configuration", async () => {
    // First initialization
    await runInitCommand(testDir);

    // Modify config
    let loadedConfig = await loadConfig(testDir);
    loadedConfig.reposDir = "./custom-repos";
    await saveConfig(testDir, loadedConfig);

    // Reinitialize with --force
    const result = await runInitCommand(testDir, ["--force"]);

    expect(result.exitCode).toBe(0);
    // The backup message is in stdout ("Backing up:") and warning is in stderr
    expect(result.stdout + result.stderr).toContain("backed up");

    // Verify config reset to defaults
    loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.reposDir).toBe("./repos");

    // Verify backup created
    const backupFiles = await Array.fromAsync(
      new runtime.Glob("*.backup-*").scan({ cwd: join(testDir, ".arashi") }),
    );
    expect(backupFiles.length).toBeGreaterThan(0);
  });

  test(".gitignore update is idempotent", async () => {
    // First init
    await runInitCommand(testDir);

    const gitignoreContent1 = await readTextFile(join(testDir, ".gitignore"));
    const reposLineCount1 = (gitignoreContent1.match(/repos\//g) || []).length;
    const worktreesLineCount1 = (gitignoreContent1.match(/\.arashi\/worktrees\//g) || []).length;
    expect(gitignoreContent1).toContain(".arashi/worktrees/");

    // Delete config to allow re-init
    await rm(join(testDir, ".arashi"), { recursive: true });

    // Second init
    await runInitCommand(testDir);

    const gitignoreContent2 = await readTextFile(join(testDir, ".gitignore"));
    const reposLineCount2 = (gitignoreContent2.match(/repos\//g) || []).length;
    const worktreesLineCount2 = (gitignoreContent2.match(/\.arashi\/worktrees\//g) || []).length;
    expect(gitignoreContent2).toContain(".arashi/worktrees/");

    // Verify repos/ pattern appears same number of times
    expect(reposLineCount2).toBe(reposLineCount1);
    expect(worktreesLineCount2).toBe(worktreesLineCount1);
  });

  test(".gitignore update is idempotent with configured worktrees directory", async () => {
    await runInitCommand(testDir, ["--worktrees-dir", "workspace-worktrees"]);

    const gitignoreContent1 = await readTextFile(join(testDir, ".gitignore"));
    const reposLineCount1 = (gitignoreContent1.match(/repos\//g) || []).length;
    const customWorktreesLineCount1 = (gitignoreContent1.match(/workspace-worktrees\//g) || [])
      .length;

    await rm(join(testDir, ".arashi"), { recursive: true });

    await runInitCommand(testDir, ["--worktrees-dir", "./workspace-worktrees/"]);

    const gitignoreContent2 = await readTextFile(join(testDir, ".gitignore"));
    const reposLineCount2 = (gitignoreContent2.match(/repos\//g) || []).length;
    const customWorktreesLineCount2 = (gitignoreContent2.match(/workspace-worktrees\//g) || [])
      .length;

    expect(reposLineCount2).toBe(reposLineCount1);
    expect(customWorktreesLineCount2).toBe(customWorktreesLineCount1);
  });

  test("hook templates are not overwritten if they exist", async () => {
    // First init
    await runInitCommand(testDir);

    // Modify a template
    const templatePath = join(testDir, ".arashi", "hooks", "pre-create.sh.example");
    await writeTextFile(templatePath, '#!/bin/bash\necho "custom"');

    // Delete config to allow re-init
    await rm(join(testDir, ".arashi", "config.json"));

    // Second init
    await runInitCommand(testDir);

    // Verify custom template preserved
    const templateContent = await readTextFile(templatePath);
    expect(templateContent).toContain("custom");
    expect(templateContent).not.toContain("Pre-Create Hook Example");
  });
});

describe("init command - error cases", () => {
  let testDir: string;

  test("fails when not in a git repository", async () => {
    testDir = await createTempDir();

    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(1); // NOT_GIT_REPOSITORY
    // Error message is in stderr, help text is in stdout
    expect(result.stderr).toContain("Not a git repository");
    expect(result.stdout).toContain("interactive terminal");

    // Verify no files created
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);

    await cleanup(testDir);
  });

  test("fails when already initialized without --force", async () => {
    testDir = await createTempGitRepo();

    // First init
    await runInitCommand(testDir);

    // Second init without --force
    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(2); // CONFIG_EXISTS
    // Error message is in stderr, help text is in stdout
    expect(result.stderr).toContain("already exists");
    expect(result.stdout).toContain("--force");

    await cleanup(testDir);
  });

  test("fails with path too long (> 4096 characters)", async () => {
    testDir = await createTempGitRepo();

    // Create a path longer than 4096 characters
    const longPath = "a".repeat(5000);
    const result = await runInitCommand(testDir, ["--repos-dir", longPath]);

    expect(result.exitCode).toBe(5); // INVALID_PATH

    await cleanup(testDir);
  });

  test("fails with path too long", async () => {
    testDir = await createTempGitRepo();

    // Create a path longer than 4096 characters
    const longPath = "a".repeat(5000);
    const result = await runInitCommand(testDir, ["--repos-dir", longPath]);

    expect(result.exitCode).toBe(5); // INVALID_PATH

    await cleanup(testDir);
  });
});

describe("init command - repository bootstrap", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) {
      await cleanup(testDir);
    }
  });

  test("exits without creating files when bootstrap is declined", async () => {
    testDir = await createTempDir();

    const result = await executeInit(
      {},
      {
        cwd: testDir,
        promptConfirm: async () => ({ status: "ok", value: false }),
        stdinIsTTY: true,
      },
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(8);
    expect(await fileExists(join(testDir, ".git"))).toBe(false);
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);
    expect(await fileExists(join(testDir, "repos"))).toBe(false);
  });

  test("bootstraps the current directory when target is '.'", async () => {
    testDir = await createTempDir();

    const result = await executeInit(
      {},
      {
        cwd: testDir,
        promptConfirm: async () => ({ status: "ok", value: true }),
        promptInput: async () => ({ status: "ok", value: "." }),
        stdinIsTTY: true,
      },
    );

    expect(result.success).toBe(true);
    expect(result.workspaceRoot).toBe(testDir);
    expect(await fileExists(join(testDir, ".git"))).toBe(true);
    expect(await fileExists(join(testDir, ".arashi"))).toBe(true);
    expect(await fileExists(join(testDir, "repos"))).toBe(true);

    const loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.reposDir).toBe("./repos");
  });

  test("bootstraps a child directory when given a child repository name", async () => {
    testDir = await createTempDir();
    const childRepoPath = join(testDir, "my-arashi-repo");

    const result = await executeInit(
      {},
      {
        cwd: testDir,
        promptConfirm: async () => ({ status: "ok", value: true }),
        promptInput: async () => ({ status: "ok", value: "my-arashi-repo" }),
        stdinIsTTY: true,
      },
    );

    expect(result.success).toBe(true);
    expect(result.workspaceRoot).toBe(childRepoPath);
    expect(await fileExists(join(childRepoPath, ".git"))).toBe(true);
    expect(await fileExists(join(childRepoPath, ".arashi"))).toBe(true);
    expect(await fileExists(join(childRepoPath, "repos"))).toBe(true);
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);

    const loadedConfig = await loadConfig(childRepoPath);
    expect(loadedConfig.reposDir).toBe("./repos");
  });

  test("rejects unsupported bootstrap targets", async () => {
    testDir = await createTempDir();

    const result = await executeInit(
      {},
      {
        cwd: testDir,
        promptConfirm: async () => ({ status: "ok", value: true }),
        promptInput: async () => ({ status: "ok", value: "foo/bar" }),
        stdinIsTTY: true,
      },
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(5);
    expect(result.error).toContain("Invalid bootstrap target");
    expect(await fileExists(join(testDir, ".git"))).toBe(false);
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);
    expect(await fileExists(join(testDir, "foo"))).toBe(false);
  });
});

describe("init command - rollback behavior", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("rolls back when repos directory creation fails", async () => {
    // Create .arashi directory first
    await mkdir(join(testDir, ".arashi"));

    // Create a file where repos directory should be (will cause mkdir to fail)
    await writeFile(join(testDir, "repos"), "file content");

    const result = await runInitCommand(testDir);

    // Should fail
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Rolling back");

    // Verify .arashi directory removed
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);
  });

  test("rolls back when config write fails due to permissions", async () => {
    // This test requires platform-specific permission handling
    // Skip on Windows where chmod behaves differently
    if (process.platform === "win32") {
      return;
    }

    // Create .arashi directory with no write permissions
    const arashiDir = join(testDir, ".arashi");
    await mkdir(arashiDir);
    await chmod(arashiDir, 0o444); // Read-only

    const result = await runInitCommand(testDir);

    // Should fail
    expect(result.exitCode).not.toBe(0);

    // Restore permissions for cleanup (if directory still exists)
    try {
      await chmod(arashiDir, 0o755);
    } catch {
      // Directory may have been removed by rollback, which is fine
    }
  });
});

describe("init command - repository discovery", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("discovers repositories in repos directory", async () => {
    // Create test repositories
    const repo1Path = join(testDir, "repos", "repo1");
    const repo2Path = join(testDir, "repos", "repo2");

    await mkdir(join(repo1Path, ".git"), { recursive: true });
    await mkdir(join(repo2Path, ".git"), { recursive: true });

    // Initialize git repos
    await spawn(["git", "init"], { cwd: repo1Path }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: repo1Path }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: repo1Path }).exited;

    await spawn(["git", "init"], { cwd: repo2Path }).exited;
    await spawn(["git", "config", "user.email", "test@example.com"], { cwd: repo2Path }).exited;
    await spawn(["git", "config", "user.name", "Test"], { cwd: repo2Path }).exited;

    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Discovered 2 repositories");

    // Verify discovered repos in config
    const loadedConfig = await loadConfig(testDir);
    expect(Object.keys(loadedConfig.repos)).toHaveLength(2);
    expect(loadedConfig.repos["repo1"]).toBeDefined();
    expect(loadedConfig.repos["repo2"]).toBeDefined();
  });

  test("handles empty repos directory", async () => {
    // Create empty repos directory
    await mkdir(join(testDir, "repos"));

    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Discovered 0 repositories");

    const loadedConfig = await loadConfig(testDir);
    expect(Object.keys(loadedConfig.repos)).toHaveLength(0);
  });
});

describe("init command - edge cases", () => {
  let testDir: string;

  test("handles .gitignore that does not exist", async () => {
    testDir = await createTempGitRepo();

    // Ensure .gitignore doesn't exist
    const gitignorePath = join(testDir, ".gitignore");
    if (await fileExists(gitignorePath)) {
      await rm(gitignorePath);
    }

    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(0);

    // Verify .gitignore created
    expect(await fileExists(gitignorePath)).toBe(true);
    const content = await readTextFile(gitignorePath);
    expect(content).toContain("repos/");
    expect(content).toContain(".arashi/worktrees/");

    await cleanup(testDir);
  });

  test("handles .gitignore without trailing newline", async () => {
    testDir = await createTempGitRepo();

    // Create .gitignore without trailing newline
    await writeFile(join(testDir, ".gitignore"), "node_modules/");

    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(0);

    // Verify repos/ added on new line
    const content = await readTextFile(join(testDir, ".gitignore"));
    expect(content).toContain("node_modules/\n");
    expect(content).toContain("repos/");
    expect(content).toContain(".arashi/worktrees/");

    await cleanup(testDir);
  });

  test("preserves existing default worktrees ignore entry without rewriting it", async () => {
    testDir = await createTempGitRepo();

    const existingContent = "repos/\n.arashi/worktrees/\nnode_modules/\n";
    await writeFile(join(testDir, ".gitignore"), existingContent);

    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(0);

    const content = await readTextFile(join(testDir, ".gitignore"));
    expect(content).toBe(existingContent);

    await cleanup(testDir);
  });

  test("handles repos directory that already exists", async () => {
    testDir = await createTempGitRepo();

    // Create repos directory with content
    await mkdir(join(testDir, "repos"));
    await writeFile(join(testDir, "repos", "README.md"), "# Repos");

    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(0);

    // Verify existing content preserved
    expect(await fileExists(join(testDir, "repos", "README.md"))).toBe(true);

    await cleanup(testDir);
  });

  test("handles absolute repos directory path", async () => {
    testDir = await createTempGitRepo();

    const absolutePath = join(testDir, "absolute-repos");
    const result = await runInitCommand(testDir, ["--repos-dir", absolutePath]);

    expect(result.exitCode).toBe(0);

    // Verify directory created at absolute path
    expect(await fileExists(absolutePath)).toBe(true);

    // Verify config stores absolute path
    const loadedConfig = await loadConfig(testDir);
    expect(loadedConfig.reposDir).toBe(absolutePath);

    await cleanup(testDir);
  });

  test("handles repos directory path with spaces", async () => {
    testDir = await createTempGitRepo();

    const result = await runInitCommand(testDir, ["--repos-dir", "./my repos"]);

    expect(result.exitCode).toBe(0);

    // Verify directory created
    expect(await fileExists(join(testDir, "my repos"))).toBe(true);

    await cleanup(testDir);
  });
});

describe("init command - output format", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("success output includes all required information", async () => {
    const result = await runInitCommand(testDir);

    expect(result.exitCode).toBe(0);

    // Check for success indicator
    expect(result.stdout).toContain("Initialized Arashi workspace");

    // Check for created paths
    expect(result.stdout).toContain("Configuration:");
    expect(result.stdout).toContain("Hooks directory:");
    expect(result.stdout).toContain("Repositories directory:");

    // Check for discovery info
    expect(result.stdout).toMatch(/Discovered \d+ repositories/);

    // Check for .gitignore info
    expect(result.stdout).toContain("Updated .gitignore");

    // Check for next steps
    expect(result.stdout).toContain("Next steps:");
  });

  test("error output includes helpful guidance", async () => {
    // Test with non-git directory
    const nonGitDir = await createTempDir();

    const result = await runInitCommand(nonGitDir);

    expect(result.exitCode).toBe(1);
    // Error message is in stderr, help text is in stdout
    expect(result.stderr).toContain("Not a git repository");
    expect(result.stdout).toContain("interactive terminal");

    await cleanup(nonGitDir);
  });
});

describe("init command - dry-run mode", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("--dry-run shows actions without creating files", async () => {
    const result = await runInitCommand(testDir, ["--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN MODE");
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain("Configuration preview:");

    // Verify NO files or directories created
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);
    expect(await fileExists(join(testDir, "repos"))).toBe(false);

    // Verify .gitignore not modified (should not exist in fresh git repo)
    const gitignorePath = join(testDir, ".gitignore");
    const gitignoreExists = await fileExists(gitignorePath);
    if (gitignoreExists) {
      const content = await readTextFile(gitignorePath);
      expect(content).not.toContain("repos/");
    }
  });

  test("--dry-run shows configuration preview", async () => {
    const result = await runInitCommand(testDir, ["--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Configuration preview:");
    expect(result.stdout).toContain('"version": "1.0.0"');
    expect(result.stdout).toContain('"reposDir": "./repos"');
  });

  test("--dry-run works with --repos-dir option", async () => {
    const result = await runInitCommand(testDir, ["--dry-run", "--repos-dir", "./custom"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain('"reposDir": "./custom"');

    // Verify custom directory NOT created
    expect(await fileExists(join(testDir, "custom"))).toBe(false);
  });

  test("--dry-run with custom worktrees directory previews managed ignore entry", async () => {
    const result = await runInitCommand(testDir, [
      "--dry-run",
      "--worktrees-dir",
      "./workspace-worktrees/",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN] UPDATE_FILE:");
    expect(result.stdout).toContain("workspace-worktrees/");
    expect(result.stdout).not.toContain(".arashi/worktrees/");
  });

  test("--dry-run with unsafe parent worktrees directory skips worktree ignore preview", async () => {
    const result = await runInitCommand(testDir, [
      "--dry-run",
      "--worktrees-dir",
      "../workspace-worktrees",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN] UPDATE_FILE:");
    expect(result.stdout).toContain("add: repos/");
    expect(result.stdout).not.toContain("../workspace-worktrees/");
    expect(result.stdout).not.toContain(".arashi/worktrees/");
  });

  test("--dry-run works with --no-discover option", async () => {
    // Create a repo in repos directory
    await mkdir(join(testDir, "repos", "test-repo", ".git"), { recursive: true });

    const result = await runInitCommand(testDir, ["--dry-run", "--no-discover"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    // With --no-discover, there should be no DISCOVER action in dry-run output
    expect(result.stdout).not.toContain("[DRY RUN] DISCOVER:");
  });

  test("--dry-run shows repository discovery preview", async () => {
    // Create test repositories
    await mkdir(join(testDir, "repos", "repo1", ".git"), { recursive: true });
    await mkdir(join(testDir, "repos", "repo2", ".git"), { recursive: true });

    await spawn(["git", "init"], { cwd: join(testDir, "repos", "repo1") }).exited;
    await spawn(["git", "init"], { cwd: join(testDir, "repos", "repo2") }).exited;

    const result = await runInitCommand(testDir, ["--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain("[DRY RUN] DISCOVER: Scan");
  });

  test("--dry-run with --force shows overwrite preview", async () => {
    // First initialize normally
    await runInitCommand(testDir);

    // Run dry-run with --force
    const result = await runInitCommand(testDir, ["--dry-run", "--force"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain("[DRY RUN] BACKUP:");

    // Verify config NOT backed up (dry-run)
    const backupFiles = await Array.fromAsync(
      new runtime.Glob("*.backup-*").scan({ cwd: join(testDir, ".arashi") }),
    );
    expect(backupFiles).toHaveLength(0);
  });

  test("--dry-run shows hook template creation", async () => {
    const result = await runInitCommand(testDir, ["--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain("[DRY RUN] WRITE_FILE:");
    expect(result.stdout).toContain("pre-create.sh.example");
    expect(result.stdout).toContain("post-create.sh.example");
    expect(result.stdout).toContain("pre-remove.sh.example");
    expect(result.stdout).toContain("post-remove.sh.example");
    expect(result.stdout).toContain("setup.sh.example");
  });

  test("--dry-run shows .gitignore update", async () => {
    const result = await runInitCommand(testDir, ["--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain("[DRY RUN] UPDATE_FILE:");
    expect(result.stdout).toContain(".gitignore");
  });
});

describe("init command - verbose mode", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("--verbose shows detailed progress during initialization", async () => {
    const result = await runInitCommand(testDir, ["--verbose"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[VERBOSE]");

    // Check for major steps logged
    expect(result.stdout).toContain("Checking if current directory is a git repository");
    expect(result.stdout).toContain("Creating .arashi directory");
    expect(result.stdout).toContain("Creating hooks directory");
    expect(result.stdout).toContain("Creating repos directory");
    expect(result.stdout).toContain("Writing configuration file");
  });

  test("--verbose shows configuration details", async () => {
    const result = await runInitCommand(testDir, ["--verbose", "--repos-dir", "./custom"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[VERBOSE]");
    expect(result.stdout).toContain("Resolved repos directory:");
    expect(result.stdout).toContain("/custom");
  });

  test("--verbose shows hook template creation details", async () => {
    const result = await runInitCommand(testDir, ["--verbose"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[VERBOSE]");
    expect(result.stdout).toContain("Writing 5 hook templates");
    expect(result.stdout).toContain("✓ Hook templates written");
  });

  test("--verbose shows repository discovery details", async () => {
    // Create test repositories
    await mkdir(join(testDir, "repos", "test-repo", ".git"), { recursive: true });
    await spawn(["git", "init"], { cwd: join(testDir, "repos", "test-repo") }).exited;

    const result = await runInitCommand(testDir, ["--verbose"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[VERBOSE]");
    expect(result.stdout).toContain("Discovering repositories");
    expect(result.stdout).toContain("✓ Found 1 repositories");
  });

  test("--verbose shows .gitignore update details", async () => {
    const result = await runInitCommand(testDir, ["--verbose"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[VERBOSE]");
    expect(result.stdout).toContain("Updating .gitignore");
  });

  test("--verbose works with --force and shows backup details", async () => {
    // First initialize normally
    await runInitCommand(testDir);

    // Reinitialize with --verbose --force
    const result = await runInitCommand(testDir, ["--verbose", "--force"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[VERBOSE]");
    expect(result.stdout).toContain("Reading existing configuration");
    expect(result.stdout).toContain("Copying configuration to backup");
    expect(result.stdout).toContain("✓ Backup created successfully");
  });

  test("--verbose with --no-discover shows skip message", async () => {
    const result = await runInitCommand(testDir, ["--verbose", "--no-discover"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[VERBOSE]");
    expect(result.stdout).toContain("Skipping repository discovery");
  });
});

describe("init command - dry-run and verbose together", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("--dry-run --verbose shows detailed preview without creating files", async () => {
    const result = await runInitCommand(testDir, ["--dry-run", "--verbose"]);

    expect(result.exitCode).toBe(0);

    // Check for both dry-run and verbose markers
    expect(result.stdout).toContain("DRY RUN MODE");
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain("[VERBOSE]");

    // Check for detailed steps
    expect(result.stdout).toContain("Checking if current directory is a git repository");
    expect(result.stdout).toContain("Configuration preview:");

    // Verify no files created
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);
    expect(await fileExists(join(testDir, "repos"))).toBe(false);
  });

  test("--dry-run --verbose works with all options", async () => {
    // Create a repo for discovery
    await mkdir(join(testDir, "custom", "test-repo", ".git"), { recursive: true });
    await spawn(["git", "init"], { cwd: join(testDir, "custom", "test-repo") }).exited;

    const result = await runInitCommand(testDir, [
      "--dry-run",
      "--verbose",
      "--repos-dir",
      "./custom",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[DRY RUN]");
    expect(result.stdout).toContain("[VERBOSE]");
    expect(result.stdout).toContain('"reposDir": "./custom"');

    // Verify nothing created (except the custom directory we created for the test)
    expect(await fileExists(join(testDir, ".arashi"))).toBe(false);
    // The custom directory was created by us for the test, so it exists
    // But the .arashi structure inside testDir should not exist
  });
});
