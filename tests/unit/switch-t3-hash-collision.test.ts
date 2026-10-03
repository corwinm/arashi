import { rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    createHash: () => ({
      update() {
        return this;
      },
      digest() {
        return "a".repeat(64);
      },
    }),
  };
});
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { git, identity, switchFixture } from "../helpers/switch-t3-intent.ts";
import { join } from "node:path";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
test("A25 injected checkout hash collision fails physical identity validation", async () => {
  const f = await switchFixture(roots);
  await dispatchT3Handoff(f.input);
  const original = f.input.workspacePath;
  const linked = join(f.root, "collision-linked");
  await git(original, "worktree", "add", "-b", "collision", linked);
  expect(await t3ReceiptPath(linked)).toBe(await t3ReceiptPath(original));
  const before = f.commands.length;
  f.input.workspacePath = linked;
  f.input.branch = "collision";
  f.input.switch!.selectedGitIdentity = await identity(linked);
  await expect(dispatchT3Handoff(f.input)).rejects.toThrow();
  expect(f.commands).toHaveLength(before);
});
