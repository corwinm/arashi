import { describe, expect, test } from "bun:test";
import { resolveCreateDefaults } from "../../../src/commands/create.ts";
import type { Config } from "../../../src/lib/config.ts";

function baseConfig(): Config {
  return {
    version: "1.0.0",
    reposDir: "./repos",
    repos: {},
  };
}

describe("resolveCreateDefaults", () => {
  test("uses configured defaults when CLI flags are omitted", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        switch: true,
        launch: true,
        launchMode: "sesh",
      },
    };

    const resolved = resolveCreateDefaults({}, config);

    expect(resolved).toEqual({
      shouldSwitch: true,
      shouldLaunch: true,
      launchMode: "sesh",
    });
  });

  test("allows CLI opt-out flags to disable configured defaults", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        switch: true,
        launch: true,
        launchMode: "sesh",
      },
    };

    const resolved = resolveCreateDefaults(
      {
        switch: false,
        launch: false,
      },
      config,
    );

    expect(resolved).toEqual({
      shouldSwitch: false,
      shouldLaunch: false,
      launchMode: "auto",
    });
  });

  test("allows explicit CLI launch options to override config defaults", () => {
    const config = baseConfig();
    config.defaults = {
      create: {
        switch: false,
        launch: false,
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
      shouldSwitch: true,
      shouldLaunch: true,
      launchMode: "sesh",
    });
  });

  test("preserves backward-compatible behavior when defaults are absent", () => {
    const resolved = resolveCreateDefaults({}, baseConfig());

    expect(resolved).toEqual({
      shouldSwitch: false,
      shouldLaunch: false,
      launchMode: "auto",
    });
  });
});
