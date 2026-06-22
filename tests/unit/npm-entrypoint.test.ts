import { describe, expect, test } from "bun:test";
import { ensureInstalled, isExplicitInstallCommand, runEntrypoint } from "../../bin/arashi.js";

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
