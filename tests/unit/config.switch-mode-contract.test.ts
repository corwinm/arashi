import {
  ConfigValidationError,
  normalizeConfig,
  normalizeConfigWithDiagnostics,
} from "../../src/lib/config.ts";
import { describe, expect, test } from "vitest";

const rawConfig = (switchDefaults?: Record<string, unknown>) => ({
  ...(switchDefaults === undefined ? {} : { defaults: { switch: switchDefaults } }),
  repos: {},
  reposDir: "./repos",
  version: "1.0.0",
});

describe("unified switch config contract", () => {
  test.each(["auto", "cd", "launch", "sesh", "herdr"] as const)(
    "accepts canonical mode %s",
    (mode) => {
      const normalized = normalizeConfig(rawConfig({ mode }));

      expect(normalized.defaults?.switch).toEqual({ mode });
    },
  );

  test("preserves an absent switch mode", () => {
    expect(normalizeConfig(rawConfig()).defaults?.switch).toBeUndefined();
  });

  test("rejects an unsupported mode instead of dropping it", () => {
    expect(() => normalizeConfig(rawConfig({ mode: "tmux" }))).toThrowError(
      new ConfigValidationError([
        'defaults.switch.mode: must be one of "auto", "cd", "launch", "sesh", or "herdr"',
      ]),
    );
  });

  test("preserves canonical create and editor-scoped create defaults", () => {
    const normalized = normalizeConfig({
      defaults: {
        create: { launch: "sesh", switch: true },
        editors: {
          cursor: { create: { launch: "none", switch: true } },
          vscode: { create: { launch: "herdr" } },
        },
        switch: { mode: "launch" },
      },
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
    });

    expect(normalized.defaults).toEqual({
      create: { launch: "sesh", switch: true },
      editors: {
        cursor: { create: { launch: "none", switch: true } },
        vscode: { create: { launch: "herdr" } },
      },
      switch: { mode: "launch" },
    });
  });
});

describe("legacy switch launch mode normalization", () => {
  test.each([
    [undefined, "auto", "launch"],
    [undefined, "sesh", "sesh"],
    [undefined, "herdr", "herdr"],
    ["launch", "auto", "launch"],
    ["launch", "sesh", "sesh"],
    ["launch", "herdr", "herdr"],
    ["auto", "auto", "auto"],
    ["auto", "sesh", "sesh"],
    ["auto", "herdr", "herdr"],
    ["cd", "auto", "cd"],
    ["sesh", "auto", "sesh"],
    ["sesh", "sesh", "sesh"],
    ["herdr", "auto", "herdr"],
    ["herdr", "herdr", "herdr"],
  ] as const)("maps mode %s and launchMode %s to %s", (mode, launchMode, expectedMode) => {
    const switchDefaults = mode === undefined ? { launchMode } : { launchMode, mode };
    const result = normalizeConfigWithDiagnostics(rawConfig(switchDefaults));

    expect(result.config.defaults?.switch).toEqual({ mode: expectedMode });
    expect(result.diagnostics).toEqual([
      {
        code: "DEPRECATED_SWITCH_LAUNCH_MODE",
        fields: ["defaults.switch.launchMode"],
        message: `defaults.switch.launchMode is deprecated; use defaults.switch.mode: "${expectedMode}" instead.`,
        replacementMode: expectedMode,
      },
    ]);
  });

  test.each(["auto", "sesh", "herdr"] as const)(
    "maps snake-case launch_mode %s and reports its exact field",
    (launchMode) => {
      const expectedMode = launchMode === "auto" ? "launch" : launchMode;
      const result = normalizeConfigWithDiagnostics(rawConfig({ launch_mode: launchMode }));

      expect(result.config.defaults?.switch).toEqual({ mode: expectedMode });
      expect(result.diagnostics).toEqual([
        {
          code: "DEPRECATED_SWITCH_LAUNCH_MODE",
          fields: ["defaults.switch.launch_mode"],
          message: `defaults.switch.launch_mode is deprecated; use defaults.switch.mode: "${expectedMode}" instead.`,
          replacementMode: expectedMode,
        },
      ]);
    },
  );

  test("collapses equal aliases and emits one diagnostic", () => {
    const result = normalizeConfigWithDiagnostics(
      rawConfig({ launchMode: "sesh", launch_mode: "sesh", mode: "auto" }),
    );

    expect(result.config.defaults?.switch).toEqual({ mode: "sesh" });
    expect(result.diagnostics).toEqual([
      {
        code: "DEPRECATED_SWITCH_LAUNCH_MODE",
        fields: ["defaults.switch.launchMode", "defaults.switch.launch_mode"],
        message:
          'defaults.switch.launchMode and defaults.switch.launch_mode are deprecated; use defaults.switch.mode: "sesh" instead.',
        replacementMode: "sesh",
      },
    ]);
  });

  test.each([
    ["sesh", "herdr"],
    ["tmux", "sesh"],
  ])(
    "rejects conflicting raw aliases %s and %s before validation or mode mapping",
    (launchMode, launch_mode) => {
      expect(() =>
        normalizeConfigWithDiagnostics(rawConfig({ launchMode, launch_mode, mode: "cd" })),
      ).toThrowError(
        `defaults.switch.launchMode: "${launchMode}" conflicts with defaults.switch.launch_mode: "${launch_mode}"; remove both legacy fields and set defaults.switch.mode to one supported value`,
      );
    },
  );

  test.each([
    ["cd", "sesh"],
    ["cd", "herdr"],
    ["sesh", "herdr"],
    ["herdr", "sesh"],
  ] as const)("rejects unrepresentable mode %s with launcher %s", (mode, launchMode) => {
    expect(() => normalizeConfig(rawConfig({ launchMode, mode }))).toThrowError(
      `defaults.switch.mode: "${mode}" cannot be combined with legacy defaults.switch.launchMode: "${launchMode}"; remove the legacy field and choose defaults.switch.mode: "${mode}" or "${launchMode}"`,
    );
  });

  test("equal aliases still reject an unrepresentable combination", () => {
    expect(() =>
      normalizeConfig(rawConfig({ launchMode: "herdr", launch_mode: "herdr", mode: "cd" })),
    ).toThrowError(
      'defaults.switch.mode: "cd" cannot be combined with legacy defaults.switch.launchMode and defaults.switch.launch_mode: "herdr"; remove the legacy fields and choose defaults.switch.mode: "cd" or "herdr"',
    );
  });

  test.each([
    ["launchMode", "tmux"],
    ["launch_mode", "tmux"],
  ])("rejects unsupported legacy field %s", (field, value) => {
    expect(() => normalizeConfig(rawConfig({ [field]: value }))).toThrowError(
      `defaults.switch.${field}: must be one of "auto", "sesh", or "herdr"`,
    );
  });
});
