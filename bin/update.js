import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { getPlatformInfo, installBinary, MANUAL_INSTALL_URL, PACKAGE_NAME } from "./install-binary.js";

export const UPDATE_COMMAND_DESCRIPTION = "Check for and apply Arashi updates";

export function parseUpdateArgs(argv = []) {
  return {
    check: argv.includes("--check"),
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

function normalizeVersion(version) {
  return String(version ?? "").trim().replace(/^v/, "").split("+")[0];
}

export function compareVersions(a, b) {
  const left = normalizeVersion(a).split(/[.-]/);
  const right = normalizeVersion(b).split(/[.-]/);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? "0";
    const rightPart = right[index] ?? "0";
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);

    if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
      if (leftNumber > rightNumber) return 1;
      if (leftNumber < rightNumber) return -1;
      continue;
    }

    if (leftPart === rightPart) continue;
    if (leftPart === "") return 1;
    if (rightPart === "") return -1;
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

export async function readPackageMetadata(rootDir, { readFileImpl = readFile } = {}) {
  const packageJsonPath = join(rootDir, "package.json");
  const packageJson = JSON.parse(await readFileImpl(packageJsonPath, "utf8"));
  return { name: packageJson.name, packageJsonPath, version: packageJson.version };
}

export function detectNpmManagedInstall({ rootDir, metadata } = {}) {
  if (!rootDir || metadata?.name !== PACKAGE_NAME || !metadata?.version) {
    return { method: "ambiguous" };
  }

  return { method: "npm-managed", rootDir, version: metadata.version };
}

export async function fetchLatestPackageVersion({ fetchImpl = fetch, packageName = PACKAGE_NAME } = {}) {
  const response = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} ${response.statusText}`.trim());
  }

  const metadata = await response.json();
  if (!metadata.version) {
    throw new Error("npm registry response did not include a version");
  }

  return metadata.version;
}

export async function fetchLatestGitHubRelease({ fetchImpl = fetch, repo = "corwinm/arashi" } = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  });

  if (!response.ok) {
    throw new Error(`GitHub releases returned ${response.status} ${response.statusText}`.trim());
  }

  const release = await response.json();
  const version = normalizeVersion(release.tag_name ?? release.name);
  if (!version) {
    throw new Error("GitHub release response did not include a tag");
  }

  return {
    htmlUrl: release.html_url ?? MANUAL_INSTALL_URL,
    version,
  };
}

export function selectPackageManagerCommand({ env = process.env } = {}) {
  const userAgent = env.npm_config_user_agent ?? "";
  const execPath = env.npm_execpath ?? "";
  const combined = `${userAgent} ${execPath}`.toLowerCase();

  if (combined.includes("pnpm")) {
    return { args: ["add", "-g", `${PACKAGE_NAME}@latest`], command: "pnpm", label: "pnpm" };
  }

  if (combined.includes("yarn")) {
    return { args: ["global", "add", `${PACKAGE_NAME}@latest`], command: "yarn", label: "yarn" };
  }

  if (combined.includes("bun")) {
    return { args: ["add", "-g", `${PACKAGE_NAME}@latest`], command: "bun", label: "bun" };
  }

  if (combined.includes("npm")) {
    return { args: ["install", "-g", `${PACKAGE_NAME}@latest`], command: "npm", label: "npm" };
  }

  return null;
}

export function formatManualUpdateGuidance(latestVersion, platformInfo) {
  const lines = [
    "Automatic update is not available for this install method.",
    `Latest release: v${latestVersion}`,
    `Manual releases: ${MANUAL_INSTALL_URL}`,
  ];

  if (platformInfo?.binaryName) {
    lines.push(`Download asset for this platform: ${platformInfo.binaryName}`);
  }

  lines.push("Replace the existing arashi binary with the downloaded asset and make it executable if needed.");
  return lines.join("\n");
}

export function formatSupportedPackageManagerGuidance() {
  return [
    "Could not confidently detect the package manager used for this npm-managed install.",
    "Run one of these manually if it matches how you installed Arashi:",
    `  npm install -g ${PACKAGE_NAME}@latest`,
    `  pnpm add -g ${PACKAGE_NAME}@latest`,
    `  yarn global add ${PACKAGE_NAME}@latest`,
    `  bun add -g ${PACKAGE_NAME}@latest`,
  ].join("\n");
}

export async function defaultConfirmPrompt(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function confirmUpdate({ promptImpl = defaultConfirmPrompt, yes }) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  return promptImpl("Update Arashi now? [y/N] ");
}

function defaultRootDir(binDir) {
  return join(binDir ?? fileURLToPath(new URL(".", import.meta.url)), "..");
}

export async function runNpmManagedUpdate(argv = [], options = {}) {
  const flags = parseUpdateArgs(argv);
  const log = options.log ?? console.log;
  const errorLog = options.error ?? console.error;
  const rootDir = options.rootDir ?? defaultRootDir(options.binDir);
  let metadata;

  try {
    metadata = options.metadata ?? (await readPackageMetadata(rootDir, options));
  } catch (error) {
    errorLog(`Failed to read package metadata: ${error instanceof Error ? error.message : String(error)}`);
    errorLog(formatSupportedPackageManagerGuidance());
    return 1;
  }

  const install = detectNpmManagedInstall({ metadata, rootDir });
  if (install.method !== "npm-managed") {
    log(formatSupportedPackageManagerGuidance());
    return 0;
  }

  let latestVersion;
  try {
    latestVersion = options.latestVersion ?? (await fetchLatestPackageVersion(options));
  } catch (error) {
    errorLog(`Failed to check latest ${PACKAGE_NAME} version: ${error instanceof Error ? error.message : String(error)}`);
    errorLog(`Manual releases: ${MANUAL_INSTALL_URL}`);
    return 1;
  }

  if (compareVersions(metadata.version, latestVersion) >= 0) {
    log(`${PACKAGE_NAME} is already up to date (v${metadata.version}).`);
    return 0;
  }

  const packageManager = options.packageManager ?? selectPackageManagerCommand(options);
  log(`Update available: ${PACKAGE_NAME} v${metadata.version} -> v${latestVersion}`);

  if (flags.check) {
    log("Check only: no changes made.");
    return 0;
  }

  if (!packageManager) {
    log(formatSupportedPackageManagerGuidance());
    return 0;
  }

  const renderedCommand = [packageManager.command, ...packageManager.args].join(" ");
  log(`Selected update command: ${renderedCommand}`);
  log("Binary refresh: reinstall the matching platform binary after the package update.");

  if (flags.dryRun) {
    log("Dry run: no changes made.");
    return 0;
  }

  if (!(await confirmUpdate({ promptImpl: options.promptImpl, yes: flags.yes }))) {
    errorLog("Update skipped. Rerun with --yes for non-interactive updates or use --dry-run to inspect the plan.");
    return 1;
  }

  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(packageManager.command, packageManager.args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.error) {
    errorLog(`Package manager failed to start: ${result.error.message}`);
    return 1;
  }

  if (result.status !== 0) {
    errorLog(`Package manager update failed with exit code ${result.status ?? "unknown"}. Existing binary was not removed.`);
    return 1;
  }

  let updatedMetadata = metadata;
  try {
    updatedMetadata = await readPackageMetadata(rootDir, options);
  } catch {
    updatedMetadata = { ...metadata, version: latestVersion };
  }

  try {
    const installBinaryImpl = options.installBinaryImpl ?? installBinary;
    const installResult = await installBinaryImpl({
      ...options,
      binDir: options.binDir,
      force: true,
      rootDir,
      version: updatedMetadata.version,
    });
    log(`✓ Updated ${PACKAGE_NAME} from v${metadata.version} to v${updatedMetadata.version}.`);
    log(`  Package-manager command: ${renderedCommand}`);
    log(`  Binary location: ${installResult.binaryPath ?? "installed platform binary"}`);
    return 0;
  } catch (error) {
    errorLog(`Package updated, but binary refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    errorLog("Run `arashi install` to retry the binary installation, or download a release manually.");
    return 1;
  }
}

