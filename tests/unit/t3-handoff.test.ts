import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  dispatchT3Handoff,
  preflightT3Bridge,
  resolveT3HandoffRequest,
  T3HandoffError,
  type T3ProcessResult,
} from "../../src/lib/t3-handoff.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "arashi-t3-handoff-"));
  temporaryRoots.push(root);
  const workspacePath = join(root, "workspace with spaces");
  const common = join(root, "common");
  await Promise.all([mkdir(workspacePath), mkdir(common)]);
  return { common, root, workspacePath: await realpath(workspacePath) };
};

const successEnvelope = (workspacePath: string) =>
  JSON.stringify({
    ok: true,
    data: {
      runtime: { environmentId: "environment-1", serverVersion: "0.0.42", token: "SECRET" },
      workspace: { workspaceRoot: workspacePath },
      project: {
        id: "project-1",
        title: "Feature",
        workspaceRoot: workspacePath,
        secret: "SECRET",
      },
      projectCreated: true,
      thread: {
        id: "11111111-1111-1111-1111-111111111111",
        title: "Implement feature",
        command: { message: { text: "TOP SECRET PROMPT" } },
      },
      opened: { mode: "none", kind: "none", url: "http://secret", exactThread: false },
    },
  });

describe("T3 handoff input", () => {
  test("accepts inline and multiline file prompts with a full-access default", async () => {
    const { root } = await fixture();
    const promptFile = join(root, "task.md");
    await writeFile(promptFile, "First line\nSecond line\n");

    await expect(resolveT3HandoffRequest({ t3: "Ship it" })).resolves.toMatchObject({
      permission: "full-access",
      prompt: "Ship it",
      source: "inline",
    });
    await expect(resolveT3HandoffRequest({ promptFile, t3: true })).resolves.toMatchObject({
      permission: "full-access",
      prompt: "First line\nSecond line\n",
      source: "file",
    });
  });

  test("rejects missing, conflicting, empty, unreadable, and detached prompt sources", async () => {
    const { root } = await fixture();
    const empty = join(root, "empty.md");
    const invalidUtf8 = join(root, "invalid.md");
    await writeFile(empty, " \n\t");
    await writeFile(invalidUtf8, Buffer.from([0xff]));

    await expect(resolveT3HandoffRequest({ t3: true })).rejects.toMatchObject({
      code: "T3_PROMPT_SOURCE_REQUIRED",
    });
    await expect(
      resolveT3HandoffRequest({ promptFile: empty, t3: "inline" }),
    ).rejects.toMatchObject({
      code: "T3_PROMPT_SOURCE_CONFLICT",
    });
    await expect(resolveT3HandoffRequest({ promptFile: empty, t3: true })).rejects.toMatchObject({
      code: "T3_PROMPT_EMPTY",
    });
    await expect(
      resolveT3HandoffRequest({ promptFile: join(root, "missing"), t3: true }),
    ).rejects.toMatchObject({
      code: "T3_PROMPT_FILE_UNREADABLE",
    });
    await expect(resolveT3HandoffRequest({ promptFile: empty })).rejects.toMatchObject({
      code: "T3_PROMPT_FILE_REQUIRES_T3",
    });
    await expect(
      resolveT3HandoffRequest({ promptFile: invalidUtf8, t3: true }),
    ).rejects.toMatchObject({ code: "T3_PROMPT_INVALID_UTF8" });
    await expect(
      resolveT3HandoffRequest({
        permission: "root" as "full-access",
        t3: "task",
      }),
    ).rejects.toMatchObject({ code: "T3_PERMISSION_INVALID" });
  });
});

describe("T3 bridge compatibility", () => {
  test("accepts the published package embedded 0.1.0 version quirk", async () => {
    await expect(
      preflightT3Bridge(".", {
        runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "0.1.0\n" }),
      }),
    ).resolves.toBe("0.1.0");
  });

  test("rejects missing and incompatible bridges with pinned guidance", async () => {
    await expect(
      preflightT3Bridge(".", {
        runProcess: async () => ({ exitCode: -1, stderr: "missing", stdout: "" }),
      }),
    ).rejects.toMatchObject({ code: "T3_BRIDGE_NOT_FOUND" });
    await expect(
      preflightT3Bridge(".", {
        runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "0.2.0" }),
      }),
    ).rejects.toMatchObject({ code: "T3_BRIDGE_VERSION_UNSUPPORTED" });
  });
});

