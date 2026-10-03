import { rm } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff } from "../../src/lib/t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
);
const boundaries = [
  "before-marker",
  "marker-before-send",
  "during-request",
  "accepted-before-ack",
  "ack-before-confirmed",
  "after-confirmed",
];
const evidenceKinds = ["present", "missing", "changed", "deleted"];
test.each(
  ["project", "thread"].flatMap((stage) =>
    boundaries.flatMap((boundary) =>
      evidenceKinds.map((evidence) => ({ boundary, evidence, stage })),
    ),
  ),
)("A22 $stage $boundary saved IDs $evidence", async ({ stage, boundary, evidence }) => {
  const f = await switchFixture(roots);
  let hit = false;
  if (
    ["before-marker", "marker-before-send", "ack-before-confirmed", "after-confirmed"].includes(
      boundary,
    )
  ) {
    const update =
      stage +
      (boundary === "before-marker" || boundary === "marker-before-send"
        ? "-requesting"
        : "-confirmed");
    const point = boundary === "before-marker" || boundary === "ack-before-confirmed" ? 1 : 6;
    f.dependencies.receiptProbe = async (s, b) => {
      if (s === update && b === point) {
        hit = true;
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
    };
  } else {
    f.fail(stage + ".create", boundary === "during-request" ? "before" : "after");
    hit = true;
  }
  await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
  expect(hit).toBe(true);
  const saved = await f.receipt();
  const ids = {
    environmentId: saved.native.environmentId,
    messageId: saved.native.messageId,
    projectId: saved.native.projectId,
    threadId: saved.native.threadId,
  };
  expect(saved.preparation[stage]).toBe(
    boundary === "before-marker"
      ? "not-attempted"
      : boundary === "after-confirmed"
        ? "confirmed"
        : "requesting",
  );
  delete f.dependencies.receiptProbe;
  const entries = stage === "project" ? f.projects : f.threads;
  entries.splice(0);
  if (evidence !== "missing") {
    entries.push(
      stage === "project"
        ? {
            id: ids.projectId,
            workspaceRoot: evidence === "changed" ? "/other" : f.input.workspacePath,
            deletedAt: evidence === "deleted" ? "deleted" : null,
          }
        : {
            id: ids.threadId,
            projectId: evidence === "changed" ? "other" : ids.projectId,
            worktreePath: null,
            deletedAt: evidence === "deleted" ? "deleted" : null,
          },
    );
  }
  const before = f.commands.length;
  if (evidence === "present" || (evidence === "missing" && boundary === "before-marker")) {
    const result = await dispatchT3Handoff(f.input);
    expect(result).toMatchObject({ native: ids, status: "succeeded" });
    const creates = f.commands.slice(before).filter((v) => v.type === stage + ".create");
    expect(creates).toHaveLength(evidence === "missing" ? 1 : 0);
    for (const command of creates) {
      expect(command[stage + "Id"]).toBe(stage === "project" ? ids.projectId : ids.threadId);
    }
    expect(f.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
  } else {
    await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
    expect(f.commands).toHaveLength(before);
    f.input.switch!.intentId = "fresh";
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: "T3_UNRESOLVED_HANDOFF",
    });
    expect(f.commands).toHaveLength(before);
  }
});
test.each(
  ["timeout", "abort", "malformed", "rejection"].flatMap((failure) =>
    [true, false].map((present) => ({ failure, present })),
  ),
)("A23 distinct $failure saved message=$present", async ({ failure, present }) => {
  const f = await switchFixture(roots);
  // Timeout and abort occur after remote acceptance with their distinct transport causes.
  const fetchOriginal = f.dependencies.fetch!;
  f.dependencies.fetch = (async (url, init) => {
    const result = await fetchOriginal(url, init);
    if (init?.body && JSON.parse(String(init.body)).type === "thread.turn.start") {
      if (!present) {
        f.messages.splice(0);
      }
      if (failure === "timeout" || failure === "abort") {
        throw new DOMException("redacted", failure === "timeout" ? "TimeoutError" : "AbortError");
      }
      if (failure === "malformed") {
        return Response.json({ invalid: true });
      }
      return Response.json({ denied: true }, { status: 403 });
    }
    return result;
  }) as typeof fetch;
  await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
    result: { status: "indeterminate" },
  });
  f.dependencies.fetch = fetchOriginal;
  if (present) {
    await expect(dispatchT3Handoff(f.input)).resolves.toMatchObject({ status: "succeeded" });
  } else {
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: "T3_DISPATCH_UNCERTAIN",
    });
    f.input.switch!.intentId = "fresh";
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: "T3_UNRESOLVED_HANDOFF",
    });
  }
  expect(f.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
});
