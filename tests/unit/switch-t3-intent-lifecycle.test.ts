import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";
type CorruptReceipt = {
  createdAt: unknown;
  updatedAt: unknown;
  status: unknown;
  dispatch: { status: unknown };
  environment: { serverVersion: unknown };
  native: { phase: unknown };
  preparation: { project: unknown; thread: unknown };
  project: { created: unknown };
  selection?: { options: unknown[] };
};
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
test.each(
  (["linux", "darwin", "win32"] as const).flatMap((platform) =>
    [
      "default",
      "A".repeat(64),
      "Followup",
      "followup",
      "CON",
      "NUL",
      "CON.txt",
      "NUL.txt",
      "followup.",
      "followup..",
    ].map((intentId) => ({ platform, intentId })),
  ),
)("A18 A25 injected $platform exact literal $intentId", async ({ platform, intentId }) => {
  const f = await switchFixture(roots);
  f.input.switch!.intentId = intentId;
  f.dependencies.platform = platform;
  const acl: string[] = [];
  f.dependencies.setWindowsOwnerOnly = async (path) => {
    acl.push(path);
  };
  const result = await dispatchT3Handoff(f.input);
  expect(result.receiptPath).toBe(await f.path());
  expect(await f.receipt()).toMatchObject({ version: 3, command: "switch", intentId });
  expect(result.receiptPath!.split("/").at(-1)).toBe(
    "i-" + Buffer.from(intentId, "utf8").toString("hex") + ".json",
  );
  if (platform === "win32") {
    expect(acl.some((path) => path.endsWith(".tmp"))).toBe(true);
    expect(acl.some((path) => path.endsWith(".lock"))).toBe(true);
  } else expect((await stat(result.receiptPath!)).mode & 0o777).toBe(0o600);
});
test.each(["", "-bad", "a/b", "a b", "é", "a".repeat(65), "a\n", "a\\b"])(
  "A18 invalid dispatcher intent %j zero effects",
  async (intentId) => {
    const f = await switchFixture(roots);
    f.input.switch!.intentId = intentId;
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_INTENT_INVALID" });
    expect(f.commands).toEqual([]);
    expect(
      await stat(dirname(await t3ReceiptPath(f.input.workspacePath))).catch(() => null),
    ).toBeNull();
  },
);
test.each(["failed", "submitting"])(
  "A21 create consults unresolved switch $0 sibling",
  async (state) => {
    const f = await switchFixture(roots);
    f.fail(state === "failed" ? "project.create" : "thread.turn.start", "before");
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    const before = f.commands.length;
    delete f.input.switch;
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: "T3_UNRESOLVED_HANDOFF",
    });
    expect(f.commands).toHaveLength(before);
  },
);
test.each(["revoke", "release"])("A26 known acceptance survives $0 failure", async (kind) => {
  const f = await switchFixture(roots);
  if (kind === "release")
    f.dependencies.removeReceiptLock = async () => {
      throw new Error("SECRET");
    };
  else {
    const run = f.dependencies.runProcess!;
    f.dependencies.runProcess = async (c, o) =>
      c.includes("revoke") ? { exitCode: 1, stdout: "SECRET", stderr: "SECRET" } : run(c, o);
  }
  await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
    result: { status: "succeeded", dispatch: { status: "succeeded" } },
  });
  expect((await f.receipt()).status).toBe("succeeded");
  expect(f.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
  if (kind === "release")
    expect(await readFile((await t3ReceiptPath(f.input.workspacePath)) + ".lock")).toBeDefined();
});
test.each([
  [
    "array native phase",
    (r: CorruptReceipt) => {
      r.status = "failed";
      r.dispatch.status = "failed";
      r.native.phase = ["accepted"];
    },
  ],
  [
    "array preparation project",
    (r: CorruptReceipt) => {
      r.preparation.project = ["confirmed"];
    },
  ],
  [
    "array preparation thread",
    (r: CorruptReceipt) => {
      r.preparation.thread = ["confirmed"];
    },
  ],
  [
    "object dispatch",
    (r: CorruptReceipt) => {
      r.status = "failed";
      r.native.phase = "preparing";
      r.dispatch.status = { secret: "CANARY" };
    },
  ],
  [
    "object server version",
    (r: CorruptReceipt) => {
      r.environment.serverVersion = { secret: "CANARY" };
    },
  ],
  [
    "object created time",
    (r: CorruptReceipt) => {
      r.createdAt = { secret: "CANARY" };
    },
  ],
  [
    "object updated time",
    (r: CorruptReceipt) => {
      r.updatedAt = { secret: "CANARY" };
    },
  ],
  [
    "object option",
    (r: CorruptReceipt) => {
      r.selection!.options = [{ id: "reasoning", value: { secret: "CANARY" } }];
    },
  ],
  [
    "object project created",
    (r: CorruptReceipt) => {
      r.project.created = { secret: "CANARY" };
    },
  ],
  [
    "accepted requesting project",
    (r: CorruptReceipt) => {
      r.preparation.project = "requesting";
    },
  ],
  [
    "accepted unattempted thread",
    (r: CorruptReceipt) => {
      r.preparation.thread = "not-attempted";
    },
  ],
  [
    "accepted missing selection",
    (r: CorruptReceipt) => {
      delete r.selection;
    },
  ],
] as const)(
  "A25/A28 rejects contradictory or nested receipt evidence: %s",
  async (_name, mutate) => {
    const f = await switchFixture(roots);
    await dispatchT3Handoff(f.input);
    const receipt = await f.receipt();
    mutate(receipt);
    await f.write(receipt);
    const before = f.commands.length;
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_RECEIPT_INVALID" });
    expect(f.commands).toHaveLength(before);
  },
);

