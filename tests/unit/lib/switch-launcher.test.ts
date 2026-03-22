import { describe, expect, test } from "bun:test";
import { detectTerminalApp, launchSwitchTarget } from "../../../src/lib/switch-launcher.ts";
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

  test("uses kitty tab launch commands when running in kitty", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (command[0] === "kitty" && command[2] === "launch") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      {},
      {
        env: { KITTY_PID: "123", TERM: "xterm-kitty" },
        platform: "linux",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[0]).toEqual([
      "kitty",
      "@",
      "launch",
      "--type=tab",
      "--cwd",
      "/workspace/feature-auth",
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
