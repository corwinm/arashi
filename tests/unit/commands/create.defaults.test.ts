import { describe, expect, test } from "bun:test";
import { resolveCreateDefaults } from "../../../src/commands/create.ts";
import type { Config } from "../../../src/lib/config.ts";

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

  test("preserves backward-compatible behavior when defaults are absent", () => {
    const resolved = resolveCreateDefaults({}, baseConfig());

    expect(resolved).toEqual({
      launchMode: "auto",
      shouldLaunch: false,
      shouldSwitch: false,
    });
  });
});
