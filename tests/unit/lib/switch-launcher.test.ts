import { describe, expect, test } from "vitest";
import {
  detectIntegratedIde,
  detectManagedSwitchContext,
  detectTerminalApp,
  isCmuxSession,
  launchSwitchTarget,
} from "../../../src/lib/switch-launcher.ts";
import type { SwitchCandidate } from "../../../src/core/switch.ts";
import { SwitchCommandErrorCode } from "../../../src/types/switch.ts";

type SwitchProcessRunner = NonNullable<
  NonNullable<Parameters<typeof launchSwitchTarget>[2]>["runProcess"]
>;

const candidate: SwitchCandidate = {
  branchName: "feature/auth",
  repoName: "workspace",
  worktreePath: "/workspace/feature-auth",
};

const failingRunProcess: SwitchProcessRunner = async () => ({
  exitCode: 1,
  stderr: "launch failed",
  stdout: "",
});

describe("detectManagedSwitchContext", () => {
  test.each([
    [{ TMUX: " /tmp/tmux/default " }, "tmux"],
    [{ HERDR_ENV: " 1 " }, "herdr"],
    [{ CMUX_WORKSPACE_ID: " workspace:1 " }, "cmux"],
    [{ CMUX_SURFACE_ID: " surface:1 " }, "cmux"],
    [
      {
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/cursor",
      },
      "cursor",
    ],
    [{ TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_EXTRA_ARGS: "--host=kiro" }, "kiro"],
    [{ TERM_PROGRAM: "vscode" }, "vscode"],
    [{ KITTY_PID: " 123 ", KITTY_WINDOW_ID: " 73 " }, "kitty"],
  ] as const)("classifies strict managed evidence %#", (env, expected) => {
    expect(detectManagedSwitchContext(env)).toBe(expected);
  });

  test.each([
    {},
    { HERDR_ENV: "true" },
    { HERDR_ENV: "11" },
    { CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
    { CMUX_SURFACE_ID: "", CMUX_WORKSPACE_ID: " " },
    { TERM_PROGRAM: "ghostty" },
    { TERM_PROGRAM: "Apple_Terminal" },
    { TERM_PROGRAM: "unsupported-ide" },
    { TERM: "xterm-256color" },
    { KITTY_PID: "123" },
    { KITTY_WINDOW_ID: "73" },
    { TERM: "xterm-kitty" },
    { KITTY_PID: "", KITTY_WINDOW_ID: "   ", TERM: "xterm-kitty-extra" },
    { TERM: "not-xterm-kitty" },
  ])("rejects weak or generic evidence %#", (env) => {
    expect(detectManagedSwitchContext(env)).toBeNull();
  });

  test("uses tmux, Herdr, cmux, IDE, then Kitty precedence", () => {
    const allSignals = {
      CMUX_WORKSPACE_ID: "workspace:1",
      HERDR_ENV: "1",
      KITTY_PID: "123",
      KITTY_WINDOW_ID: "73",
      TERM: "xterm-kitty",
      TERM_PROGRAM: "vscode",
      TMUX: "/tmp/tmux/default",
      VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/cursor",
    };
    expect(detectManagedSwitchContext(allSignals)).toBe("tmux");
    expect(detectManagedSwitchContext({ ...allSignals, TMUX: "" })).toBe("herdr");
    expect(detectManagedSwitchContext({ ...allSignals, HERDR_ENV: "0", TMUX: "" })).toBe("cmux");
    const ideWins = {
      ...allSignals,
      CMUX_WORKSPACE_ID: "",
      HERDR_ENV: "0",
      TMUX: "",
    };
    expect(detectManagedSwitchContext(ideWins)).toBe("cursor");
    expect(
      detectManagedSwitchContext({
        ...ideWins,
        TERM_PROGRAM: "",
        VSCODE_GIT_ASKPASS_NODE: "",
      }),
    ).toBe("kitty");
  });
});

describe("launchSwitchTarget", () => {
  test("prioritizes --sesh in tmux over VS Code handling", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "which" && command[1] === "sesh") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/sesh\n" };
      }

      if (command[0] === "tmux") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      { sesh: true },
      {
        env: { TERM_PROGRAM: "vscode", TMUX: "/tmp/tmux-1000/default" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("sesh");
    expect(commands[0]).toEqual(["which", "sesh"]);
    expect(commands[1][0]).toBe("tmux");
    expect(commands.some((command) => command.includes("code"))).toBe(false);
  });

  test("returns actionable error when --sesh is used outside tmux", async () => {
    await expect(
      launchSwitchTarget(candidate, { sesh: true }, { env: {}, platform: "darwin" }),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.SESH_REQUIRES_TMUX,
    });
  });

  test("uses VS Code launcher when in VS Code terminal and code is available", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "which" && command[1] === "code") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/code\n" };
      }

      if (command[0] === "code") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { TERM_PROGRAM: "vscode" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("vscode");
    expect(commands[0]).toEqual(["which", "code"]);
    expect(commands[1]).toEqual(["code", "--new-window", "/workspace/feature-auth"]);
  });

  test("uses cmd.exe for VS Code launcher on Windows", async () => {
    const windowsCandidate: SwitchCandidate = {
      branchName: "feature/auth",
      repoName: "workspace",
      worktreePath: "C:\\workspace\\feature-auth",
    };
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "where" && command[1] === "code") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n",
        };
      }

      if (command[0] === "cmd.exe") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      windowsCandidate,
      {},
      {
        env: { TERM_PROGRAM: "vscode" },
        platform: "win32",
        runProcess,
      },
    );

    expect(result.mode).toBe("vscode");
    expect(commands[0]).toEqual(["where", "code"]);
    expect(commands[1]).toEqual([
      "cmd.exe",
      "/d",
      "/c",
      "code",
      "--new-window",
      String.raw`C:\workspace\feature-auth`,
    ]);
  });

  test("preserves nested Windows worktree segments when launching VS Code", async () => {
    const windowsCandidate: SwitchCandidate = {
      branchName: "test/new",
      repoName: "workspace",
      worktreePath: "C:\\workspace\\.arashi\\worktrees\\workspace-test\\new",
    };
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "where" && command[1] === "code") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n",
        };
      }

      if (command[0] === "cmd.exe") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      windowsCandidate,
      {},
      {
        env: { TERM_PROGRAM: "vscode" },
        platform: "win32",
        runProcess,
      },
    );

    expect(result.mode).toBe("vscode");
    expect(commands[1]).toEqual([
      "cmd.exe",
      "/d",
      "/c",
      "code",
      "--new-window",
      String.raw`C:\workspace\.arashi\worktrees\workspace-test\new`,
    ]);
  });

  test("uses Cursor launcher when explicitly requested", async () => {
    const commands: string[][] = [];
    const envs: Record<string, string | undefined>[] = [];
    const currentEnv = {
      ARASHI_DIRECTIVE_FILE: "/tmp/arashi-directive",
      ARASHI_SHELL: "bash",
      TMUX: "/tmp/tmux-1000/default",
    };
    const runProcess: SwitchProcessRunner = async (command, options) => {
      commands.push(command);
      envs.push(options.env);

      if (command[0] === "which" && command[1] === "cursor") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/cursor\n" };
      }

      if (command[0] === "cursor") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      { preferredIde: "cursor", requirePreferredIde: true },
      {
        env: currentEnv,
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("cursor");
    expect(commands[0]).toEqual(["which", "cursor"]);
    expect(commands[1]).toEqual(["cursor", "--new-window", "/workspace/feature-auth"]);
    expect(envs[1]?.ARASHI_DIRECTIVE_FILE).toBeUndefined();
    expect(envs[1]?.ARASHI_SHELL).toBeUndefined();
  });

  test("returns actionable error when an explicit IDE launcher is unavailable", async () => {
    await expect(
      launchSwitchTarget(
        candidate,
        { preferredIde: "kiro", requirePreferredIde: true },
        {
          env: {},
          platform: "darwin",
          runProcess: async (command) => {
            if (command[0] === "which" && command[1] === "kiro") {
              return { exitCode: 1, stderr: "not found", stdout: "" };
            }

            return { exitCode: 1, stderr: "unexpected", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.IDE_NOT_FOUND,
    });
  });

  test("uses Cursor launcher when detected from the terminal environment", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "which" && command[1] === "cursor") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/cursor\n" };
      }

      if (command[0] === "cursor") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: {
          TERM_PROGRAM: "vscode",
          VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("cursor");
    expect(commands[0]).toEqual(["which", "cursor"]);
    expect(commands[1]).toEqual(["cursor", "--new-window", "/workspace/feature-auth"]);
  });

  test("falls back when an auto-detected IDE launcher is unavailable", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "which" && command[1] === "cursor") {
        return { exitCode: 1, stderr: "not found", stdout: "" };
      }

      if (command[0] === "open") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: {
          TERM_PROGRAM: "vscode",
          VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[1]).toEqual(["open", "-a", "Terminal", "/workspace/feature-auth"]);
  });

  test("rejects when an available auto-detected IDE launcher exits nonzero", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "which" && command[1] === "code") {
        return { exitCode: 0, stderr: "", stdout: "/usr/local/bin/code\n" };
      }

      if (command[0] === "code") {
        return { exitCode: 23, stderr: "editor launch failed", stdout: "" };
      }

      return { exitCode: 0, stderr: "unexpected fallback", stdout: "" };
    };

    await expect(
      launchSwitchTarget(
        candidate,
        {},
        { env: { TERM_PROGRAM: "vscode" }, platform: "darwin", runProcess },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: {
        command: ["code", "--new-window", candidate.worktreePath],
        path: candidate.worktreePath,
        reason: "editor launch failed",
      },
    });
    expect(commands).toEqual([
      ["which", "code"],
      ["code", "--new-window", candidate.worktreePath],
    ]);
  });

  test("falls back to terminal launcher when VS Code CLI is unavailable", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "which" && command[1] === "code") {
        return { exitCode: 1, stderr: "not found", stdout: "" };
      }

      if (command[0] === "open") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { TERM_PROGRAM: "vscode" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[1]).toEqual(["open", "-a", "Terminal", "/workspace/feature-auth"]);
  });

  test("forces plain tmux ahead of Herdr and IDE detection with an argv-safe path", async () => {
    const specialCandidate = {
      ...candidate,
      worktreePath: "/workspace/feature auth's $review",
    };
    const commands: string[][] = [];

    const result = await launchSwitchTarget(
      specialCandidate,
      { tmux: true },
      {
        env: { HERDR_ENV: "1", TERM_PROGRAM: "vscode", TMUX: " /tmp/tmux/default " },
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result).toEqual({
      command: ["tmux", "new-window", "-c", specialCandidate.worktreePath],
      mode: "tmux",
    });
    expect(commands).toEqual([result.command]);
  });

  test.each([undefined, "", "   "])(
    "rejects forced plain tmux without non-empty TMUX context (%s)",
    async (tmuxValue) => {
      const commands: string[][] = [];
      await expect(
        launchSwitchTarget(
          candidate,
          { tmux: true },
          {
            env: { HERDR_ENV: "1", TMUX: tmuxValue },
            platform: "darwin",
            runProcess: async (command) => {
              commands.push(command);
              return { exitCode: 0, stderr: "", stdout: "" };
            },
          },
        ),
      ).rejects.toMatchObject({
        code: SwitchCommandErrorCode.TMUX_CONTEXT_REQUIRED,
        message: expect.stringContaining("--tmux requires an active tmux"),
      });
      expect(commands).toEqual([]);
    },
  );

  test("does not fall back when forced plain tmux execution fails", async () => {
    const commands: string[][] = [];
    await expect(
      launchSwitchTarget(
        candidate,
        { tmux: true },
        {
          env: { HERDR_ENV: "1", TMUX: "/tmp/tmux/default" },
          platform: "darwin",
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: 23, stderr: "tmux failed", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { command: ["tmux", "new-window", "-c", candidate.worktreePath] },
    });
    expect(commands).toEqual([["tmux", "new-window", "-c", candidate.worktreePath]]);
  });

  test("opens a new tmux window automatically when running inside tmux", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "tmux") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { TERM_PROGRAM: "vscode", TMUX: "/tmp/tmux-1000/default" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("tmux");
    expect(commands[0]).toEqual(["tmux", "new-window", "-c", "/workspace/feature-auth"]);
    expect(commands.some((command) => command[0] === "code")).toBe(false);
  });

  test("rejects when auto-selected tmux execution fails without fallback", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);
      return { exitCode: 41, stderr: "tmux server unavailable", stdout: "" };
    };

    await expect(
      launchSwitchTarget(
        candidate,
        {},
        {
          env: { TERM_PROGRAM: "vscode", TMUX: "/tmp/tmux-1000/default" },
          platform: "darwin",
          runProcess,
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: {
        command: ["tmux", "new-window", "-c", candidate.worktreePath],
        path: candidate.worktreePath,
        reason: "tmux server unavailable",
      },
    });
    expect(commands).toEqual([["tmux", "new-window", "-c", candidate.worktreePath]]);
  });

  test("selects managed Kitty before support preflight and never falls back", async () => {
    const commands: string[][] = [];
    await expect(
      launchSwitchTarget(
        { ...candidate, worktreePath: process.cwd() },
        {},
        {
          env: { KITTY_PID: "123", KITTY_WINDOW_ID: "73", TERM: "xterm-kitty" },
          pathExists: async () => false,
          platform: "linux",
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: 1, stderr: "kitten missing", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      message: expect.stringContaining("kitten"),
    });
    expect(commands).toEqual([["which", "kitten"]]);
  });

  test("continues from an unavailable integrated IDE to managed Kitty", async () => {
    const commands: string[][] = [];

    await expect(
      launchSwitchTarget(
        { ...candidate, worktreePath: process.cwd() },
        {},
        {
          env: { KITTY_PID: "123", KITTY_WINDOW_ID: "73", TERM_PROGRAM: "vscode" },
          pathExists: async () => false,
          platform: "linux",
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: 1, stderr: "missing", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.LAUNCH_FAILED });

    expect(commands).toEqual([
      ["which", "code"],
      ["which", "kitten"],
    ]);
  });

  test("uses ghostty launch command when running in ghostty", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "ghostty") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { TERM_PROGRAM: "ghostty" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[0]).toEqual(["ghostty", "--working-directory", "/workspace/feature-auth"]);
  });

  test("uses wezterm launch commands when running in wezterm", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "wezterm") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { TERM_PROGRAM: "WezTerm" },
        platform: "linux",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[0]).toEqual(["wezterm", "cli", "spawn", "--cwd", "/workspace/feature-auth"]);
  });

  test("uses iTerm launch command when running in iTerm2", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "open" && command[3] === "/workspace/feature-auth") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { TERM_PROGRAM: "iTerm.app" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[0]).toEqual(["open", "-a", "iTerm", "/workspace/feature-auth"]);
  });

  test("launches a cmux workspace with an argv-safe exact worktree path", async () => {
    const specialCandidate: SwitchCandidate = {
      ...candidate,
      worktreePath: "/workspace/feature auth's $review",
    };
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);
      return {
        exitCode: 0,
        stderr: "",
        stdout: '{"workspace_ref":"workspace:7"}\n',
      };
    };

    const result = await launchSwitchTarget(
      specialCandidate,
      {},
      {
        env: {
          CMUX_SURFACE_ID: "surface:2",
          CMUX_WORKSPACE_ID: "workspace:1",
          TERM_PROGRAM: "ghostty",
        },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("cmux");
    expect(result.command).toEqual([
      "cmux",
      "workspace",
      "create",
      "--cwd",
      "/workspace/feature auth's $review",
      "--focus",
      "true",
      "--json",
    ]);
    expect(commands).toEqual([result.command]);
  });

  test("accepts cmux workspace UUID output", async () => {
    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { CMUX_WORKSPACE_ID: "workspace:1", TERM_PROGRAM: "ghostty" },
        platform: "darwin",
        runProcess: async () => ({
          exitCode: 0,
          stderr: "",
          stdout: '{"workspace_id":"9836651E-71D1-4558-B5A8-E108D95CC92B"}',
        }),
      },
    );

    expect(result.mode).toBe("cmux");
  });

  test("does not treat a cmux socket path alone as an active cmux terminal", async () => {
    const commands: string[][] = [];
    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock", TERM_PROGRAM: "ghostty" },
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[0]).toEqual(["ghostty", "--working-directory", candidate.worktreePath]);
  });

  test("preserves nested tmux precedence inside cmux", async () => {
    const commands: string[][] = [];
    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: {
          CMUX_WORKSPACE_ID: "workspace:1",
          TERM_PROGRAM: "ghostty",
          TMUX: "/tmp/tmux-1000/default",
        },
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result.mode).toBe("tmux");
    expect(commands).toEqual([["tmux", "new-window", "-c", candidate.worktreePath]]);
  });

  test("preserves explicit IDE precedence inside cmux", async () => {
    const commands: string[][] = [];
    const result = await launchSwitchTarget(
      candidate,
      { preferredIde: "vscode", requirePreferredIde: true },
      {
        env: { CMUX_WORKSPACE_ID: "workspace:1", TERM_PROGRAM: "ghostty" },
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result.mode).toBe("vscode");
    expect(commands).toEqual([
      ["which", "code"],
      ["code", "--new-window", candidate.worktreePath],
    ]);
  });

  test.each([
    {
      name: "cannot execute the cmux CLI",
      result: { exitCode: -1, stderr: "spawn cmux ENOENT", stdout: "" },
    },
    {
      name: "cmux socket access fails",
      result: { exitCode: 1, stderr: "socket access denied", stdout: "" },
    },
    {
      name: "cmux returns malformed JSON",
      result: { exitCode: 0, stderr: "", stdout: "OK workspace:2" },
    },
    {
      name: "cmux omits the workspace identifier",
      result: { exitCode: 0, stderr: "", stdout: '{"ok":true}' },
    },
  ])("fails without Ghostty fallback when $name", async ({ result }) => {
    const commands: string[][] = [];

    await expect(
      launchSwitchTarget(
        candidate,
        {},
        {
          env: { CMUX_WORKSPACE_ID: "workspace:1", TERM_PROGRAM: "ghostty" },
          platform: "darwin",
          runProcess: async (command) => {
            commands.push(command);
            return result;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: {
        command: [
          "cmux",
          "workspace",
          "create",
          "--cwd",
          candidate.worktreePath,
          "--focus",
          "true",
          "--json",
        ],
        path: candidate.worktreePath,
      },
      message: expect.stringContaining("cmux v0.64.18 or newer"),
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.[0]).toBe("cmux");
  });

  test("throws launch failure when all fallback commands fail", async () => {
    await expect(
      launchSwitchTarget(
        candidate,
        {},
        { env: {}, platform: "linux", runProcess: failingRunProcess },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
    });
  });
});

describe("isCmuxSession", () => {
  test("detects a cmux workspace identifier", () => {
    expect(isCmuxSession({ CMUX_WORKSPACE_ID: "workspace:1" })).toBe(true);
  });

  test("detects a cmux surface identifier", () => {
    expect(isCmuxSession({ CMUX_SURFACE_ID: "surface:1" })).toBe(true);
  });

  test("rejects empty cmux identifiers", () => {
    expect(isCmuxSession({ CMUX_SURFACE_ID: " ", CMUX_WORKSPACE_ID: "" })).toBe(false);
  });

  test("rejects socket path without managed-terminal identifiers", () => {
    expect(isCmuxSession({ CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toBe(false);
  });
});

describe("detectTerminalApp", () => {
  test("detects kitty context", () => {
    expect(detectTerminalApp({ TERM: "xterm-kitty" })).toBe("kitty");
  });

  test("detects ghostty context", () => {
    expect(detectTerminalApp({ TERM_PROGRAM: "ghostty" })).toBe("ghostty");
  });

  test("detects wezterm context", () => {
    expect(detectTerminalApp({ TERM_PROGRAM: "WezTerm" })).toBe("wezterm");
  });

  test("detects iTerm2 context", () => {
    expect(detectTerminalApp({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
  });

  test("returns null for unknown terminal apps", () => {
    expect(detectTerminalApp({ TERM_PROGRAM: "Apple_Terminal" })).toBeNull();
  });
});

describe("detectIntegratedIde", () => {
  test("detects Cursor from VS Code environment hints", () => {
    expect(
      detectIntegratedIde({
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_NODE: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      }),
    ).toBe("cursor");
  });

  test("detects Kiro from VS Code environment hints", () => {
    expect(
      detectIntegratedIde({
        TERM_PROGRAM: "vscode",
        VSCODE_GIT_ASKPASS_EXTRA_ARGS: "--host=kiro",
      }),
    ).toBe("kiro");
  });

  test("falls back to VS Code detection when no fork-specific hint exists", () => {
    expect(detectIntegratedIde({ TERM_PROGRAM: "vscode" })).toBe("vscode");
  });
});
