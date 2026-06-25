import {
  compareVersions,
  detectNpmManagedInstall,
  fetchLatestPackageVersion,
  formatManualUpdateGuidance,
  runNpmManagedUpdate,
  selectPackageManagerCommand,
} from "../../bin/update.js";
import { describe, expect, test } from "bun:test";

function createResponse(body, ok = true) {
  return {
    json: () => Promise.resolve(body),
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
  };
}

describe("update helpers", () => {
  test("compares semantic versions", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("v2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("fetches latest npm package version with injectable fetch", async () => {
    const version = await fetchLatestPackageVersion({
      fetchImpl: (url) => {
        expect(url).toBe("https://registry.npmjs.org/arashi/latest");
        return Promise.resolve(createResponse({ version: "9.8.7" }));
      },
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
    expect(selectPackageManagerCommand({ env: {} })).toBeNull();
  });

  test("formats direct-binary manual guidance with platform asset", () => {
    expect(formatManualUpdateGuidance("2.0.0", { binaryName: "arashi-linux-x64" })).toContain(
      "arashi-linux-x64",
    );
  });
});

describe("npm-managed update flow", () => {
  test("check mode reports available update without mutating", async () => {
    const logs = [];
    let spawned = false;
    let installed = false;

    const exitCode = await runNpmManagedUpdate(["--check"], {
      installBinaryImpl: () => {
        installed = true;
        return Promise.resolve({});
      },
      latestVersion: "2.0.0",
      log: (line) => logs.push(line),
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
    const logs = [];
    let spawned = false;

    const exitCode = await runNpmManagedUpdate(["--dry-run"], {
      env: { npm_config_user_agent: "bun/1.2" },
      latestVersion: "2.0.0",
      log: (line) => logs.push(line),
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

  test("non-interactive mutation requires --yes", async () => {
    const errors = [];
    let spawned = false;

    const exitCode = await runNpmManagedUpdate([], {
      env: { npm_config_user_agent: "npm/10" },
      error: (line) => errors.push(line),
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

  test("runs package manager and forces binary refresh with --yes", async () => {
    const spawnCalls = [];
    const installCalls = [];

    const exitCode = await runNpmManagedUpdate(["--yes"], {
      env: { npm_config_user_agent: "npm/10" },
      installBinaryImpl: (options) => {
        installCalls.push(options);
        return Promise.resolve({ binaryPath: "/pkg/bin/arashi-linux-x64" });
      },
      latestVersion: "2.0.0",
      log: () => {},
      metadata: { name: "arashi", version: "1.0.0" },
      readFileImpl: () => Promise.resolve(JSON.stringify({ name: "arashi", version: "2.0.0" })),
      rootDir: "/pkg",
      spawnSyncImpl: (command, args, options) => {
        spawnCalls.push({ args, command, cwd: options.cwd });
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([
      { args: ["install", "-g", "arashi@latest"], command: "npm", cwd: "/pkg" },
    ]);
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0].force).toBe(true);
    expect(installCalls[0].version).toBe("2.0.0");
  });
});
