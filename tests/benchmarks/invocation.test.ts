import { describe, expect, test } from "vitest";
import { createBenchmarkFixture } from "../../scripts/benchmark/fixtures.ts";
import { invoke } from "../../scripts/benchmark/invoke.ts";

describe("benchmarked CLI environment", () => {
  test("enforces benchmark controls after hostile fixture values without dropping platform state", async () => {
    const result = await invoke(
      {
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ci:process.env.CI,forceColor:process.env.FORCE_COLOR,noColor:process.env.NO_COLOR,prompt:process.env.GIT_TERMINAL_PROMPT,pathExt:process.env.PATHEXT,sentinel:process.env.ARASHI_PLATFORM_SENTINEL,systemRoot:process.env.SystemRoot}))",
        ],
        command: process.execPath,
      },
      [],
      process.cwd(),
      {
        ARASHI_PLATFORM_SENTINEL: "preserved",
        CI: "hostile",
        FORCE_COLOR: "1",
        GIT_TERMINAL_PROMPT: "1",
        NO_COLOR: "0",
        PATHEXT: ".BENCH",
        SystemRoot: "benchmark-system-root",
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ci: "1",
      forceColor: "0",
      noColor: "1",
      pathExt: ".BENCH",
      prompt: "0",
      sentinel: "preserved",
      systemRoot: "benchmark-system-root",
    });
  });

  test("reports truthful per-process CPU availability", async () => {
    const result = await invoke(
      { args: ["-e", "for(let i=0;i<100000;i++) Math.sqrt(i)"], command: process.execPath },
      [],
      process.cwd(),
      {},
      { measureCpu: true },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.cpu).toEqual(
      result.cpu.available
        ? {
            available: true,
            method: expect.any(String),
            systemMs: expect.any(Number),
            userMs: expect.any(Number),
          }
        : {
            available: false,
            method: expect.any(String),
            reason: expect.any(String),
          },
    );
  });

  test("passes the fixture's isolated Git configuration and hooks to the child process", async () => {
    const fixture = await createBenchmarkFixture("small");
    try {
      const result = await invoke(
        {
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({global:process.env.GIT_CONFIG_GLOBAL,hooks:process.env.GIT_CONFIG_VALUE_0,nosystem:process.env.GIT_CONFIG_NOSYSTEM}))",
          ],
          command: process.execPath,
        },
        [],
        fixture.refreshedRoot,
        fixture.environment,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        global: fixture.environment.GIT_CONFIG_GLOBAL,
        hooks: fixture.environment.GIT_CONFIG_VALUE_0,
        nosystem: "1",
      });
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);
});
