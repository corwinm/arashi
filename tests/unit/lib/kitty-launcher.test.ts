import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { SwitchCandidate } from "../../../src/core/switch.ts";
import { SwitchCommandErrorCode } from "../../../src/types/switch.ts";
import {
  acquireKittyIdentityLock,
  deriveKittyWorktreeMetadata,
  launchManagedKitty,
  parseKittyState,
  parseKittyVersion,
  resolveKittenExecutable,
  type KittyIdentityLock,
  type KittyWorktreeMetadata,
} from "../../../src/lib/kitty-launcher.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

const candidate: SwitchCandidate = {
  branchName: `feat/quote' [review] $HOME; echo nope`,
  repoName: `repo $name's [x]`,
  worktreePath: "/workspace/feature auth's [review] $HOME; echo nope",
};

const state = (options: {
  cwd: string;
  foregroundCwd?: string;
  id?: number;
  identity: string;
  focused?: boolean;
  session?: string;
  title?: string;
}) =>
  JSON.stringify([
    {
      id: 1,
      is_focused: true,
      tabs: [
        {
          id: 2,
          is_focused: true,
          windows: [
            {
              cwd: options.cwd,
              env: { API_TOKEN: "must-never-be-retained" },
              foreground_processes: options.foregroundCwd
                ? [
                    {
                      cmdline: ["shell", "--token", "must-never-be-retained"],
                      cwd: options.foregroundCwd,
                      pid: 123,
                    },
                  ]
                : undefined,
              id: options.id ?? 73,
              is_focused: options.focused ?? true,
              last_focused_at: 123,
              session_name: options.session ?? "stale presentation",
              title: options.title ?? "stale presentation",
              user_vars: { arashi_worktree_id: options.identity, unrelated: "ignored" },
            },
          ],
        },
      ],
    },
  ]);

