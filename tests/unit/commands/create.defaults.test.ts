import { describe, expect, test } from "vitest";
import type { Config } from "../../../src/lib/config.ts";
import {
  applyCreateLaunchFlagPrecedence,
  createCommand,
  resolveCreateDefaults,
} from "../../../src/commands/create.ts";

function configWithDefaults(defaults?: Config["defaults"]): Config {
  return { defaults, repos: {}, reposDir: "./repos", version: "1.0.0" };
}

describe("resolveCreateDefaults", () => {
  test("registers explicit plain tmux launch", () => {
    expect(
      createCommand().options.find((option) => option.long === "--tmux")?.description,
    ).toContain("implies --launch and --switch");
    expect(
      createCommand().options.find((option) => option.long === "--tab")?.description,
    ).toContain("tab");
  });

  test("renders the default-window and fail-closed tab disposition contract", () => {
    let help = "";
    createCommand()
      .configureOutput({ writeOut: (value) => (help += value) })
      .outputHelp();
    expect(help).toContain(
      "By default, launch opens a new OS window or managed independent-session equivalent.",
    );
    expect(help).toContain(
      "--tab requests a true tab or equivalent; unsupported mappings fail without opening a window.",
    );
  });

  test.each([
    [undefined, "auto", false, false],
    ["none", "auto", false, false],
    ["auto", "auto", true, true],
    ["sesh", "sesh", true, true],
    ["herdr", "herdr", true, true],
  ] as const)(
    "resolves configured launch %s to internal mode %s",
    (launch, launchMode, shouldLaunch, shouldSwitch) => {
      const create = launch === undefined ? undefined : { launch };
      expect(
        resolveCreateDefaults({}, configWithDefaults(create ? { create } : undefined)),
      ).toEqual({
        disposition: "window",
        launchMode,
        shouldLaunch,
        shouldSwitch,
      });
    },
  );

  test("keeps switch independent when launch is none", () => {
    expect(
      resolveCreateDefaults({}, configWithDefaults({ create: { launch: "none", switch: true } })),
    ).toEqual({
      disposition: "window",
      launchMode: "auto",
      shouldLaunch: false,
      shouldSwitch: true,
    });
  });

  test("launch implies switch despite explicit switch opt-out", () => {
    expect(
      resolveCreateDefaults(
        { switch: false },
        configWithDefaults({ create: { launch: "herdr", switch: false } }),
      ),
    ).toEqual({
      disposition: "window",
      launchMode: "herdr",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test.each([
    ["vscode", "sesh"],
    ["cursor", "herdr"],
    ["kiro", "auto"],
  ] as const)("uses only matching %s editor defaults", (editorHost, launch) => {
    const config = configWithDefaults({
      create: { launch: "herdr", switch: true },
      editors: {
        cursor: { create: { launch: "herdr" } },
        kiro: { create: { launch: "auto" } },
        vscode: { create: { launch: "sesh" } },
      },
    });
    expect(resolveCreateDefaults({ editorHost }, config)).toMatchObject({ launchMode: launch });
  });

  test("does not fall back to generic defaults when the editor scope is missing", () => {
    expect(
      resolveCreateDefaults(
        { editorHost: "cursor" },
        configWithDefaults({ create: { launch: "sesh", switch: true } }),
      ),
    ).toEqual({
      disposition: "window",
      launchMode: "auto",
      shouldLaunch: false,
      shouldSwitch: false,
    });
  });

  test.each([
    [{ launch: true }, "auto", true],
    [{ launch: false }, "auto", false],
    [{ launch: true, sesh: true }, "sesh", true],
    [{ launch: false, sesh: true }, "sesh", true],
    [{ herdr: true, launch: true }, "herdr", true],
    [{ herdr: true, launch: false }, "herdr", true],
  ] as const)("applies CLI precedence for %#", (options, launchMode, shouldLaunch) => {
    const resolved = resolveCreateDefaults(
      options,
      configWithDefaults({ create: { launch: "herdr", switch: false } }),
    );
    expect(resolved.launchMode).toBe(launchMode);
    expect(resolved.shouldLaunch).toBe(shouldLaunch);
    expect(resolved.shouldSwitch).toBe(resolved.shouldLaunch);
  });

  test.each(["sesh", "herdr"] as const)(
    "--tab bypasses configured create %s without repeating --launch",
    (launch) => {
      expect(
        resolveCreateDefaults(
          { tab: true },
          configWithDefaults({ create: { launch, switch: false } }),
        ),
      ).toEqual({
        disposition: "tab",
        launchMode: "auto",
        shouldLaunch: true,
        shouldSwitch: true,
      });
    },
  );

  test("--tab bypasses editor-scoped configured launchers", () => {
    expect(
      resolveCreateDefaults(
        { editorHost: "vscode", tab: true },
        configWithDefaults({ editors: { vscode: { create: { launch: "herdr" } } } }),
      ),
    ).toMatchObject({ disposition: "tab", launchMode: "auto" });
  });

  test.each(["sesh", "herdr", "tmux"] as const)(
    "--tab preserves explicit create launcher --%s",
    (launcher) => {
      expect(
        resolveCreateDefaults(
          { [launcher]: true, tab: true },
          configWithDefaults({ create: { launch: launcher === "sesh" ? "herdr" : "sesh" } }),
        ),
      ).toMatchObject({ disposition: "tab", launchMode: launcher });
    },
  );

  test("describes --tab as bypassing configured create launchers", () => {
    expect(
      createCommand().options.find((option) => option.long === "--tab")?.description,
    ).toContain("bypasses configured launch defaults");
  });

  test("includes --tab in the rendered create precedence help", () => {
    let help = "";
    createCommand()
      .configureOutput({ writeOut: (value) => (help += value) })
      .outputHelp();
    expect(help).toContain(
      "Precedence: --tmux/--sesh/--herdr, --tab/--launch, --no-launch, matching configured scope, then none.",
    );
  });

  test("applies --launch before --no-launch regardless of argument order", () => {
    for (const rawArgs of [
      ["--launch", "--no-launch"],
      ["--no-launch", "--launch"],
    ]) {
      expect(applyCreateLaunchFlagPrecedence({ launch: false }, rawArgs)).toMatchObject({
        launch: true,
      });
    }
  });

  test.each([
    { launch: false, tmux: true },
    { switch: false, tmux: true },
  ])("explicit tmux implies launch and switch despite opt-out %#", (options) => {
    expect(resolveCreateDefaults(options, configWithDefaults())).toEqual({
      disposition: "window",
      launchMode: "tmux",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test.each(["sesh", "herdr"] as const)(
    "rejects explicit tmux with explicit %s before defaults resolve",
    (launcher) => {
      expect(() =>
        resolveCreateDefaults({ tmux: true, [launcher]: true }, configWithDefaults()),
      ).toThrowError(new RegExp(`--tmux, --${launcher}`));
    },
  );

  test("rejects simultaneous explicit launchers", () => {
    expect(() => resolveCreateDefaults({ herdr: true, sesh: true }, configWithDefaults())).toThrow(
      "Choose exactly one explicit create launcher",
    );
  });
});
