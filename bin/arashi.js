#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { formatInstallError, getPlatformInfo, installBinary } from "./install-binary.js";
import { runNpmManagedUpdate } from "./update.js";
import { stringifyWrapperJsonEnvelope } from "./update-options.js";

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
  const sourceOutputFirstUse =
    options.argv?.[0] === "completion" ||
    (options.argv?.[0] === "shell" && options.argv?.[1] === "init");
  const log = sourceOutputFirstUse ? () => {} : (options.log ?? console.log);
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

export function isExplicitUninstallCommand(argv) {
  return argv[0] === "uninstall";
}

const removalCommands = {
  npm: ["npm", ["uninstall", "-g", "arashi"]],
  pnpm: ["pnpm", ["remove", "-g", "arashi"]],
  "yarn-classic": ["yarn", ["global", "remove", "arashi"]],
  bun: ["bun", ["remove", "-g", "arashi"]],
  "vite-plus": ["vp", ["uninstall", "-g", "arashi"]],
};

function normalizeEvidencePath(value, platform = currentPlatform) {
  const normalized = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function inferOwnerEvidence(
  rootDir,
  env = process.env,
  realpath = realpathSync,
  npmGlobalRoot,
  platform = currentPlatform,
) {
  const normalized = normalizeEvidencePath(realpath(rootDir), platform);
  const home = normalizeEvidencePath(env.HOME ?? env.USERPROFILE, platform);
  const pnpmHome = normalizeEvidencePath(env.PNPM_HOME, platform);
  const localAppData = normalizeEvidencePath(env.LOCALAPPDATA, platform);
  const appData = normalizeEvidencePath(env.APPDATA, platform);
  const configuredNpmPrefix = normalizeEvidencePath(env.NPM_CONFIG_PREFIX, platform);
  const detectedNpmRoot = normalizeEvidencePath(npmGlobalRoot, platform);
  const evidence = [];
  const add = (owner) => {
    if (!evidence.includes(owner)) evidence.push(owner);
  };
  if (
    pnpmHome &&
    normalized.startsWith(`${pnpmHome}/global/`) &&
    /\/(?:\.pnpm\/[^/]+\/node_modules|node_modules)\/arashi$/.test(normalized)
  )
    add("pnpm");
  if (home && normalized === `${home}/.bun/install/global/node_modules/arashi`) add("bun");
  if (home && normalized === `${home}/.config/yarn/global/node_modules/arashi`)
    add("yarn-classic");
  if (
    localAppData &&
    normalized === `${localAppData}/yarn/data/global/node_modules/arashi`
  )
    add("yarn-classic");
  if (normalized.includes("/.yarn/")) add("yarn-berry");
  if (home && normalized === `${home}/.vite-plus/packages/arashi/current/package`)
    add("vite-plus");
  if (
    normalized === "/usr/local/lib/node_modules/arashi" ||
    normalized === "/usr/lib/node_modules/arashi" ||
    normalized === "/opt/homebrew/lib/node_modules/arashi" ||
    (home &&
      (normalized === `${home}/.npm-global/lib/node_modules/arashi` ||
        (normalized.startsWith(`${home}/.nvm/versions/node/`) &&
          /\/lib\/node_modules\/arashi$/.test(normalized)))) ||
    (appData && normalized === `${appData}/npm/node_modules/arashi`) ||
    (configuredNpmPrefix &&
      (normalized === `${configuredNpmPrefix}/lib/node_modules/arashi` ||
        normalized === `${configuredNpmPrefix}/node_modules/arashi`)) ||
    (detectedNpmRoot && normalized === `${detectedNpmRoot}/arashi`)
  )
    add("npm");
  return evidence;
}

function spawnRemoval(command, args, options) {
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(typeof code === "number" ? code : 1));
    child.on("error", (error) => {
      (options.error ?? console.error)(`Failed to run ${command}. ${error.message}.`);
      resolve(1);
    });
  });
}

