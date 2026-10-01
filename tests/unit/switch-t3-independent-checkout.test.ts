import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { git, identity, switchFixture } from "../helpers/switch-t3-intent.ts";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))),
);
async function pair() {
  const a = await switchFixture(roots),
    b = await switchFixture(roots);
  const linked = join(a.root, "independent-linked");
  await git(a.input.workspacePath, "worktree", "add", "-b", "independent", linked);
  b.input.workspacePath = linked;
  b.input.switch!.selectedGitIdentity = await identity(linked);
  // Two injected clients of one official fixture, with snapshots containing both exact roots.
  for (const [current, other] of [
    [a, b],
    [b, a],
  ]) {
    const original = current.dependencies.fetch!;
    current.dependencies.fetch = (async (url, init) =>
      new URL(String(url)).pathname.endsWith("snapshot")
        ? Response.json({
            projects: [...current.projects, ...other.projects],
            threads: [...current.threads, ...other.threads],
          })
        : original(url, init)) as typeof fetch;
  }
  expect(a.input.switch!.selectedGitIdentity.commonDirectory).toBe(
    b.input.switch!.selectedGitIdentity.commonDirectory,
  );
  expect(await t3ReceiptPath(a.input.workspacePath)).not.toBe(
    await t3ReceiptPath(b.input.workspacePath),
  );
  return { a, b };
}
test("A20 distinct checkout concurrent locks are independent in same repository", async () => {
  const { a, b } = await pair();
  let resume!: () => void, entered!: () => void;
  const held = new Promise<void>((accept) => {
    resume = accept;
  });
  const reached = new Promise<void>((accept) => {
    entered = accept;
  });
  const config = a.dependencies.getConfig!;
  a.dependencies.getConfig = async (...args) => {
    entered();
    await held;
    return config(...args);
  };
  const owner = dispatchT3Handoff(a.input);
  await reached;
  try {
    await expect(dispatchT3Handoff(b.input)).resolves.toMatchObject({ status: "succeeded" });
    expect(await readFile((await t3ReceiptPath(a.input.workspacePath)) + ".lock")).toBeDefined();
  } finally {
    resume();
    await owner.catch(() => {});
  }
  expect(a.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
  expect(b.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
});
test("A20 A26 unassignable root temp protects both distinct checkout keys", async () => {
  const { a, b } = await pair();
  const root = dirname(await t3ReceiptPath(a.input.workspacePath));
  await mkdir(root, { recursive: true });
  const orphan = join(root, ".unassignable.tmp");
  await writeFile(orphan, "partial");
  for (const f of [a, b]) {
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_RECEIPT_UNSAFE" });
    expect(f.commands).toEqual([]);
  }
  expect(await readFile(orphan, "utf8")).toBe("partial");
});

test.each(
  ["same", "different"].flatMap((intent) =>
    ["same", "alias"].flatMap((checkout) =>
      ["same", "different"].map((environment) => ({ intent, checkout, environment })),
    ),
  ),
)(
  "A20 held owner $intent intent $checkout checkout $environment environment",
  async ({ intent, checkout, environment }) => {
    const f = await switchFixture(roots);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((accept) => {
      release = accept;
    });
    const reached = new Promise<void>((accept) => {
      entered = accept;
    });
    const config = f.dependencies.getConfig!;
    f.dependencies.getConfig = async (...args) => {
      entered();
      await held;
      return config(...args);
    };
    const owner = dispatchT3Handoff(f.input);
    await reached;
    try {
      const other = {
        ...f.input,
        switch: { ...f.input.switch!, intentId: intent === "same" ? "default" : "followup-1" },
        environment: {
          ...f.input.environment,
          environmentId: environment === "same" ? "environment-1" : "different",
        },
      };
      if (checkout === "alias") {
        const alias = join(f.root, "physical-alias");
        await symlink(f.input.workspacePath, alias);
        other.workspacePath = alias;
      }
      const lock = (await t3ReceiptPath(f.input.workspacePath)) + ".lock";
      expect((await t3ReceiptPath(other.workspacePath)) + ".lock").toBe(lock);
      const before = await readFile(lock);
      await expect(dispatchT3Handoff(other)).rejects.toMatchObject({
        code: "T3_HANDOFF_LOCKED",
        details: { lockPath: lock },
      });
      expect(await readFile(lock)).toEqual(before);
      expect(f.commands).toEqual([]);
    } finally {
      release();
      await owner.catch(() => undefined);
    }
    expect(f.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
  },
);
