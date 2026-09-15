import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  cleanupFixtureDirectory,
  createBenchmarkFixture,
} from "../../scripts/benchmark/fixtures.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("benchmark fixtures", () => {
  test("ignore host Git configuration and hooks without creating an unused local workspace", async () => {
    const poisonRoot = await mkdtemp(join(tmpdir(), "arashi-benchmark-git-poison-"));
    temporaryPaths.push(poisonRoot);
    const hooksPath = join(poisonRoot, "hooks");
    await mkdir(hooksPath);
    const preCommit = join(hooksPath, "pre-commit");
    await writeFile(preCommit, "#!/bin/sh\nexit 97\n", "utf8");
    await chmod(preCommit, 0o755);
    const globalConfig = join(poisonRoot, "global.gitconfig");
    const systemConfig = join(poisonRoot, "system.gitconfig");
    await writeFile(globalConfig, `[core]\n\tbare = true\n\thooksPath = ${hooksPath}\n`, "utf8");
    await writeFile(systemConfig, "[core]\n\tbare = true\n", "utf8");

    const keys = [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_VALUE_0",
    ] as const;
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_VALUE_0: hooksPath,
    });

    try {
      const fixture = await createBenchmarkFixture("small");
      expect(fixture).not.toHaveProperty("localRoot");
      expect(fixture.environment).toEqual(
        expect.objectContaining({
          GIT_CONFIG_GLOBAL: expect.stringContaining("gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_TERMINAL_PROMPT: "0",
        }),
      );
      expect(fixture.environment.GIT_CONFIG_GLOBAL).not.toBe(globalConfig);
      expect(fixture.environment.GIT_CONFIG_VALUE_0).not.toBe(hooksPath);
      await fixture.cleanup();
    } finally {
      for (const key of keys) {
        const value = original[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }, 120_000);

  test("uses bounded Windows-friendly retries for recursive cleanup", async () => {
    const remove = vi.fn(async () => undefined);

    await cleanupFixtureDirectory("portable-fixture", remove);

    expect(remove).toHaveBeenCalledWith("portable-fixture", {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
