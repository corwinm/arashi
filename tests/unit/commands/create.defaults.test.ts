import { describe, expect, test } from "vitest";
import type { Config } from "../../../src/lib/config.ts";
import {
  applyCreateLaunchFlagPrecedence,
  resolveCreateDefaults,
} from "../../../src/commands/create.ts";

function configWithDefaults(defaults?: Config["defaults"]): Config {
  return { defaults, repos: {}, reposDir: "./repos", version: "1.0.0" };
}

describe("resolveCreateDefaults", () => {
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
        launchMode,
        shouldLaunch,
        shouldSwitch,
      });
    },
  );

  test("keeps switch independent when launch is none", () => {
    expect(
      resolveCreateDefaults({}, configWithDefaults({ create: { launch: "none", switch: true } })),
    ).toEqual({ launchMode: "auto", shouldLaunch: false, shouldSwitch: true });
  });

  test("launch implies switch despite explicit switch opt-out", () => {
    expect(
      resolveCreateDefaults(
        { switch: false },
        configWithDefaults({ create: { launch: "herdr", switch: false } }),
      ),
    ).toEqual({ launchMode: "herdr", shouldLaunch: true, shouldSwitch: true });
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
    ).toEqual({ launchMode: "auto", shouldLaunch: false, shouldSwitch: false });
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

  test("rejects simultaneous explicit launchers", () => {
    expect(() => resolveCreateDefaults({ herdr: true, sesh: true }, configWithDefaults())).toThrow(
      "Choose exactly one explicit create launcher",
    );
  });
});
