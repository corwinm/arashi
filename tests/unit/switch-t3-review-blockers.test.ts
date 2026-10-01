import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { executeSwitch } from "../../src/commands/switch.ts";
import { selectSwitchCandidate } from "../../src/core/switch.ts";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { T3HandoffError } from "../../src/lib/t3-error.ts";
import { switchT3PinnedSettings } from "../../src/lib/switch-t3-handoff.ts";
import { acceptedHandoff, invokeSwitch, jsonDetails } from "../helpers/switch-t3-command.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";

const native = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("../../src/lib/t3-native.ts", async (original) => ({
  ...(await original<typeof import("../../src/lib/t3-native.ts")>()),
  preflightT3Native: native.preflight,
}));
const roots: string[] = [];
const originalCwd = process.cwd();
let f: Awaited<ReturnType<typeof switchFixture>>;
beforeEach(async () => {
  f = await switchFixture(roots);
  process.chdir(f.input.workspacePath);
  await mkdir(join(f.input.workspacePath, ".arashi"));
  await writeFile(
    join(f.input.workspacePath, ".arashi", "config.json"),
    JSON.stringify({
      version: "1.0.0",
      reposDir: "repos",
      repos: {},
      worktreesDir: ".arashi/worktrees",
    }),
  );
  const home = join(f.root, "home");
  await mkdir(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("NO_COLOR", "1");
  native.preflight.mockReset().mockResolvedValue(f.input.environment);
});
afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function unresolved(stage: "preparing" | "submitting") {
  f.input.switch!.intentId = "old-intent";
  f.input.request.permission = "approval-required";
  f.fail(stage === "preparing" ? "thread.create" : "thread.turn.start", "before", false);
  await expect(dispatchT3Handoff(f.input)).rejects.toBeInstanceOf(T3HandoffError);
  const receipt = await f.receipt();
  const bytes = await readFile(await f.path());
  return { receipt, bytes, path: await f.path() };
}

test.each(["hint", "locked-dispatch"])(
  "blocking receipt metadata survives %s admission with zero further effects",
  async (admission) => {
    const saved = await unresolved("submitting");
    f.input.switch!.intentId = "new-intent";
    const count = f.commands.length;
    const error = await (
      admission === "hint"
        ? switchT3PinnedSettings(f.input.workspacePath, "new-intent", f.dependencies)
        : dispatchT3Handoff(f.input)
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "T3_UNRESOLVED_HANDOFF",
      details: {
        blockingIntentId: "old-intent",
        requestedIntentId: "new-intent",
        receiptPath: saved.path,
      },
      result: {
        permission: "approval-required",
        environment: saved.receipt.environment,
        project: saved.receipt.project,
        thread: saved.receipt.thread,
        native: saved.receipt.native,
        receiptPath: saved.path,
      },
    });
    expect(f.commands).toHaveLength(count);
    expect(await readFile(saved.path)).toEqual(saved.bytes);
  },
);

test.each(
  (["preparing", "submitting"] as const).flatMap((stage) =>
    (["Commander", "executor"] as const).flatMap((boundary) =>
      [false, true].map((json) => ({ stage, boundary, json })),
    ),
  ),
)(
  "blocking $stage $boundary json=$json retains original recovery",
  async ({ stage, boundary, json }) => {
    const saved = await unresolved(stage);
    const count = f.commands.length;
    const out = await invokeSwitch(boundary, f.input.workspacePath, {
      t3: "different requested task",
      path: true,
      t3Intent: "new-intent",
      json,
    });
    expect(out.exitCode).toBe(1);
    if (json || boundary === "executor") {
      const details = json ? jsonDetails(out) : (out.error as T3HandoffError).details;
      expect(details).toMatchObject({
        blockingIntentId: "old-intent",
        requestedIntentId: "new-intent",
        receiptPath: saved.path,
        t3Handoff: {
          intentId: "old-intent",
          permission: "approval-required",
          environment: saved.receipt.environment,
          native: saved.receipt.native,
          project: saved.receipt.project,
          thread: saved.receipt.thread,
          receiptPath: saved.path,
        },
      });
      const guidance = (details.t3Handoff as { retry: { guidance: string } }).retry.guidance;
      expect(guidance).toContain("--t3-intent old-intent");
      expect(guidance).not.toContain("--t3-intent new-intent");
      expect(guidance).not.toContain("no task was submitted");
      expect(guidance).toMatch(stage === "submitting" ? /read-only/ : /preparation/i);
    } else {
      expect(out.stdout() + out.stderr()).toContain("intent: old-intent");
      expect(out.stdout() + out.stderr()).toContain("Requested intent: new-intent");
      expect(out.stdout() + out.stderr()).toContain(saved.path);
      expect(out.stdout() + out.stderr()).toContain(saved.receipt.native.messageId);
      expect(out.stdout() + out.stderr()).toContain(saved.receipt.native.projectId);
      expect(out.stdout() + out.stderr()).toContain(saved.receipt.native.threadId);
      expect(out.stdout() + out.stderr()).not.toContain("--t3-intent new-intent");
    }
    expect(native.preflight).not.toHaveBeenCalled();
    expect(f.commands).toHaveLength(count);
    expect(await readFile(saved.path)).toEqual(saved.bytes);
  },
);

