import { spawn } from "node:child_process";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
);
const updates = [
  "initial",
  "selection",
  "project-requesting",
  "project-confirmed",
  "thread-requesting",
  "thread-confirmed",
  "submitting",
  "accepted",
];
const cases = updates.flatMap((stage) =>
  [1, 2, 3, 4, 5, 6].flatMap((boundary) =>
    ["crash", "io"].map((failure) => ({ boundary, failure, stage })),
  ),
);
async function child(
  f: Awaited<ReturnType<typeof switchFixture>>,
  settings: Record<string, unknown>,
) {
  const inputPath = join(f.root, "child-input.json"),
    hitPath = join(f.root, "hit.json"),
    statePath = join(f.root, "official-state.json"),
    resultPath = join(f.root, "result.json");
  const { dependencies: _dependencies, ...input } = f.input;
  await writeFile(
    inputPath,
    JSON.stringify({ hitPath, input, resultPath, statePath, ...settings }),
  );
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (accept, reject) => {
      const processChild = spawn(
        "bun",
        [resolve("tests/helpers/switch-t3-crash-child.ts"), inputPath],
        { env: process.env, stdio: "ignore" },
      );
      processChild.on("error", reject);
      processChild.on("exit", (code, signal) => accept({ code, signal }));
    },
  );
  return { hitPath, outcome, resultPath, statePath };
}
test.each(cases)(
  "A26 real child $failure $stage boundary=$boundary",
  async ({ stage, boundary, failure }) => {
    const f = await switchFixture(roots);
    const c = await child(f, { boundary, failure, stage });
    // A missing hit is an unmet seam/behavior on base, never counted as a successful crash.
    expect(JSON.parse(await readFile(c.hitPath, "utf8"))).toMatchObject({ boundary, stage });
    if (failure === "crash") {
      expect(c.outcome.signal).toBe("SIGKILL");
    } else {
      expect(c.outcome).toEqual({ code: 1, signal: null });
    }
    const state = JSON.parse(await readFile(c.statePath, "utf8"));
    const permitted =
      stage === "initial" || stage === "selection" || stage === "project-requesting"
        ? 0
        : stage === "project-confirmed" || stage === "thread-requesting"
          ? 1
          : stage === "thread-confirmed" || stage === "submitting"
            ? 2
            : 3;
    expect(state.commands).toHaveLength(permitted);
    if (stage === "accepted") {
      expect(state.messages).toHaveLength(1);
      if (failure === "io") {
        expect(JSON.parse(await readFile(c.resultPath, "utf8")).error.result).toMatchObject({
          status: "succeeded",
          dispatch: { status: "succeeded" },
        });
      }
    }
    if (failure === "crash") {
      const lock = (await t3ReceiptPath(f.input.workspacePath)) + ".lock";
      expect((await lstat(lock)).isFile()).toBe(true);
      const before = await readFile(lock);
      await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_HANDOFF_LOCKED" });
      expect(await readFile(lock)).toEqual(before);
      expect(f.commands).toEqual([]);
    }
  },
  15_000,
);
test.each([true, false])(
  "A23 actual task acceptance SIGKILL saved message=$0",
  async (present) => {
    const f = await switchFixture(roots);
    const c = await child(f, { savedMessage: present, stage: "task-accepted" });
    expect(c.outcome.signal).toBe("SIGKILL");
    expect(JSON.parse(await readFile(c.hitPath, "utf8"))).toEqual({ stage: "task-accepted" });
    const saved = await f.receipt();
    expect(saved.native.phase).toBe("submitting");
    const state = JSON.parse(await readFile(c.statePath, "utf8"));
    expect(
      state.commands.filter((v: { type: string }) => v.type === "thread.turn.start"),
    ).toHaveLength(1);
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_HANDOFF_LOCKED" });
    // Explicit operator action only after the child is dead and fixture server state has been examined.
    await rm((await t3ReceiptPath(f.input.workspacePath)) + ".lock");
    f.projects.push(...state.projects);
    f.threads.push(...state.threads);
    f.messages.push(...state.messages);
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
    expect(f.commands.filter((v) => v.type === "thread.turn.start")).toEqual([]);
  },
  15_000,
);
