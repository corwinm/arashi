#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const argv = process.argv.slice(2);
const isWindows = process.platform === "win32";

const resolveBinaryPath = () => {
  const defaultBinary = isWindows ? "arashi.bin.exe" : "arashi.bin";
  const defaultBinaryPath = join(__dirname, defaultBinary);

  if (existsSync(defaultBinaryPath)) {
    return defaultBinaryPath;
  }

  if (isWindows) {
    return join(__dirname, "arashi-windows-x64.exe");
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    return join(__dirname, "arashi-macos-arm64");
  }

  if (process.platform === "linux" && process.arch === "x64") {
    return join(__dirname, "arashi-linux-x64");
  }

  return defaultBinaryPath;
};

const ensureInstalled = () => {
  const wrapper = isWindows ? "arashi.bat" : "arashi";
  const wrapperPath = join(__dirname, wrapper);
  const postinstallPath = join(__dirname, "..", "scripts", "postinstall.js");
  const defaultBinary = isWindows ? "arashi.bin.exe" : "arashi.bin";
  const defaultBinaryPath = join(__dirname, defaultBinary);
  const platformBinary = (() => {
    if (isWindows) {
      return "arashi-windows-x64.exe";
    }

    if (process.platform === "darwin" && process.arch === "arm64") {
      return "arashi-macos-arm64";
    }

    if (process.platform === "linux" && process.arch === "x64") {
      return "arashi-linux-x64";
    }

    return null;
  })();
  const platformBinaryPath = platformBinary ? join(__dirname, platformBinary) : null;
  const binaryExists = () => {
    if (existsSync(defaultBinaryPath)) {
      return true;
    }

    if (platformBinaryPath && existsSync(platformBinaryPath)) {
      return true;
    }

    return false;
  };

  if (existsSync(wrapperPath) && binaryExists()) {
    return;
  }

  console.log("arashi binary missing; running postinstall to download.");
  const result = spawnSync(process.execPath, [postinstallPath], { stdio: "inherit" });

  if (result.error) {
    console.error(`Failed to run postinstall. ${result.error.message}.`);
    process.exit(1);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
};

ensureInstalled();
const wrapper = isWindows ? "arashi.bat" : "arashi";
const wrapperPath = join(__dirname, wrapper);
const binaryPath = resolveBinaryPath();

const child = isWindows
  ? spawn(binaryPath, argv, {
    stdio: "inherit",
    windowsHide: false,
  })
  : spawn(wrapperPath, argv, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }

  process.exit(signal ? 1 : 0);
});

child.on("error", (error) => {
  console.error(`Failed to start arashi. ${error.message}.`);
  process.exit(1);
});
