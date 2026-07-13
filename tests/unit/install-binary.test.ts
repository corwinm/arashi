import {
  UnsupportedPlatformError,
  buildReleaseAssetUrl,
  getPlatformInfo,
  installBinary,
  isBinaryInstalled,
} from "../../bin/install-binary.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arashi-install-binary-"));
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("install-binary platform resolution", () => {
  test("maps supported platforms to release asset names", () => {
    expect(getPlatformInfo({ arch: "arm64", platform: "darwin" }).binaryName).toBe(
      "arashi-macos-arm64",
    );
    expect(getPlatformInfo({ arch: "x64", platform: "linux" }).binaryName).toBe("arashi-linux-x64");
    expect(getPlatformInfo({ arch: "x64", platform: "win32" }).binaryName).toBe(
      "arashi-windows-x64.exe",
    );
  });

  test("throws a clear error for unsupported platforms", () => {
    expect(() => getPlatformInfo({ arch: "arm64", platform: "linux" })).toThrow(
      UnsupportedPlatformError,
    );
  });

  test("builds version-specific GitHub release URLs", () => {
    expect(buildReleaseAssetUrl("1.2.3", "arashi-linux-x64")).toBe(
      "https://github.com/corwinm/arashi/releases/download/v1.2.3/arashi-linux-x64",
    );
  });

  test("detects whether a binary is already installed", async () => {
    await expect(isBinaryInstalled("/already-there", { accessImpl: async () => {} })).resolves.toBe(
      true,
    );
    await expect(
      isBinaryInstalled("/missing", {
        accessImpl: async () => {
          throw new Error("missing");
        },
      }),
    ).resolves.toBe(false);
  });
});

describe("installBinary", () => {
  test("downloads, chmods, verifies, and reports a successful install", async () => {
    const chmodCalls: { mode: number; path: string }[] = [];
    const verifyCalls: string[] = [];
    const logs: string[] = [];

    const result = await installBinary({
      arch: "x64",
      binDir: tempDir,
      chmodImpl: (path: string, mode: number) => {
        chmodCalls.push({ mode, path: String(path) });
      },
      downloadFileImpl: async (_url: string, dest: string) => {
        await writeFile(String(dest), "binary");
      },
      log: (message: string) => logs.push(message),
      platform: "linux",
      verifyBinaryImpl: (path: string) => {
        verifyCalls.push(String(path));
      },
      version: "1.2.3",
    });

    const binaryPath = join(tempDir, "arashi-linux-x64");
    expect(result.status).toBe("installed");
    expect(result.downloadUrl).toBe(
      "https://github.com/corwinm/arashi/releases/download/v1.2.3/arashi-linux-x64",
    );
    expect(existsSync(binaryPath)).toBe(true);
    expect(chmodCalls).toEqual([{ mode: 0o755, path: binaryPath }]);
    expect(verifyCalls).toEqual([binaryPath]);
    expect(logs.some((line) => line.includes("Successfully installed"))).toBe(true);
  });

  test("removes partial downloads when verification fails", async () => {
    const binaryPath = join(tempDir, "arashi-linux-x64");

    await expect(
      installBinary({
        arch: "x64",
        binDir: tempDir,
        chmodImpl: () => {},
        downloadFileImpl: async (_url: string, dest: string) => {
          await writeFile(String(dest), "partial");
        },
        log: () => {},
        platform: "linux",
        verifyBinaryImpl: () => {
          throw new Error("bad binary");
        },
        version: "1.2.3",
      }),
    ).rejects.toThrow("bad binary");

    expect(existsSync(binaryPath)).toBe(false);
  });

  test("does not download when a matching binary already exists", async () => {
    const binaryPath = join(tempDir, "arashi-linux-x64");
    await writeFile(binaryPath, "existing");
    let downloaded = false;

    const result = await installBinary({
      arch: "x64",
      binDir: tempDir,
      downloadFileImpl: async () => {
        downloaded = true;
      },
      log: () => {},
      platform: "linux",
      version: "1.2.3",
    });

    expect(result.status).toBe("already-installed");
    expect(downloaded).toBe(false);
  });

  test("force refresh replaces an existing binary for update flows", async () => {
    const binaryPath = join(tempDir, "arashi-linux-x64");
    await writeFile(binaryPath, "existing");
    let downloaded = false;

    const result = await installBinary({
      arch: "x64",
      binDir: tempDir,
      chmodImpl: () => {},
      downloadFileImpl: async (_url: string, dest: string) => {
        downloaded = true;
        await writeFile(String(dest), "new binary");
      },
      force: true,
      log: () => {},
      platform: "linux",
      verifyBinaryImpl: () => {},
      version: "2.0.0",
    });

    expect(result.status).toBe("installed");
    expect(downloaded).toBe(true);
  });
});
