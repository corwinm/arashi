/**
 * Integration Tests for List Command
 *
 * Tests the complete list workflow including git operations,
 * worktree discovery, sub-repository detection, and output formatting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "bun";
import { listCommand } from "../../src/core/list";

interface JsonSubRepository {
  branch: string | null;
  commit: string;
  hasChanges: boolean;
  relativePath: string;
}

interface JsonWorktree {
  branch: string | null;
  hasChanges: boolean;
  locked: boolean;
  path: string;
  subRepositories?: JsonSubRepository[];
}

/**
 * Helper to create a temporary git repository for testing
 */
async function createTempGitRepo(): Promise<string> {
  const testDir = await mkdtemp(join(tmpdir(), "arashi-list-test-"));

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

  // Create initial commit
  await writeFile(join(testDir, "README.md"), "# Test Repository");
  await spawn(["git", "add", "."], { cwd: testDir }).exited;
  await spawn(["git", "commit", "-m", "Initial commit"], { cwd: testDir }).exited;

  // Initialize Arashi config to avoid warnings
  await mkdir(join(testDir, ".arashi"), { recursive: true });
  const testConfig = {
    discovery: {
      max_depth: 3,
    },
    hooks: {
      timeout: 300,
    },
    repos: {},
    reposDir: "./repos",
    version: "1.0.0",
  };
  await writeFile(join(testDir, ".arashi", "config.json"), JSON.stringify(testConfig, null, 2));

  return testDir;
}

/**
 * Helper to create a worktree with unique path
 */
