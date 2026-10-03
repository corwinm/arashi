// Separate Bun process: durable test-server state is an injected official API fixture,
// Never a T3 database. SIGKILL exercises process death, independently of EIO injection.
import { open, readFile, writeFile } from "node:fs/promises";
import { dispatchT3Handoff } from "../../src/lib/t3-handoff.ts";
import type { T3HandoffDependencies } from "../../src/lib/t3-handoff.ts";
import { nativeConfig } from "./t3-native.ts";

type Command = Record<string, unknown>;
interface State {
  commands: Command[];
  projects: Command[];
  threads: Command[];
  messages: Command[];
}
const configuration = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const state: State = { commands: [], messages: [], projects: [], threads: [] };
const durable = async (path: string, value: unknown) => {
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
};
await durable(configuration.statePath, state);
const dependencies: T3HandoffDependencies & {
  receiptProbe?: (stage: string, boundary: number, path: string) => Promise<void>;
} = {
  fetch: (async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint.endsWith("environment"))
      return Response.json({
        environmentId: "environment-1",
        serverVersion: "0.0.43",
        orchestrationProtocolVersion: 1,
      });
    if (endpoint.endsWith("snapshot"))
      return Response.json({ projects: state.projects, threads: state.threads });
    if (endpoint.includes("/threads/"))
      return Response.json({ thread: { messages: state.messages } });
    const command = JSON.parse(String(init?.body)) as Command;
    state.commands.push(command);
    if (command.type === "project.create")
      state.projects.push({
        id: command.projectId,
        workspaceRoot: command.workspaceRoot,
        deletedAt: null,
      });
    if (command.type === "thread.create")
      state.threads.push({
        id: command.threadId,
        projectId: command.projectId,
        worktreePath: null,
        deletedAt: null,
      });
    if (command.type === "thread.turn.start" && configuration.savedMessage !== false)
      state.messages.push({ id: (command.message as Command).messageId, role: "user" });
    await durable(configuration.statePath, state);
    if (command.type === "thread.turn.start" && configuration.stage === "task-accepted") {
      await durable(configuration.hitPath, { stage: "task-accepted" });
      process.kill(process.pid, "SIGKILL");
    }
    return Response.json({ sequence: state.commands.length });
  }) as typeof fetch,
  getConfig: async () => nativeConfig(),
  receiptProbe: async (stage, boundary, path) => {
    if (stage !== configuration.stage || boundary !== configuration.boundary) return;
    await durable(configuration.hitPath, { stage, boundary, path });
    if (configuration.failure === "crash") process.kill(process.pid, "SIGKILL");
    throw Object.assign(new Error("Injected receipt write failure"), { code: "EIO" });
  },
  runProcess: async (command) => ({
    exitCode: 0,
    stderr: "",
    stdout: command.includes("--version")
      ? "t3 v0.0.43"
      : command.includes("issue")
        ? JSON.stringify({ sessionId: "session-1", token: "fixture-token" })
        : "revoked",
  }),
};
try {
  const result = await dispatchT3Handoff({ ...configuration.input, dependencies });
  await writeFile(configuration.resultPath, JSON.stringify({ result }));
} catch (error) {
  const failure = error as { code?: string; result?: unknown };
  await writeFile(
    configuration.resultPath,
    JSON.stringify({ error: { code: failure.code, result: failure.result } }),
  );
  process.exitCode = 1;
}
