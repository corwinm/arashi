import { describe, expect, test } from "vitest";
import {
  ensureInstalled,
  isExplicitInstallCommand,
  isExplicitUpdateCommand,
  isExplicitUninstallCommand,
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

  test("recognizes uninstall before first-use native dispatch", () => {
    expect(isExplicitUninstallCommand(["uninstall"])).toBe(true);
    expect(isExplicitUninstallCommand(["shell", "uninstall"])).toBe(false);
  });

  test.each(["--help", "-h"])(
    "prints public uninstall help for %s without side effects",
    async (flag) => {
      const output: string[] = [];
      let inferredOwnership = false;
      let installed = false;
      let spawned = false;
      let confirmed = false;

      const exitCode = await runEntrypoint(["uninstall", flag], {
        confirm: async () => {
          confirmed = true;
          return true;
        },
        installBinaryImpl: async () => {
          installed = true;
        },
        log: (line: string) => output.push(line),
        realpathSyncImpl: (path: string) => {
          inferredOwnership = true;
          return path;
        },
        spawnImpl: () => {
          spawned = true;
          throw new Error("must not spawn");
        },
      });

      expect(exitCode).toBe(0);
      expect(output.join("\n")).toContain("Usage: arashi uninstall [options]");
      expect(output.join("\n")).toContain("-n, --dry-run");
      expect(output.join("\n")).toContain("-y, --yes");
      expect(output.join("\n")).toContain("-h, --help");
      expect({ confirmed, inferredOwnership, installed, spawned }).toEqual({
        confirmed: false,
        inferredOwnership: false,
        installed: false,
        spawned: false,
      });
    },
  );

  test.each([
    ["npm", "npm", ["uninstall", "-g", "arashi"]],
    ["pnpm", "pnpm", ["remove", "-g", "arashi"]],
    ["yarn-classic", "yarn", ["global", "remove", "arashi"]],
    ["bun", "bun", ["remove", "-g", "arashi"]],
    ["vite-plus", "vp", ["uninstall", "-g", "arashi"]],
  ])("delegates the %s owner with exact argv once", async (owner, command, args) => {
    const spawn = createSuccessfulSpawn();
    let installed = false;
    const exitCode = await runEntrypoint(["uninstall", "--yes"], {
      ownerEvidence: [owner],
      installBinaryImpl: async () => {
        installed = true;
      },
      spawnImpl: spawn.spawnImpl,
      log: () => {},
    });
    expect(exitCode).toBe(0);
    expect(installed).toBe(false);
    expect(spawn.calls).toEqual([{ command, args }]);
  });

  test("detects npm ownership under standard and configured global prefixes", async () => {
    for (const [rootDir, options] of [
      ["/opt/homebrew/lib/node_modules/arashi", {}],
      [
        "/custom/npm-prefix/lib/node_modules/arashi",
        { env: { NPM_CONFIG_PREFIX: "/custom/npm-prefix" } },
      ],
      [
        "C:\\custom\\npm-prefix\\node_modules\\arashi",
        { env: { NPM_CONFIG_PREFIX: "C:\\custom\\npm-prefix" }, platform: "win32" },
      ],
      ["/detected/global/node_modules/arashi", { npmGlobalRoot: "/detected/global/node_modules" }],
    ] as const) {
      const spawn = createSuccessfulSpawn();
      expect(
        await runEntrypoint(["uninstall", "--yes"], {
          ...options,
          rootDir,
          realpathSyncImpl: (path: string) => path,
          spawnImpl: spawn.spawnImpl,
          log: () => {},
        }),
      ).toBe(0);
      expect(spawn.calls).toEqual([{ command: "npm", args: ["uninstall", "-g", "arashi"] }]);
    }
  });

  test("keeps POSIX package ownership paths case-sensitive", async () => {
    const spawn = createSuccessfulSpawn();
    const errors: string[] = [];
    expect(
      await runEntrypoint(["uninstall", "--yes"], {
        env: { HOME: "/home/Alice" },
        error: (line: string) => errors.push(line),
        platform: "linux",
        realpathSyncImpl: (path: string) => path,
        rootDir: "/home/alice/.bun/install/global/node_modules/arashi",
        spawnImpl: spawn.spawnImpl,
      }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/not proven/i);
    expect(spawn.calls).toEqual([]);
  });

  test("does not infer global npm ownership from a project-local lib/node_modules path", async () => {
    const spawn = createSuccessfulSpawn();
    const errors: string[] = [];
    expect(
      await runEntrypoint(["uninstall", "--yes"], {
        error: (line: string) => errors.push(line),
        realpathSyncImpl: (path: string) => path,
        rootDir: "/workspace/project/lib/node_modules/arashi",
        spawnImpl: spawn.spawnImpl,
      }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/not proven/i);
    expect(spawn.calls).toEqual([]);
  });

  test("recognizes the Yarn Classic Windows LocalAppData global package root", async () => {
    const spawn = createSuccessfulSpawn();
    expect(
      await runEntrypoint(["uninstall", "--yes"], {
        env: { LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local" },
        platform: "win32",
        realpathSyncImpl: (path: string) => path,
        rootDir: "C:\\Users\\A\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\arashi",
        spawnImpl: spawn.spawnImpl,
        log: () => {},
      }),
    ).toBe(0);
    expect(spawn.calls).toEqual([{ command: "yarn", args: ["global", "remove", "arashi"] }]);
  });

  test("refuses ambiguous inferred roots without executing a manager", async () => {
    const spawn = createSuccessfulSpawn();
    const errors: string[] = [];
    expect(
      await runEntrypoint(["uninstall", "--yes"], {
        env: { HOME: "/home/a" },
        npmGlobalRoot: "/home/a/.config/yarn/global/node_modules",
        realpathSyncImpl: (path: string) => path,
        rootDir: "/home/a/.config/yarn/global/node_modules/arashi",
        error: (line: string) => errors.push(line),
        spawnImpl: spawn.spawnImpl,
      }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/ambiguous/i);
    expect(spawn.calls).toEqual([]);
  });

  test("dry-run prints one exact manager command without spawning", async () => {
    const spawn = createSuccessfulSpawn();
    const output: string[] = [];
    expect(
      await runEntrypoint(["uninstall", "-n"], {
        ownerEvidence: ["pnpm"],
        spawnImpl: spawn.spawnImpl,
        log: (line: string) => output.push(line),
      }),
    ).toBe(0);
    expect(output.join("\n")).toContain("pnpm remove -g arashi");
    expect(spawn.calls).toEqual([]);
  });

  test("interactive package removal defaults to no", async () => {
    const spawn = createSuccessfulSpawn();
    const confirmCalls: boolean[] = [];
    expect(
      await runEntrypoint(["uninstall"], {
        confirm: async (defaultValue: boolean) => {
          confirmCalls.push(defaultValue);
          return false;
        },
        interactive: true,
        ownerEvidence: ["npm"],
        spawnImpl: spawn.spawnImpl,
        log: () => {},
      }),
    ).toBe(0);
    expect(confirmCalls).toEqual([false]);
    expect(spawn.calls).toEqual([]);
  });

  test.each([
    [["npm", "pnpm"], /ambiguous/i],
    [["yarn-berry"], /unsupported/i],
    [[], /not proven/i],
  ])("refuses conflicting, unsupported, or absent evidence", async (ownerEvidence, message) => {
    const spawn = createSuccessfulSpawn();
    const errors: string[] = [];
    expect(
      await runEntrypoint(["uninstall", "--yes"], {
        ownerEvidence,
        error: (line: string) => errors.push(line),
        spawnImpl: spawn.spawnImpl,
      }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(message);
    expect(spawn.calls).toEqual([]);
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
    expect(spawn.calls[0].args).toEqual(["/package/bin/arashi", "--version"]);
    expect(spawn.calls[0].command).toBe("/bin/bash");
  });

  test.each([
    ["completion", "bash"],
    ["shell", "init", "bash"],
  ])("keeps source-output first use silent for %s", async (...argv) => {
    const output: string[] = [];
    await ensureInstalled({
      argv,
      existsSyncImpl: () => false,
      installBinaryImpl: async (options: { log: (line: string) => void }) => {
        options.log("installer progress");
        return { status: "installed" };
      },
      log: (line: string) => output.push(line),
    });
    expect(output).toEqual([]);
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

  test("explicit install formats asynchronous failures inside the entrypoint", async () => {
    const errors: string[] = [];
    const exitCode = await runEntrypoint(["install"], {
      error: (line: string) => errors.push(line),
      installBinaryImpl: async () => {
        await Promise.resolve();
        throw new Error("async install sentinel");
      },
    });

    expect(exitCode).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("✗ Failed to install arashi: async install sentinel");
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
