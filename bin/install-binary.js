import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream } from "node:fs";
import { access, constants, mkdir, readFile, rm } from "node:fs/promises";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PACKAGE_NAME = "arashi";
export const GITHUB_REPO = "corwinm/arashi";
export const MANUAL_INSTALL_URL = `https://github.com/${GITHUB_REPO}/releases`;

export class UnsupportedPlatformError extends Error {
  constructor(platform = process.platform, arch = process.arch) {
    super(
      `Unsupported platform: ${platform}-${arch}. Please build from source or file an issue at https://github.com/${GITHUB_REPO}/issues`,
    );
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.arch = arch;
  }
}

export function getPlatformInfo({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "arm64") {
    return { arch, binaryName: `${PACKAGE_NAME}-macos-arm64`, isWindows: false, platform };
  }

  if (platform === "linux" && arch === "x64") {
    return { arch, binaryName: `${PACKAGE_NAME}-linux-x64`, isWindows: false, platform };
  }

  if (platform === "win32" && arch === "x64") {
    return { arch, binaryName: `${PACKAGE_NAME}-windows-x64.exe`, isWindows: true, platform };
  }

  throw new UnsupportedPlatformError(platform, arch);
}

export function buildReleaseAssetUrl(version, binaryName, repo = GITHUB_REPO) {
  return `https://github.com/${repo}/releases/download/v${version}/${binaryName}`;
}

export async function readPackageVersion(packageJsonPath, { readFileImpl = readFile } = {}) {
  const packageJson = JSON.parse(await readFileImpl(packageJsonPath, "utf8"));
  return packageJson.version;
}

export async function isBinaryInstalled(binaryPath, { accessImpl = access } = {}) {
  try {
    await accessImpl(binaryPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function downloadFile(url, dest, options = {}) {
  const {
    createWriteStreamImpl = createWriteStream,
    getImpl = get,
    log = console.log,
    maxRedirects = 5,
  } = options;

  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error("Too many redirects while downloading binary"));
      return;
    }

    log(`Downloading ${url}...`);

    const file = createWriteStreamImpl(dest);
    const request = getImpl(url, (response) => {
      if (
        response.statusCode === 301 ||
        response.statusCode === 302 ||
        response.statusCode === 307 ||
        response.statusCode === 308
      ) {
        file.close();
        const location = response.headers.location;
        if (!location) {
          reject(new Error(`Redirect response from ${url} did not include a location header`));
          return;
        }

        downloadFile(location, dest, { ...options, maxRedirects: maxRedirects - 1 })
          .then(resolve)
          .catch(reject);
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

    request.on("error", (error) => {
      file.close();
      reject(error);
    });

    file.on("error", (error) => {
      file.close();
      reject(error);
    });
  });
}

export function verifyBinary(binaryPath, { log = console.log, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(binaryPath, ["--version"], {
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

  log(`✓ Verified ${PACKAGE_NAME} executable (${versionOutput})`);
  return versionOutput;
}

export async function installBinary(options = {}) {
  const rootDir = options.rootDir ?? join(__dirname, "..");
  const binDir = options.binDir ?? join(rootDir, "bin");
  const packageJsonPath = options.packageJsonPath ?? join(rootDir, "package.json");
  const log = options.log ?? console.log;
  const accessImpl = options.accessImpl ?? access;
  const chmodImpl = options.chmodImpl ?? chmodSync;
  const downloadFileImpl = options.downloadFileImpl ?? downloadFile;
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const readFileImpl = options.readFileImpl ?? readFile;
  const rmImpl = options.rmImpl ?? rm;
  const verifyBinaryImpl = options.verifyBinaryImpl ?? verifyBinary;

  const version = options.version ?? (await readPackageVersion(packageJsonPath, { readFileImpl }));
  const { binaryName, isWindows } = getPlatformInfo({
    arch: options.arch ?? process.arch,
    platform: options.platform ?? process.platform,
  });
  const binaryPath = join(binDir, binaryName);
  const downloadUrl = buildReleaseAssetUrl(version, binaryName, options.repo ?? GITHUB_REPO);

  if (await isBinaryInstalled(binaryPath, { accessImpl })) {
    log(`✓ Binary already installed at ${binaryPath}`);
    return { binaryName, binaryPath, downloadUrl, status: "already-installed", version };
  }

  try {
    await mkdirImpl(binDir, { recursive: true });
    await downloadFileImpl(downloadUrl, binaryPath, { log });

    if (!isWindows) {
      chmodImpl(binaryPath, 0o755);
    }

    verifyBinaryImpl(binaryPath, { log });

    log(`✓ Successfully installed ${PACKAGE_NAME} v${version}`);
    log(`  Binary location: ${binaryPath}`);
    return { binaryName, binaryPath, downloadUrl, status: "installed", version };
  } catch (error) {
    await rmImpl(binaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function formatInstallError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    `✗ Failed to install ${PACKAGE_NAME}: ${message}`,
    "",
    `You can manually download binaries from: ${MANUAL_INSTALL_URL}`,
  ].join("\n");
}

export async function runInstallCli(options = {}) {
  const errorLog = options.error ?? console.error;
  try {
    await installBinary(options);
    return 0;
  } catch (error) {
    errorLog(formatInstallError(error));
    return 1;
  }
}
