import { describe, expect, test } from "vitest";
import {
  ensureInstalled,
  isExplicitInstallCommand,
  isExplicitUpdateCommand,
  runEntrypoint,
} from "../../bin/arashi.js";

function createSuccessfulSpawn() {
  const calls: { args: string[]; command: string }[] = [];
  const spawnImpl = (command: string, args: string[]) => {
    calls.push({ args, command });
    const child = {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "exit") {
          queueMicrotask(() => listener(0, null));
        }
        return child;
      },
    };
    return child;
  };

  return { calls, spawnImpl };
}

describe("npm JavaScript entrypoint", () => {
  test("recognizes explicit install as an entrypoint-level command", () => {
    expect(isExplicitInstallCommand(["install"])).toBe(true);
    expect(isExplicitInstallCommand(["--help"])).toBe(false);
  });

  test("recognizes explicit update as an entrypoint-level command", () => {
    expect(isExplicitUpdateCommand(["update"])).toBe(true);
    expect(isExplicitUpdateCommand(["install"])).toBe(false);
  });

  test("first-use fallback installs a missing binary before spawning arashi", async () => {
    const installed: string[] = [];
    const spawn = createSuccessfulSpawn();

    const exitCode = await runEntrypoint(["--version"], {
      arch: "x64",
      binDir: "/package/bin",
      existsSyncImpl: () => false,
      installBinaryImpl: async (options: { binDir: string }) => {
        installed.push(options.binDir);
        return { status: "installed" };
      },
      log: () => {},
      platform: "linux",
      spawnImpl: spawn.spawnImpl,
    });

    expect(exitCode).toBe(0);
    expect(installed).toEqual(["/package/bin"]);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].args).toEqual(["--version"]);
    expect(spawn.calls[0].command.replaceAll("\\", "/")).toBe("/package/bin/arashi");
  });

  test("explicit install downloads without spawning the native binary", async () => {
    const installed: string[] = [];
    const spawn = createSuccessfulSpawn();

    const exitCode = await runEntrypoint(["install"], {
      arch: "x64",
      binDir: "/package/bin",
      existsSyncImpl: () => false,
      installBinaryImpl: async (options: { binDir: string }) => {
        installed.push(options.binDir);
        return { status: "installed" };
      },
      log: () => {},
      platform: "linux",
      spawnImpl: spawn.spawnImpl,
    });

    expect(exitCode).toBe(0);
    expect(installed).toEqual(["/package/bin"]);
    expect(spawn.calls).toEqual([]);
  });

  test.each([["-j"], ["--json"], ["-j", "--json"]])(
    "explicit install %s emits one JSON document and installs exactly once",
    async (...flags) => {
      const output: string[] = [];
      let installCount = 0;
      const exitCode = await runEntrypoint(["install", ...flags], {
        installBinaryImpl: async () => {
          installCount += 1;
          return {
            binaryPath: "/package/bin/arashi-linux-x64",
            status: "installed",
            version: "2.0.0",
          };
        },
        log: (line: string) => output.push(line),
      });

      expect(exitCode).toBe(0);
      expect(installCount).toBe(1);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0])).toMatchObject({
        command: "install",
        ok: true,
        schemaVersion: 1,
      });
    },
  );

  test("explicit update is handled without spawning the native binary", async () => {
    const spawn = createSuccessfulSpawn();
    let installed = false;

    const exitCode = await runEntrypoint(["update", "--check"], {
      arch: "x64",
      binDir: "/package/bin",
      existsSyncImpl: () => true,
      installBinaryImpl: async () => {
        installed = true;
        return { status: "installed" };
      },
      latestVersion: "2.0.0",
      log: () => {},
      metadata: { name: "arashi", version: "1.0.0" },
      platform: "linux",
      rootDir: "/package",
      spawnImpl: spawn.spawnImpl,
    });

    expect(exitCode).toBe(0);
    expect(installed).toBe(false);
    expect(spawn.calls).toEqual([]);
  });

  test.each([["-j"], ["--json"], ["-j", "--json"]])(
    "explicit update %s emits one JSON document and delegates exactly once",
    async (...flags) => {
      const output: string[] = [];
      let lookupCount = 0;
      const exitCode = await runEntrypoint(["update", "--check", ...flags], {
        fetchImpl: async () => {
          lookupCount += 1;
          return { json: async () => ({ version: "2.0.0" }), ok: true };
        },
        log: (line: string) => output.push(line),
        metadata: { name: "arashi", version: "1.0.0" },
        rootDir: "/package",
      });

      expect(exitCode).toBe(0);
      expect(lookupCount).toBe(1);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0])).toMatchObject({
        command: "update",
        ok: true,
        schemaVersion: 1,
      });
    },
  );

  test("ensureInstalled is a no-op when a runnable binary already exists", async () => {
    let installCalled = false;

    const result = await ensureInstalled({
      arch: "x64",
      binDir: "/package/bin",
      existsSyncImpl: (path: string) => path.endsWith("arashi-linux-x64"),
      installBinaryImpl: async () => {
        installCalled = true;
        return { status: "installed" };
      },
      log: () => {},
      platform: "linux",
    });

    expect(result.status).toBe("already-installed");
    expect(installCalled).toBe(false);
  });
});