describe("Kitty support helpers", () => {
  test.each([
    ["kitty 0.43.0 created by Kovid Goyal", "0.43.0"],
    ["kitten 0.48.1", "0.48.1"],
    ["kitty 1.2", null],
    ["not kitty", null],
  ])("parses a strict semantic Kitty version from %j", (output, expected) => {
    expect(parseKittyVersion(output)).toBe(expected);
  });

  test("resolves kitten from inherited PATH before the macOS app bundle", async () => {
    const commands: string[][] = [];
    await expect(
      resolveKittenExecutable({
        env: { PATH: "/custom/bin" },
        pathExists: async () => true,
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "/custom/bin/kitten\n" };
        },
      }),
    ).resolves.toBe("/custom/bin/kitten");
    expect(commands).toEqual([["which", "kitten"]]);
  });

  test("uses only the standard macOS app-bundle fallback when PATH lookup fails", async () => {
    const commands: string[][] = [];
    await expect(
      resolveKittenExecutable({
        env: {},
        pathExists: async (path) => path === "/Applications/kitty.app/Contents/MacOS/kitten",
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return { exitCode: 1, stderr: "missing", stdout: "" };
        },
      }),
    ).resolves.toBe("/Applications/kitty.app/Contents/MacOS/kitten");
    expect(commands).toEqual([["which", "kitten"]]);
  });

  test("canonicalizes real paths and derives stable full SHA-256 identity plus readable labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-meta-"));
    cleanup.push(root);
    const target = join(root, "real worktree");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias);

    const metadata = await deriveKittyWorktreeMetadata({
      branchName: "feat/review",
      repoName: "workspace",
      worktreePath: `${alias}/`,
    });

    expect(metadata.canonicalPath).toBe(await realpath(target));
    expect(metadata.identity).toMatch(/^arashi-v1-[a-f0-9]{64}$/);
    expect(metadata.sessionName).toBe("workspace: feat/review");
    expect(metadata.title).toBe("workspace: feat/review");
    await expect(
      deriveKittyWorktreeMetadata({
        branchName: "feat/review",
        repoName: "workspace",
        worktreePath: target,
      }),
    ).resolves.toEqual(metadata);
  });

  test("reports canonical-path resolution failures as actionable managed-launch errors", async () => {
    const missing = join(tmpdir(), `arashi-kitty-missing-${randomUUID()}`);
    await expect(
      deriveKittyWorktreeMetadata({ ...candidate, worktreePath: missing }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { phase: "identity" },
      message: expect.stringContaining("canonical"),
    });
  });

  test("projects Kitty state narrowly and never retains raw environment values", () => {
    const projected = parseKittyState(
      state({
        cwd: "/stale-kitty-window-cwd",
        foregroundCwd: "/workspace/wt",
        identity: "arashi-v1-deadbeef",
        focused: false,
      }),
    );
    expect(projected).toEqual([
      {
        cwd: "/workspace/wt",
        id: 73,
        isFocused: false,
        lastFocusedAt: 123,
        osWindowId: 1,
        sessionName: "stale presentation",
        tabId: 2,
        title: "stale presentation",
        userVars: { arashi_worktree_id: "arashi-v1-deadbeef" },
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("API_TOKEN");
    expect(JSON.stringify(projected)).not.toContain("must-never-be-retained");
  });

  test.each(["not json", "[{}]", '[{"id":1,"tabs":[{"id":2,"windows":[{"id":"7"}]}]}]'])(
    "rejects malformed or wrong-typed structured state without echoing it: %s",
    (raw) => {
      expect(() => parseKittyState(raw)).toThrow("structured state");
      try {
        parseKittyState(raw);
      } catch (error) {
        expect(String(error)).not.toContain(raw);
      }
    },
  );
});

describe("managed Kitty launch", () => {
  test("reuses one exact marker despite mutable cwd/labels, focuses by numeric id, and revalidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-reuse-"));
    cleanup.push(root);
    const lockRoot = join(root, "locks");
    const worktree = join(root, "wt");
    await mkdir(worktree);
    const target = { ...candidate, worktreePath: worktree };
    const metadata = await deriveKittyWorktreeMetadata(target);
    const commands: string[][] = [];
    let inspections = 0;

    const result = await launchManagedKitty(target, {
      env: { KITTY_PID: "123" },
      lockRoot,
      platform: "linux",
      runProcess: async (command) => {
        commands.push(command);
        if (command[0] === "which") return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
        if (command[1] === "--version") return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
        if (command.at(-1) === "ls") {
          inspections += 1;
          return {
            exitCode: 0,
            stderr: "",
            stdout: state({
              cwd: join(metadata.canonicalPath, "nested-shell-directory"),
              focused: inspections > 1,
              identity: metadata.identity,
            }),
          };
        }
        if (command.includes("focus-window")) return { exitCode: 0, stderr: "", stdout: "" };
        return { exitCode: 99, stderr: "unexpected", stdout: "" };
      },
    });

    expect(result).toEqual({
      command: ["/usr/bin/kitten", "@", "focus-window", "--match", "id:73"],
      mode: "kitty",
    });
    expect(commands.filter((command) => command.includes("launch"))).toEqual([]);
    expect(commands.filter((command) => command.includes("focus-window"))).toEqual([
      ["/usr/bin/kitten", "@", "focus-window", "--match", "id:73"],
    ]);
  });

  test("launches one session-backed tab with adversarial values as distinct argv, focuses it, and validates", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-launch-"));
    cleanup.push(root);
    const worktree = join(root, `feature auth's [review] $HOME; echo nope`);
    await mkdir(worktree);
    const target = { ...candidate, worktreePath: worktree };
    const metadata = await deriveKittyWorktreeMetadata(target);
    const commands: string[][] = [];
    let launched = false;

    const result = await launchManagedKitty(target, {
      env: { TERM: "xterm-kitty" },
      lockRoot: join(root, "locks"),
      platform: "linux",
      runProcess: async (command) => {
        commands.push(command);
        if (command[0] === "which")
          return { exitCode: 0, stderr: "", stdout: "/opt/kitty/bin/kitten\n" };
        if (command[1] === "--version") return { exitCode: 0, stderr: "", stdout: "kitty 0.43.0" };
        if (command.at(-1) === "ls") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: launched
              ? state({
                  cwd: metadata.canonicalPath,
                  focused: true,
                  identity: metadata.identity,
                  session: metadata.sessionName,
                  title: "shell-updated-title",
                })
              : "[]",
          };
        }
        if (command.includes("launch")) {
          launched = true;
          return { exitCode: 0, stderr: "", stdout: "73\n" };
        }
        if (command.includes("focus-window")) return { exitCode: 0, stderr: "", stdout: "" };
        return { exitCode: 99, stderr: "unexpected", stdout: "" };
      },
    });

    const launchCommand = [
      "/opt/kitty/bin/kitten",
      "@",
      "launch",
      "--type=tab",
      "--cwd",
      metadata.canonicalPath,
      "--add-to-session",
      metadata.sessionName,
      "--var",
      `arashi_worktree_id=${metadata.identity}`,
      "--title",
      metadata.title,
    ];
    expect(commands).toContainEqual(launchCommand);
    expect(commands).toContainEqual([
      "/opt/kitty/bin/kitten",
      "@",
      "focus-window",
      "--match",
      "id:73",
    ]);
    expect(result).toEqual({ command: launchCommand, mode: "kitty" });
  });

  test.each([
    ["kitty 0.42.2", "0.43.0"],
    ["unparseable", "version"],
  ])("fails closed for unsupported or malformed version %s", async (version, detail) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-version-"));
    cleanup.push(root);
    const commands: string[][] = [];
    await expect(
      launchManagedKitty(
        { ...candidate, worktreePath: root },
        {
          env: { KITTY_WINDOW_ID: "7" },
          lockRoot: join(root, "locks"),
          platform: "linux",
          runProcess: async (command) => {
            commands.push(command);
            if (command[0] === "which")
              return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
            return { exitCode: 0, stderr: "", stdout: version };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining(detail),
    });
    expect(commands).toHaveLength(2);
  });

  test("fails closed when kitten is missing without trying a generic launcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-missing-"));
    cleanup.push(root);
    const commands: string[][] = [];
    await expect(
      launchManagedKitty(
        { ...candidate, worktreePath: root },
        {
          env: { KITTY_PID: "1" },
          lockRoot: join(root, "locks"),
          pathExists: async () => false,
          platform: "linux",
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: -1, stderr: "ENOENT", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining("kitten"),
    });
    expect(commands).toEqual([["which", "kitten"]]);
  });

  test.each([
    {
      name: "remote control denied",
      result: { exitCode: 1, stderr: "remote control permission denied", stdout: "" },
    },
    { name: "malformed ls", result: { exitCode: 0, stderr: "", stdout: "not json" } },
  ])("fails inspection without fallback when $name", async ({ result }) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-inspect-"));
    cleanup.push(root);
    const commands: string[][] = [];
    await expect(
      launchManagedKitty(
        { ...candidate, worktreePath: root },
        {
          env: { KITTY_PID: "1" },
          lockRoot: join(root, "locks"),
          platform: "linux",
          runProcess: async (command) => {
            commands.push(command);
            if (command[0] === "which")
              return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
            if (command[1] === "--version")
              return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
            return result;
          },
        },
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.LAUNCH_FAILED });
    expect(commands.some((command) => command[0] === "kitty" || command[0] === "open")).toBe(false);
  });

  test.each([
    {
      name: "launch process failure",
      runManagedCommand: (command: string[]) =>
        command.includes("launch")
          ? { exitCode: 17, stderr: "launch denied", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: "[]" },
      expectedPhase: "launch",
    },
    {
      name: "persistent focus failure",
      runManagedCommand: (command: string[], metadata: KittyWorktreeMetadata) =>
        command.at(-1) === "ls"
          ? {
              exitCode: 0,
              stderr: "",
              stdout: state({ cwd: metadata.canonicalPath, identity: metadata.identity }),
            }
          : { exitCode: 19, stderr: "focus denied", stdout: "" },
      expectedPhase: "focus",
    },
  ])("fails closed without fallback for $name", async ({ expectedPhase, runManagedCommand }) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-process-failure-"));
    cleanup.push(root);
    const target = { ...candidate, worktreePath: root };
    const metadata = await deriveKittyWorktreeMetadata(target);
    const commands: string[][] = [];

    await expect(
      launchManagedKitty(target, {
        env: { KITTY_PID: "1" },
        lockRoot: join(root, "locks"),
        platform: "linux",
        runProcess: async (command) => {
          commands.push(command);
          if (command[0] === "which") {
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
          }
          if (command[1] === "--version") {
            return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
          }
          return runManagedCommand(command, metadata);
        },
      }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { phase: expectedPhase },
    });

    expect(commands.some((command) => command[0] === "kitty" || command[0] === "open")).toBe(false);
  });

  test("does not retry a failed focus while the same exact window remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-focus-failure-"));
    cleanup.push(root);
    const target = { ...candidate, worktreePath: root };
    const metadata = await deriveKittyWorktreeMetadata(target);
    let focusAttempts = 0;

    await expect(
      launchManagedKitty(target, {
        env: { KITTY_PID: "1" },
        lockRoot: join(root, "locks"),
        platform: "linux",
        runProcess: async (command) => {
          if (command[0] === "which")
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
          if (command[1] === "--version")
            return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
          if (command.at(-1) === "ls")
            return {
              exitCode: 0,
              stderr: "",
              stdout: state({ cwd: metadata.canonicalPath, identity: metadata.identity }),
            };
          focusAttempts += 1;
          return focusAttempts === 1
            ? { exitCode: 7, stderr: "focus denied", stdout: "" }
            : { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { phase: "focus" },
    });

    expect(focusAttempts).toBe(1);
  });

  test("does not retry a zero-exit focus when the same exact window remains unfocused", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-focus-validation-"));
    cleanup.push(root);
    const target = { ...candidate, worktreePath: root };
    const metadata = await deriveKittyWorktreeMetadata(target);
    let focusAttempts = 0;

    await expect(
      launchManagedKitty(target, {
        env: { KITTY_PID: "1" },
        lockRoot: join(root, "locks"),
        platform: "linux",
        runProcess: async (command) => {
          if (command[0] === "which")
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
          if (command[1] === "--version")
            return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
          if (command.at(-1) === "ls")
            return {
              exitCode: 0,
              stderr: "",
              stdout: state({
                cwd: metadata.canonicalPath,
                focused: false,
                identity: metadata.identity,
              }),
            };
          focusAttempts += 1;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { phase: "focus-validation" },
    });

    expect(focusAttempts).toBe(1);
  });

  test("rejects inconsistent returned launch state", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-inconsistent-"));
    cleanup.push(root);
    const target = { ...candidate, worktreePath: root };
    const metadata = await deriveKittyWorktreeMetadata(target);
    let launched = false;

    await expect(
      launchManagedKitty(target, {
        env: { KITTY_PID: "1" },
        lockRoot: join(root, "locks"),
        platform: "linux",
        runProcess: async (command) => {
          if (command[0] === "which") {
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
          }
          if (command[1] === "--version") {
            return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
          }
          if (command.at(-1) === "ls") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: launched
                ? state({
                    cwd: metadata.canonicalPath,
                    id: 74,
                    identity: metadata.identity,
                    session: metadata.sessionName,
                    title: metadata.title,
                  })
                : "[]",
            };
          }
          if (command.includes("launch")) {
            launched = true;
            return { exitCode: 0, stderr: "", stdout: "73" };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { phase: "launch-state-validation" },
    });
  });

  test("fails duplicate exact state without focus, launch, or close", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-duplicate-"));
    cleanup.push(root);
    const metadata = await deriveKittyWorktreeMetadata({ ...candidate, worktreePath: root });
    const duplicate = JSON.parse(
      state({ cwd: metadata.canonicalPath, identity: metadata.identity }),
    );
    duplicate[0].tabs[0].windows.push({ ...duplicate[0].tabs[0].windows[0], id: 74 });
    const commands: string[][] = [];
    await expect(
      launchManagedKitty(
        { ...candidate, worktreePath: root },
        {
          env: { KITTY_PID: "1" },
          lockRoot: join(root, "locks"),
          platform: "linux",
          runProcess: async (command) => {
            commands.push(command);
            if (command[0] === "which")
              return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
            if (command[1] === "--version")
              return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
            return { exitCode: 0, stderr: "", stdout: JSON.stringify(duplicate) };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining("multiple"),
    });
    expect(
      commands.some(
        (command) =>
          command.includes("focus-window") ||
          command.includes("launch") ||
          command.includes("close-window"),
      ),
    ).toBe(false);
  });

  test("re-inspects once when the sole match closes before focus and launches only when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-race-"));
    cleanup.push(root);
    const metadata = await deriveKittyWorktreeMetadata({ ...candidate, worktreePath: root });
    const commands: string[][] = [];
    let inspections = 0;
    let launched = false;
    await launchManagedKitty(
      { ...candidate, worktreePath: root },
      {
        env: { KITTY_PID: "1" },
        lockRoot: join(root, "locks"),
        platform: "linux",
        runProcess: async (command) => {
          commands.push(command);
          if (command[0] === "which")
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
          if (command[1] === "--version")
            return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
          if (command.at(-1) === "ls") {
            inspections += 1;
            if (inspections === 1)
              return {
                exitCode: 0,
                stderr: "",
                stdout: state({ cwd: metadata.canonicalPath, identity: metadata.identity }),
              };
            if (inspections === 2) return { exitCode: 0, stderr: "", stdout: "[]" };
            return {
              exitCode: 0,
              stderr: "",
              stdout: state({
                cwd: metadata.canonicalPath,
                identity: metadata.identity,
                session: metadata.sessionName,
                title: metadata.title,
              }),
            };
          }
          if (command.includes("focus-window") && !launched)
            return { exitCode: 1, stderr: "no matching windows", stdout: "" };
          if (command.includes("launch")) {
            launched = true;
            return { exitCode: 0, stderr: "", stdout: "73" };
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );
    expect(commands.filter((command) => command.includes("launch"))).toHaveLength(1);
    expect(commands.filter((command) => command.at(-1) === "ls")).toHaveLength(3);
  });

  test("serializes concurrent same-identity launchers so only one tab is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-concurrent-"));
    cleanup.push(root);
    const target = { ...candidate, worktreePath: root };
    const metadata = await deriveKittyWorktreeMetadata(target);
    const lockRoot = join(root, "locks");
    let launched = false;
    let launchCalls = 0;

    const runProcess = async (command: string[]) => {
      if (command[0] === "which") {
        return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
      }
      if (command[1] === "--version") {
        return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
      }
      if (command.at(-1) === "ls") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: launched
            ? state({
                cwd: metadata.canonicalPath,
                focused: true,
                identity: metadata.identity,
                session: metadata.sessionName,
                title: metadata.title,
              })
            : "[]",
        };
      }
      if (command.includes("launch")) {
        launchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        launched = true;
        return { exitCode: 0, stderr: "", stdout: "73" };
      }
      if (command.includes("focus-window")) {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return { exitCode: 99, stderr: "unexpected", stdout: "" };
    };

    const [first, second] = await Promise.all([
      launchManagedKitty(target, {
        env: { KITTY_PID: "1" },
        lockRoot,
        platform: "linux",
        runProcess,
      }),
      launchManagedKitty(target, {
        env: { KITTY_PID: "1" },
        lockRoot,
        platform: "linux",
        runProcess,
      }),
    ]);

    expect(launchCalls).toBe(1);
    expect([first.mode, second.mode]).toEqual(["kitty", "kitty"]);
    expect(
      [first.command, second.command].filter((command) => command.includes("launch")),
    ).toHaveLength(1);
  });

  test("releases the identity lock in finally after a managed launch failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-finally-"));
    cleanup.push(root);
    const target = { ...candidate, worktreePath: root };
    const metadata = await deriveKittyWorktreeMetadata(target);
    const lockRoot = join(root, "locks");

    await expect(
      launchManagedKitty(target, {
        env: { KITTY_PID: "1" },
        lockRoot,
        platform: "linux",
        runProcess: async (command) => {
          if (command[0] === "which") {
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
          }
          if (command[1] === "--version") {
            return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
          }
          return { exitCode: 1, stderr: "permission denied", stdout: "" };
        },
      }),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.LAUNCH_FAILED });

    const recovered = await acquireKittyIdentityLock(metadata.identity, {
      lockRoot,
      pollIntervalMs: 5,
      timeoutMs: 100,
    });
    await recovered.release();
  });

  test.each(["", "window=73", "73 74"])("rejects malformed launch id %j", async (launchOutput) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-launch-id-"));
    cleanup.push(root);
    await expect(
      launchManagedKitty(
        { ...candidate, worktreePath: root },
        {
          env: { KITTY_PID: "1" },
          lockRoot: join(root, "locks"),
          platform: "linux",
          runProcess: async (command) => {
            if (command[0] === "which")
              return { exitCode: 0, stderr: "", stdout: "/usr/bin/kitten\n" };
            if (command[1] === "--version")
              return { exitCode: 0, stderr: "", stdout: "kitty 0.48.1" };
            if (command.at(-1) === "ls") return { exitCode: 0, stderr: "", stdout: "[]" };
            if (command.includes("launch"))
              return { exitCode: 0, stderr: "", stdout: launchOutput };
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining("window ID"),
    });
  });
});

