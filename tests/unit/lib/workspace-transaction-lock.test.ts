import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  resolveWorkspaceTransactionLockPath,
  withWorkspaceTransactionLock,
} from "../../../src/lib/workspace-transaction-lock.ts";

describe("shared workspace transaction lock", () => {
  test("serializes add and configure operations through one lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-workspace-lock-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const lockPath = await resolveWorkspaceTransactionLockPath(root, {
      gitCommonDirectory: async () => root,
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstOwnerEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      firstOwnerEntered = resolve;
    });
    const first = withWorkspaceTransactionLock(lockPath, async () => {
      events.push("add-start");
      firstOwnerEntered();
      await firstGate;
      events.push("add-end");
    });
    await firstEntered;
    const second = withWorkspaceTransactionLock(lockPath, async () => events.push("configure"));
    expect(events).toEqual(["add-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["add-start", "add-end", "configure"]);
  });
});
