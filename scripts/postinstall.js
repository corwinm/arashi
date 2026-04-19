#!/usr/bin/env node

/**
 * Post-install script to download the platform-specific arashi binary from GitHub releases
 * This keeps the npm package size small while providing pre-compiled binaries
 */

import { access, constants, mkdir, readFile, rm } from "node:fs/promises";
import { chmodSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_NAME = "arashi";
const GITHUB_REPO = "corwinm/arashi";

// Determine platform and binary name
function getPlatformInfo() {
  const { platform } = process;
  const { arch } = process;

  let binaryName = "";
  if (platform === "darwin" && arch === "arm64") {
    binaryName = `${PACKAGE_NAME}-macos-arm64`;
  } else if (platform === "linux" && arch === "x64") {
    binaryName = `${PACKAGE_NAME}-linux-x64`;
  } else if (platform === "win32" && arch === "x64") {
    binaryName = `${PACKAGE_NAME}-windows-x64.exe`;
  } else {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. Please build from source or file an issue at https://github.com/${GITHUB_REPO}/issues`,
    );
  }

  return { binaryName, isWindows: platform === "win32" };
}

// Download file from URL
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url}...`);

    const file = createWriteStream(dest);
    const request = get(url, (response) => {
      // Handle redirects
      if (
        response.statusCode === 301 ||
        response.statusCode === 302 ||
        response.statusCode === 307
      ) {
        file.close();
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
        return;
      }

      response.pipe(file);

      file.on("finish", () => {
        file.close(resolve);
      });
    });

    request.on("error", (err) => {
      file.close();
      reject(err);
    });

    file.on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

function verifyBinary(binaryPath) {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const signalDetail = result.signal ? ` (signal: ${result.signal})` : "";
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `Downloaded binary failed smoke test with exit code ${result.status ?? "unknown"}${signalDetail}${output ? `: ${output}` : ""}`,
    );
  }

  const versionOutput = (result.stdout ?? "").trim();
  if (!versionOutput) {
    throw new Error("Downloaded binary returned success but produced no version output");
  }

  console.log(`✓ Verified ${PACKAGE_NAME} executable (${versionOutput})`);
}

// Main installation logic
async function install() {
  let binaryPath = "";

  try {
    // Skip postinstall in development (when installing from the repo)
    // Check if we're in development by looking for src/ directory
    const srcDir = join(__dirname, "..", "src");
    try {
      await access(srcDir, constants.F_OK);
      console.log("✓ Development environment detected, skipping binary download");
      console.log("  Run 'bun run build' to build binary locally");
      return;
    } catch {
      // Not in development, continue with download
    }

    // Get version from package.json
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const { version } = packageJson;

    const { binaryName, isWindows } = getPlatformInfo();
    const binDir = join(__dirname, "..", "bin");
    binaryPath = join(binDir, binaryName);

    // Check if binary already exists
    try {
      await access(binaryPath, constants.F_OK);
      console.log(`✓ Binary already exists at ${binaryPath}`);
      return;
    } catch {
      // Binary doesn't exist, continue with download
    }

    // Ensure bin directory exists
    await mkdir(binDir, { recursive: true });

    // Download binary from GitHub releases
    const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

    await downloadFile(downloadUrl, binaryPath);

    // Make binary executable (Unix-like systems)
    if (!isWindows) {
      chmodSync(binaryPath, 0o755);
    }

    verifyBinary(binaryPath);

    console.log(`✓ Successfully installed ${PACKAGE_NAME} v${version}`);
    console.log(`  Binary location: ${binaryPath}`);
  } catch (error) {
    if (binaryPath) {
      await rm(binaryPath, { force: true }).catch(() => {});
    }

    console.error(`✗ Failed to install ${PACKAGE_NAME}:`, error.message);
    console.error(
      `\nYou can manually download binaries from: https://github.com/${GITHUB_REPO}/releases`,
    );
    process.exit(1);
  }
}

await install();
