import { dirname } from "node:path";
import { rm } from "node:fs/promises";
import { test, expect } from "vitest";
import { dispatchT3Handoff, t3ReceiptPath } from "../../src/lib/t3-handoff.ts";
import { switchFixture } from "../helpers/switch-t3-intent.ts";

test("create rejects unsafe existing Windows receipt root before repair", async () => {
  const roots: string[] = [];
  try {
    const f = await switchFixture(roots);
    await dispatchT3Handoff(f.input);
    const root = dirname(await t3ReceiptPath(f.input.workspacePath));
    let rootSafe = false;
    const events: string[] = [];
    f.dependencies.platform = "win32";
    f.dependencies.assertWindowsOwnerOnly = async (path) => {
      events.push("assert:" + path);
      return path !== root || rootSafe;
    };
    f.dependencies.setWindowsOwnerOnly = async (path) => {
      events.push("repair:" + path);
      if (path === root) rootSafe = true;
    };
    delete f.input.switch;
    const before = f.commands.length;
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({ code: "T3_RECEIPT_UNSAFE" });
    expect(events.some((event) => event.startsWith("repair:"))).toBe(false);
    expect(f.commands).toHaveLength(before);
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
