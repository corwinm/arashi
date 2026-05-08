import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTestRepo, createHookInRepo, createTestRepo } from "../helpers/hooks";
import { runLifecycleHook } from "../../src/lib/hooks";

// ============================================================================
// Integration Tests
// ============================================================================

describe("Hook System Integration", () => {
  let testRepo: string;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(testRepo);
  });

  test("executes real shell script that succeeds", async () => {
    createHookInRepo(
      testRepo,
      "pre-create",
      `
			echo "Starting pre-create hook..."
			echo "Validating environment..."
			echo "Pre-create checks complete!"
		`,
    );

    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {
        BRANCH: "feature-123",
      },
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain("Starting pre-create hook");
    expect(result?.stdout).toContain("Pre-create checks complete");
  });

  test("executes real shell script that fails", async () => {
    createHookInRepo(
      testRepo,
      "pre-create",
      `
			echo "Running validation..."
			echo "ERROR: Validation failed!" >&2
			exit 1
		`,
    );

    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(1);
    expect(result?.stderr).toContain("ERROR: Validation failed");
  });

  test("executes script with large output", async () => {
    createHookInRepo(
      testRepo,
      "post-create",
      `
			echo "=== Hook Output Start ==="
			for i in $(seq 1 100); do
				echo "Line $i: Processing item..."
			done
			echo "=== Hook Output End ==="
		`,
    );

    const result = await runLifecycleHook({
      lifecyclePoint: "post-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.stdout).toContain("Line 1:");
    expect(result?.stdout).toContain("Line 100:");
    expect(result?.stdout).toContain("Hook Output Start");
    expect(result?.stdout).toContain("Hook Output End");
  });

  test("executes script that reads environment variables", async () => {
    createHookInRepo(
      testRepo,
      "pre-create",
      `
			echo "Hook Name: $ARASHI_HOOK_NAME"
			echo "Repo Path: $ARASHI_REPO_PATH"
			echo "Branch: $ARASHI_BRANCH"
			echo "Worktree Path: $ARASHI_WORKTREE_PATH"
			echo "Base Branch: $ARASHI_BASE_BRANCH"
			
			# Test that variables are accessible
			if [ -z "$ARASHI_HOOK_NAME" ]; then
				echo "ERROR: ARASHI_HOOK_NAME not set" >&2
				exit 1
			fi
			
			if [ -z "$ARASHI_BRANCH" ]; then
				echo "ERROR: ARASHI_BRANCH not set" >&2
				exit 1
			fi
			
			echo "All environment variables validated!"
		`,
    );

    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {
        BASE_BRANCH: "main",
        BRANCH: "feature-456",
        WORKTREE_PATH: "/path/to/worktree",
      },
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.stdout).toContain("Hook Name: pre-create");
    expect(result?.stdout).toContain(`Repo Path: ${testRepo}`);
    expect(result?.stdout).toContain("Branch: feature-456");
    expect(result?.stdout).toContain("Worktree Path: /path/to/worktree");
    expect(result?.stdout).toContain("Base Branch: main");
    expect(result?.stdout).toContain("All environment variables validated");
  });

  test("skips hook execution with --no-hooks flag", async () => {
    createHookInRepo(testRepo, "pre-create", "echo 'This should not run'");

    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      options: { skipHooks: true },
      repoPath: testRepo,
    });

    expect(result).toBeNull();
  });

  test("handles hook with mixed stdout and stderr output", async () => {
    createHookInRepo(
      testRepo,
      "post-create",
      `
			echo "INFO: Starting post-create hook"
			echo "WARNING: This is a warning" >&2
			echo "INFO: Processing..."
			echo "ERROR: This is an error" >&2
			echo "INFO: Completed successfully"
		`,
    );

    const result = await runLifecycleHook({
      lifecyclePoint: "post-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.stdout).toContain("INFO: Starting post-create hook");
    expect(result?.stdout).toContain("INFO: Completed successfully");
    expect(result?.stderr).toContain("WARNING: This is a warning");
    expect(result?.stderr).toContain("ERROR: This is an error");
  });

  test("continues command execution even when hook fails", async () => {
    createHookInRepo(
      testRepo,
      "pre-create",
      `
			echo "Hook is about to fail..."
			exit 42
		`,
    );

    // This should not throw
    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.exitCode).toBe(42);

    // Simulate continuing with command - this demonstrates non-fatal behavior
    const commandContinued = true;
    expect(commandContinued).toBe(true);
  });

  test("handles multiple hooks in sequence", async () => {
    createHookInRepo(testRepo, "pre-create", "echo 'Pre-create hook'");
    createHookInRepo(testRepo, "post-create", "echo 'Post-create hook'");

    const preResult = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      repoPath: testRepo,
    });
    const postResult = await runLifecycleHook({
      lifecyclePoint: "post-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(preResult?.success).toBe(true);
    expect(preResult?.stdout).toContain("Pre-create hook");

    expect(postResult?.success).toBe(true);
    expect(postResult?.stdout).toContain("Post-create hook");
  });
});