test("A28 accepted receipt extensions excluded from sanitized replay", async () => {
  const f = await switchFixture(roots);
  await dispatchT3Handoff(f.input);
  const receipt = await f.receipt();
  receipt.token = "TOKEN-CANARY";
  receipt.unknown = "CONFIG-CANARY";
  receipt.native.unknown = "NESTED-NATIVE-CANARY";
  receipt.selectedGitIdentity.unknown = "NESTED-IDENTITY-CANARY";
  await f.write(receipt);
  const before = f.commands.length;
  const result = await dispatchT3Handoff(f.input);
  for (const secret of [
    "PROMPT-CANARY",
    "TOKEN-CANARY",
    "CONFIG-CANARY",
    "NESTED-NATIVE-CANARY",
    "NESTED-IDENTITY-CANARY",
    "SESSION-CANARY",
    "127.0.0.1",
  ])
    expect(JSON.stringify(result)).not.toContain(secret);
  expect(f.commands).toHaveLength(before);
});
test("A29 legacy create duplicate remains refused after accepted switch", async () => {
  const f = await switchFixture(roots);
  const descriptor = f.input.switch;
  delete f.input.switch;
  const create = await dispatchT3Handoff(f.input);
  const before = await readFile(create.receiptPath!);
  f.input.switch = descriptor;
  await dispatchT3Handoff(f.input);
  delete f.input.switch;
  await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
    code: "T3_DUPLICATE_HANDOFF_BLOCKED",
  });
  expect(await readFile(create.receiptPath!)).toEqual(before);
});
test.each(["same", "different"])(
  "A20 external stale lock $0 environment unchanged",
  async (kind) => {
    const f = await switchFixture(roots);
    const lock = (await t3ReceiptPath(f.input.workspacePath)) + ".lock";
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, "dead-owner");
    if (kind === "different") f.input.environment.environmentId = "different";
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: "T3_HANDOFF_LOCKED",
      details: { lockPath: lock },
    });
    expect(await readFile(lock, "utf8")).toBe("dead-owner");
    expect(f.commands).toEqual([]);
  },
);
