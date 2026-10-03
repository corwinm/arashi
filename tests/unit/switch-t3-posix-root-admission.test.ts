import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { switchT3PinnedSettings } from "../../src/lib/switch-t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seededCreate(mode: number, phase: "preparing" | "submitting" | "accepted") {
  const f = await switchFixture(roots);
  const path = await t3ReceiptPath(f.input.workspacePath);
  const root = dirname(path);
  await mkdir(root, { mode: 0o700 });
  // Model attacker-controlled bytes in an existing writable root. The mock
  // snapshot is official transport evidence, not a replacement for admission.
  const projectId = "known-workspace-project";
  const threadId = "attacker-selected-thread";
  const messageId = "attacker-selected-message";
  f.projects.push({ id: projectId, workspaceRoot: f.input.workspacePath, deletedAt: null });
  f.threads.push({ id: threadId, projectId, worktreePath: null, deletedAt: null });
  f.messages.push({ id: messageId, role: "user" });
  const status = phase === "accepted" ? "succeeded" : "indeterminate";
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      adapter: "native",
      adapterVersion: "1",
      branch: f.input.branch,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status,
      workspacePath: f.input.workspacePath,
      receiptPath: path,
      permission: f.input.request.permission,
      promptDigest: f.input.request.promptDigest,
      environment: { id: "environment-1", serverVersion: "0.0.43" },
      project: { id: projectId, title: null, created: false },
      thread: { id: threadId, title: null },
      native: { environmentId: "environment-1", projectId, threadId, messageId, phase },
      dispatch: { status },
      ui: { mode: "none", kind: "none", exactThread: false, status: "skipped" },
      retry: { safe: false, guidance: "Reconcile saved IDs." },
    }),
    { mode: 0o644 },
  );
  await chmod(root, mode);
  const effects: string[] = [];
  const fetch = f.dependencies.fetch!;
  const runProcess = f.dependencies.runProcess!;
  f.dependencies.fetch = (async (url, init) => {
    effects.push("http:" + new URL(String(url)).pathname);
    return fetch(url, init);
  }) as typeof globalThis.fetch;
  f.dependencies.runProcess = async (command, options) => {
    effects.push("process:" + command.join(" "));
    return runProcess(command, options);
  };
  return { ...f, createPath: path, receiptRoot: root, effects };
}

for (const mode of [0o770, 0o777, 0o755]) {
  for (const phase of ["preparing", "submitting"] as const) {
    test.skipIf(process.platform === "win32")(
      `create rejects POSIX root ${mode.toString(8)} with preseeded ${phase} receipt before repair`,
      async () => {
        const f = await seededCreate(mode, phase);
        delete f.input.switch;
        const bytes = await readFile(f.createPath);
        const entries = await readdir(f.receiptRoot);
        const outcome = await dispatchT3Handoff(f.input).then(
          (result) => ({ result, code: undefined }),
          (error) => ({ result: undefined, code: error.code }),
        );
        expect.soft(outcome.code).toBe("T3_RECEIPT_UNSAFE");
        expect.soft((await stat(f.receiptRoot)).mode & 0o777).toBe(mode);
        expect.soft(await readFile(f.createPath)).toEqual(bytes);
        expect.soft(await readdir(f.receiptRoot)).toEqual(entries);
        expect.soft(f.effects).toEqual([]);
        expect.soft(f.commands).toEqual([]);
      },
    );
  }
  test.skipIf(process.platform === "win32")(
    `switch rejects POSIX root ${mode.toString(8)} with preseeded accepted create receipt before repair`,
    async () => {
      const f = await seededCreate(mode, "accepted");
      const bytes = await readFile(f.createPath);
      const entries = await readdir(f.receiptRoot);
      await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_RECEIPT_UNSAFE" });
      expect((await stat(f.receiptRoot)).mode & 0o777).toBe(mode);
      expect(await readFile(f.createPath)).toEqual(bytes);
      expect(await readdir(f.receiptRoot)).toEqual(entries);
      expect(f.effects).toEqual([]);
      expect(f.commands).toEqual([]);
    },
  );
}

test.skipIf(process.platform === "win32")(
  "read-only switch admission rejects unsafe root without repair",
  async () => {
    const f = await seededCreate(0o777, "accepted");
    const bytes = await readFile(f.createPath);
    await expect(
      switchT3PinnedSettings(f.input.workspacePath, "default", f.dependencies),
    ).rejects.toMatchObject({ code: "T3_RECEIPT_UNSAFE" });
    expect((await stat(f.receiptRoot)).mode & 0o777).toBe(0o777);
    expect(await readFile(f.createPath)).toEqual(bytes);
    expect(f.effects).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "create dry-run leaves unsafe storage untouched",
  async () => {
    const f = await seededCreate(0o777, "submitting");
    delete f.input.switch;
    f.input.dryRun = true;
    const bytes = await readFile(f.createPath);
    const entries = await readdir(f.receiptRoot);
    expect((await dispatchT3Handoff(f.input)).status).toBe("planned");
    expect((await stat(f.receiptRoot)).mode & 0o777).toBe(0o777);
    expect(await readFile(f.createPath)).toEqual(bytes);
    expect(await readdir(f.receiptRoot)).toEqual(entries);
    expect(f.effects).toEqual([]);
  },
);

for (const command of ["create", "switch"]) {
  for (const existing of [false, true]) {
    test.skipIf(process.platform === "win32")(
      `${command} admits ${existing ? "safe existing" : "missing"} POSIX root`,
      async () => {
        const f = await switchFixture(roots);
        const root = dirname(await t3ReceiptPath(f.input.workspacePath));
        if (existing) await mkdir(root, { mode: 0o700 });
        if (command === "create") delete f.input.switch;
        expect((await dispatchT3Handoff(f.input)).status).toBe("succeeded");
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect(f.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          1,
        );
      },
    );
  }
}