test.each([false, true])("retained lock reports exact lockPath json=%s", async (json) => {
  const lockPath = (await t3ReceiptPath(f.input.workspacePath)) + ".lock";
  await mkdir(join(f.input.switch!.selectedGitIdentity.commonDirectory, ".arashi-t3-handoffs"), {
    mode: 0o700,
  });
  await writeFile(lockPath, "retained owner", { mode: 0o600 });
  const out = await invokeSwitch("executor", f.input.workspacePath, {
    path: true,
    t3: "Task",
    json,
  });
  const details = json ? jsonDetails(out) : (out.error as T3HandoffError).details;
  expect(out.exitCode).toBe(1);
  expect(details.lockPath).toBe(lockPath);
  expect((details.t3Handoff as { retry: { guidance: string } }).retry.guidance).toContain(lockPath);
  expect(JSON.stringify(details)).not.toContain("no task was submitted");
  expect(await readFile(lockPath, "utf8")).toBe("retained owner");
  expect(native.preflight).not.toHaveBeenCalled();
});

test.each(["accepted-cleanup", "preparing", "submitting", "prerequisite"])(
  "recovery guidance describes %s evidence",
  async (stage) => {
    const result = acceptedHandoff(f.input.workspacePath, "approval-required");
    if (stage === "preparing" || stage === "submitting") {
      result.status = result.dispatch.status = stage === "preparing" ? "failed" : "indeterminate";
      result.native!.phase = stage;
    }
    const deps = {
      dispatchT3Handoff: vi.fn().mockRejectedValue(
        new T3HandoffError(
          "T3_HANDOFF_FAILED",
          "Reconcile.",
          {
            receiptPath: result.receiptPath,
            token: "DETAIL-CANARY",
            lockPath: "lock\u001b[31m-path",
          },
          result,
        ),
      ),
    };
    if (stage === "prerequisite")
      native.preflight.mockRejectedValue(new T3HandoffError("T3_CLI_NOT_FOUND", "Install T3."));
    const out = await invokeSwitch(
      "executor",
      f.input.workspacePath,
      { path: true, t3: "Task", json: true },
      deps,
    );
    const details = jsonDetails(out);
    const handoff = details.t3Handoff as {
      dispatch: { status: string };
      retry: { guidance: string };
    };
    expect(handoff.retry.guidance).toMatch(
      stage === "accepted-cleanup"
        ? /accepted/i
        : stage === "preparing"
          ? /preparation/i
          : stage === "submitting"
            ? /read-only/
            : /no task was submitted/,
    );
    if (stage === "accepted-cleanup") expect(handoff.dispatch.status).toBe("succeeded");
    expect(JSON.stringify(details)).not.toContain("DETAIL-CANARY");
    expect(JSON.stringify(details)).not.toMatch(/\\u001b/);
  },
);

test.each([false, true])(
  "ambiguity projects sanitized contextual candidates json=%s",
  async (json) => {
    const candidates = [
      {
        repoName: "repo\u0007-a",
        branchName: "feature\u001b[31m-a",
        worktreePath: join(f.root, "checkout-a"),
        token: "CANDIDATE-CANARY",
      },
      { repoName: "repo-b", branchName: "feature-b", worktreePath: join(f.root, "checkout-b") },
    ];
    const out = await invokeSwitch(
      "executor",
      undefined,
      { t3: "Task", json },
      {
        discoverSwitchCandidates: async () => ({ candidates, skippedCount: 0 }),
        selectSwitchCandidate: (values) => selectSwitchCandidate(values, { interactive: false }),
      },
    );
    expect(out.exitCode).toBe(2);
    const error = json ? JSON.parse(out.stdout()).error : out.error;
    const context = json ? error.details : error.context;
    expect(context).toMatchObject({
      matchCount: 2,
      candidates: [
        { repoName: "repo-a", branchName: "feature-a", worktreePath: candidates[0].worktreePath },
        { repoName: "repo-b", branchName: "feature-b", worktreePath: candidates[1].worktreePath },
      ],
    });
    for (const candidate of candidates) expect(error.message).toContain(candidate.worktreePath);
    expect(error.message).toContain("--path <checkout>");
    expect(JSON.stringify({ message: error.message, context })).not.toMatch(
      /CANDIDATE-CANARY|\\u001b|\\u0007/,
    );
    expect(native.preflight).not.toHaveBeenCalled();
  },
);

test("disabled T3 cd returns the ordinary execution object", async () => {
  const result = await executeSwitch(f.input.workspacePath, { path: true, t3: false, cd: true });
  expect(result).toMatchObject({
    launchMode: "cd",
    selected: { worktreePath: f.input.workspacePath },
  });
  expect(native.preflight).not.toHaveBeenCalled();
});
