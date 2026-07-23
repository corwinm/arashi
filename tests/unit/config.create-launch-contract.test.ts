import {
  ConfigValidationError,
  normalizeConfig,
  normalizeConfigWithDiagnostics,
} from "../../src/lib/config.ts";
import { describe, expect, test } from "vitest";

const scopes = [
  ["defaults.create", (create: Record<string, unknown>) => ({ create })],
  [
    "defaults.editors.vscode.create",
    (create: Record<string, unknown>) => ({ editors: { vscode: { create } } }),
  ],
  [
    "defaults.editors.cursor.create",
    (create: Record<string, unknown>) => ({ editors: { cursor: { create } } }),
  ],
  [
    "defaults.editors.kiro.create",
    (create: Record<string, unknown>) => ({ editors: { kiro: { create } } }),
  ],
] as const;

const rawConfig = (defaults?: Record<string, unknown>) => ({
  ...(defaults === undefined ? {} : { defaults }),
  repos: {},
  reposDir: "./repos",
  version: "1.0.0",
});

describe("canonical create launch configuration", () => {
  test.each(["none", "auto", "sesh", "herdr"] as const)("accepts canonical launch %s", (launch) => {
    const normalized = normalizeConfig(rawConfig({ create: { launch, switch: false } }));
    expect(normalized.defaults?.create).toEqual({ launch, switch: false });
  });

  test("preserves absent launch and independent switch", () => {
    expect(normalizeConfig(rawConfig({ create: { switch: true } })).defaults?.create).toEqual({
      switch: true,
    });
  });

  test.each(scopes)("rejects invalid nested values at %s", (scope, wrap) => {
    expect(() => normalizeConfig(rawConfig(wrap({ launch: "tmux", switch: "yes" })))).toThrowError(
      new ConfigValidationError([
        `${scope}.switch: must be a boolean if present`,
        `${scope}.launch: must be one of "none", "auto", "sesh", or "herdr"`,
      ]),
    );
  });
});

