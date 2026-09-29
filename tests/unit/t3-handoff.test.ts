import { nativeConfig, nativeEnvironment } from "../helpers/t3-native.ts";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  dispatchT3Handoff,
  t3ReceiptPath,
  resolveT3HandoffRequest,
  T3HandoffError,
  type T3HandoffDependencies,
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

async function handoffFixture() {
  const { common, workspacePath } = await fixture();
  const projects: Record<string, unknown>[] = [];
  const threads: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  let failAt = "";
  let failAfterAcceptance = false;
  let failAfterCreation = false;
  const dependencies: T3HandoffDependencies = {
    getConfig: async () => nativeConfig(),
    resolveGitCommonDirectory: async () => common,
    runProcess: async (command) => ({
      exitCode: 0,
      stderr: "SECRET",
      stdout: command.includes("issue")
        ? JSON.stringify({ sessionId: "session-1", token: "SECRET" })
        : "revoked",
    }),
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("environment"))
        return Response.json({
          environmentId: "environment-1",
          serverVersion: "0.0.43",
          orchestrationProtocolVersion: 1,
        });
      if (path.endsWith("snapshot")) return Response.json({ projects, threads });
      if (path.startsWith("/api/orchestration/threads/"))
        return Response.json({ thread: { messages } });
      const command = JSON.parse(String(init?.body));
      commands.push(command);
      const receipt = JSON.parse(
        await readFile(await t3ReceiptPath(workspacePath, dependencies), "utf8"),
      );
      expect(receipt.native).toBeDefined();
      if (command.type === "thread.turn.start") expect(receipt.native.phase).toBe("submitting");
      if (command.type === failAt) {
        failAt = "";
        throw new Error("SECRET response");
      }
      if (command.type === "project.create")
        projects.push({
          id: command.projectId,
          workspaceRoot: command.workspaceRoot,
          deletedAt: null,
          defaultModelSelection: null,
        });
      if (command.type === "thread.create")
        threads.push({
          id: command.threadId,
          projectId: command.projectId,
          worktreePath: null,
          deletedAt: null,
        });
      if (command.type === "thread.create" && failAfterCreation) {
        failAfterCreation = false;
        throw new Error("accepted thread followed by timeout SECRET");
      }
      if (command.type === "thread.turn.start") {
        messages.push({ id: command.message.messageId, role: "user" });
        if (failAfterAcceptance) {
          failAfterAcceptance = false;
          throw new Error("Timeout after accepted task SECRET");
        }
      }
      return Response.json({ sequence: commands.length });
    }) as typeof fetch,
  };
  const input = {
    branch: "feature/test",
    environment: nativeEnvironment(),
    dryRun: false,
    request: (await resolveT3HandoffRequest({ t3: "TOP SECRET PROMPT" }))!,
    workspacePath,
    dependencies,
  };
  return {
    input,
    commands,
    projects,
    threads,
    messages,
    fail: (type: string) => {
      failAt = type;
    },
    timeoutAfterCreation: () => {
      failAfterCreation = true;
    },
    timeoutAfterAcceptance: () => {
      failAfterAcceptance = true;
    },
  };
}

