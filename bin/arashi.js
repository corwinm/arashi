#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatInstallError, getPlatformInfo, installBinary } from "./install-binary.js";
import { runNpmManagedUpdate } from "./update.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const currentPlatform = process.platform;
const currentArch = process.arch;
const isWindows = currentPlatform === "win32";

export function getDefaultBinaryName(platform = currentPlatform) {
  return platform === "win32" ? "arashi.bin.exe" : "arashi.bin";
}

export function getWrapperName(platform = currentPlatform) {
  return platform === "win32" ? "arashi.bat" : "arashi";
}

export function resolvePlatformBinaryName({ arch = currentArch, platform = currentPlatform } = {}) {
  return getPlatformInfo({ arch, platform }).binaryName;
}

export function resolveBinaryPath(options = {}) {
  const binDir = options.binDir ?? __dirname;
  const platform = options.platform ?? currentPlatform;
  const arch = options.arch ?? currentArch;
  const exists = options.existsSyncImpl ?? existsSync;
  const defaultBinaryPath = join(binDir, getDefaultBinaryName(platform));

  if (exists(defaultBinaryPath)) {
    return defaultBinaryPath;
  }

  try {
    return join(binDir, resolvePlatformBinaryName({ arch, platform }));
  } catch {
    return defaultBinaryPath;
  }
}

export function hasRunnableBinary(options = {}) {
  const binDir = options.binDir ?? __dirname;
  const platform = options.platform ?? currentPlatform;
  const arch = options.arch ?? currentArch;
  const exists = options.existsSyncImpl ?? existsSync;

  if (exists(join(binDir, getDefaultBinaryName(platform)))) {
    return true;
  }

  try {
    return exists(join(binDir, resolvePlatformBinaryName({ arch, platform })));
  } catch {
    return false;
  }
}

export async function ensureInstalled(options = {}) {
  const binDir = options.binDir ?? __dirname;
  const rootDir = options.rootDir ?? join(binDir, "..");
  const platform = options.platform ?? currentPlatform;
  const arch = options.arch ?? currentArch;
  const log = options.log ?? console.log;
  const installBinaryImpl = options.installBinaryImpl ?? installBinary;

  if (hasRunnableBinary({ arch, binDir, existsSyncImpl: options.existsSyncImpl, platform })) {
    return { status: "already-installed" };
  }

  log("arashi binary missing; installing the matching platform binary before continuing.");
  return installBinaryImpl({ ...options, arch, binDir, log, platform, rootDir });
}

export function isExplicitInstallCommand(argv) {
  return argv[0] === "install";
}

export function isExplicitUpdateCommand(argv) {
  return argv[0] === "update";
}

async function runExplicitInstall(options) {
  const binDir = options.binDir ?? __dirname;
  const rootDir = options.rootDir ?? join(binDir, "..");
  const installBinaryImpl = options.installBinaryImpl ?? installBinary;

  await installBinaryImpl({ ...options, binDir, rootDir });
}

function spawnArashi(argv, options = {}) {
  const binDir = options.binDir ?? __dirname;
  const platform = options.platform ?? currentPlatform;
  const windows = platform === "win32";
  const spawnImpl = options.spawnImpl ?? spawn;
  const wrapperPath = join(binDir, getWrapperName(platform));
  const binaryPath = resolveBinaryPath({
    arch: options.arch,
    binDir,
    existsSyncImpl: options.existsSyncImpl,
    platform,
  });

  return new Promise((resolve) => {
    const child = windows
      ? spawnImpl(binaryPath, argv, {
        stdio: "inherit",
        windowsHide: false,
      })
      : spawnImpl(wrapperPath, argv, { stdio: "inherit" });

    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }

      resolve(signal ? 1 : 0);
    });

    child.on("error", (error) => {
      const errorLog = options.error ?? console.error;
      errorLog(`Failed to start arashi. ${error.message}.`);
      resolve(1);
    });
  });
}

export async function runEntrypoint(argv = process.argv.slice(2), options = {}) {
  const errorLog = options.error ?? console.error;

  try {
    if (isExplicitInstallCommand(argv)) {
      await runExplicitInstall(options);
      return 0;
    }

    if (isExplicitUpdateCommand(argv)) {
      return runNpmManagedUpdate(argv.slice(1), options);
    }

    await ensureInstalled(options);
  } catch (error) {
    errorLog(formatInstallError(error));
    return 1;
  }

  return spawnArashi(argv, options);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  process.exitCode = await runEntrypoint();
}