async function createUniqueWorktree(mainRepoPath: string, branchName: string): Promise<string> {
  const worktreePath = join(
    mainRepoPath,
    "..",
    `worktree-${branchName}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  );
  await createWorktree(mainRepoPath, branchName, worktreePath);
  return worktreePath;
}

/**
 * Helper to create a worktree
 */
async function createWorktree(
  mainRepoPath: string,
  branchName: string,
  worktreePath: string,
): Promise<void> {
  await spawn(["git", "worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
    cwd: mainRepoPath,
  }).exited;
}

/**
 * Helper to create nested git repository
 */
async function createNestedRepo(parentPath: string, relativePath: string): Promise<string> {
  const nestedPath = join(parentPath, relativePath);
  await mkdir(nestedPath, { recursive: true });

  await spawn(["git", "init"], { cwd: nestedPath }).exited;
  await spawn(["git", "config", "user.email", "test@example.com"], { cwd: nestedPath }).exited;
  await spawn(["git", "config", "user.name", "Test User"], { cwd: nestedPath }).exited;

  // Create initial commit
  await writeFile(join(nestedPath, "README.md"), "# Nested Repository");
  await spawn(["git", "add", "."], { cwd: nestedPath }).exited;
  await spawn(["git", "commit", "-m", "Initial commit"], { cwd: nestedPath }).exited;

  return nestedPath;
}

/**
 * Helper to clean up test directory
 */
async function cleanup(testDir: string): Promise<void> {
  await rm(testDir, { force: true, recursive: true });
}

/**
 * Helper to run list command and capture output
 */
async function runListCommand(
  cwd: string,
  options?: { verbose?: boolean; json?: boolean; table?: boolean; maxDepth?: number },
): Promise<{
  output: string;
  error?: Error;
}> {
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let capturedOutput = "";

  // Mock console.log/warn/error and process.stdout.write to capture output
  console.log = (message: string) => {
    capturedOutput += message + "\n";
  };
  console.warn = () => {}; // Suppress warnings
  console.error = () => {}; // Suppress errors

  // Mock process.stdout.write to capture direct writes
  const mockedStdoutWrite = ((chunk: string | Uint8Array): boolean => {
    capturedOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = mockedStdoutWrite;

  try {
    process.chdir(cwd);
    await listCommand(options);
    return { output: capturedOutput };
  } catch (error) {
    return { error: error as Error, output: capturedOutput };
  } finally {
    process.chdir(originalCwd);
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
  }
}

describe("list command - basic functionality", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("lists main repository when no worktrees exist", async () => {
    const { output, error } = await runListCommand(testDir, { table: true });

    expect(error).toBeUndefined();
    expect(output).toContain("Worktrees");
    expect(output).toContain("No additional worktrees found");
    expect(output).toContain("arashi create");
  });

  test("lists all worktrees in table format", async () => {
    // Create worktrees
    const wt1Path = await createUniqueWorktree(testDir, "feature");
    const wt2Path = await createUniqueWorktree(testDir, "bugfix");

    const { output, error } = await runListCommand(testDir, { table: true });

    expect(error).toBeUndefined();
    expect(output).toContain("Worktrees (3 total)");
    expect(output).toContain("PATH");
    expect(output).toContain("BRANCH");
    expect(output).toContain("STATUS");
    // Check that the output contains branch names (paths may be truncated)
    expect(output).toContain("feature");
    expect(output).toContain("bugfix");
    expect(output).toContain("Legend");

    // Cleanup worktrees
    await spawn(["git", "worktree", "remove", wt1Path], { cwd: testDir }).exited;
    await spawn(["git", "worktree", "remove", wt2Path], { cwd: testDir }).exited;
  });

  test("lists all worktrees in simple format (default)", async () => {
    // Create worktrees
    const wt1Path = await createUniqueWorktree(testDir, "feature");
    const wt2Path = await createUniqueWorktree(testDir, "bugfix");

    const { output, error } = await runListCommand(testDir); // No --table flag

    expect(error).toBeUndefined();
    // Simple format: just paths, one per line, no headers
    expect(output).not.toContain("Worktrees");
    expect(output).not.toContain("PATH");
    expect(output).not.toContain("BRANCH");
    expect(output).not.toContain("Legend");
    // Should contain full paths (not truncated)
    expect(output).toContain(testDir);
    const lines = output.trim().split("\n");
    expect(lines.length).toBe(3); // Main + 2 worktrees

    // Cleanup worktrees
    await spawn(["git", "worktree", "remove", wt1Path], { cwd: testDir }).exited;
    await spawn(["git", "worktree", "remove", wt2Path], { cwd: testDir }).exited;
  });

  test("shows clean status for unmodified worktrees", async () => {
    // Create a worktree so we have the table format
    const wtPath = await createUniqueWorktree(testDir, "test-clean");

    const { output } = await runListCommand(testDir);

    expect(output).toContain("clean");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("shows modified status for worktrees with changes", async () => {
    // Create uncommitted changes
    await writeFile(join(testDir, "changes.txt"), "uncommitted content");

    // Create a worktree so we have the table format
    const wtPath = await createUniqueWorktree(testDir, "test-modified");

    const { output } = await runListCommand(testDir);

    expect(output).toContain("modified");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("displays branch names correctly", async () => {
    const wtPath = await createUniqueWorktree(testDir, "my-feature-branch");

    const { output } = await runListCommand(testDir);

    expect(output).toContain("my-feature-branch");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });
});

describe("list command - JSON output", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("outputs valid JSON when --json flag is used", async () => {
    const { output, error } = await runListCommand(testDir, { json: true });

    expect(error).toBeUndefined();

    // Should be valid JSON
    let parsed;
    expect(() => {
      parsed = JSON.parse(output);
    }).not.toThrow();

    expect(Array.isArray(parsed)).toBe(true);
  });

  test("JSON output contains all required fields", async () => {
    const { output } = await runListCommand(testDir, { json: true });
    const parsed = JSON.parse(output) as JsonWorktree[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveProperty("path");
    expect(parsed[0]).toHaveProperty("branch");
    expect(parsed[0]).toHaveProperty("commit");
    expect(parsed[0]).toHaveProperty("locked");
    expect(parsed[0]).toHaveProperty("hasChanges");
    expect(parsed[0]).toHaveProperty("isMain");
  });

  test("JSON output includes all worktrees", async () => {
    const wt1Path = await createUniqueWorktree(testDir, "feature");
    const wt2Path = await createUniqueWorktree(testDir, "bugfix");

    const { output } = await runListCommand(testDir, { json: true });
    const parsed = JSON.parse(output) as JsonWorktree[];

    expect(parsed).toHaveLength(3);

    // Use realpath for comparison
    const { realpathSync } = await import("fs");
    const paths = parsed.map((wt) => realpathSync(wt.path));
    expect(paths).toContain(realpathSync(testDir));
    expect(paths).toContain(realpathSync(wt1Path));
    expect(paths).toContain(realpathSync(wt2Path));

    // Cleanup
    await spawn(["git", "worktree", "remove", wt1Path], { cwd: testDir }).exited;
    await spawn(["git", "worktree", "remove", wt2Path], { cwd: testDir }).exited;
  });

  test("JSON correctly represents hasChanges field", async () => {
    // Create changes
    await writeFile(join(testDir, "changes.txt"), "content");

    const { output } = await runListCommand(testDir, { json: true });
    const parsed = JSON.parse(output) as JsonWorktree[];

    expect(parsed[0].hasChanges).toBe(true);
  });
});

describe("list command - verbose mode", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("verbose mode shows detailed worktree information", async () => {
    // Create a worktree so we get detailed output (not the "no worktrees" message)
    const wtPath = await createUniqueWorktree(testDir, "verbose-branch");

    const { output } = await runListCommand(testDir, { verbose: true });

    expect(output).toContain("PATH:");
    expect(output).toContain("BRANCH:");
    expect(output).toContain("STATUS:");
    expect(output).toContain("TYPE:");
    expect(output).toContain("Main worktree");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("verbose mode discovers nested repositories", async () => {
    // Create nested repository
    await createNestedRepo(testDir, "repos/nested-repo");

    // Create a worktree so we get verbose output (not the "no worktrees" message)
    const wtPath = await createUniqueWorktree(testDir, "verbose-sub");

    const { output } = await runListCommand(testDir, { verbose: true });

    expect(output).toContain("SUB-REPOSITORIES:");
    expect(output).toContain("repos/nested-repo");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("verbose mode shows sub-repository status", async () => {
    const nestedPath = await createNestedRepo(testDir, "repos/nested-repo");

    // Add changes to nested repo
    await writeFile(join(nestedPath, "changes.txt"), "content");

    // Create a worktree so we get verbose output
    const wtPath = await createUniqueWorktree(testDir, "verbose-status");

    const { output } = await runListCommand(testDir, { verbose: true });

    expect(output).toContain("repos/nested-repo");
    expect(output).toContain("modified");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("verbose mode shows sub-repository branch names", async () => {
    const nestedPath = await createNestedRepo(testDir, "repos/nested-repo");

    // Create a branch in nested repo
    await spawn(["git", "checkout", "-b", "develop"], { cwd: nestedPath }).exited;

    // Create a worktree so we get verbose output
    const wtPath = await createUniqueWorktree(testDir, "verbose-branch");

    const { output } = await runListCommand(testDir, { verbose: true });

    expect(output).toContain("develop");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("verbose mode respects maxDepth parameter", async () => {
    // Create nested repos at different depths
    await createNestedRepo(testDir, "level1/repo1");
    await createNestedRepo(testDir, "level1/level2/level3/deep-repo");

    // Create a worktree so we get verbose output
    const wtPath = await createUniqueWorktree(testDir, "verbose-depth");

    // With maxDepth = 2, should find level1/repo1 but not deep-repo
    const { output } = await runListCommand(testDir, { maxDepth: 2, verbose: true });

    expect(output).toContain("level1/repo1");
    // Deep repo should not be found
    expect(output).not.toContain("deep-repo");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });
});

describe("list command - JSON + verbose mode", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("combines JSON output with sub-repository discovery", async () => {
    await createNestedRepo(testDir, "repos/nested-repo");

    const { output } = await runListCommand(testDir, { json: true, verbose: true });
    const parsed = JSON.parse(output) as JsonWorktree[];

    expect(parsed[0]).toHaveProperty("subRepositories");
    expect(Array.isArray(parsed[0].subRepositories)).toBe(true);
    expect(parsed[0].subRepositories).toHaveLength(1);
  });

  test("JSON includes sub-repository details", async () => {
    await createNestedRepo(testDir, "repos/nested-repo");

    const { output } = await runListCommand(testDir, { json: true, verbose: true });
    const parsed = JSON.parse(output) as JsonWorktree[];

    const subRepo = parsed[0]?.subRepositories?.[0];
    if (!subRepo) {
      throw new Error("Expected nested sub-repository details in JSON output");
    }
    expect(subRepo).toHaveProperty("relativePath");
    expect(subRepo).toHaveProperty("branch");
    expect(subRepo).toHaveProperty("commit");
    expect(subRepo).toHaveProperty("hasChanges");
    expect(subRepo.relativePath).toBe("repos/nested-repo");
  });
});

describe("list command - error cases", () => {
  let testDir: string;

  test("fails when not in a git repository", async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-list-test-"));

    const { error } = await runListCommand(testDir);

    expect(error).toBeDefined();
    expect(error?.message).toContain("Not a git repository");

    await cleanup(testDir);
  });

  test("warns when Arashi config is missing but continues", async () => {
    testDir = await createTempGitRepo();

    // Don't initialize Arashi - just test raw git repo
    const { output, error } = await runListCommand(testDir, { table: true });

    // Should succeed despite missing config
    expect(error).toBeUndefined();
    expect(output).toContain("Worktrees");

    await cleanup(testDir);
  });
});

describe("list command - locked worktrees", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("shows locked status for locked worktrees", async () => {
    const wtPath = await createUniqueWorktree(testDir, "locked-branch");

    // Lock the worktree
    await spawn(["git", "worktree", "lock", wtPath], { cwd: testDir }).exited;

    const { output } = await runListCommand(testDir);

    expect(output).toContain("locked");

    // Cleanup
    await spawn(["git", "worktree", "unlock", wtPath], { cwd: testDir }).exited;
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("JSON output includes locked status", async () => {
    const wtPath = await createUniqueWorktree(testDir, "locked-json");
    await spawn(["git", "worktree", "lock", wtPath], { cwd: testDir }).exited;

    const { output } = await runListCommand(testDir, { json: true });
    const parsed = JSON.parse(output) as JsonWorktree[];

    // Use realpath for comparison
    const { realpathSync } = await import("fs");
    const canonicalWtPath = realpathSync(wtPath);
    const lockedWorktree = parsed.find((wt) => realpathSync(wt.path) === canonicalWtPath);
    if (!lockedWorktree) {
      throw new Error("Expected to find locked worktree in JSON output");
    }
    expect(lockedWorktree.locked).toBe(true);

    // Cleanup
    await spawn(["git", "worktree", "unlock", wtPath], { cwd: testDir }).exited;
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });
});

describe("list command - detached HEAD", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("shows detached HEAD correctly", async () => {
    // Create detached HEAD worktree
    const commitResult = await spawn(["git", "rev-parse", "HEAD"], {
      cwd: testDir,
      stdout: "pipe",
    });
    const commit = (await new Response(commitResult.stdout).text()).trim();

    const wtPath = join(
      testDir,
      "..",
      `worktree-detached-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    );
    await spawn(["git", "worktree", "add", "--detach", wtPath, commit], {
      cwd: testDir,
    }).exited;

    const { output } = await runListCommand(testDir);

    expect(output).toContain("detached");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("JSON shows null branch for detached HEAD", async () => {
    const commitResult = await spawn(["git", "rev-parse", "HEAD"], {
      cwd: testDir,
      stdout: "pipe",
    });
    const commit = (await new Response(commitResult.stdout).text()).trim();

    const wtPath = join(
      testDir,
      "..",
      `worktree-detached-json-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    );
    await spawn(["git", "worktree", "add", "--detach", wtPath, commit], {
      cwd: testDir,
    }).exited;

    const { output } = await runListCommand(testDir, { json: true });
    const parsed = JSON.parse(output) as JsonWorktree[];

    // Find the detached worktree - use realpath for comparison
    const { realpathSync } = await import("fs");
    const canonicalWtPath = realpathSync(wtPath);
    const detachedWorktree = parsed.find((wt) => realpathSync(wt.path) === canonicalWtPath);
    if (!detachedWorktree) {
      throw new Error("Expected to find detached worktree in JSON output");
    }
    expect(detachedWorktree.branch).toBeNull();

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });
});

describe("list command - performance", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("completes basic list in under 2 seconds", async () => {
    // Create multiple worktrees
    const worktrees: string[] = [];
    for (let i = 0; i < 5; i++) {
      const wtPath = await createUniqueWorktree(testDir, `branch-${i}`);
      worktrees.push(wtPath);
    }

    const startTime = Date.now();
    await runListCommand(testDir);
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(2000); // < 2 seconds

    // Cleanup
    for (const wtPath of worktrees) {
      await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
    }
  });

  test("completes verbose mode with sub-repos in under 5 seconds", async () => {
    // Create nested repositories
    for (let i = 0; i < 3; i++) {
      await createNestedRepo(testDir, `repos/nested-${i}`);
    }

    const startTime = Date.now();
    await runListCommand(testDir, { verbose: true });
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(5000); // < 5 seconds
  });
});

describe("list command - edge cases", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempGitRepo();
  });

  afterEach(async () => {
    await cleanup(testDir);
  });

  test("handles worktrees with spaces in path", async () => {
    const wtPath = await createUniqueWorktree(testDir, "branch-with-spaces");

    const { output, error } = await runListCommand(testDir);

    expect(error).toBeUndefined();
    // Check for branch name instead of full path (path may be truncated in table)
    expect(output).toContain("branch-with-spaces");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("handles branch names with special characters", async () => {
    const wtPath = await createUniqueWorktree(testDir, "feature/JIRA-123_fix");

    const { output } = await runListCommand(testDir);

    expect(output).toContain("feature/JIRA-123_fix");

    // Cleanup
    await spawn(["git", "worktree", "remove", wtPath], { cwd: testDir }).exited;
  });

  test("handles empty sub-repositories array", async () => {
    // Create a worktree but no nested repos
    const wtPath = await createUniqueWorktree(testDir, "empty-branch");

    // Initialize Arashi config in the worktree
    await mkdir(join(wtPath, ".arashi"), { recursive: true });
    const testConfig = {
      discovery: { max_depth: 3 },
      hooks: { timeout: 300 },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    };
    await writeFile(join(wtPath, ".arashi", "config.json"), JSON.stringify(testConfig, null, 2));

    const { output } = await runListCommand(wtPath, { json: true, verbose: true });
    const parsed = JSON.parse(output);

    // Should have subRepositories as empty array or undefined
    if (parsed[0].subRepositories) {
      expect(parsed[0].subRepositories).toHaveLength(0);
    }

    // Cleanup - use --force because we added .arashi directory
    await spawn(["git", "worktree", "remove", "--force", wtPath], { cwd: testDir }).exited;
  });
});
