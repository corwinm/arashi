import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "vitest";
import type { dispatchT3Handoff } from "../../src/lib/t3-handoff.ts";
import {
  resolveT3HandoffRequest,
  t3ReceiptPath,
  type T3HandoffDependencies,
} from "../../src/lib/t3-handoff.ts";
import { nativeConfig, nativeEnvironment } from "./t3-native.ts";
export const run = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  return (
    await run("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
      },
    })
  ).stdout.trim();
}
export async function repository(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(
    path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  return await realpath(path);
}
export async function identity(path: string) {
  const physical = await realpath(path);
  const metadata = await stat(physical);
  return {
    commonDirectory: await realpath(
      resolve(physical, await git(physical, "rev-parse", "--git-common-dir")),
    ),
    device: String(metadata.dev),
    gitDirectory: await realpath(await git(physical, "rev-parse", "--absolute-git-dir")),
    inode: String(metadata.ino),
  };
}
export interface SwitchDescriptor {
  command: "switch";
  intentId: string;
  explicitSettings: Record<string, string>;
  provenance: Record<string, string>;
  selectedGitIdentity: Awaited<ReturnType<typeof identity>>;
  repository: string;
}
export type SwitchInput = Parameters<typeof dispatchT3Handoff>[0] & { switch?: SwitchDescriptor };
export type ProbeDependencies = T3HandoffDependencies & {
  receiptProbe?: (stage: string, boundary: number, path: string) => Promise<void>;
};
export async function switchFixture(roots: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "switch-t3-finite-")));
  roots.push(root);
  const workspacePath = await repository(join(root, "checkout spaces 日本"));
  const projects: Record<string, unknown>[] = [],
    threads: Record<string, unknown>[] = [],
    messages: Record<string, unknown>[] = [],
    commands: Record<string, unknown>[] = [];
  let failType = "",
    failure = "before",
    savedMessage = true;
  const input: SwitchInput = {
    branch: "main",
    dryRun: false,
    environment: nativeEnvironment(),
    request: (await resolveT3HandoffRequest({
      t3: "PROMPT-CANARY $(touch forbidden)\nsecond line",
    }))!,
    switch: {
      command: "switch",
      intentId: "default",
      explicitSettings: {},
      provenance: {},
      selectedGitIdentity: await identity(workspacePath),
      repository: basename(workspacePath),
    },
    workspacePath,
  };
  const path = async () => {
    const create = await t3ReceiptPath(input.workspacePath);
    return input.switch
      ? join(
          create.slice(0, -5) + ".switch",
          "i-" + Buffer.from(input.switch.intentId).toString("hex") + ".json",
        )
      : create;
  };
  const dependencies: ProbeDependencies = {
    fetch: (async (url, init) => {
      const endpoint = new URL(String(url)).pathname;
      if (endpoint.endsWith("environment"))
        return Response.json({
          environmentId: "environment-1",
          serverVersion: "0.0.43",
          orchestrationProtocolVersion: 1,
        });
      if (endpoint.endsWith("snapshot")) return Response.json({ projects, threads });
      if (endpoint.includes("/threads/")) return Response.json({ thread: { messages } });
      const command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      commands.push(command);
      const receipt = JSON.parse(await readFile(await path(), "utf8"));
      expect(receipt.native).toBeDefined();
      if (input.switch) {
        expect(receipt.version).toBe(3);
        expect(receipt.intentId).toBe(input.switch.intentId);
        expect(receipt.selectedGitIdentity).toEqual(await identity(input.workspacePath));
        if (command.type === "project.create") {
          expect(receipt.preparation.project).toBe("requesting");
          expect(command.projectId).toBe(receipt.native.projectId);
        }
        if (command.type === "thread.create") {
          expect(receipt.preparation.thread).toBe("requesting");
          expect(command.threadId).toBe(receipt.native.threadId);
        }
      }
      if (command.type === "thread.turn.start") expect(receipt.native.phase).toBe("submitting");
      const fail = command.type === failType;
      if (fail && failure === "before") {
        failType = "";
        throw new Error("TRANSPORT-CANARY");
      }
      if (command.type === "project.create")
        projects.push({
          id: command.projectId,
          workspaceRoot: command.workspaceRoot,
          deletedAt: null,
        });
      if (command.type === "thread.create")
        threads.push({
          id: command.threadId,
          projectId: command.projectId,
          worktreePath: null,
          deletedAt: null,
        });
      if (command.type === "thread.turn.start" && savedMessage)
        messages.push({ id: (command.message as Record<string, unknown>).messageId, role: "user" });
      if (fail) {
        failType = "";
        if (failure === "malformed") return Response.json({ bad: "ACK-CANARY" });
        if (failure === "rejection")
          return Response.json({ secret: "ACK-CANARY" }, { status: 403 });
        throw new Error("TRANSPORT-CANARY");
      }
      return Response.json({ sequence: commands.length });
    }) as typeof fetch,
    getConfig: async () => nativeConfig(),
    runProcess: async (command, options) => {
      expect(options.cwd).toBe(input.workspacePath);
      return {
        exitCode: 0,
        stderr: "SESSION-CANARY",
        stdout: command.includes("--version")
          ? "t3 v0.0.43"
          : command.includes("issue")
            ? JSON.stringify({ sessionId: "session-1", token: "TOKEN-CANARY" })
            : "revoked",
      };
    },
  };
  input.dependencies = dependencies;
  return {
    commands,
    dependencies,
    fail: (type: string, when = "before", present = true) => {
      failType = type;
      failure = when;
      savedMessage = present;
    },
    input,
    messages,
    path,
    projects,
    receipt: async () => JSON.parse(await readFile(await path(), "utf8")),
    root,
    threads,
    write: async (value: unknown) => writeFile(await path(), JSON.stringify(value)),
  };
}
