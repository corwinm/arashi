import { afterEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  cleanupFixtureDirectory,
  createBenchmarkFixture,
} from "../../scripts/benchmark/fixtures.ts";
import { invoke } from "../../scripts/benchmark/invoke.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temporaryPaths: string[] = [];

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(original: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, original);
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("benchmark fixtures", () => {
  test.runIf(process.platform !== "win32")(
    "strip hostile inherited Git controls from setup and benchmark invocations",
    async () => {
      const poisonRoot = await mkdtemp(join(tmpdir(), "arashi-benchmark-git-poison-"));
      temporaryPaths.push(poisonRoot);
      const fsmonitorMarker = join(poisonRoot, "fsmonitor-ran");
      const hookMarker = join(poisonRoot, "hook-ran");
      const staleTrace = join(poisonRoot, "stale-trace.json");
      const ownedTrace = join(poisonRoot, "owned-trace.json");
      const fsmonitor = join(poisonRoot, "fsmonitor");
      await writeFile(fsmonitor, `#!/bin/sh\nprintf ran >> '${fsmonitorMarker}'\n`, "utf8");
      await chmod(fsmonitor, 0o755);

      const templateDirectory = join(poisonRoot, "template");
      const templateHooks = join(templateDirectory, "hooks");
      await mkdir(templateHooks, { recursive: true });
      const preCommit = join(templateHooks, "pre-commit");
      await writeFile(preCommit, `#!/bin/sh\nprintf ran >> '${hookMarker}'\n`, "utf8");
      await chmod(preCommit, 0o755);

      const original = { ...process.env };
      Object.assign(process.env, {
        ARASHI_BENCHMARK_SENTINEL: "preserved",
        GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${fsmonitor}'`,
        GIT_TEMPLATE_DIR: templateDirectory,
        GIT_TRACE2_EVENT: staleTrace,
        SystemRoot: "benchmark-system-root",
        TEMP: "benchmark-temp",
      });

      try {
        const fixture = await createBenchmarkFixture("small");
        expect(fixture).not.toHaveProperty("localRoot");
        expect(fixture.environment).toEqual(
          expect.objectContaining({
            ARASHI_BENCHMARK_SENTINEL: "preserved",
            GIT_ALLOW_PROTOCOL: "file",
            GIT_CONFIG_GLOBAL: expect.stringContaining("gitconfig"),
            GIT_CONFIG_KEY_0: "core.hooksPath",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            SystemRoot: "benchmark-system-root",
            TEMP: "benchmark-temp",
          }),
        );
        expect(fixture.environment).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
        expect(fixture.environment).not.toHaveProperty("GIT_TEMPLATE_DIR");
        expect(fixture.environment).not.toHaveProperty("GIT_TRACE2_EVENT");
        expect(await pathExists(join(fixture.refreshedRoot, ".git", "hooks", "pre-commit"))).toBe(
          false,
        );
        expect(await pathExists(fsmonitorMarker)).toBe(false);
        expect(await pathExists(hookMarker)).toBe(false);
        expect(await pathExists(staleTrace)).toBe(false);

        const result = await invoke(
          { args: [], command: "git" },
          ["status"],
          fixture.refreshedRoot,
          {
            ...fixture.environment,
            GIT_TRACE2_EVENT: ownedTrace,
          },
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(await pathExists(ownedTrace)).toBe(true);
        expect(await pathExists(fsmonitorMarker)).toBe(false);
        expect(await pathExists(hookMarker)).toBe(false);
        expect(await pathExists(staleTrace)).toBe(false);
        await fixture.cleanup();
      } finally {
        restoreEnvironment(original);
      }
    },
    120_000,
  );

  test("uses bounded Windows-friendly retries for recursive cleanup", async () => {
    const remove = vi.fn(async () => {});

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
