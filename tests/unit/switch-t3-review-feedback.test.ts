import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchT3Handoff } from "../../src/lib/t3-handoff.ts";
import { invokeSwitch } from "../helpers/switch-t3-command.ts";
import { git, switchFixture } from "../helpers/switch-t3-intent.ts";

const native = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("../../src/lib/t3-native.ts", async (original) => ({
  ...(await original<typeof import("../../src/lib/t3-native.ts")>()),
  preflightT3Native: native.preflight,
}));
const roots: string[] = [];
const cwd = process.cwd();
let f: Awaited<ReturnType<typeof switchFixture>>;
beforeEach(async () => {
  f = await switchFixture(roots);
  process.chdir(f.input.workspacePath);
  await mkdir(join(f.input.workspacePath, ".arashi"));
  await writeFile(
    join(f.input.workspacePath, ".arashi/config.json"),
    JSON.stringify({
      version: "1.0.0",
      reposDir: "repos",
      repos: {},
      worktreesDir: ".arashi/worktrees",
    }),
  );
  native.preflight.mockReset().mockResolvedValue(f.input.environment);
});
afterEach(async () => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test.each(["root", "directory", "file", "probe-error"])(
  "Windows %s ACL rejection blocks saved executable before preflight without repairing content",
  async (boundary) => {
    await dispatchT3Handoff(f.input);
    const path = await f.path();
    const saved = await f.receipt();
    saved.pinnedSettings.cli = "/attacker-controlled-cli";
    await f.write(saved);
    const bytes = await readFile(path);
    const target =
      boundary === "root"
        ? dirname(dirname(path))
        : boundary === "directory"
          ? dirname(path)
          : path;
    const assertWindowsOwnerOnly = vi.fn(async (candidate: string) => {
      if (candidate !== target) return true;
      if (boundary === "probe-error") throw new Error("ACL-PROBE-CANARY");
      return false;
    });
    const setWindowsOwnerOnly = vi.fn(async () => {});
    const count = f.commands.length;
    const out = await invokeSwitch(
      "executor",
      f.input.workspacePath,
      {
        path: true,
        t3: f.input.request.prompt,
        json: true,
      },
      { t3: { ...f.dependencies, platform: "win32", assertWindowsOwnerOnly, setWindowsOwnerOnly } },
    );
    expect(JSON.parse(out.stdout()).error).toMatchObject({ code: "T3_RECEIPT_UNSAFE" });
    expect(out.exitCode).toBe(1);
    expect(native.preflight).not.toHaveBeenCalled();
    expect(setWindowsOwnerOnly).not.toHaveBeenCalled();
    expect(f.commands).toHaveLength(count);
    expect(await readFile(path)).toEqual(bytes);
  },
);

test("git switch during native preflight rejects stale selected branch before dispatch", async () => {
  native.preflight.mockImplementation(async () => {
    await git(f.input.workspacePath, "switch", "-c", "other");
    return f.input.environment;
  });
  const dispatch = vi.fn().mockResolvedValue({});
  const out = await invokeSwitch(
    "executor",
    f.input.workspacePath,
    {
      path: true,
      t3: "Task",
      json: true,
    },
    { t3: f.dependencies, dispatchT3Handoff: dispatch },
  );
  expect(JSON.parse(out.stdout()).error).toMatchObject({ code: "T3_WORKSPACE_CHANGED" });
  expect(out.exitCode).toBe(1);
  expect(dispatch).not.toHaveBeenCalled();
});

test("detaching HEAD during preflight rejects selected branch even at the same commit", async () => {
  native.preflight.mockImplementation(async () => {
    await git(f.input.workspacePath, "switch", "--detach");
    return f.input.environment;
  });
  const dispatch = vi.fn();
  const out = await invokeSwitch(
    "executor",
    f.input.workspacePath,
    {
      path: true,
      t3: "Task",
      json: true,
    },
    { t3: f.dependencies, dispatchT3Handoff: dispatch },
  );
  expect(JSON.parse(out.stdout()).error).toMatchObject({ code: "T3_WORKSPACE_CHANGED" });
  expect(dispatch).not.toHaveBeenCalled();
});

test("proven Windows ACLs admit an existing receipt without changing its schema", async () => {
  await dispatchT3Handoff(f.input);
  const assertWindowsOwnerOnly = vi.fn(async () => true);
  const out = await invokeSwitch(
    "executor",
    f.input.workspacePath,
    {
      path: true,
      t3: f.input.request.prompt,
      json: true,
    },
    {
      t3: {
        ...f.dependencies,
        platform: "win32",
        assertWindowsOwnerOnly,
        setWindowsOwnerOnly: async () => {},
      },
    },
  );
  expect(out.exitCode).toBe(0);
  expect(assertWindowsOwnerOnly).toHaveBeenCalledWith(await f.path());
  expect(native.preflight).toHaveBeenCalled();
  expect(f.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
});

test.each(["project-requesting", "thread-requesting", "submitting"])(
  "branch change before %s blocks the next native mutation",
  async (stage) => {
    f.dependencies.receiptProbe = async (current, boundary) => {
      if (current === stage && boundary === 6)
        await git(f.input.workspacePath, "switch", "-c", "other");
    };
    await expect(dispatchT3Handoff(f.input)).rejects.toMatchObject({
      code: "T3_WORKSPACE_CHANGED",
    });
    const forbidden =
      stage === "project-requesting"
        ? "project.create"
        : stage === "thread-requesting"
          ? "thread.create"
          : "thread.turn.start";
    expect(f.commands.some((command) => command.type === forbidden)).toBe(false);
  },
);

test("same-branch edits and new commits remain allowed without receipt schema changes", async () => {
  f.dependencies.receiptProbe = async (stage, boundary) => {
    if (stage !== "thread-requesting" || boundary !== 6) return;
    await writeFile(join(f.input.workspacePath, "working.txt"), "allowed working change");
    await git(
      f.input.workspacePath,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "same branch advance",
    );
  };
  expect((await dispatchT3Handoff(f.input)).status).toBe("succeeded");
  const receipt = await f.receipt();
  expect(Object.keys(receipt.selectedGitIdentity).toSorted()).toEqual([
    "commonDirectory",
    "device",
    "gitDirectory",
    "inode",
  ]);
  expect((await dispatchT3Handoff(f.input)).status).toBe("succeeded");
  expect(f.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(1);
});