describe("T3 dispatch and receipts", () => {
  test.each([true, false])(
    "preserves the bridge outcome after cleanup fails (success=%s)",
    async (succeeded) => {
      const { common, workspacePath } = await fixture();
      const input = {
        branch: "feature/cleanup",
        bridgeVersion: "0.1.0",
        dryRun: false,
        request: (await resolveT3HandoffRequest({ t3: "cleanup task" }))!,
        workspacePath,
        dependencies: {
          resolveGitCommonDirectory: async () => common,
          removePromptDirectory: async (path: string) => {
            temporaryRoots.push(path);
            throw new Error("locked");
          },
          runProcess: async () => ({
            exitCode: succeeded ? 0 : 1,
            stdout: succeeded ? successEnvelope(workspacePath) : "",
            stderr: JSON.stringify({
              ok: false,
              error: { code: "T3_AUTH_FAILED", message: "not paired" },
            }),
          }),
        },
      };
      await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
        code: succeeded ? "T3_PROMPT_CLEANUP_FAILED" : "T3_AUTH_FAILED",
        details: { promptCleanupFailed: true, promptDirectory: expect.any(String) },
        result: {
          status: succeeded ? "succeeded" : "failed",
          dispatch: { status: succeeded ? "succeeded" : "failed" },
        },
      });
    },
  );

  test("preserves a bridge failure when persisting its receipt fails", async () => {
    const { common, workspacePath } = await fixture();
    let dispatched = false;
    await expect(
      dispatchT3Handoff({
        branch: "feature/failure-write",
        bridgeVersion: "0.1.0",
        dryRun: false,
        request: (await resolveT3HandoffRequest({ t3: "failure write" }))!,
        workspacePath,
        dependencies: {
          platform: "win32",
          resolveGitCommonDirectory: async () => common,
          setWindowsOwnerOnly: async () => {
            if (dispatched) throw new Error("disk full");
          },
          runProcess: async () => {
            dispatched = true;
            return {
              exitCode: 1,
              stdout: "",
              stderr: JSON.stringify({
                ok: false,
                error: { code: "T3_AUTH_FAILED", message: "not paired" },
              }),
            };
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "T3_AUTH_FAILED",
      details: { receiptWriteFailed: true },
      result: { status: "failed", error: { code: "T3_AUTH_FAILED" }, retry: { safe: false } },
    });
  });
  test("applies native permissions through a successful dispatch", async () => {
    const { common, workspacePath } = await fixture();
    try {
      const result = await dispatchT3Handoff({
        branch: "feature/native-acl",
        bridgeVersion: "0.1.0",
        dryRun: false,
        request: (await resolveT3HandoffRequest({ t3: "native permissions" }))!,
        workspacePath,
        dependencies: {
          resolveGitCommonDirectory: async () => common,
          runProcess: async () => ({
            exitCode: 0,
            stderr: "",
            stdout: successEnvelope(workspacePath),
          }),
        },
      });
      expect(result.status).toBe("succeeded");
    } catch (error) {
      throw new Error(`${String(error)}\n${(error as { stderr?: string }).stderr ?? ""}`, {
        cause: error,
      });
    }
  });

  test("preserves proven remote success when the final receipt write fails", async () => {
    const { common, workspacePath } = await fixture();
    let dispatched = false;
    const input = {
      branch: "feature/receipt-write",
      bridgeVersion: "0.1.0",
      dryRun: false,
      request: (await resolveT3HandoffRequest({ t3: "receipt write failure" }))!,
      workspacePath,
      dependencies: {
        platform: "win32" as const,
        resolveGitCommonDirectory: async () => common,
        setWindowsOwnerOnly: async () => {
          if (dispatched) throw new Error("storage unavailable");
        },
        runProcess: async () => {
          dispatched = true;
          return { exitCode: 0, stderr: "", stdout: successEnvelope(workspacePath) };
        },
      },
    };
    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_RECEIPT_WRITE_FAILED",
      result: {
        status: "succeeded",
        project: { id: "project-1" },
        thread: { id: "11111111-1111-1111-1111-111111111111" },
        retry: { safe: false },
      },
    });
    input.dependencies.setWindowsOwnerOnly = async () => {};
    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_DUPLICATE_HANDOFF_BLOCKED",
      result: { status: "dispatching" },
    });
  });
  test.each(["darwin", "linux", "win32"] as const)(
    "uses exact argv, private paths, and sanitized receipts on %s",
    async (platform) => {
      const { common, workspacePath } = await fixture();
      const calls: readonly string[][] = [];
      const mutableCalls = calls as string[][];
      const aclPaths: string[] = [];
      const request = await resolveT3HandoffRequest({
        permission: "approval-required",
        t3: "line one\n$HOME `unsafe` line two",
      });
      expect(request).not.toBeNull();

      const result = await dispatchT3Handoff({
        branch: "feature/t3",
        bridgeVersion: "0.1.0",
        dryRun: false,
        request: request!,
        workspacePath,
        dependencies: {
          platform,
          resolveGitCommonDirectory: async () => common,
          setWindowsOwnerOnly: async (path) => {
            aclPaths.push(path);
          },
          runProcess: async (command): Promise<T3ProcessResult> => {
            mutableCalls.push([...command]);
            return { exitCode: 0, stderr: "", stdout: successEnvelope(workspacePath) };
          },
        },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        "t3code",
        "--json",
        "handover",
        "--cwd",
        result.workspacePath,
        "--workspace-mode",
        "folder",
        "--project-policy",
        "create",
        "--checkout",
        "current",
        "--open",
        "none",
        "--permission",
        "approval-required",
        "--prompt-file",
        expect.stringContaining("task.md"),
      ]);
      expect(result).toMatchObject({
        status: "succeeded",
        permission: "approval-required",
        environment: { id: "environment-1", serverVersion: "0.0.42" },
        project: { id: "project-1", created: true },
        thread: { id: "11111111-1111-1111-1111-111111111111", title: null },
        ui: { mode: "none", status: "skipped" },
      });
      const receiptText = await readFile(result.receiptPath!, "utf8");
      expect(receiptText).not.toContain("TOP SECRET PROMPT");
      expect(receiptText).not.toContain("Implement feature");
      expect(receiptText).not.toContain("line one");
      expect(receiptText).not.toContain("SECRET");
      if (process.platform !== "win32") {
        expect((await stat(result.receiptPath!)).mode & 0o077).toBe(0);
      }
      if (platform === "win32") {
        expect(aclPaths.some((path) => path.endsWith("task.md"))).toBe(true);
        expect(aclPaths.some((path) => path.endsWith(".arashi-t3-handoffs"))).toBe(true);
      } else {
        expect(aclPaths).toEqual([]);
      }
    },
  );

  test("allows a matching retry after definite failure, then blocks a duplicate success", async () => {
    const { common, workspacePath } = await fixture();
    const request = (await resolveT3HandoffRequest({ t3: "retry task" }))!;
    let response: T3ProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: JSON.stringify({
        ok: false,
        error: { code: "T3_AUTH_FAILED", message: "not paired" },
      }),
    };
    const dependencies = {
      resolveGitCommonDirectory: async () => common,
      runProcess: async () => response,
    };
    const input = {
      branch: "feature/retry",
      bridgeVersion: "0.1.0",
      dryRun: false,
      request,
      workspacePath,
      dependencies,
    };

    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_AUTH_FAILED",
      result: { status: "failed", retry: { safe: true } },
    });
    response = { exitCode: 0, stderr: "", stdout: successEnvelope(workspacePath) };
    await expect(dispatchT3Handoff(input)).resolves.toMatchObject({ status: "succeeded" });
    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_DUPLICATE_HANDOFF_BLOCKED",
      result: { status: "succeeded" },
    });
  });

  test("treats an unavailable server as indeterminate and blocks blind retry", async () => {
    const { common, workspacePath } = await fixture();
    const request = (await resolveT3HandoffRequest({ t3: "server task" }))!;
    const input = {
      branch: "feature/server",
      bridgeVersion: "0.1.0",
      dryRun: false,
      request,
      workspacePath,
      dependencies: {
        resolveGitCommonDirectory: async () => common,
        runProcess: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: { code: "T3_REQUEST_FAILED", message: "server unavailable" },
          }),
        }),
      },
    };

    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_REQUEST_FAILED",
      result: { status: "indeterminate", retry: { safe: false } },
    });
    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_DUPLICATE_HANDOFF_BLOCKED",
      result: { status: "indeterminate" },
    });
  });

  test("blocks changed intent after failure and concurrent dispatch for one workspace", async () => {
    const { common, workspacePath } = await fixture();
    const firstRequest = (await resolveT3HandoffRequest({ t3: "first task" }))!;
    const failedDependencies = {
      resolveGitCommonDirectory: async () => common,
      runProcess: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({
          ok: false,
          error: { code: "T3_AUTH_FAILED", message: "not paired" },
        }),
      }),
    };
    await expect(
      dispatchT3Handoff({
        branch: "feature/intent",
        bridgeVersion: "0.1.0",
        dryRun: false,
        request: firstRequest,
        workspacePath,
        dependencies: failedDependencies,
      }),
    ).rejects.toMatchObject({ code: "T3_AUTH_FAILED" });
    const changedRequest = (await resolveT3HandoffRequest({ t3: "changed task" }))!;
    await expect(
      dispatchT3Handoff({
        branch: "feature/intent",
        bridgeVersion: "0.1.0",
        dryRun: false,
        request: changedRequest,
        workspacePath,
        dependencies: failedDependencies,
      }),
    ).rejects.toMatchObject({ code: "T3_HANDOFF_INTENT_CHANGED" });

    const secondFixture = await fixture();
    let allowResponse!: () => void;
    let processStarted!: () => void;
    const started = new Promise<void>((resolve) => (processStarted = resolve));
    const responseAllowed = new Promise<void>((resolve) => (allowResponse = resolve));
    const concurrentRequest = (await resolveT3HandoffRequest({ t3: "concurrent task" }))!;
    const concurrentInput = {
      branch: "feature/concurrent",
      bridgeVersion: "0.1.0",
      dryRun: false,
      request: concurrentRequest,
      workspacePath: secondFixture.workspacePath,
      dependencies: {
        resolveGitCommonDirectory: async () => secondFixture.common,
        runProcess: async () => {
          processStarted();
          await responseAllowed;
          return {
            exitCode: 0,
            stderr: "",
            stdout: successEnvelope(secondFixture.workspacePath),
          };
        },
      },
    };
    const firstDispatch = dispatchT3Handoff(concurrentInput);
    await started;
    await expect(dispatchT3Handoff(concurrentInput)).rejects.toMatchObject({
      code: "T3_HANDOFF_LOCKED",
    });
    allowResponse();
    await expect(firstDispatch).resolves.toMatchObject({ status: "succeeded" });
  });

  test("records malformed post-spawn output as indeterminate and blocks blind retry", async () => {
    const { common, workspacePath } = await fixture();
    const request = (await resolveT3HandoffRequest({ t3: "uncertain task" }))!;
    const input = {
      branch: "feature/uncertain",
      bridgeVersion: "0.1.0",
      dryRun: false,
      request,
      workspacePath,
      dependencies: {
        resolveGitCommonDirectory: async () => common,
        runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "not-json" }),
      },
    };

    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_BRIDGE_RESPONSE_INVALID",
      result: { status: "indeterminate", retry: { safe: false } },
    });
    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({
      code: "T3_DUPLICATE_HANDOFF_BLOCKED",
      result: { status: "indeterminate" },
    });
  });

  test("fails closed on a corrupted receipt instead of dispatching", async () => {
    const { common, workspacePath } = await fixture();
    const request = (await resolveT3HandoffRequest({ t3: "receipt task" }))!;
    let receiptPath = "";
    const input = {
      branch: "feature/receipt",
      bridgeVersion: "0.1.0",
      dryRun: false,
      request,
      workspacePath,
      dependencies: {
        resolveGitCommonDirectory: async () => common,
        runProcess: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: { code: "T3_AUTH_FAILED", message: "not paired" },
          }),
        }),
      },
    };
    try {
      await dispatchT3Handoff(input);
    } catch (error) {
      expect(error).toBeInstanceOf(T3HandoffError);
      receiptPath = (error as T3HandoffError).result?.receiptPath ?? "";
    }
    expect(receiptPath).not.toBe("");
    await writeFile(receiptPath, "{}\n");
    await expect(dispatchT3Handoff(input)).rejects.toMatchObject({ code: "T3_RECEIPT_INVALID" });
  });

  test("dry-run plans without subprocess or receipt mutation", async () => {
    const { workspacePath } = await fixture();
    const request = (await resolveT3HandoffRequest({ t3: "plan only" }))!;
    const result = await dispatchT3Handoff({
      branch: "feature/plan",
      bridgeVersion: "0.1.0",
      dryRun: true,
      request,
      workspacePath: join(workspacePath, "not-created-yet"),
      dependencies: {
        runProcess: async () => {
          throw new Error("must not run");
        },
      },
    });
    expect(result).toMatchObject({
      status: "planned",
      receiptPath: null,
      dispatch: { status: "planned" },
    });
  });
});

test("T3HandoffError exposes stable structured fields", () => {
  expect(new T3HandoffError("CODE", "message", { safe: true })).toMatchObject({
    code: "CODE",
    details: { safe: true },
  });
});