describe("cross-process Kitty identity lock", () => {
  test("reports lock-root setup failures as managed launch errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-lock-setup-"));
    cleanup.push(root);
    const lockRoot = join(root, "not-a-directory");
    await writeFile(lockRoot, "occupied");

    await expect(acquireKittyIdentityLock("identity", { lockRoot })).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { phase: "identity-lock" },
    });
  });

  test("serializes contenders and releases only the owned lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-lock-"));
    cleanup.push(root);
    const first = await acquireKittyIdentityLock("arashi-v1-a", { lockRoot: root });
    let secondAcquired = false;
    const secondPromise = acquireKittyIdentityLock("arashi-v1-a", {
      lockRoot: root,
      pollIntervalMs: 5,
      timeoutMs: 500,
    }).then((lock) => {
      secondAcquired = true;
      return lock;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondAcquired).toBe(false);
    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  });

  test("never steals a live-owner lock solely because it is old and times out boundedly", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-live-lock-"));
    cleanup.push(root);
    const lockPath = join(root, "arashi-v1-live.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        createdAt: 0,
        identity: "arashi-v1-live",
        owner: "other",
        pid: process.pid,
      }),
    );
    await expect(
      acquireKittyIdentityLock("arashi-v1-live", {
        lockRoot: root,
        pollIntervalMs: 5,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining("lock"),
    });
    expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).owner).toBe("other");
  });

  test("does not remove a live owner that replaces stale metadata during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-replaced-lock-"));
    cleanup.push(root);
    const identity = "arashi-v1-replaced";
    const lockPath = join(root, `${identity}.lock`);
    const ownerPath = join(lockPath, "owner.json");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      ownerPath,
      JSON.stringify({ createdAt: 0, identity, owner: "stale", pid: 999_999_999 }),
    );
    let replaced = false;

    await expect(
      acquireKittyIdentityLock(identity, {
        lockRoot: root,
        pidAlive: (pid) => {
          if (!replaced) {
            replaced = true;
            writeFileSync(
              ownerPath,
              JSON.stringify({
                createdAt: Date.now(),
                identity,
                owner: "replacement",
                pid: process.pid,
              }),
            );
          }
          return pid === process.pid;
        },
        pollIntervalMs: 5,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.LAUNCH_FAILED });

    expect(JSON.parse(await readFile(ownerPath, "utf8")).owner).toBe("replacement");
  });

  test("keeps contenders serialized when one starts between owner validation and stale rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-recovery-race-"));
    cleanup.push(root);
    const identity = "arashi-v1-recovery-race";
    const lockPath = join(root, `${identity}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ createdAt: 0, identity, owner: "stale", pid: 999_999_999 }),
    );

    let startContender!: () => void;
    const contenderStarted = new Promise<void>((resolve) => {
      startContender = resolve;
    });
    let contenderPromise!: Promise<KittyIdentityLock>;
    const acquired: string[] = [];
    const recoveryPromise = acquireKittyIdentityLock(identity, {
      beforeStaleLockRename: async () => {
        contenderPromise = acquireKittyIdentityLock(identity, {
          lockRoot: root,
          pollIntervalMs: 5,
          timeoutMs: 500,
        }).then((lock) => {
          acquired.push("contender");
          return lock;
        });
        startContender();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      lockRoot: root,
      pollIntervalMs: 5,
      timeoutMs: 500,
    }).then((lock) => {
      acquired.push("recovery");
      return lock;
    });

    await contenderStarted;
    const first = await Promise.race([recoveryPromise, contenderPromise]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acquired).toHaveLength(1);
    await first.release();
    const second = acquired[0] === "recovery" ? await contenderPromise : await recoveryPromise;
    await second.release();
    expect(acquired.toSorted()).toEqual(["contender", "recovery"]);
  });

  test("does not delete a replacement lock when owner creation loses a stale-recovery race", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-owner-write-race-"));
    cleanup.push(root);
    const identity = "arashi-v1-owner-write-race";
    let ownerWritePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      ownerWritePaused = resolve;
    });
    let resumeOwnerWrite!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeOwnerWrite = resolve;
    });
    let firstAcquired = false;
    const firstPromise = acquireKittyIdentityLock(identity, {
      beforeLockOwnerWrite: async () => {
        ownerWritePaused();
        await resume;
      },
      lockRoot: root,
      pollIntervalMs: 5,
      timeoutMs: 500,
    }).then((lock) => {
      firstAcquired = true;
      return lock;
    });

    await paused;
    const replacement = await acquireKittyIdentityLock(identity, {
      lockRoot: root,
      now: () => Date.now() + 31_000,
      pollIntervalMs: 5,
      timeoutMs: 500,
    });
    resumeOwnerWrite();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstAcquired).toBe(false);
    expect(
      JSON.parse(await readFile(join(replacement.path, "owner.json"), "utf8")).owner,
    ).toBeTypeOf("string");
    await replacement.release();
    const first = await firstPromise;
    await first.release();
  });

  test("does not delete a replacement recovery guard when its owner write loses a race", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-guard-write-race-"));
    cleanup.push(root);
    const identity = "arashi-v1-guard-write-race";
    const lockPath = join(root, `${identity}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ createdAt: 0, identity, owner: "stale", pid: 999_999_999 }),
    );
    let guardWritePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      guardWritePaused = resolve;
    });
    let resumeGuardWrite!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeGuardWrite = resolve;
    });
    let firstAcquired = false;
    const firstPromise = acquireKittyIdentityLock(identity, {
      beforeRecoveryGuardOwnerWrite: async () => {
        guardWritePaused();
        await resume;
      },
      lockRoot: root,
      pollIntervalMs: 5,
      timeoutMs: 500,
    }).then((lock) => {
      firstAcquired = true;
      return lock;
    });

    await paused;
    const replacement = await acquireKittyIdentityLock(identity, {
      lockRoot: root,
      now: () => Date.now() + 31_000,
      pollIntervalMs: 5,
      timeoutMs: 500,
    });
    resumeGuardWrite();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstAcquired).toBe(false);
    expect(
      JSON.parse(await readFile(join(replacement.path, "owner.json"), "utf8")).owner,
    ).toBeTypeOf("string");
    await replacement.release();
    const first = await firstPromise;
    await first.release();
  });

  test("treats non-positive owner PIDs as malformed stale metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-invalid-pid-lock-"));
    cleanup.push(root);
    const identity = "arashi-v1-invalid-pid";
    const lockPath = join(root, `${identity}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ createdAt: Date.now() - 31_000, identity, owner: "invalid", pid: 0 }),
    );
    const old = new Date(Date.now() - 31_000);
    await utimes(lockPath, old, old);

    const recovered = await acquireKittyIdentityLock(identity, {
      lockRoot: root,
      pidAlive: () => true,
      timeoutMs: 100,
    });
    await recovered.release();
  });

  test("recovers dead owner immediately and malformed metadata only after stale age", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-kitty-stale-lock-"));
    cleanup.push(root);
    const deadPath = join(root, "arashi-v1-dead.lock");
    await mkdir(deadPath, { recursive: true });
    await writeFile(
      join(deadPath, "owner.json"),
      JSON.stringify({
        createdAt: Date.now(),
        identity: "arashi-v1-dead",
        owner: "dead",
        pid: 999_999_999,
      }),
    );
    const deadRecovered = await acquireKittyIdentityLock("arashi-v1-dead", {
      lockRoot: root,
      timeoutMs: 100,
    });
    await deadRecovered.release();

    const malformedPath = join(root, "arashi-v1-malformed.lock");
    await mkdir(malformedPath, { recursive: true });
    await writeFile(join(malformedPath, "owner.json"), "not json");
    const old = new Date(Date.now() - 31_000);
    await utimes(malformedPath, old, old);
    const malformedRecovered = await acquireKittyIdentityLock("arashi-v1-malformed", {
      lockRoot: root,
      timeoutMs: 100,
    });
    await malformedRecovered.release();
  });
});
