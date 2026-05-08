import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { HookContext } from "../../src/lib/hooks";
import { tmpdir } from "os";

function createTempPath(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Creates a temporary hook script for testing.
 *
 * @param script - Shell script content
 * @returns Absolute path to the created hook script
 */
export function createMockHook(script: string): string {
  const tempDir = createTempPath("arashi-hook-");
  const tempPath = join(tempDir, "test-hook.sh");
  writeFileSync(tempPath, `#!/bin/sh\n${script}`);
  if (process.platform !== "win32") {
    chmodSync(tempPath, 0o755);
  }
  return tempPath;
}

/**
 * Creates a test context with default values.
 *
 * @param overrides - Partial context to override defaults
 * @returns Complete hook context for testing
 */
export function createTestContext(overrides?: Partial<HookContext>): HookContext {
  // Create the test repo directory if it doesn't exist
  const testRepoPath = overrides?.repoPath || createTempPath("arashi-hook-context-");
  try {
    mkdirSync(testRepoPath, { recursive: true });
  } catch {
    // Ignore if already exists
  }

  return {
    hookName: "test-hook",
    operationData: {},
    repoPath: testRepoPath,
    ...overrides,
  };
}

/**
 * Creates a test repository structure with hooks directory.
 *
 * @returns Absolute path to the test repository
 */
export function createTestRepo(): string {
  const repoPath = createTempPath("arashi-hook-repo-");
  const hooksDir = join(repoPath, ".arashi", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  return repoPath;
}

/**
 * Cleans up test repository and files.
 *
 * @param path - Path to clean up
 */
export function cleanupTestRepo(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Creates a hook file in a test repository.
 *
 * @param repoPath - Path to the repository
 * @param hookName - Name of the hook
 * @param script - Script content
 * @param executable - Whether to make the script executable
 * @returns Absolute path to the created hook
 */
export function createHookInRepo(
  ...args: [
    repoPath: string,
    hookName: string,
    script: string,
    executableOrOptions?: boolean | { executable?: boolean },
  ]
): string {
  const [repoPath, hookName, script, executableOrOptions = true] = args;
  const executable =
    typeof executableOrOptions === "boolean"
      ? executableOrOptions
      : (executableOrOptions.executable ?? true);
  const hookPath = join(repoPath, ".arashi", "hooks", `${hookName}.sh`);
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, `#!/bin/sh\n${script}`);
  if (executable && process.platform !== "win32") {
    chmodSync(hookPath, 0o755);
  }
  return hookPath;
}

export function createRepoSpecificHookInRepo(
  ...args: [
    repoPath: string,
    lifecycle: "pre-create" | "post-create",
    repoName: string,
    script: string,
    options?: { executable?: boolean },
  ]
): string {
  const [repoPath, lifecycle, repoName, script, options = {}] = args;
  const hookName = `${lifecycle}.${repoName}`;
  return createHookInRepo(repoPath, hookName, script, options);
}
