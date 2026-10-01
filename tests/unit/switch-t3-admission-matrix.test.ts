import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { git, identity, repository, switchFixture } from "../helpers/switch-t3-intent.ts";
import type { SwitchInput } from "../helpers/switch-t3-intent.ts";
const roots: string[] = [];
const originalCwd = process.cwd();
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
const invocations = ["main", "linked-parent", "linked-child"];
const targets = ["parent-main", "parent-linked", "child-main", "child-linked"];
const positions = invocations.flatMap((invocation) =>
  targets.map((target) => ({ invocation, target })),
);
async function fixture(invocation: string, target: string) {
  const f = await switchFixture(roots);
  const parent = f.input.workspacePath;
  const child = await repository(join(f.root, "child-main"));
  const parentLinked = join(f.root, "parent-linked"),
    childLinked = join(f.root, "child-linked");
  await git(parent, "worktree", "add", "-b", "parent-linked", parentLinked);
  await git(child, "worktree", "add", "-b", "child-linked", childLinked);
  const selected = (
    {
      "child-linked": childLinked,
      "child-main": child,
      "parent-linked": parentLinked,
      "parent-main": parent,
    } as Record<string, string>
  )[target]!;
  process.chdir(
    invocation === "main" ? parent : invocation === "linked-parent" ? parentLinked : childLinked,
  );
  f.input.workspacePath = selected;
  f.input.switch!.selectedGitIdentity = await identity(selected);
  f.input.switch!.repository = target.startsWith("parent") ? "parent" : "child";
  const createPath = await t3ReceiptPath(selected);
  expect(dirname(createPath)).toBe(
    join(f.input.switch!.selectedGitIdentity.commonDirectory, ".arashi-t3-handoffs"),
  );
  return { ...f, child, createPath, parent };
}
const states = [
  "none",
  "create-accepted",
  "create-failed",
  "create-submitting",
  "create-v1",
  "corrupt",
  "unsafe",
  "mismatched",
  "switch-accepted",
  "switch-failed",
  "switch-submitting",
];
test.each(
  positions.flatMap((position) =>
    states.flatMap((state) => ["same", "fresh"].map((intent) => ({ ...position, intent, state }))),
  ),
)(
  "A21 $invocation selects $target $state $intent admission",
  async ({ invocation, target, state, intent }) => {
    const f = await fixture(invocation, target);
    const descriptor = f.input.switch!;
    let protectedPath: string | undefined, protectedBytes: Buffer | undefined;
    if (state.startsWith("create-")) {
      delete f.input.switch;
      const created = await dispatchT3Handoff(f.input);
      protectedPath = created.receiptPath!;
      const receipt = JSON.parse(await readFile(protectedPath, "utf8"));
      if (state === "create-failed") {
        receipt.status = "failed";
        receipt.native.phase = "preparing";
        receipt.dispatch.status = "failed";
      }
      if (state === "create-submitting") {
        receipt.status = "indeterminate";
        receipt.native.phase = "submitting";
        receipt.dispatch.status = "indeterminate";
      }
      if (state === "create-v1") {
        receipt.version = 1;
        receipt.bridgeVersion = "1";
      }
      await writeFile(protectedPath, JSON.stringify(receipt));
      protectedBytes = await readFile(protectedPath);
      f.input.switch = descriptor;
    } else if (["corrupt", "unsafe", "mismatched"].includes(state)) {
      protectedPath = f.createPath;
      await mkdir(dirname(protectedPath), { mode: 0o700, recursive: true });
      if (state === "unsafe") {
        await symlink(join(f.root, "missing"), protectedPath);
      } else {
        await writeFile(
          protectedPath,
          state === "corrupt"
            ? "{}"
            : JSON.stringify({ receiptPath: protectedPath, version: 2, workspacePath: "/other" }),
        );
        protectedBytes = await readFile(protectedPath);
      }
    } else if (state.startsWith("switch-")) {
      await dispatchT3Handoff(f.input);
      if (state !== "switch-accepted") {
        const receipt = await f.receipt();
        receipt.status = state === "switch-failed" ? "failed" : "indeterminate";
        receipt.native.phase = state === "switch-failed" ? "preparing" : "submitting";
        receipt.dispatch.status = receipt.status;
        if (state === "switch-failed") {
          receipt.preparation = { project: "confirmed", thread: "confirmed" };
        }
        await f.write(receipt);
        if (state === "switch-submitting") {
          f.messages.splice(0);
        }
      }
    }
    if (intent === "fresh") {
      f.input.switch!.intentId = "followup-1";
    }
    const before = f.commands.length;
    const allowed =
      state === "none" ||
      state === "create-accepted" ||
      state === "switch-accepted" ||
      (state === "switch-failed" && intent === "same");
    if (allowed) {
      const result = await dispatchT3Handoff(f.input);
      expect(result).toMatchObject({ status: "succeeded", workspacePath: f.input.workspacePath });
      expect(result.receiptPath).toBe(await f.path());
      const tasks = f.commands.slice(before).filter((v) => v.type === "thread.turn.start");
      expect(tasks).toHaveLength(state === "switch-accepted" && intent === "same" ? 0 : 1);
    } else {
      await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
      expect(f.commands).toHaveLength(before);
    }
    if (protectedBytes) {
      expect(await readFile(protectedPath!)).toEqual(protectedBytes);
    }
  },
);
test.each(positions)(
  "A20 A25 $invocation selects $target create vs switch exact active lock",
  async ({ invocation, target }) => {
    const f = await fixture(invocation, target);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((accept) => {
      release = accept;
    });
    const acquired = new Promise<void>((accept) => {
      entered = accept;
    });
    const getConfig = f.dependencies.getConfig!;
    f.dependencies.getConfig = async (...args) => {
      entered();
      await held;
      return getConfig(...args);
    };
    const descriptor = f.input.switch!;
    delete f.input.switch;
    const owner = dispatchT3Handoff(f.input);
    await acquired;
    try {
      const lock = f.createPath + ".lock";
      const bytes = await readFile(lock);
      await chmod(lock, 0o600);
      for (const intentId of ["default", "fresh"]) {
        await expect(
          dispatchT3Handoff({ ...f.input, switch: { ...descriptor, intentId } } as SwitchInput),
        ).rejects.toMatchObject({ code: "T3_HANDOFF_LOCKED", details: { lockPath: lock } });
        expect(await readFile(lock)).toEqual(bytes);
      }
    } finally {
      release();
      await owner.catch(() => {});
      f.input.switch = descriptor;
    }
    expect(f.commands.filter((v) => v.type === "thread.turn.start")).toHaveLength(1);
  },
);
test.each(positions)(
  "A20 A25 $invocation selects $target stale lock never expires",
  async ({ invocation, target }) => {
    const f = await fixture(invocation, target);
    const lock = f.createPath + ".lock";
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, "dead-owner");
    for (const kind of ["create", "switch"]) {
      await expect(
        dispatchT3Handoff({
          ...f.input,
          switch: kind === "create" ? undefined : f.input.switch,
        } as SwitchInput),
      ).rejects.toMatchObject({ code: "T3_HANDOFF_LOCKED", details: { lockPath: lock } });
      expect(await readFile(lock, "utf8")).toBe("dead-owner");
    }
    expect(f.commands).toEqual([]);
  },
);