describe("legacy create launch normalization", () => {
  test.each([
    [{}, undefined],
    [{ launchMode: "auto" }, "auto"],
    [{ launch_mode: "sesh" }, "sesh"],
    [{ launch: true }, "auto"],
    [{ launch: true, launchMode: "auto" }, "auto"],
    [{ launch: true, launchMode: "sesh" }, "sesh"],
    [{ launch: true, launch_mode: "herdr" }, "herdr"],
    [{ launch: false }, "none"],
  ] as const)("maps legacy create defaults %# to %s", (create, expected) => {
    const result = normalizeConfigWithDiagnostics(rawConfig({ create }));
    expect(result.config.defaults?.create?.launch).toBe(expected);
    expect(result.diagnostics).toHaveLength(Object.keys(create).length === 0 ? 0 : 1);
    if (expected !== undefined) {
      expect(result.diagnostics[0]).toMatchObject({
        code: "DEPRECATED_CREATE_LAUNCH_FIELDS",
        replacementLaunch: expected,
      });
      expect(result.diagnostics[0]?.message).toContain(`defaults.create.launch: "${expected}"`);
    }
  });

  test.each(["auto", "sesh", "herdr"] as const)(
    "rejects legacy launch false with %s without discarding either intent",
    (launchMode) => {
      expect(() =>
        normalizeConfig(rawConfig({ create: { launch: false, launchMode } })),
      ).toThrowError(
        `defaults.create.launch: false cannot be combined with legacy defaults.create.launchMode: "${launchMode}"; choose defaults.create.launch: "none" or "${launchMode}"`,
      );
    },
  );

  test("collapses equal aliases and emits one scope-qualified diagnostic", () => {
    const result = normalizeConfigWithDiagnostics(
      rawConfig({ create: { launch: true, launchMode: "sesh", launch_mode: "sesh" } }),
    );
    expect(result.config.defaults?.create).toEqual({ launch: "sesh" });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      fields: [
        "defaults.create.launch",
        "defaults.create.launchMode",
        "defaults.create.launch_mode",
      ],
      replacementLaunch: "sesh",
      scope: "defaults.create",
    });
  });

  test("rejects conflicting aliases before mapping", () => {
    expect(() =>
      normalizeConfig(rawConfig({ create: { launchMode: "sesh", launch_mode: "herdr" } })),
    ).toThrowError(
      'defaults.create.launchMode: "sesh" conflicts with defaults.create.launch_mode: "herdr"',
    );
  });

  test.each([
    ["none", "auto"],
    ["auto", "sesh"],
    ["auto", "herdr"],
    ["sesh", "herdr"],
    ["herdr", "sesh"],
  ] as const)("rejects canonical %s with conflicting legacy launcher %s", (launch, launchMode) => {
    expect(() => normalizeConfig(rawConfig({ create: { launch, launchMode } }))).toThrowError(
      `defaults.create.launch: "${launch}" conflicts with legacy defaults.create.launchMode: "${launchMode}"`,
    );
  });

  test.each([
    ["auto", "auto"],
    ["sesh", "auto"],
    ["sesh", "sesh"],
    ["herdr", "auto"],
    ["herdr", "herdr"],
  ] as const)("accepts canonical %s with compatible legacy launcher %s", (launch, launchMode) => {
    const result = normalizeConfigWithDiagnostics(
      rawConfig({ create: { launch, launchMode, switch: true } }),
    );
    expect(result.config.defaults?.create).toEqual({ launch, switch: true });
    expect(result.diagnostics).toHaveLength(1);
  });

  test("exhausts every legacy launcher alias and canonical compatibility combination", () => {
    const launchers = ["auto", "sesh", "herdr"] as const;
    const aliases = ["launchMode", "launch_mode"] as const;
    const compatible = new Map([
      ["none", []],
      ["auto", ["auto"]],
      ["sesh", ["auto", "sesh"]],
      ["herdr", ["auto", "herdr"]],
    ] as const);

    for (const alias of aliases) {
      for (const launcher of launchers) {
        expect(
          normalizeConfigWithDiagnostics(rawConfig({ create: { [alias]: launcher } })).config
            .defaults?.create?.launch,
        ).toBe(launcher);
        expect(
          normalizeConfigWithDiagnostics(rawConfig({ create: { [alias]: launcher, launch: true } }))
            .config.defaults?.create?.launch,
        ).toBe(launcher);
        expect(() =>
          normalizeConfig(rawConfig({ create: { [alias]: launcher, launch: false } })),
        ).toThrow("cannot be combined");

        for (const [canonical, acceptedLaunchers] of compatible) {
          const input = { [alias]: launcher, launch: canonical };
          if ((acceptedLaunchers as readonly string[]).includes(launcher)) {
            expect(normalizeConfig(rawConfig({ create: input })).defaults?.create?.launch).toBe(
              canonical,
            );
          } else {
            expect(() => normalizeConfig(rawConfig({ create: input }))).toThrow("conflicts");
          }
        }
      }
    }

    for (const launcher of launchers) {
      const result = normalizeConfigWithDiagnostics(
        rawConfig({ create: { launchMode: launcher, launch_mode: launcher } }),
      );
      expect(result.config.defaults?.create?.launch).toBe(launcher);
      expect(result.diagnostics).toHaveLength(1);
    }
  });

  test("emits exactly one diagnostic for every affected create scope", () => {
    const result = normalizeConfigWithDiagnostics(
      rawConfig({
        create: { launch: true },
        editors: {
          cursor: { create: { launch: false } },
          kiro: { create: { launch_mode: "herdr" } },
          vscode: { create: { launchMode: "sesh" } },
        },
      }),
    );
    expect(
      result.diagnostics.flatMap((diagnostic) =>
        diagnostic.code === "DEPRECATED_CREATE_LAUNCH_FIELDS" ? [diagnostic.scope] : [],
      ),
    ).toEqual([
      "defaults.create",
      "defaults.editors.vscode.create",
      "defaults.editors.cursor.create",
      "defaults.editors.kiro.create",
    ]);
  });
});
