import { describe, expect, test, vi } from "vitest";
import * as git from "../../../src/lib/git.ts";
import {
  executeIndependentPulls,
  independentPullPaths,
} from "../../../src/lib/pull-concurrency.ts";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Barrier was never reached");
}

describe("pull child worker lifecycle", () => {
  test("identity proof does not start unbounded Git probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pull-probe-bound-"));
    const paths = [join(root, "first"), join(root, "second")];
    const gates = [barrier(), barrier()];
    const started: string[] = [];
    const originalExec = git.exec;
    try {
      for (const path of paths) execFileSync("git", ["init", path], { stdio: "pipe" });
      vi.spyOn(git, "exec").mockImplementation(async (args, cwd) => {
        started.push(cwd!);
        await gates[paths.indexOf(cwd!)]!.promise;
        return originalExec(args, cwd);
      });
      const proof = independentPullPaths(paths);
      await until(() => started.length > 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started).toEqual([paths[0]]);
      gates[0]!.release();
      await until(() => started.length === 2);
      gates[1]!.release();
      expect(await proof).toBe(true);
    } finally {
      gates.forEach((gate) => gate.release());
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires distinct Git common directories and non-overlapping physical paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pull-independent-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      const linked = join(root, "linked");
      git(root, "init", first);
      git(root, "init", second);
      git(
        first,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      );
      git(first, "worktree", "add", "-b", "linked", linked);
      await symlink(first, join(root, "alias"));
      expect(await independentPullPaths([first, second])).toBe(true);
      expect(await independentPullPaths([first, linked])).toBe(false);
      expect(await independentPullPaths([first, join(root, "alias")])).toBe(false);
      expect(await independentPullPaths([first, join(first, "subdir")])).toBe(false);
      expect(await independentPullPaths([first, join(root, "absent")])).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds active children and orders completed results", async () => {
    const gates = [barrier(), barrier(), barrier()];
    const started: number[] = [];
    let active = 0;
    let maximum = 0;
    const run = executeIndependentPulls([0, 1, 2], 2, async (item) => {
      started.push(item);
      active += 1;
      maximum = Math.max(maximum, active);
      await gates[item]!.promise;
      active -= 1;
      return { status: "updated" as const, item };
    });
    await until(() => started.length === 2);
    expect(started).toEqual([0, 1]);
    gates[1]!.release();
    await until(() => started.length === 3);
    gates[2]!.release();
    gates[0]!.release();
    expect(await run).toEqual([0, 1, 2].map((item) => ({ status: "updated", item })));
    expect(maximum).toBe(2);
  });

  test("drains multiple failing children and retains only attempted outcomes", async () => {
    const gates = [barrier(), barrier()];
    const started: number[] = [];
    const run = executeIndependentPulls([0, 1, 2], 2, async (item) => {
      started.push(item);
      await gates[item]!.promise;
      return { item, status: item === 0 ? "failed" : "manual-update" };
    });
    await until(() => started.length === 2);
    gates[0]!.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);
    gates[1]!.release();
    expect(await run).toEqual([
      { item: 0, status: "failed" },
      { item: 1, status: "manual-update" },
    ]);
  });

  test("first failed result stops queued work and drains already started work", async () => {
    const held = barrier();
    const started: number[] = [];
    let settled = false;
    const run = executeIndependentPulls([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) await held.promise;
      return { status: item === 1 ? ("manual-update" as const) : ("updated" as const), item };
    }).then((results) => {
      settled = true;
      return results;
    });
    await until(() => started.length === 2);
    await until(() => started.includes(1));
    // A successful mapper cannot claim the queued third item after the failure.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);
    expect(settled).toBe(false);
    held.release();
    expect(await run).toEqual([
      { status: "updated", item: 0 },
      { status: "manual-update", item: 1 },
    ]);
    expect(started).toEqual([0, 1]);
  });
});