export async function runDirectBinaryUpdate(argv = [], options = {}) {
  const flags = parseUpdateArgs(argv);
  const log = options.log ?? console.log;
  const errorLog = options.error ?? console.error;
  const currentVersion = options.currentVersion;

  let release;
  try {
    release = options.latestRelease ?? (await fetchLatestGitHubRelease(options));
  } catch (error) {
    errorLog(`Failed to check latest ${PACKAGE_NAME} release: ${error instanceof Error ? error.message : String(error)}`);
    errorLog(`Manual releases: ${MANUAL_INSTALL_URL}`);
    return 1;
  }

  let platformInfo;
  try {
    platformInfo = getPlatformInfo({ arch: options.arch, platform: options.platform });
  } catch {
    platformInfo = undefined;
  }

  if (currentVersion && compareVersions(currentVersion, release.version) >= 0) {
    log(`${PACKAGE_NAME} direct binary is already current (v${currentVersion}).`);
    return 0;
  }

  if (currentVersion) {
    log(`Update available: ${PACKAGE_NAME} v${currentVersion} -> v${release.version}`);
  } else {
    log(`Latest ${PACKAGE_NAME} release: v${release.version}`);
  }
  log(formatManualUpdateGuidance(release.version, platformInfo));
  if (release.htmlUrl) log(`Release URL: ${release.htmlUrl}`);
  if (flags.check) log("Check only: no changes made.");
  if (flags.dryRun) log("Dry run: no changes made.");
  return 0;
}
