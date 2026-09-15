import { describe, expect, test } from "vitest";
import { createBenchmarkFixture } from "../../scripts/benchmark/fixtures.ts";
import { invoke } from "../../scripts/benchmark/invoke.ts";

describe("benchmarked CLI environment", () => {
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
