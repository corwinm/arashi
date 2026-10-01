import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  dispatchT3Handoff,
  resolveT3HandoffRequest,
  t3ReceiptPath,
  type T3HandoffDependencies,
} from "../../src/lib/t3-handoff.ts";
import { initGit } from "./switch-t3-command.ts";
import { nativeConfig, nativeEnvironment } from "./t3-native.ts";

/** Official transport injection only; Git identity and receipt I/O are real. */
export async function nativeTransportFixture(
  roots: string[],
  prompt = "Exact task",
  child = false,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "arashi-392-transport-")));
  roots.push(root);
  const parent = join(root, "parent checkout 日本 '$");
  await initGit(parent);
  const workspacePath = child ? join(parent, "repos/child with spaces") : parent;
  if (child) await initGit(workspacePath);
  const projects: Record<string, unknown>[] = [];
  const threads: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const processes: { command: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const runtime = {
    environmentId: "environment-1",
    serverVersion: "0.0.43",
    orchestrationProtocolVersion: 1,
  };
  let cliVersion = "0.0.43";
  let canary = "NATIVE_RAW_CANARY";
  let failTask = false;
  const dependencies: T3HandoffDependencies = {
    getConfig: async () => ({
      ...nativeConfig(),
      secret: canary,
      authenticatedUrl: "http://token@localhost/?secret=" + canary,
    }),
    runProcess: async (command, options) => {
      processes.push({ command: [...command], cwd: options.cwd, env: { ...options.env } });
      return {
        exitCode: 0,
        stderr: canary,
        stdout: command.includes("--version")
          ? "t3 v" + cliVersion
          : command.includes("issue")
            ? JSON.stringify({ sessionId: "session-1", token: canary, rawSessionOutput: canary })
            : canary,
      };
    },
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      expect(init?.redirect).toBe("error");
      if (path.endsWith("environment")) return Response.json(runtime);
      if (path.endsWith("snapshot")) return Response.json({ projects, threads, rawOutput: canary });
      if (path.includes("/threads/"))
        return Response.json({ thread: { messages }, rawOutput: canary });
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const receipt = JSON.parse(await readFile(await t3ReceiptPath(workspacePath), "utf8"));
      expect(receipt.native.projectId).toBeTruthy();
      expect(receipt.native.threadId).toBeTruthy();
      expect(receipt.native.messageId).toBeTruthy();
      if (command.type === "thread.turn.start") expect(receipt.native.phase).toBe("submitting");
      commands.push(command);
      if (command.type === "project.create")
        projects.push({
          id: command.projectId,
          workspaceRoot: command.workspaceRoot,
          deletedAt: null,
          title: canary,
        });
      if (command.type === "thread.create")
        threads.push({
          id: command.threadId,
          projectId: command.projectId,
          worktreePath: null,
          deletedAt: null,
          title: canary,
        });
      if (command.type === "thread.turn.start") {
        const message = command.message as Record<string, unknown>;
        messages.push({ id: message.messageId, role: "user" });
        if (failTask) throw new Error(canary);
      }
      return Response.json({ sequence: commands.length, rawOutput: canary });
    }) as typeof fetch,
  };
  const input: Parameters<typeof dispatchT3Handoff>[0] = {
    workspacePath,
    branch: "main",
    dryRun: false,
    environment: nativeEnvironment(),
    request: (await resolveT3HandoffRequest({ t3: prompt }))!,
    dependencies,
  };
  return {
    root,
    parent,
    workspacePath,
    input,
    projects,
    threads,
    messages,
    commands,
    processes,
    runtime,
    cli: (version: string) => {
      cliVersion = version;
    },
    canary: (value: string) => {
      canary = value;
    },
    failTask: () => {
      failTask = true;
    },
    receipt: async () => JSON.parse(await readFile(await t3ReceiptPath(workspacePath), "utf8")),
  };
}
