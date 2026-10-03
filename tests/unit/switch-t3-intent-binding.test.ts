import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { git, identity, switchFixture } from "../helpers/switch-t3-intent.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dispatchT3Handoff } from "../../src/lib/t3-handoff.ts";
import { invokeSwitch } from "../helpers/switch-t3-command.ts";
import { join } from "node:path";

const native = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("../../src/lib/t3-native.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  preflightT3Native: native.preflight,
}));
const roots: string[] = [];
const cwd = process.cwd();
let f: Awaited<ReturnType<typeof switchFixture>>;
beforeEach(async () => {
  f = await switchFixture(roots);
  process.chdir(f.input.workspacePath);
  await mkdir(join(f.input.workspacePath, ".arashi"));
  await writeFile(
    join(f.input.workspacePath, ".arashi/config.json"),
    JSON.stringify({
      repos: {},
      reposDir: "repos",
      version: "1.0.0",
      worktreesDir: ".arashi/worktrees",
    }),
  );
  native.preflight.mockReset().mockResolvedValue(f.input.environment);
});
afterEach(async () => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function save(state: string) {
  if (state === "interrupted") {
    f.fail("thread.create", "after");
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    expect((await f.receipt()).preparation.thread).toBe("requesting");
  } else {
    await dispatchT3Handoff(f.input);
  }
  return await f.receipt();
}
async function invoke() {
  return invokeSwitch(
    "executor",
    f.input.workspacePath,
    { json: true, path: true, t3: f.input.request.prompt, t3Intent: f.input.switch!.intentId },
    {
      // Repository identity is the discovery candidate's repoName, not display text.
      discoverSwitchCandidates: async () => ({
        candidates: [
          {
            branchName: f.input.branch,
            repoName: f.input.switch!.repository,
            worktreePath: f.input.workspacePath,
          },
        ],
        skippedCount: 0,
      }),
      t3: f.dependencies,
    },
  );
}

const retries = ["accepted", "interrupted"].flatMap((state) =>
  ["executor", "dispatch"].map((boundary) => ({ boundary, state })),
);
test.each(
  retries.flatMap((retry) => ["branch", "repository"].map((field) => ({ ...retry, field }))),
)(
  "$state $boundary rejects reused intent with changed $field before native effects",
  async ({ boundary, field, state }) => {
    const saved = await save(state);
    const bytes = await readFile(await f.path());
    const commands = f.commands.length;
    if (field === "branch") {
      await git(f.input.workspacePath, "switch", "-c", "other");
      f.input.branch = "other";
    } else {
      // A case-only identity change must not be presentation-normalized away.
      f.input.switch!.repository = "Checkout spaces 日本";
    }
    expect(await identity(f.input.workspacePath)).toEqual(saved.selectedGitIdentity);
    const fetch = vi.spyOn(f.dependencies, "fetch");
    const process = vi.spyOn(f.dependencies, "runProcess");
    const probe = vi.fn(async () => {});
    f.dependencies.receiptProbe = probe;
    if (boundary === "executor") {
      const out = await invoke();
      const envelope = JSON.parse(out.stdout());
      expect(envelope.error).toMatchObject({ code: "T3_HANDOFF_INTENT_CHANGED" });
      expect(out.exitCode).toBe(1);
      expect(envelope.error.details.t3Handoff.native).toMatchObject({
        messageId: saved.native.messageId,
      });
    } else {
      await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
        code: "T3_HANDOFF_INTENT_CHANGED",
        result: { native: saved.native },
      });
    }
    expect(native.preflight).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(f.commands).toHaveLength(commands);
    expect(await readFile(await f.path())).toEqual(bytes);
  },
);

test.each(retries)(
  "$state $boundary permits same-branch commits and working edits on retry",
  async ({ boundary, state }) => {
    const saved = await save(state);
    await writeFile(join(f.input.workspacePath, "working.txt"), "allowed working edit");
    await git(
      f.input.workspacePath,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "advance same branch",
    );
    if (boundary === "executor") {
      const out = await invoke();
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout()).data.t3Handoff.native).toMatchObject({
        messageId: saved.native.messageId,
      });
    } else {
      expect((await dispatchT3Handoff(f.input)).status).toBe("succeeded");
    }
    expect((await f.receipt()).native).toEqual({ ...saved.native, phase: "accepted" });
    expect(f.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
  },
);

test("resolved prior branch permits deliberate fresh intent", async () => {
  await save("accepted");
  await git(f.input.workspacePath, "switch", "-c", "other");
  f.input.branch = "other";
  f.input.switch!.intentId = "followup";
  const out = await invoke();
  expect(out.exitCode).toBe(0);
  expect((await f.receipt()).branch).toBe("other");
  expect(f.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(2);
});

test("branch mismatch cannot bypass unresolved sibling recovery with a fresh intent", async () => {
  const saved = await save("interrupted");
  await git(f.input.workspacePath, "switch", "-c", "other");
  f.input.branch = "other";
  f.input.switch!.intentId = "followup";
  const out = await invoke();
  const envelope = JSON.parse(out.stdout());
  expect(envelope.error).toMatchObject({ code: "T3_UNRESOLVED_HANDOFF" });
  expect(envelope.error.details).toMatchObject({
    blockingIntentId: "default",
    receiptPath: saved.receiptPath,
    requestedIntentId: "followup",
  });
  expect(envelope.error.details.t3Handoff.native).toMatchObject({
    messageId: saved.native.messageId,
  });
  expect(native.preflight).not.toHaveBeenCalled();
  expect(f.commands.some((command) => command.type === "thread.turn.start")).toBe(false);
});
