#!/usr/bin/env node

/**
 * Post-install script to download the platform-specific arashi binary from GitHub releases
 * This keeps the npm package size small while providing pre-compiled binaries
 */

import { createWriteStream, chmodSync } from "node:fs";
import { mkdir, access, constants } from "node:fs/promises";
import { get } from "node:https";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE_NAME = "arashi";
const GITHUB_REPO = "corwinm/arashi";

// Determine platform and binary name
function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  let binaryName;
  if (platform === "darwin" && arch === "arm64") {
    binaryName = `${PACKAGE_NAME}-macos-arm64`;
  } else if (platform === "linux" && arch === "x64") {
    binaryName = `${PACKAGE_NAME}-linux-x64`;
  } else if (platform === "win32" && arch === "x64") {
    binaryName = `${PACKAGE_NAME}-windows-x64.exe`;
  } else {
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. Please build from source or file an issue at https://github.com/${GITHUB_REPO}/issues`
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
        downloadFile(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        reject(
          new Error(
            `Failed to download: ${response.statusCode} ${response.statusMessage}`
          )
        );
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

// Main installation logic
async function install() {
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
    const { readFile } = await import("node:fs/promises");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
    const { version } = packageJson;

    const { binaryName, isWindows } = getPlatformInfo();
    const binDir = join(__dirname, "..", "bin");
    const binaryPath = join(binDir, binaryName);

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

    console.log(`✓ Successfully installed ${PACKAGE_NAME} v${version}`);
    console.log(`  Binary location: ${binaryPath}`);
  } catch (error) {
    console.error(`✗ Failed to install ${PACKAGE_NAME}:`, error.message);
    console.error(
      `\nYou can manually download binaries from: https://github.com/${GITHUB_REPO}/releases`
    );
    process.exit(1);
  }
}

install();