describe("native T3 receipt protection", () => {
  test("uses exact project selection before server defaults for effort-only overrides", async () => {
    const fixture = await handoffFixture();
    const config = nativeConfig();
    config.providers.push({ ...config.providers[0]!, instanceId: "project-provider" });
    fixture.input.dependencies.getConfig = async () => config;
    fixture.input.environment.settings = { effort: "high" };
    fixture.projects.push({
      id: "existing-project",
      workspaceRoot: fixture.input.workspacePath,
      deletedAt: null,
      defaultModelSelection: {
        instanceId: "project-provider",
        model: "catalog-default",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    });
    const result = await dispatchT3Handoff(fixture.input);
    expect(result.selection).toEqual({
      instanceId: "project-provider",
      model: "catalog-default",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(fixture.commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
  });

  test.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
    "dispatches %s to the exact checkout and protects the receipt",
    async (permission) => {
      const fixture = await handoffFixture();
      fixture.input.request.permission = permission;
      const result = await dispatchT3Handoff(fixture.input);
      expect(result.status).toBe("succeeded");
      expect(result.selection).toEqual({
        instanceId: "codex",
        model: "catalog-default",
        options: [{ id: "reasoningEffort", value: "medium" }],
      });
      expect(fixture.commands.map((command) => command.type)).toEqual([
        "project.create",
        "thread.create",
        "thread.turn.start",
      ]);
      expect(fixture.commands[0]!.workspaceRoot).toBe(fixture.input.workspacePath);
      expect(fixture.commands[1]).toMatchObject({ worktreePath: null, runtimeMode: permission });
      expect(fixture.commands[2]).toMatchObject({
        runtimeMode: permission,
        message: { text: "TOP SECRET PROMPT" },
      });
      const persisted = await readFile(result.receiptPath!, "utf8");
      expect(persisted).not.toContain("SECRET");
      expect(JSON.stringify(result)).not.toContain("SECRET");
      if (process.platform !== "win32") {
        expect((await stat(result.receiptPath!)).mode & 0o777).toBe(0o600);
        expect((await stat(join(result.receiptPath!, ".."))).mode & 0o777).toBe(0o700);
      }
      await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
        code: "T3_DUPLICATE_HANDOFF_BLOCKED",
      });
      expect(fixture.commands).toHaveLength(3);
    },
  );

  test.each(["project.create", "thread.create"])(
    "reconciles partial %s failure using saved identifiers",
    async (type) => {
      const fixture = await handoffFixture();
      fixture.fail(type);
      await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
        result: { status: "failed", retry: { safe: true } },
      });
      await expect(dispatchT3Handoff(fixture.input)).resolves.toMatchObject({
        status: "succeeded",
      });
      expect(fixture.projects).toHaveLength(1);
      expect(fixture.threads).toHaveLength(1);
      expect(
        fixture.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(1);
    },
  );

  test("thread creation accepted before timeout is reconciled without creating another thread", async () => {
    const fixture = await handoffFixture();
    fixture.timeoutAfterCreation();
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      result: { status: "failed" },
    });
    await expect(dispatchT3Handoff(fixture.input)).resolves.toMatchObject({ status: "succeeded" });
    expect(fixture.commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
    expect(fixture.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      1,
    );
  });

  test("concurrent invocation never starts a second dispatch", async () => {
    const fixture = await handoffFixture();
    const results = await Promise.allSettled([
      dispatchT3Handoff(fixture.input),
      dispatchT3Handoff(fixture.input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect((failure as PromiseRejectedResult).reason.code).toMatch(
      /T3_HANDOFF_LOCKED|T3_DUPLICATE_HANDOFF_BLOCKED/u,
    );
    expect(fixture.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      1,
    );
  });

  test("accepted task followed by timeout is confirmed on restart without a second submission", async () => {
    const fixture = await handoffFixture();
    fixture.timeoutAfterAcceptance();
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      result: { status: "indeterminate", retry: { safe: false } },
    });
    await expect(dispatchT3Handoff(fixture.input)).resolves.toMatchObject({ status: "succeeded" });
    expect(fixture.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      1,
    );
  });

  test("uncertain unaccepted task never resubmits, even if the thread is deleted", async () => {
    const fixture = await handoffFixture();
    fixture.fail("thread.turn.start");
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      result: { status: "indeterminate" },
    });
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_DISPATCH_UNCERTAIN",
    });
    fixture.threads.splice(0);
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_DISPATCH_UNCERTAIN",
    });
    expect(fixture.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      1,
    );
  });

  test.each(["succeeded", "dispatching", "indeterminate", "failed"])(
    "bridge-era %s receipts block native redispatch",
    async (status) => {
      const fixture = await handoffFixture();
      const success = await dispatchT3Handoff(fixture.input);
      const receipt = JSON.parse(await readFile(success.receiptPath!, "utf8"));
      receipt.token = "SECRET";
      receipt.retry.guidance = "SECRET bridge output";
      receipt.error = { code: "LEGACY", message: "SECRET bridge error" };
      receipt.version = 1;
      receipt.bridgeVersion = "0.1.0";
      receipt.status = status;
      receipt.dispatch.status = status;
      delete receipt.native;
      delete receipt.adapter;
      delete receipt.selection;
      await writeFile(success.receiptPath!, JSON.stringify(receipt));
      await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
        code: "T3_DUPLICATE_HANDOFF_BLOCKED",
      });
      expect(fixture.commands).toHaveLength(3);
    },
  );

  test("blocks changed prompt, permissions, and explicit model selection", async () => {
    const fixture = await handoffFixture();
    fixture.fail("thread.create");
    await expect(dispatchT3Handoff(fixture.input)).rejects.toBeInstanceOf(T3HandoffError);
    fixture.input.environment.settings = { model: "other" };
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_HANDOFF_INTENT_CHANGED",
    });
    fixture.input.environment.settings = {};
    fixture.input.request.permission = "approval-required";
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_HANDOFF_INTENT_CHANGED",
    });
  });

  test("fails closed on corrupt receipts and stale/concurrent locks", async () => {
    const fixture = await handoffFixture();
    const path = await t3ReceiptPath(fixture.input.workspacePath, fixture.input.dependencies);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{}");
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_RECEIPT_INVALID",
    });
    await rm(path);
    await writeFile(`${path}.lock`, "");
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_HANDOFF_LOCKED",
    });
    expect(fixture.commands).toHaveLength(0);
  });

  test("auth cleanup failure preserves accepted task and receipt protection", async () => {
    const fixture = await handoffFixture();
    fixture.input.dependencies.runProcess = async (command) => ({
      exitCode: command.includes("revoke") ? -1 : 0,
      stderr: "SECRET",
      stdout: JSON.stringify({ sessionId: "session-1", token: "SECRET" }),
    });
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_AUTH_CLEANUP_FAILED",
      details: { sessionCleanupFailed: true },
      result: { status: "succeeded", retry: { safe: false } },
    });
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_DUPLICATE_HANDOFF_BLOCKED",
    });
    expect(fixture.commands).toHaveLength(3);
  });

  test("fresh catalog rejection stops remote preparation when preflight has become stale", async () => {
    const fixture = await handoffFixture();
    fixture.input.dependencies.getConfig = async () => ({ providers: [], settings: {} });
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_PROVIDER_AMBIGUOUS",
      result: { status: "failed" },
    });
    expect(fixture.commands).toHaveLength(0);
  });

  test("a retained lock preserves successful remote outcome", async () => {
    const fixture = await handoffFixture();
    fixture.input.dependencies.removeReceiptLock = async () => {
      throw new Error("cleanup failure");
    };
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_LOCK_CLEANUP_FAILED",
      details: { lockCleanupFailed: true },
      result: { status: "succeeded", retry: { safe: false } },
    });
  });

  test("receipt persistence failure after acceptance cannot lead to duplicate dispatch", async () => {
    const fixture = await handoffFixture();
    let syncs = 0;
    fixture.input.dependencies.syncDirectory = async () => {
      syncs++;
      if (fixture.messages.length > 0) throw new Error("disk failure");
    };
    await expect(dispatchT3Handoff(fixture.input)).rejects.toMatchObject({
      code: "T3_RECEIPT_WRITE_FAILED",
      result: { status: "succeeded", retry: { safe: false } },
    });
    expect(syncs).toBeGreaterThan(0);
    delete fixture.input.dependencies.syncDirectory;
    await expect(dispatchT3Handoff(fixture.input)).resolves.toMatchObject({ status: "succeeded" });
    expect(fixture.commands).toHaveLength(3);
  });

  test("sync failure before dispatch prevents every remote mutation", async () => {
    const fixture = await handoffFixture();
    fixture.input.dependencies.syncDirectory = async () => {
      throw new Error("no durability");
    };
    await expect(dispatchT3Handoff(fixture.input)).rejects.toThrow();
    expect(fixture.commands).toHaveLength(0);
  });

  test("Windows uses owner-only ACLs for receipt directory, lock, and receipt", async () => {
    const fixture = await handoffFixture();
    const paths: string[] = [];
    fixture.input.dependencies.platform = "win32";
    fixture.input.dependencies.setWindowsOwnerOnly = async (path) => {
      paths.push(path);
    };
    await dispatchT3Handoff(fixture.input);
    expect(paths.some((path) => path.endsWith(".lock"))).toBe(true);
    expect(paths.some((path) => path.endsWith(".tmp"))).toBe(true);
    expect(paths.some((path) => path.endsWith(".arashi-t3-handoffs"))).toBe(true);
  });

  test("dry-run does not issue credentials, dispatch, or write receipts", async () => {
    const fixture = await handoffFixture();
    fixture.input.dryRun = true;
    await expect(dispatchT3Handoff(fixture.input)).resolves.toMatchObject({
      status: "planned",
      receiptPath: null,
    });
    expect(fixture.commands).toHaveLength(0);
  });
});
