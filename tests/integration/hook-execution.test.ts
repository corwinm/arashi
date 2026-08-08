import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  cleanupTestRepo,
  createHookInRepo,
  createMockHook,
  createTestContext,
  createTestRepo,
} from "../helpers/hooks";
import {
  discoverLifecycleHookInDirectory,
  executeHook,
  releaseHookInterruptGuards,
  runLifecycleHook,
  validateHook,
} from "../../src/lib/hooks";

describe("hook execution integration", () => {
  let testRepo: string;

  beforeEach(() => {
    testRepo = createTestRepo();
  });

  afterEach(() => {
    releaseHookInterruptGuards();
    cleanupTestRepo(testRepo);
  });

  test("validates executable hooks on Unix", async () => {
    if (process.platform === "win32") {
      return;
    }

    const hookPath = createHookInRepo(testRepo, "test-hook", "echo 'test'", true);
    const result = await validateHook(hookPath);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("rejects non-executable hooks on Unix", async () => {
    if (process.platform === "win32") {
      return;
    }

    const hookPath = createHookInRepo(testRepo, "test-hook", "echo 'test'", false);
    const result = await validateHook(hookPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("not executable");
    expect(result.error).toContain("chmod +x");
  });

  test("returns clear validation errors for missing hooks", async () => {
    const result = await validateHook("/nonexistent/hook.sh");

    expect(result.valid).toBe(false);
    expect(result.error).toContain("Failed to validate hook");
  });

  test.runIf(process.platform === "win32")(
    "executes native PowerShell, cmd, and bat lifecycle hooks",
    async () => {
      const hooksDirectory = join(testRepo, ".arashi", "hooks");
      mkdirSync(hooksDirectory, { recursive: true });
      for (const [extension, content] of [
        ["ps1", "Write-Output $env:ARASHI_BRANCH_NAME\n"],
        ["cmd", "@echo off\r\necho %ARASHI_BRANCH_NAME%\r\n"],
        ["bat", "@echo off\r\necho %ARASHI_BRANCH_NAME%\r\n"],
      ] as const) {
        const scriptPath = join(hooksDirectory, `native-${extension}.${extension}`);
        writeFileSync(scriptPath, content);
        const result = await executeHook({
          context: createTestContext({
            operationData: { BRANCH_NAME: `native-${extension}` },
            repoPath: testRepo,
          }),
          hookName: `native-${extension}`,
          quiet: true,
          scriptPath,
        });
        expect(result.success).toBe(true);
        expect(result.stdout).toContain(`native-${extension}`);
      }
    },
  );

  test.runIf(process.platform === "win32")(
    "fails closed when multiple native lifecycle definitions exist",
    async () => {
      const hooksDirectory = join(testRepo, ".arashi", "hooks");
      mkdirSync(hooksDirectory, { recursive: true });
      writeFileSync(join(hooksDirectory, "pre-create.ps1"), "exit 0\n");
      writeFileSync(join(hooksDirectory, "pre-create.cmd"), "@exit /b 0\r\n");

      await expect(discoverLifecycleHookInDirectory("pre-create", hooksDirectory)).rejects.toThrow(
        "Ambiguous lifecycle hook",
      );
    },
  );

  test("executes hooks and captures stdout and stderr", async () => {
    const hookPath = createMockHook("echo 'stdout message' && echo 'stderr message' >&2");

    try {
      const result = await executeHook({
        context: createTestContext({ repoPath: testRepo }),
        hookName: "test-hook",
        scriptPath: hookPath,
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("stdout message");
      expect(result.stderr).toContain("stderr message");
      expect(result.timedOut).toBe(false);
    } finally {
      cleanupTestRepo(hookPath);
    }
  });

  test("preserves trailing newlines in captured hook output", async () => {
    const hookPath = createMockHook("printf 'first\\n\\nsecond\\n\\n'");

    try {
      const result = await executeHook({
        context: createTestContext({ repoPath: testRepo }),
        hookName: "test-hook",
        quiet: true,
        scriptPath: hookPath,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toBe("first\n\nsecond\n\n");
    } finally {
      cleanupTestRepo(hookPath);
    }
  });

  test.runIf(process.platform !== "win32")(
    "terminates redirected descendants after the direct hook times out",
    async () => {
      const descendantPath = join(testRepo, "timeout-descendant");
      const hookPath = createMockHook(
        `(trap '' INT TERM; sleep 60) </dev/null >/dev/null 2>&1 &\nprintf '%s' "$!" > '${descendantPath}'\nwhile true; do sleep 0.1; done`,
      );
      let descendantPid: number | undefined;

      try {
        const execution = executeHook({
          context: createTestContext({ repoPath: testRepo }),
          hookName: "timeout-descendant-hook",
          quiet: true,
          scriptPath: hookPath,
          timeout: 1000,
        });
        for (let attempt = 0; attempt < 100 && !existsSync(descendantPath); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(descendantPath)).toBe(true);
        descendantPid = Number.parseInt(readFileSync(descendantPath, "utf8"), 10);

        const result = await execution;

        expect(result.success).toBe(false);
        expect(result.timedOut).toBe(true);
        expect(descendantPid).toBeTypeOf("number");
        const timedOutDescendantPid = descendantPid;
        if (!timedOutDescendantPid) throw new Error("Expected timeout descendant process ID");
        expect(() => process.kill(timedOutDescendantPid, 0)).toThrow();
      } finally {
        if (descendantPid) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The expected timeout cleanup already terminated the descendant.
          }
        }
        cleanupTestRepo(hookPath);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "reports cancellation when an interrupted hook traps SIGINT and exits zero",
    async () => {
      const readyPath = join(testRepo, "hook-ready");
      const interruptPath = join(testRepo, "hook-interrupted");
      const stdinTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      const hookPath = createMockHook(
        `trap 'printf interrupted > "${interruptPath}"; exit 0' INT\nprintf ready > '${readyPath}'\nwhile true; do sleep 0.1; done`,
      );

      try {
        const execution = executeHook({
          context: createTestContext({ repoPath: testRepo }),
          hookInputMode: "tty",
          hookName: "interrupt-hook",
          quiet: true,
          scriptPath: hookPath,
        });
        for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(readyPath)).toBe(true);

        process.emit("SIGINT", "SIGINT");
        const result = await execution;

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(130);
        expect(result.signalCode).toBe("SIGINT");
        expect(readFileSync(interruptPath, "utf8")).toBe("interrupted");
      } finally {
        if (stdinTTYDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinTTYDescriptor);
        else Reflect.deleteProperty(process.stdin, "isTTY");
        cleanupTestRepo(hookPath);
      }
    },
  );

  test.runIf(process.platform !== "win32")(
    "escalates cancellation when an interrupted hook ignores SIGINT",
    async () => {
      const readyPath = join(testRepo, "ignored-interrupt-ready");
      const descendantPath = join(testRepo, "ignored-interrupt-descendant");
      const lateDescendantPath = join(testRepo, "ignored-interrupt-late-descendant");
      const hookPath = createMockHook(
        `trap 'exit 0' INT\n(\n  trap '' INT TERM\n  sleep 0.1\n  sh -c 'trap "" INT TERM; sleep 60' </dev/null >/dev/null 2>&1 &\n  late=$!\n  printf '%s' "$late" > '${lateDescendantPath}'\n  exit 0\n) &\ndescendant=$!\nprintf '%s' "$descendant" > '${descendantPath}'\nprintf ready > '${readyPath}'\nwait "$descendant"`,
      );

      let descendantPid: number | undefined;
      let lateDescendantPid: number | undefined;
      let unrelatedPid: number | undefined;
      try {
        const execution = executeHook({
          context: createTestContext({ repoPath: testRepo }),
          hookInputMode: "tty",
          hookName: "ignored-interrupt-hook",
          quiet: true,
          scriptPath: hookPath,
          timeout: 5000,
        });
        for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(readyPath)).toBe(true);
        descendantPid = Number.parseInt(readFileSync(descendantPath, "utf8"), 10);
        const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
        unrelatedPid = unrelated.pid;
        expect(unrelatedPid).toBeTypeOf("number");

        process.emit("SIGINT", "SIGINT");
        setTimeout(() => process.emit("SIGINT", "SIGINT"), 50);
        const result = await execution;

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(130);
        expect(result.signalCode).toBe("SIGINT");
        expect(result.duration).toBeLessThan(5000);
        expect(existsSync(lateDescendantPath)).toBe(true);
        lateDescendantPid = Number.parseInt(readFileSync(lateDescendantPath, "utf8"), 10);
        for (const processId of [descendantPid, lateDescendantPid]) {
          expect(processId).toBeTypeOf("number");
          if (!processId) throw new Error("Expected descendant process ID");
          let processAlive = true;
          for (let attempt = 0; attempt < 100 && processAlive; attempt += 1) {
            try {
              process.kill(processId, 0);
              await new Promise((resolve) => setTimeout(resolve, 10));
            } catch {
              processAlive = false;
            }
          }
          expect(processAlive).toBe(false);
        }
        const unrelatedProcessId = unrelatedPid;
        if (!unrelatedProcessId) throw new Error("Expected unrelated process ID");
        expect(() => process.kill(unrelatedProcessId, 0)).not.toThrow();
      } finally {
        for (const processId of [descendantPid, lateDescendantPid, unrelatedPid]) {
          if (!processId) continue;
          try {
            process.kill(processId, "SIGKILL");
          } catch {
            // The expected path already terminated the descendant process tree.
          }
        }
        cleanupTestRepo(hookPath);
      }
    },
  );

  test("pauses an active progress spinner around all hook output", async () => {
    const hookPath = createMockHook(String.raw`printf 'hook output\n'`);
    const events: string[] = [];
    const outputSpinner = {
      isSpinning: true,
      start: () => events.push("spinner:start"),
      stopAndPersist: () => events.push("spinner:persist"),
    };
    const originalLog = console.log;
    console.log = (...args: unknown[]) => events.push(args.map(String).join(" "));

    try {
      const result = await executeHook({
        context: createTestContext({ repoPath: testRepo }),
        hookName: "test-hook",
        outputSpinner,
        scriptPath: hookPath,
      });

      expect(result.success).toBe(true);
      expect(events).toEqual([
        "spinner:persist",
        "🪝 Executing hook: test-hook",
        "[test-hook:OUT] hook output",
        "spinner:start",
      ]);
    } finally {
      console.log = originalLog;
      cleanupTestRepo(hookPath);
    }
  });

  test("passes scope metadata environment variables", async () => {
    const hookPath = createMockHook(`
      echo "Scope: $ARASHI_HOOK_SCOPE"
      echo "Source: $ARASHI_HOOK_SOURCE_PATH"
      echo "TargetRepo: $ARASHI_HOOK_TARGET_REPOSITORY"
      echo "TargetRepoPath: $ARASHI_HOOK_TARGET_REPO_PATH"
    `);

    try {
      const result = await executeHook({
        context: {
          hookName: "test-hook",
          hookScope: "global-shared",
          operationData: {},
          repoPath: testRepo,
          sourceScriptPath: "/tmp/source-hook.sh",
          targetRepoName: "repo-a",
          targetRepoPath: "/tmp/repo-a",
        },
        hookName: "test-hook",
        scriptPath: hookPath,
      });

      expect(result.stdout).toContain("Scope: global-shared");
      expect(result.stdout).toContain("Source: /tmp/source-hook.sh");
      expect(result.stdout).toContain("TargetRepo: repo-a");
      expect(result.stdout).toContain("TargetRepoPath: /tmp/repo-a");
    } finally {
      cleanupTestRepo(hookPath);
    }
  });

  test("does not leak directive environment variables to hooks", async () => {
    const originalDirectiveFile = process.env.ARASHI_DIRECTIVE_FILE;
    const originalDirectiveShell = process.env.ARASHI_SHELL;
    process.env.ARASHI_DIRECTIVE_FILE = "/tmp/arashi-directive";
    process.env.ARASHI_SHELL = "bash";

    const hookPath = createMockHook(`
      if [ -n "$ARASHI_DIRECTIVE_FILE" ]; then
        echo "directive leaked"
        exit 1
      fi
      if [ -n "$ARASHI_SHELL" ]; then
        echo "shell leaked"
        exit 1
      fi
      echo "clean"
    `);

    try {
      const result = await executeHook({
        context: createTestContext({ repoPath: testRepo }),
        hookName: "test-hook",
        scriptPath: hookPath,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain("clean");
    } finally {
      cleanupTestRepo(hookPath);

      if (originalDirectiveFile === undefined) {
        delete process.env.ARASHI_DIRECTIVE_FILE;
      } else {
        process.env.ARASHI_DIRECTIVE_FILE = originalDirectiveFile;
      }

      if (originalDirectiveShell === undefined) {
        delete process.env.ARASHI_SHELL;
      } else {
        process.env.ARASHI_SHELL = originalDirectiveShell;
      }
    }
  });

  test("runLifecycleHook returns null when validation fails", async () => {
    if (process.platform === "win32") {
      return;
    }

    createHookInRepo(testRepo, "pre-create", "echo 'test'", false);
    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {},
      repoPath: testRepo,
    });

    expect(result).toBeNull();
  });

  test("runLifecycleHook executes hooks with operation data", async () => {
    createHookInRepo(testRepo, "pre-create", 'echo "Branch: $ARASHI_BRANCH_NAME"');

    const result = await runLifecycleHook({
      lifecyclePoint: "pre-create",
      operationData: {
        BRANCH_NAME: "feature-123",
      },
      repoPath: testRepo,
    });

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(result?.stdout).toContain("Branch: feature-123");
  });
});
