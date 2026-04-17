import { describe, expect, test } from "bun:test";
import type { Config } from "../../../src/lib/config.ts";
import { resolveCreateDefaults } from "../../../src/commands/create.ts";

function baseConfig(): Config {
  return {
    repos: {},
    reposDir: "./repos",
    version: "1.0.0",
  };
}

describe("resolveCreateDefaults", () => {
  test("uses configured defaults when CLI flags are omitted", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        launch: true,
        launchMode: "sesh",
        switch: true,
      },
    };

    const resolved = resolveCreateDefaults({}, config);

    expect(resolved).toEqual({
      launchMode: "sesh",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test("uses editor-scoped defaults for editor-hosted create invocations", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        launch: true,
        switch: true,
      },
      editors: {
        vscode: {
          create: {
            launch: true,
            launchMode: "sesh",
          },
        },
      },
    };

    const resolved = resolveCreateDefaults({ editorHost: "vscode" }, config);

    expect(resolved).toEqual({
      launchMode: "sesh",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test("does not fall back to generic defaults for editor-hosted create without overrides", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        launch: true,
        launchMode: "sesh",
        switch: true,
      },
    };

    const resolved = resolveCreateDefaults({ editorHost: "cursor" }, config);

    expect(resolved).toEqual({
      launchMode: "auto",
      shouldLaunch: false,
      shouldSwitch: false,
    });
  });

  test("allows CLI opt-out flags to disable configured defaults", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        launch: true,
        launchMode: "sesh",
        switch: true,
      },
    };

    const resolved = resolveCreateDefaults(
      {
        launch: false,
        switch: false,
      },
      config,
    );

    expect(resolved).toEqual({
      launchMode: "auto",
      shouldLaunch: false,
      shouldSwitch: false,
    });
  });

  test("allows explicit CLI launch options to override config defaults", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        launch: false,
        switch: false,
      },
    };

    const resolved = resolveCreateDefaults(
      {
        launch: true,
        sesh: true,
      },
      config,
    );

    expect(resolved).toEqual({
      launchMode: "sesh",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test("allows explicit CLI options to override editor-scoped defaults", () => {
    const config = baseConfig();
    config.defaults = {
      editors: {
        vscode: {
          create: {
            launch: false,
            switch: false,
          },
        },
      },
    };

    const resolved = resolveCreateDefaults(
      {
        editorHost: "vscode",
        launch: true,
        sesh: true,
      },
      config,
    );

    expect(resolved).toEqual({
      launchMode: "sesh",
      shouldLaunch: true,
      shouldSwitch: true,
    });
  });

  test("preserves backward-compatible behavior when defaults are absent", () => {
    const resolved = resolveCreateDefaults({}, baseConfig());

    expect(resolved).toEqual({
      launchMode: "auto",
      shouldLaunch: false,
      shouldSwitch: false,
    });
  });
});
