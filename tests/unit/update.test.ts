import { dirname } from "node:path";
import {
  compareVersions,
  detectNpmManagedInstall,
  fetchLatestPackageVersion,
  formatManualUpdateGuidance,
  runNpmManagedUpdate,
  selectPackageManagerCommand,
} from "../../bin/update.js";
import { describe, expect, test } from "vitest";

interface MockPackageResponse {
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
  statusText: string;
}

interface InstallBinaryOptions {
  force?: boolean;
  rootDir?: string;
  version?: string;
}

interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

interface SpawnCall {
  args: string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

function createResponse(body: unknown, ok = true): MockPackageResponse {
  return {
    json: () => Promise.resolve(body),
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
  };
}

const selectCommand = selectPackageManagerCommand as (options?: {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
}) => { args: string[]; command: string; label: string } | null;

describe("update helpers", () => {
  test("compares semantic versions", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("v2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("fetches latest npm package version with injectable fetch", async () => {
    const version = await fetchLatestPackageVersion({
      fetchImpl: ((input: string | URL | Request) => {
        expect(input).toBe("https://registry.npmjs.org/arashi/latest");
        return Promise.resolve(createResponse({ version: "9.8.7" }) as Response);
      }) as typeof fetch,
    });

    expect(version).toBe("9.8.7");
  });

  test("detects npm-managed install only with package metadata", () => {
    expect(
      detectNpmManagedInstall({
        metadata: { name: "arashi", version: "1.0.0" },
        rootDir: "/pkg",
      }),
    ).toEqual({ method: "npm-managed", rootDir: "/pkg", version: "1.0.0" });
    expect(
      detectNpmManagedInstall({ metadata: { name: "other", version: "1.0.0" }, rootDir: "/pkg" }),
    ).toEqual({
      method: "ambiguous",
    });
  });

  test("selects supported package-manager commands from npm user agent", () => {
    expect(
      selectPackageManagerCommand({ env: { npm_config_user_agent: "pnpm/9 node/v20" } }),
    ).toMatchObject({
      args: ["add", "-g", "arashi@latest"],
      command: "pnpm",
    });
    expect(
      selectPackageManagerCommand({ env: { npm_config_user_agent: "npm/10 node/v20" } }),
    ).toMatchObject({
      args: ["install", "-g", "arashi@latest"],
      command: "npm",
    });
    expect(
      selectPackageManagerCommand({ env: { npm_execpath: "/Users/corwin/.vite-plus/bin/vp" } }),
    ).toMatchObject({
      args: ["update", "-g", "arashi"],
      command: "vp",
    });
    expect(
      // The JavaScript implementation accepts rootDir, but TypeScript cannot infer it from the
      // defaulted destructuring signature.
      selectPackageManagerCommand({
        env: {
          HOME: "/Users/corwin",
          npm_config_user_agent: "npm/10 node/v22",
        },
        // @ts-expect-error rootDir is a supported runtime option
        rootDir: "/Users/corwin/.vite-plus/packages/arashi/current/package",
      }),
    ).toMatchObject({
      args: ["update", "-g", "arashi"],
      command: "vp",
    });
    expect(selectPackageManagerCommand({ env: {} })).toBeNull();
  });

  test("detects package managers from standard Windows global install roots", () => {
    expect(
      selectCommand({
        env: { APPDATA: String.raw`C:\Users\corwin\AppData\Roaming` },
        rootDir: String.raw`C:\Users\corwin\AppData\Roaming\npm\node_modules\arashi`,
      }),
    ).toMatchObject({ command: "npm" });
    expect(
      selectCommand({
        env: { LOCALAPPDATA: String.raw`C:\Users\corwin\AppData\Local` },
        rootDir: String.raw`C:\Users\corwin\AppData\Local\pnpm\global\5\.pnpm\arashi@1.24.0\node_modules\arashi`,
      }),
    ).toMatchObject({ command: "pnpm" });
    expect(
      selectCommand({
        env: { LOCALAPPDATA: String.raw`C:\Users\corwin\AppData\Local` },
        rootDir: String.raw`C:\Users\corwin\AppData\Local\Yarn\Data\global\node_modules\arashi`,
      }),
    ).toMatchObject({ command: "yarn" });
    expect(
      selectCommand({
        env: { USERPROFILE: String.raw`C:\Users\corwin` },
        rootDir: String.raw`C:\Users\corwin\.bun\install\global\node_modules\arashi`,
      }),
    ).toMatchObject({ command: "bun" });
  });

  test("prefers verified install roots over unrelated caller package-manager variables", () => {
    expect(
      selectCommand({
        env: {
          LOCALAPPDATA: String.raw`C:\Users\corwin\AppData\Local`,
          npm_config_user_agent: "npm/11 node/v24",
        },
        rootDir: String.raw`C:\Users\corwin\AppData\Local\pnpm\global\5\node_modules\arashi`,
      }),
    ).toMatchObject({ command: "pnpm" });
    expect(
      selectCommand({
        env: {
          APPDATA: String.raw`C:\Users\corwin\AppData\Roaming`,
          npm_config_user_agent: "pnpm/10 node/v24",
        },
        rootDir: String.raw`C:\Users\corwin\AppData\Roaming\npm\node_modules\arashi`,
      }),
    ).toMatchObject({ command: "npm" });
  });

  test("does not let an unrelated Vite+ lookalike override caller provenance", () => {
    expect(
      selectCommand({
        env: {
          HOME: String.raw`C:\Users\corwin`,
          npm_config_user_agent: "npm/11 node/v24",
        },
        rootDir: String.raw`C:\workspace\.vite-plus\node_modules\arashi`,
      }),
    ).toMatchObject({ command: "npm" });
  });

  test("normalizes case and slash styles when detecting Windows npm installs", () => {
    expect(
      selectCommand({
        env: { appdata: "c:/users/corwin/appdata/roaming" },
        rootDir: "C:/USERS/CORWIN/APPDATA/ROAMING/NPM/NODE_MODULES/ARASHI",
      }),
    ).toMatchObject({ command: "npm" });
  });

  test("rejects local paths that resemble package-manager global layouts", () => {
    const env = {
      APPDATA: String.raw`C:\Users\corwin\AppData\Roaming`,
      LOCALAPPDATA: String.raw`C:\Users\corwin\AppData\Local`,
      USERPROFILE: String.raw`C:\Users\corwin`,
    };

    for (const rootDir of [
      String.raw`C:\workspace\npm\node_modules\arashi`,
      String.raw`D:\yarn\global\node_modules\arashi`,
      String.raw`C:\foo\pnpm\global\5\node_modules\arashi`,
      String.raw`C:\workspace\app\node_modules\.pnpm\arashi@1.24.0\node_modules\arashi`,
      String.raw`D:\users\corwin\.bun\install\global\node_modules\arashi`,
    ]) {
      expect(selectCommand({ env, rootDir })).toBeNull();
    }
  });

  test("formats direct-binary manual guidance with platform asset", () => {
    expect(formatManualUpdateGuidance("2.0.0", { binaryName: "arashi-linux-x64" })).toContain(
      "arashi-linux-x64",
    );
  });
});

describe("npm-managed update flow", () => {
  test("check mode reports available update without mutating", async () => {
    const logs: string[] = [];
    let spawned = false;
    let installed = false;

    const exitCode = await runNpmManagedUpdate(["--check"], {
      installBinaryImpl: () => {
        installed = true;
        return Promise.resolve({});
      },
      latestVersion: "2.0.0",
      log: (line: string) => logs.push(line),
      metadata: { name: "arashi", version: "1.0.0" },
      rootDir: "/pkg",
      spawnSyncImpl: () => {
        spawned = true;
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(spawned).toBe(false);
    expect(installed).toBe(false);
    expect(logs.join("\n")).toContain("Update available");
  });

  test("dry run prints selected command and skips mutation", async () => {
    const logs: string[] = [];
    let spawned = false;

    const exitCode = await runNpmManagedUpdate(["--dry-run"], {
      env: { npm_config_user_agent: "bun/1.2" },
      latestVersion: "2.0.0",
      log: (line: string) => logs.push(line),
      metadata: { name: "arashi", version: "1.0.0" },
      rootDir: "/pkg",
      spawnSyncImpl: () => {
        spawned = true;
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(spawned).toBe(false);
    expect(logs.join("\n")).toContain("bun add -g arashi@latest");
  });

  test("uses the computed install root to select a Windows package manager", async () => {
    const logs: string[] = [];

    const exitCode = await runNpmManagedUpdate(["--dry-run"], {
      binDir: "C:/Users/corwin/AppData/Roaming/npm/node_modules/arashi/bin",
      env: { APPDATA: "C:/Users/corwin/AppData/Roaming" },
      latestVersion: "2.0.0",
      log: (message: string) => logs.push(message),
      metadata: { name: "arashi", version: "1.0.0" },
      platform: "win32",
    });

    expect(exitCode).toBe(0);
    expect(logs).toContain("Selected update command: npm install -g arashi@latest");
  });

  test("non-interactive mutation requires --yes", async () => {
    const errors: string[] = [];
    let spawned = false;

    const exitCode = await runNpmManagedUpdate([], {
      env: { npm_config_user_agent: "npm/10" },
      error: (line: string) => errors.push(line),
      latestVersion: "2.0.0",
      log: () => {},
      metadata: { name: "arashi", version: "1.0.0" },
      rootDir: "/pkg",
      spawnSyncImpl: () => {
        spawned = true;
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(1);
    expect(spawned).toBe(false);
    expect(errors.join("\n")).toContain("--yes");
  });

  test("runs Windows package-manager shims safely through cmd.exe", async () => {
    const spawnCalls: SpawnCall[] = [];
    const rootDir = String.raw`C:\Users\corwin\AppData\Roaming\npm\node_modules\arashi`;
    const updateCwd = String.raw`C:\Program Files\nodejs`;

    const exitCode = await runNpmManagedUpdate(["--yes"], {
      env: {
        APPDATA: String.raw`C:\Users\corwin\AppData\Roaming`,
        ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      },
      installBinaryImpl: () =>
        Promise.resolve({ binaryPath: `${rootDir}\\bin\\arashi-windows-x64.exe` }),
      latestVersion: "2.0.0",
      log: () => {},
      metadata: { name: "arashi", version: "1.0.0" },
      platform: "win32",
      readFileImpl: () => Promise.resolve(JSON.stringify({ name: "arashi", version: "2.0.0" })),
      rootDir,
      spawnSyncImpl: (command: string, args: string[], options: SpawnOptions) => {
        spawnCalls.push({
          args,
          command,
          cwd: options.cwd,
          env: options.env,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
        });
        return { status: 0 };
      },
      updateCwd,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      args: [
        "/d",
        "/v:off",
        "/s",
        "/c",
        '"%ARASHI_CMD_ARGUMENT_0% %ARASHI_CMD_ARGUMENT_1% %ARASHI_CMD_ARGUMENT_2% %ARASHI_CMD_ARGUMENT_3%"',
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      cwd: updateCwd,
      windowsVerbatimArguments: true,
    });
    expect(spawnCalls[0].env).toMatchObject({
      ARASHI_CMD_ARGUMENT_0: '"npm"',
      ARASHI_CMD_ARGUMENT_1: '"install"',
      ARASHI_CMD_ARGUMENT_2: '"-g"',
      ARASHI_CMD_ARGUMENT_3: '"arashi@latest"',
    });
  });

  test("refreshes the binary in pnpm's active global package after an upgrade", async () => {
    const installCalls: InstallBinaryOptions[] = [];
    const spawnCalls: SpawnCall[] = [];
    const oldRoot = String.raw`C:\Users\corwin\AppData\Local\pnpm\global\5\.pnpm\arashi@1.24.0\node_modules\arashi`;
    const activeRoot = String.raw`C:\Users\corwin\AppData\Local\pnpm\global\5\node_modules\arashi`;
    const updateCwd = String.raw`C:\Program Files\nodejs`;

    const exitCode = await runNpmManagedUpdate(["--yes"], {
      env: {
        ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
        LOCALAPPDATA: String.raw`C:\Users\corwin\AppData\Local`,
      },
      installBinaryImpl: (options: InstallBinaryOptions) => {
        installCalls.push(options);
        return Promise.resolve({ binaryPath: `${options.rootDir}\\bin\\arashi-windows-x64.exe` });
      },
      latestVersion: "2.0.0",
      log: () => {},
      metadata: { name: "arashi", version: "1.24.0" },
      platform: "win32",
      readFileImpl: (path: string) =>
        Promise.resolve(
          JSON.stringify({
            name: "arashi",
            version: path.startsWith(activeRoot) ? "2.0.0" : "1.24.0",
          }),
        ),
      rootDir: oldRoot,
      spawnSyncImpl: (command: string, args: string[], options: SpawnOptions) => {
        spawnCalls.push({ args, command, cwd: options.cwd, env: options.env });
        if (spawnCalls.length === 2) {
          return { status: 0, stdout: `${activeRoot.slice(0, -7)}\r\n` };
        }
        return { status: 0 };
      },
      updateCwd,
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls.every((call) => call.cwd === updateCwd)).toBe(true);
    expect(spawnCalls[1].env).toMatchObject({
      ARASHI_CMD_ARGUMENT_0: '"pnpm"',
      ARASHI_CMD_ARGUMENT_1: '"root"',
      ARASHI_CMD_ARGUMENT_2: '"-g"',
    });
    expect(installCalls).toEqual([
      expect.objectContaining({ force: true, rootDir: activeRoot, version: "2.0.0" }),
    ]);
  });

  test("runs package manager and forces binary refresh with --yes", async () => {
    const spawnCalls: SpawnCall[] = [];
    const installCalls: InstallBinaryOptions[] = [];

    const exitCode = await runNpmManagedUpdate(["--yes"], {
      env: { npm_config_user_agent: "npm/10" },
      installBinaryImpl: (options: InstallBinaryOptions) => {
        installCalls.push(options);
        return Promise.resolve({ binaryPath: "/pkg/bin/arashi-linux-x64" });
      },
      latestVersion: "2.0.0",
      log: () => {},
      metadata: { name: "arashi", version: "1.0.0" },
      platform: "linux",
      readFileImpl: () => Promise.resolve(JSON.stringify({ name: "arashi", version: "2.0.0" })),
      rootDir: "/pkg",
      spawnSyncImpl: (command: string, args: string[], options: SpawnOptions) => {
        spawnCalls.push({ args, command, cwd: options.cwd });
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([
      { args: ["install", "-g", "arashi@latest"], command: "npm", cwd: dirname(process.execPath) },
    ]);
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0].force).toBe(true);
    expect(installCalls[0].version).toBe("2.0.0");
  });
});
