/** Opt-in real smoke: bun scripts/test/t3-native-smoke.ts /absolute/path/to/official/t3 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { preflightT3Native, records, withT3Session } from "../../src/lib/t3-native.ts";

const run = promisify(execFile);
const cli = process.argv[2];
if (!cli)
  throw new Error("Pass the installed official T3 CLI path; this smoke never installs anything.");
const environment = await preflightT3Native(
  process.cwd(),
  {},
  { cli, provider: "codex", model: "gpt-6.1-sol", effort: "medium" },
);
const root = await realpath(await mkdtemp(join(tmpdir(), "arashi-native-t3-smoke-")));
const main = join(root, "main");
const child = join(main, "repos", "child");
const branch = `smoke-${randomUUID()}`;
const source = resolve(import.meta.dirname, "../../src/index.ts");
let projectId: string | undefined;
let threadId: string | undefined;
try {
  await mkdir(child, { recursive: true });
  for (const cwd of [main, child]) {
    await run("git", ["init", "-b", "main"], { cwd });
    await run("git", ["config", "user.name", "Arashi smoke"], { cwd });
    await run("git", ["config", "user.email", "arashi-smoke@example.invalid"], { cwd });
    await writeFile(join(cwd, "README.md"), "Disposable native T3 smoke fixture.\n");
    await run("git", ["add", "README.md"], { cwd });
    await run("git", ["commit", "-m", "test: initialize smoke fixture"], { cwd });
  }
  await run("bun", [source, "init", "--no-discover", "--json"], { cwd: main });
  await writeFile(
    join(main, ".arashi", "config.json"),
    JSON.stringify({
      version: "1.0.0",
      reposDir: "repos",
      repos: { child: { path: "repos/child" } },
      defaults: { create: { switch: false, launch: "none" } },
    }),
  );
  const task = join(root, "task.md");
  await writeFile(
    task,
    "Bounded native Arashi adapter smoke only. Reply exactly ARASHI_NATIVE_T3_SMOKE_OK. Do not use tools, modify files, spawn agents, dispatch work, execute commands, or implement anything. End after that acknowledgement.\n",
  );
  const args = [
    source,
    "create",
    branch,
    "--json",
    "--t3",
    "--prompt-file",
    task,
    "--t3-cli",
    cli,
    "--t3-provider",
    "codex",
    "--t3-model",
    "gpt-6.1-sol",
    "--t3-effort",
    "medium",
  ];
  const created = JSON.parse((await run("bun", args, { cwd: main, timeout: 60_000 })).stdout);
  const handoff = created.data.t3Handoff;
  projectId = handoff.project.id;
  threadId = handoff.thread.id;
  if (!projectId || !threadId || handoff.status !== "succeeded")
    throw new Error("No successful handoff identifiers.");
  const duplicate = await run("bun", [...args, "--conflict", "REUSE_EXISTING"], { cwd: main }).then(
    () => {
      throw new Error("Duplicate handoff unexpectedly succeeded.");
    },
    (error: unknown) => {
      const result = JSON.parse((error as { stdout: string }).stdout);
      if (result.error?.code !== "T3_DUPLICATE_HANDOFF_BLOCKED")
        throw new Error("Retry did not report duplicate protection.");
      return result.error.code;
    },
  );
  const observed = await withT3Session(environment, main, {}, async (request) => {
    const snapshot = await request("/api/orchestration/snapshot");
    const project = records(snapshot.projects).find((value) => value.id === projectId);
    if (project?.workspaceRoot !== handoff.workspacePath)
      throw new Error("Project does not use the exact created parent checkout.");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const detail = await request(`/api/orchestration/threads/${threadId}`);
      const thread = detail.thread as Record<string, unknown>;
      if (thread.worktreePath !== null) throw new Error("T3 created a second worktree.");
      const reply = records(thread.messages).find(
        (message) =>
          message.role === "assistant" &&
          typeof message.text === "string" &&
          message.text.includes("ARASHI_NATIVE_T3_SMOKE_OK"),
      );
      if (reply)
        return { exactCheckout: true, noAdditionalWorktree: true, providerAcknowledged: true };
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error("No bounded provider acknowledgement within 60 seconds.");
  });
  console.log(
    JSON.stringify(
      {
        serverVersion: environment.serverVersion,
        platform: process.platform,
        arch: process.arch,
        workspacePath: handoff.workspacePath,
        environmentId: environment.environmentId,
        projectId,
        threadId,
        permission: handoff.permission,
        selection: handoff.selection,
        dispatch: handoff.dispatch,
        ui: handoff.ui,
        duplicate,
        ...observed,
      },
      null,
      2,
    ),
  );
} finally {
  // Recover the owned project id even if create returned a partial-success error.
  if (!projectId) {
    await withT3Session(environment, main, {}, async (request) => {
      const snapshot = await request("/api/orchestration/snapshot");
      const owned = records(snapshot.projects).filter(
        (project) =>
          project.workspaceRoot === join(main, ".arashi", "worktrees", branch) &&
          project.deletedAt === null,
      );
      if (owned.length > 1)
        throw new Error(`Ambiguous test-owned cleanup; fixture retained at ${root}`);
      projectId = owned[0]?.id as string | undefined;
    });
  }
  if (projectId) {
    await withT3Session(environment, main, {}, async (request) => {
      await request("/api/orchestration/dispatch", {
        type: "project.delete",
        commandId: `arashi-smoke-cleanup-${randomUUID()}`,
        projectId,
        force: true,
      });
    });
  }
  await rm(root, { recursive: true, force: true });
}
