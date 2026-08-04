import { describe, expect, test } from "vitest";
import {
  detectIntegratedIde,
  detectManagedSwitchContext,
  detectTerminalApp,
  isCmuxSession,
  isKittySession,
  launchSwitchTarget,
  preflightLaunchSwitchTarget,
  resolveLaunchPlan,
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
const successfulRunProcess: SwitchProcessRunner = async () => ({
  exitCode: 0,
  stderr: "",
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

describe("launch disposition matrix", () => {
  const launch = async (
    disposition: "window" | "tab",
    env: Record<string, string | undefined>,
    platform: NodeJS.Platform,
    runProcess: SwitchProcessRunner = successfulRunProcess,
  ) => launchSwitchTarget(candidate, { disposition }, { env, platform, runProcess });

  test("exposes a pure support plan and reports the resolved disposition", async () => {
    expect(resolveLaunchPlan("tmux", "tab", {}, "linux")).toEqual({
      disposition: "tab",
      launcher: "tmux",
      supported: true,
    });
    await expect(launch("window", { TMUX: "/tmp/tmux" }, "linux")).resolves.toMatchObject({
      disposition: "window",
      mode: "tmux",
    });
  });

  test.each([
    [{ KITTY_PID: " 1 " }, true],
    [{ KITTY_WINDOW_ID: " 2 " }, true],
    [{ TERM: " XTERM-KITTY " }, true],
    [{ KITTY_PID: " ", KITTY_WINDOW_ID: "", TERM: "xterm-kitty-extra" }, false],
  ] as const)("uses canonical one-of managed Kitty evidence %#", (env, expected) => {
    expect(isKittySession(env)).toBe(expected);
  });

  test.each([
    [{ TMUX: "/tmp/tmux", TERM_PROGRAM: "ghostty" }, ["tmux", "new-window"]],
    [{ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "ws-7", TERM_PROGRAM: "ghostty" }, ["herdr", "tab"]],
    [{ CMUX_WORKSPACE_ID: "ws-1", TERM_PROGRAM: "ghostty" }, ["cmux", "workspace"]],
  ] as const)("keeps managed context ahead of containing Ghostty %#", async (env, prefix) => {
    const commands: string[][] = [];
    await launchSwitchTarget(
      candidate,
      { disposition: "tab" },
      {
        env,
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          if (command[0] === "herdr")
            return {
              exitCode: 0,
              stderr: "",
              stdout: '{"result":{"tab":{"tab_id":"t1","root_pane_id":"p1"}}}',
            };
          if (command[0] === "cmux")
            return { exitCode: 0, stderr: "", stdout: '{"workspace_ref":"workspace:7"}' };
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );
    expect(commands[0]?.slice(0, 2)).toEqual(prefix);
    expect(commands.some((command) => command[0] === "osascript" || command[0] === "ghostty")).toBe(
      false,
    );
  });

  test("maps Windows Terminal exactly and never falls back after tab failure", async () => {
    const path = String.raw`C:\\work trees\\x & 'y`;
    const target = { ...candidate, worktreePath: path };
    const env = { WT_SESSION: "session", WT_PROFILE_ID: " {profile} " };
    await expect(
      launchSwitchTarget(
        target,
        { disposition: "window" },
        { env, platform: "win32", runProcess: successfulRunProcess },
      ),
    ).resolves.toMatchObject({
      command: ["wt.exe", "-w", "new", "new-tab", "-p", "{profile}", "-d", path],
      disposition: "window",
    });
    const commands: string[][] = [];
    await expect(
      launchSwitchTarget(
        target,
        { disposition: "tab" },
        {
          env,
          platform: "win32",
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: 9, stderr: "denied", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.LAUNCH_FAILED });
    expect(commands).toEqual([["wt.exe", "-w", "0", "new-tab", "-p", "{profile}", "-d", path]]);
  });

  test.each([
    ["standalone Git Bash", { MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" }, "win32"],
    ["generic Linux", {}, "linux"],
    ["generic macOS", {}, "darwin"],
    ["unmanaged Kitty", { TERM_PROGRAM: "kitty" }, "linux"],
    ["Linux Ghostty", { TERM_PROGRAM: "ghostty" }, "linux"],
  ] as const)(
    "rejects unsupported tab for %s before process execution",
    async (_name, env, platform) => {
      const commands: string[][] = [];
      await expect(
        launch("tab", env, platform, async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        }),
      ).rejects.toMatchObject({ code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED });
      expect(commands).toEqual([]);
    },
  );

  test("uses disposition-specific WezTerm argv and requires an exact pane", async () => {
    await expect(launch("window", { TERM_PROGRAM: "WezTerm" }, "linux")).resolves.toMatchObject({
      command: ["wezterm", "cli", "spawn", "--new-window", "--cwd", candidate.worktreePath],
    });
    await expect(
      launch("tab", { TERM_PROGRAM: "WezTerm", WEZTERM_PANE: " 41 " }, "linux"),
    ).resolves.toMatchObject({
      command: ["wezterm", "cli", "spawn", "--pane-id", "41", "--cwd", candidate.worktreePath],
    });
    await expect(launch("tab", { TERM_PROGRAM: "WezTerm" }, "linux")).rejects.toMatchObject({
      code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED,
    });
  });

  test("falls back from WezTerm CLI window spawn to an explicitly independent process window", async () => {
    const commands: string[][] = [];
    await expect(
      launch("window", { TERM_PROGRAM: "WezTerm" }, "linux", async (command) => {
        commands.push(command);
        return command[1] === "start"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : { exitCode: 1, stderr: "no mux server", stdout: "" };
      }),
    ).resolves.toMatchObject({
      command: ["wezterm", "start", "--always-new-process", "--cwd", candidate.worktreePath],
    });
    expect(commands).toEqual([
      ["wezterm", "cli", "spawn", "--new-window", "--cwd", candidate.worktreePath],
      ["wezterm", "start", "--always-new-process", "--cwd", candidate.worktreePath],
    ]);
  });

  test("uses a new Kitty OS window only for unmanaged window disposition", async () => {
    await expect(launch("window", { TERM_PROGRAM: "kitty" }, "linux")).resolves.toMatchObject({
      command: ["kitty", "--detach", "--directory", candidate.worktreePath],
      disposition: "window",
    });
    await expect(launch("window", { TERM_PROGRAM: "kitty" }, "darwin")).resolves.toMatchObject({
      command: ["open", "-na", "kitty.app", "--args", "--directory", candidate.worktreePath],
      disposition: "window",
    });
  });

  test("never probes or remote-controls unrelated Kitty instances in unmanaged mode", async () => {
    const commands: string[][] = [];
    await launch("window", { TERM_PROGRAM: "kitty" }, "linux", async (command) => {
      commands.push(command);
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    expect(commands).toEqual([["kitty", "--detach", "--directory", candidate.worktreePath]]);
    expect(commands.flat()).not.toContain("@");
    expect(commands.flat()).not.toContain("--wait-for-single-instance-window-close");
  });

  test("treats tmux, sesh, and cmux primitives as both dispositions", async () => {
    await expect(launch("tab", { TMUX: "/tmp/tmux" }, "linux")).resolves.toMatchObject({
      disposition: "tab",
      mode: "tmux",
    });
    await expect(
      launchSwitchTarget(
        candidate,
        { disposition: "tab", sesh: true },
        { env: { TMUX: "/tmp/tmux" }, platform: "linux", runProcess: successfulRunProcess },
      ),
    ).resolves.toMatchObject({ disposition: "tab", mode: "sesh" });
    await expect(
      launch("tab", { CMUX_WORKSPACE_ID: "ws" }, "darwin", async () => ({
        exitCode: 0,
        stderr: "",
        stdout: '{"workspace_id":"new"}',
      })),
    ).resolves.toMatchObject({ disposition: "tab", mode: "cmux" });
  });

  test("creates and validates a Herdr tab without resolving a source checkout", async () => {
    let resolved = false;
    const commands: string[][] = [];
    const result = await launchSwitchTarget(
      candidate,
      { disposition: "tab", herdr: true },
      {
        env: { HERDR_WORKSPACE_ID: " workspace-9 " },
        platform: "darwin",
        resolveGitMainWorktree: async () => {
          resolved = true;
          return null;
        },
        runProcess: async (command) => {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: '{"result":{"tab":{"tab_id":"tab-1","root_pane_id":"pane-1"}}}',
          };
        },
      },
    );
    expect(resolved).toBe(false);
    expect(result).toEqual({
      command: [
        "herdr",
        "tab",
        "create",
        "--workspace",
        "workspace-9",
        "--cwd",
        candidate.worktreePath,
        "--label",
        "workspace: feature/auth",
        "--focus",
        "--json",
      ],
      disposition: "tab",
      mode: "herdr",
    });
    expect(commands).toEqual([result.command]);
  });

  test("rejects missing/invalid Herdr tab targets without fallback", async () => {
    await expect(
      launchSwitchTarget(
        candidate,
        { disposition: "tab", herdr: true },
        { env: {}, platform: "darwin", runProcess: successfulRunProcess },
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED });
    const commands: string[][] = [];
    await expect(
      launchSwitchTarget(
        candidate,
        { disposition: "tab", herdr: true },
        {
          env: { HERDR_WORKSPACE_ID: "ws" },
          platform: "darwin",
          runProcess: async (command) => {
            commands.push(command);
            return {
              exitCode: 0,
              stderr: "",
              stdout: '{"result":{"tab":{"tab_id":"","root_pane_id":"p"}}}',
            };
          },
        },
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.LAUNCH_FAILED });
    expect(commands).toHaveLength(1);
  });

  test("rejects an available IDE tab but lets an unavailable auto IDE reach fallback capability", async () => {
    const availableCalls: string[][] = [];
    await expect(
      launch("tab", { TERM_PROGRAM: "vscode" }, "darwin", async (command) => {
        availableCalls.push(command);
        return { exitCode: 0, stderr: "", stdout: "/bin/code" };
      }),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED });
    expect(availableCalls).toEqual([["which", "code"]]);
    const unavailableCalls: string[][] = [];
    await expect(
      launch("tab", { TERM_PROGRAM: "vscode" }, "darwin", async (command) => {
        unavailableCalls.push(command);
        return { exitCode: 1, stderr: "missing", stdout: "" };
      }),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED });
    expect(unavailableCalls).toEqual([["which", "code"]]);
  });

  test.each(["vscode", "cursor", "kiro"] as const)(
    "rejects explicitly selected %s tabs before checking CLI availability",
    async (ide) => {
      const commands: string[][] = [];
      await expect(
        launchSwitchTarget(
          candidate,
          { disposition: "tab", preferredIde: ide, requirePreferredIde: true },
          {
            env: {},
            platform: "darwin",
            runProcess: async (command) => {
              commands.push(command);
              return { exitCode: 1, stderr: "not installed", stdout: "" };
            },
          },
        ),
      ).rejects.toMatchObject({ code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED });
      expect(commands).toEqual([]);
    },
  );

  test("preflights auto IDE availability with execution-equivalent detection before resolving fallback", async () => {
    const availableCalls: string[][] = [];
    await expect(
      preflightLaunchSwitchTarget(
        { disposition: "tab" },
        {
          env: { TERM_PROGRAM: "vscode" },
          platform: "darwin",
          runProcess: async (command) => {
            availableCalls.push(command);
            return { exitCode: 0, stderr: "", stdout: "/usr/bin/code\n" };
          },
        },
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED });
    expect(availableCalls).toEqual([["which", "code"]]);

    const unavailableCalls: string[][] = [];
    await expect(
      preflightLaunchSwitchTarget(
        { disposition: "tab" },
        {
          env: { TERM_PROGRAM: "vscode", WT_SESSION: "session" },
          platform: "win32",
          runProcess: async (command) => {
            unavailableCalls.push(command);
            return { exitCode: 1, stderr: "not installed", stdout: "" };
          },
        },
      ),
    ).resolves.toMatchObject({ launcher: "windows-terminal", supported: true });
    expect(unavailableCalls).toEqual([["where", "code"]]);
  });

  test.each([undefined, "", "   "])(
    "preflight rejects sesh with trimmed TMUX context %s without probing executables",
    async (tmuxValue) => {
      const commands: string[][] = [];
      await expect(
        preflightLaunchSwitchTarget(
          { disposition: "window", sesh: true },
          {
            env: { TMUX: tmuxValue },
            platform: "linux",
            runProcess: async (command) => {
              commands.push(command);
              return successfulRunProcess(command, { cwd: candidate.worktreePath, env: {} });
            },
          },
        ),
      ).rejects.toMatchObject({ code: SwitchCommandErrorCode.SESH_REQUIRES_TMUX });
      expect(commands).toEqual([]);
    },
  );

  test("preflight rejects sesh when its executable is unavailable", async () => {
    const commands: string[][] = [];
    await expect(
      preflightLaunchSwitchTarget(
        { disposition: "window", sesh: true },
        {
          env: { TMUX: " /tmp/tmux " },
          platform: "linux",
          runProcess: async (command) => {
            commands.push(command);
            return { exitCode: 1, stderr: "missing", stdout: "" };
          },
        },
      ),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.SESH_NOT_FOUND });
    expect(commands).toEqual([["which", "sesh"]]);
  });

  test("uses static AppleScript source and passes adversarial cwd and shell only as data", async () => {
    const special = { ...candidate, worktreePath: `/tmp/a' & do shell script "pwn"` };
    for (const env of [
      { TERM_PROGRAM: "Apple_Terminal", SHELL: `/bin/zsh' & pwn` },
      { TERM_PROGRAM: "iTerm.app", SHELL: `/bin/zsh' & pwn` },
      { TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.3.0", SHELL: `/bin/zsh' & pwn` },
    ]) {
      const commands: string[][] = [];
      const result = await launchSwitchTarget(
        special,
        { disposition: "tab" },
        {
          env,
          platform: "darwin",
          runProcess: async (command) => {
            commands.push(command);
            return commands.length === 1
              ? {
                  exitCode: 0,
                  stderr: "",
                  stdout: JSON.stringify({ profile: "Exact", target: "17", version: "3.5.0" }),
                }
              : successfulRunProcess(command, { cwd: special.worktreePath, env });
          },
        },
      );
      expect(result.command.slice(0, 2)).toEqual(["osascript", "-e"]);
      expect(result.command[2]).not.toContain(special.worktreePath);
      expect(result.command[2]).not.toContain(env.SHELL);
      expect(result.command.slice(-5)).toEqual([
        special.worktreePath,
        env.SHELL,
        "17",
        "Exact",
        "3.5.0",
      ]);
      expect(commands).toHaveLength(2);
      expect(result.disposition).toBe("tab");
    }
  });

  test.each([
    ["Apple_Terminal", undefined, "terminal"],
    ["iTerm.app", "3.5.0", "iterm2"],
    ["ghostty", "1.3.0", "ghostty"],
  ] as const)(
    "performs read-only %s target preflight and launches the exact returned target",
    async (termProgram, version, launcher) => {
      const special = { ...candidate, worktreePath: `/tmp/preflight ' & unsafe` };
      const commands: string[][] = [];
      const result = await launchSwitchTarget(
        special,
        { disposition: "tab" },
        {
          env: {
            SHELL: `/bin/zsh' & unsafe`,
            TERM_PROGRAM: termProgram,
            ...(version ? { TERM_PROGRAM_VERSION: version } : {}),
          },
          platform: "darwin",
          runProcess: async (command) => {
            commands.push(command);
            if (commands.length === 1) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  profile: "Exact Profile",
                  target: "window-17",
                  version: version ?? "2.14",
                }),
              };
            }
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      );
      expect(commands).toHaveLength(2);
      expect(commands[0]?.slice(0, 2)).toEqual(["osascript", "-e"]);
      expect(commands[0]?.[2]).not.toContain(special.worktreePath);
      expect(commands[1]?.slice(0, 2)).toEqual(["osascript", "-e"]);
      const launchScript = commands[1]?.[2] ?? "";
      if (launcher !== "terminal") {
        expect(launchScript).not.toContain("first window whose id as text is targetIdentifier");
        expect(launchScript).toContain("repeat with candidateWindow in windows");
        expect(launchScript).toContain(
          "if (id of candidateWindow as text) is targetIdentifier then",
        );
        expect(launchScript).toContain(
          'if targetWindow is missing value then error "ARASHI_TAB_TARGET_UNAVAILABLE" number 42',
        );
      }
      expect(commands[1]?.slice(-5)).toEqual([
        special.worktreePath,
        `/bin/zsh' & unsafe`,
        "window-17",
        "Exact Profile",
        version ?? "2.14",
      ]);
      expect(result).toMatchObject({ disposition: "tab" });
      expect(JSON.stringify(commands)).toContain(
        launcher === "terminal" ? "Terminal" : launcher === "iterm2" ? "iTerm2" : "Ghostty",
      );
    },
  );

  test("uses authoritative Ghostty preflight version when the environment hint is absent", async () => {
    const commands: string[][] = [];
    const result = await preflightLaunchSwitchTarget(
      { disposition: "tab" },
      {
        env: { GHOSTTY_BIN_DIR: "/Applications/Ghostty.app/Contents/MacOS" },
        platform: "darwin",
        runProcess: async (command) => {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({ profile: "Default", target: "window-7", version: "1.3.0" }),
          };
        },
      },
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 2)).toEqual(["osascript", "-e"]);
    expect(result).toMatchObject({
      supported: true,
      macTarget: { target: "window-7", version: "1.3.0" },
    });
  });

  test.each([
    ["Apple_Terminal", "terminal"],
    ["iTerm.app", "iterm2"],
  ] as const)(
    "launches a default %s window without tab-only target evidence",
    async (termProgram, launcher) => {
      const commands: string[][] = [];
      const result = await launch(
        "window",
        { SHELL: "/bin/fish", TERM_PROGRAM: termProgram },
        "darwin",
        async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      );

      expect(commands).toHaveLength(1);
      expect(commands[0]?.slice(0, 2)).toEqual(["osascript", "-e"]);
      expect(commands[0]?.slice(-5)).toEqual([candidate.worktreePath, "/bin/fish", "", "", ""]);
      expect(JSON.stringify(commands[0])).toContain(
        launcher === "terminal" ? "Terminal" : "iTerm2",
      );
      expect(result).toMatchObject({ disposition: "window" });
    },
  );

  test("falls back after macOS window AppleScript failures", async () => {
    const cases = [
      [{ TERM_PROGRAM: "Apple_Terminal" }, ["open", "-a", "Terminal", candidate.worktreePath]],
      [{ TERM_PROGRAM: "iTerm.app" }, ["open", "-a", "iTerm", candidate.worktreePath]],
      [
        { TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.3.0" },
        [
          "open",
          "-na",
          "Ghostty.app",
          "--args",
          "--working-directory",
          candidate.worktreePath,
          "-e",
          "/bin/zsh",
        ],
      ],
    ] as const;
    for (const [env, fallback] of cases) {
      const commands: string[][] = [];
      const result = await launch("window", env, "darwin", async (command) => {
        commands.push(command);
        return command[0] === "osascript"
          ? { exitCode: 1, stderr: "Not authorized", stdout: "" }
          : { exitCode: 0, stderr: "", stdout: "" };
      });
      expect(commands).toHaveLength(2);
      expect(commands[0]?.slice(0, 2)).toEqual(["osascript", "-e"]);
      expect(commands[1]).toEqual(fallback);
      expect(result.command).toEqual(fallback);
    }
  });

  test("maps macOS Ghostty windows by version without exact target preflight", async () => {
    const modernCommands: string[][] = [];
    await expect(
      launch(
        "window",
        { SHELL: "/bin/fish", TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.3.0" },
        "darwin",
        async (command) => {
          modernCommands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      ),
    ).resolves.toMatchObject({
      command: expect.arrayContaining([candidate.worktreePath, "/bin/fish"]),
    });
    expect(modernCommands).toHaveLength(1);
    expect(modernCommands[0]?.slice(0, 2)).toEqual(["osascript", "-e"]);

    const legacyCommands: string[][] = [];
    await expect(
      launch(
        "window",
        { SHELL: "/bin/fish", TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.9" },
        "darwin",
        async (command) => {
          legacyCommands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      ),
    ).resolves.toMatchObject({
      command: [
        "open",
        "-na",
        "Ghostty.app",
        "--args",
        "--working-directory",
        candidate.worktreePath,
        "-e",
        "/bin/fish",
      ],
    });
    expect(legacyCommands).toHaveLength(1);
  });

  test("maps macOS missing targets and automation failures without fallback", async () => {
    for (const processResult of [
      { exitCode: 42, stderr: "ARASHI_TAB_TARGET_UNAVAILABLE", stdout: "" },
      { exitCode: 1, stderr: "Not authorized", stdout: "" },
    ]) {
      const commands: string[][] = [];
      await expect(
        launch(
          "tab",
          { TERM_PROGRAM: "Apple_Terminal", SHELL: "/bin/zsh" },
          "darwin",
          async (command) => {
            commands.push(command);
            return processResult;
          },
        ),
      ).rejects.toMatchObject({
        code:
          processResult.exitCode === 42
            ? SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED
            : SwitchCommandErrorCode.LAUNCH_FAILED,
      });
      expect(commands).toHaveLength(1);
    }
  });

  test("uses Linux Ghostty +new-window and rejects old macOS Ghostty tabs", async () => {
    await expect(
      launch("window", { SHELL: "/bin/fish", TERM_PROGRAM: "ghostty" }, "linux"),
    ).resolves.toMatchObject({
      command: [
        "ghostty",
        "+new-window",
        "--working-directory",
        candidate.worktreePath,
        "-e",
        "/bin/fish",
      ],
    });
    await expect(
      launch("tab", { TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.2.9" }, "darwin"),
    ).rejects.toMatchObject({ code: SwitchCommandErrorCode.TAB_DISPOSITION_UNSUPPORTED });
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
      { disposition: "window", sesh: true },
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
      launchSwitchTarget(
        candidate,
        { disposition: "window", sesh: true },
        { env: {}, platform: "darwin" },
      ),
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
      { disposition: "window" },
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
      { disposition: "window" },
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
      { disposition: "window" },
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
      { disposition: "window", preferredIde: "cursor", requirePreferredIde: true },
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
        { disposition: "window", preferredIde: "kiro", requirePreferredIde: true },
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
      { disposition: "window" },
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
      { disposition: "window" },
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
        { disposition: "window" },
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
      { disposition: "window" },
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
      { disposition: "window", tmux: true },
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
      disposition: "window",
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
          { disposition: "window", tmux: true },
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
        { disposition: "window", tmux: true },
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
      { disposition: "window" },
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
        { disposition: "window" },
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
        { disposition: "window" },
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
        { disposition: "window" },
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
      return { exitCode: 0, stderr: "", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      { disposition: "window" },
      {
        env: { TERM_PROGRAM: "ghostty" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands).toEqual([
      [
        "open",
        "-na",
        "Ghostty.app",
        "--args",
        "--working-directory",
        candidate.worktreePath,
        "-e",
        "/bin/zsh",
      ],
    ]);
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
      { disposition: "window" },
      {
        env: { TERM_PROGRAM: "WezTerm" },
        platform: "linux",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands[0]).toEqual([
      "wezterm",
      "cli",
      "spawn",
      "--new-window",
      "--cwd",
      "/workspace/feature-auth",
    ]);
  });

  test("uses iTerm launch command when running in iTerm2", async () => {
    const commands: string[][] = [];
    const runProcess: SwitchProcessRunner = async (command) => {
      commands.push(command);

      if (commands.length === 1 && command[0] === "osascript") {
        return { exitCode: 0, stderr: "", stdout: "3.5.0\n17\nDefault" };
      }
      if (command[0] === "osascript") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }

      return { exitCode: 1, stderr: "unexpected", stdout: "" };
    };

    const result = await launchSwitchTarget(
      candidate,
      { disposition: "window" },
      {
        env: { TERM_PROGRAM: "iTerm.app" },
        platform: "darwin",
        runProcess,
      },
    );

    expect(result.mode).toBe("fallback");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(-5)).toEqual(["/workspace/feature-auth", "/bin/zsh", "", "", ""]);
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
      { disposition: "window" },
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
      { disposition: "window" },
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
      { disposition: "window" },
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
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 4)).toEqual(["open", "-na", "Ghostty.app", "--args"]);
  });

  test("preserves nested tmux precedence inside cmux", async () => {
    const commands: string[][] = [];
    const result = await launchSwitchTarget(
      candidate,
      { disposition: "window" },
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
      { disposition: "window", preferredIde: "vscode", requirePreferredIde: true },
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
        { disposition: "window" },
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

  test("opens a new window with the current profile inside Windows Terminal", async () => {
    const windowsCandidate: SwitchCandidate = {
      ...candidate,
      worktreePath: String.raw`C:\workspace\feature auth's`,
    };
    const commands: string[][] = [];

    const result = await launchSwitchTarget(
      windowsCandidate,
      { disposition: "window" },
      {
        env: {
          MSYSTEM: "MINGW64",
          SHELL: "/usr/bin/bash",
          WT_PROFILE_ID: "{00000000-0000-0000-0000-000000000001}",
          WT_SESSION: "00000000-0000-0000-0000-000000000002",
        },
        platform: "win32",
        runProcess: async (command) => {
          commands.push(command);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result).toEqual({
      command: [
        "wt.exe",
        "-w",
        "new",
        "new-tab",
        "-p",
        "{00000000-0000-0000-0000-000000000001}",
        "-d",
        windowsCandidate.worktreePath,
      ],
      disposition: "window",
      mode: "fallback",
    });
    expect(commands).toEqual([result.command]);
  });

  test("uses the configured Git Bash launcher so MinTTY or ConHost is preserved", async () => {
    const windowsCandidate: SwitchCandidate = {
      ...candidate,
      worktreePath: String.raw`C:\workspace\feature auth's`,
    };
    const commands: string[][] = [];
    const environments: Record<string, string | undefined>[] = [];

    const result = await launchSwitchTarget(
      windowsCandidate,
      { disposition: "window" },
      {
        env: { MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" },
        platform: "win32",
        runProcess: async (command, options) => {
          commands.push(command);
          environments.push(options.env);
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result).toEqual({
      command: [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$directory = Split-Path -Parent (Get-Command git.exe -ErrorAction Stop).Source; while ($directory) { $gitBash = Join-Path $directory 'git-bash.exe'; if (Test-Path -LiteralPath $gitBash) { Start-Process -FilePath $gitBash -ArgumentList '--no-cd' -WorkingDirectory $env:ARASHI_SWITCH_WORKTREE -ErrorAction Stop; exit 0 }; $parent = Split-Path -Parent $directory; if ($parent -eq $directory) { break }; $directory = $parent }; exit 1",
      ],
      disposition: "window",
      mode: "fallback",
    });
    expect(commands).toEqual([result.command]);
    expect(result.command).not.toContain(windowsCandidate.worktreePath);
    expect(environments).toEqual([
      {
        ARASHI_SWITCH_WORKTREE: windowsCandidate.worktreePath,
        CHERE_INVOKING: "1",
        MSYSTEM: "MINGW64",
        SHELL: "/usr/bin/bash",
      },
    ]);
  });

  test("falls back from Windows Terminal through configured Git Bash to MinTTY without leaking attempt variables", async () => {
    const windowsCandidate: SwitchCandidate = {
      ...candidate,
      worktreePath: String.raw`C:\workspace\feature & release`,
    };
    const baseEnv = {
      MSYSTEM: "MINGW64",
      SHELL: "/usr/bin/bash",
      WT_PROFILE_ID: "{00000000-0000-0000-0000-000000000001}",
      WT_SESSION: "00000000-0000-0000-0000-000000000002",
    };
    const attempts: Array<{
      command: string[];
      env: Record<string, string | undefined>;
    }> = [];

    const result = await launchSwitchTarget(
      windowsCandidate,
      { disposition: "window" },
      {
        env: baseEnv,
        platform: "win32",
        runProcess: async (command, options) => {
          attempts.push({ command, env: options.env });
          return {
            exitCode: command[0] === "mintty.exe" ? 0 : 1,
            stderr: "simulated failure",
            stdout: "",
          };
        },
      },
    );

    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toEqual({
      command: [
        "wt.exe",
        "-w",
        "new",
        "new-tab",
        "-p",
        baseEnv.WT_PROFILE_ID,
        "-d",
        windowsCandidate.worktreePath,
      ],
      env: baseEnv,
    });
    expect(attempts[1]?.command[4]).toContain("git-bash.exe");
    expect(attempts[1]?.env).toEqual({
      ...baseEnv,
      ARASHI_SWITCH_WORKTREE: windowsCandidate.worktreePath,
      CHERE_INVOKING: "1",
    });
    expect(attempts[2]).toEqual({
      command: [
        "mintty.exe",
        "--daemon",
        "--dir",
        windowsCandidate.worktreePath,
        "/usr/bin/bash",
        "--login",
        "-i",
      ],
      env: { ...baseEnv, CHERE_INVOKING: "1" },
    });
    expect(result.command).toEqual(attempts[2]?.command);
  });

  test("launches the generic Windows fallback without cmd.exe reparsing the worktree path", async () => {
    const windowsCandidate: SwitchCandidate = {
      ...candidate,
      worktreePath: String.raw`C:\workspace\feature & release|^%TEMP%`,
    };
    const attempts: Array<{
      command: string[];
      env: Record<string, string | undefined>;
    }> = [];

    const result = await launchSwitchTarget(
      windowsCandidate,
      { disposition: "window" },
      {
        env: {},
        platform: "win32",
        runProcess: async (command, options) => {
          attempts.push({ command, env: options.env });
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result.command).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process -FilePath cmd.exe -WorkingDirectory $env:ARASHI_SWITCH_WORKTREE",
    ]);
    expect(result.command).not.toContain(windowsCandidate.worktreePath);
    expect(attempts).toEqual([
      {
        command: result.command,
        env: { ARASHI_SWITCH_WORKTREE: windowsCandidate.worktreePath },
      },
    ]);
  });

  test("throws launch failure when all fallback commands fail", async () => {
    await expect(
      launchSwitchTarget(
        candidate,
        { disposition: "window" },
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

  test("detects Terminal.app", () => {
    expect(detectTerminalApp({ TERM_PROGRAM: "Apple_Terminal" })).toBe("terminal");
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