export function detectNpmGlobalRoot(options = {}) {
  try {
    const output = (options.execFileSyncImpl ?? execFileSync)("npm", ["root", "-g"], {
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(output).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function runPackageUninstall(argv, options) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    (options.log ?? console.log)(`Usage: arashi uninstall [options]

Conservatively remove a proven Arashi installation

Options:
  -n, --dry-run  Inspect the uninstall plan without changing anything
  -y, --yes      Apply the completely preflighted uninstall plan
  -h, --help     display help for command`);
    return 0;
  }
  const unsupportedOption = argv.find((arg) => !["-n", "--dry-run", "-y", "--yes"].includes(arg));
  if (unsupportedOption) {
    (options.error ?? console.error)(`Unknown uninstall option: ${unsupportedOption}`);
    return 1;
  }
  let evidence =
    options.ownerEvidence ??
    inferOwnerEvidence(
      options.rootDir ?? join(__dirname, ".."),
      options.env ?? process.env,
      options.realpathSyncImpl ?? realpathSync,
      options.npmGlobalRoot,
      options.platform ?? currentPlatform,
    );
  if (options.ownerEvidence === undefined && evidence.length === 0 && options.npmGlobalRoot === undefined) {
    const detectedNpmRoot = (options.detectNpmGlobalRoot ?? detectNpmGlobalRoot)({
      env: options.env ?? process.env,
    });
    if (detectedNpmRoot) {
      evidence = inferOwnerEvidence(
        options.rootDir ?? join(__dirname, ".."),
        options.env ?? process.env,
        options.realpathSyncImpl ?? realpathSync,
        detectedNpmRoot,
        options.platform ?? currentPlatform,
      );
    }
  }
  if (evidence.length > 1) {
    (options.error ?? console.error)(`Package-manager ownership is ambiguous: ${evidence.join(", ")}. No command was run.`);
    return 1;
  }
  if (evidence.length === 0) {
    (options.error ?? console.error)("Package-manager ownership is not proven. Remove the package manually with its known owner.");
    return 1;
  }
  const selected = removalCommands[evidence[0]];
  if (!selected) {
    (options.error ?? console.error)(`Package-manager ownership is unsupported: ${evidence[0]}. No command was run.`);
    return 1;
  }
  const [command, args] = selected;
  (options.log ?? console.log)(`Package-manager uninstall: ${command} ${args.join(" ")}`);
  if (argv.includes("-n") || argv.includes("--dry-run")) return 0;
  if (!argv.includes("-y") && !argv.includes("--yes")) {
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      (options.error ?? console.error)("Non-interactive package-manager uninstall requires --yes.");
      return 1;
    }
    let accepted;
    if (options.confirm) accepted = await options.confirm(false);
    else {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question("Remove this package-managed Arashi installation? [y/N] ");
        accepted = /^(?:y|yes)$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    }
    if (!accepted) return 0;
  }
  return spawnRemoval(command, args, options);
}

async function runExplicitInstall(argv, options) {
  const binDir = options.binDir ?? __dirname;
  const rootDir = options.rootDir ?? join(binDir, "..");
  const installBinaryImpl = options.installBinaryImpl ?? installBinary;
  const json = argv.includes("--json") || argv.includes("-j");
  const log = options.log ?? console.log;

  try {
    const result = await installBinaryImpl({
      ...options,
      binDir,
      log: json ? () => {} : options.log,
      rootDir,
    });
    if (json) log(stringifyWrapperJsonEnvelope("install", { data: result, ok: true }));
    return 0;
  } catch (error) {
    if (!json) throw error;
    log(
      stringifyWrapperJsonEnvelope("install", {
        error: {
          code: "INSTALL_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
        ok: false,
      }),
    );
    return 1;
  }
}

function spawnArashi(argv, options = {}) {
  const binDir = options.binDir ?? __dirname;
  const platform = options.platform ?? currentPlatform;
  const windows = platform === "win32";
  const spawnImpl = options.spawnImpl ?? spawn;
  const wrapperPath = (windows ? win32 : posix).join(binDir, getWrapperName(platform));
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
      : spawnImpl("/bin/bash", [wrapperPath, ...argv], { stdio: "inherit" });

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
      return await runExplicitInstall(argv.slice(1), options);
    }

    if (isExplicitUpdateCommand(argv)) {
      return runNpmManagedUpdate(argv.slice(1), options);
    }

    if (isExplicitUninstallCommand(argv)) {
      return runPackageUninstall(argv.slice(1), options);
    }

    await ensureInstalled({ ...options, argv });
  } catch (error) {
    errorLog(formatInstallError(error));
    return 1;
  }

  return spawnArashi(argv, options);
}

let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(__filename);
} catch {
  // A missing or inaccessible argv path cannot be a direct invocation of this module.
}
if (invokedDirectly) {
  process.exitCode = await runEntrypoint();
}
