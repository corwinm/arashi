import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  unsupportedJsonModeError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { info, error as logError } from "../lib/logger.ts";
import { confirm as promptConfirm, type PromptOutcome } from "../lib/prompts.ts";
import { Command } from "commander";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

export const UPDATE_COMMAND_DESCRIPTION = "Check for and apply Arashi updates";
const RELEASES_URL = "https://github.com/corwinm/arashi/releases";
const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/corwinm/arashi/releases/latest";

interface UpdateOptions {
  check?: boolean;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
}

interface ReleaseInfo {
  htmlUrl: string;
  version: string;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;
type SpawnSyncImpl = typeof spawnSync;
type ConfirmImpl = (message: string, defaultValue?: boolean) => Promise<PromptOutcome<boolean>>;

const POSIX_INSTALLER_URL = "https://arashi.haphazard.dev/install";
const WINDOWS_INSTALLER_URL = "https://arashi.haphazard.dev/install.ps1";

interface DirectUpdateDeps {
  confirmImpl?: ConfirmImpl;
  currentVersion?: string;
  execPath?: string;
  fetchImpl?: FetchImpl;
  isInteractive?: boolean;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  spawnSyncImpl?: SpawnSyncImpl;
}

interface InstallerUpdatePlanOptions {
  parentProcessId?: number;
  platform?: NodeJS.Platform;
}

function installerDirname(execPath: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return dirname(execPath);
  }

  const trimmedPath = execPath.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmedPath.lastIndexOf("\\"), trimmedPath.lastIndexOf("/"));
  if (separatorIndex <= 0) {
    return ".";
  }

  return trimmedPath.slice(0, separatorIndex);
}

export function buildInstallerUpdatePlan(
  latestVersion: string,
  execPath: string,
  options: InstallerUpdatePlanOptions = {},
): {
  args: string[];
  command: string;
  deferred: boolean;
  env: Record<string, string>;
  installDir: string;
  label: string;
  url: string;
} {
  const platform = options.platform ?? process.platform;
  const parentProcessId = options.parentProcessId ?? process.pid;
  const installDir = installerDirname(execPath, platform);

  if (platform === "win32") {
    const installCommand = `irm ${WINDOWS_INSTALLER_URL} | iex`;
    const escapedInstallCommand = installCommand.replaceAll("'", "''");

    return {
      args: [
        "-NoProfile",
        "-c",
        `Start-Process -FilePath powershell -ArgumentList @('-NoProfile', '-c', '${escapedInstallCommand}') -NoNewWindow`,
      ],
      command: "powershell",
      deferred: true,
      env: {
        ARASHI_INSTALL_DIR: installDir,
        ARASHI_NO_MODIFY_PATH: "1",
        ARASHI_VERSION: latestVersion,
        ARASHI_WAIT_FOR_PID: String(parentProcessId),
      },
      installDir,
      label: "official PowerShell installer",
      url: WINDOWS_INSTALLER_URL,
    };
  }

  return {
    args: [
      "-c",
      `curl -fsSL ${POSIX_INSTALLER_URL} | bash -s -- --no-shell-integration --no-modify-path`,
    ],
    command: "bash",
    deferred: false,
    env: {
      ARASHI_INSTALL_DIR: installDir,
      ARASHI_SHELL_INTEGRATION: "no",
      ARASHI_VERSION: latestVersion,
    },
    installDir,
    label: "official POSIX installer",
    url: POSIX_INSTALLER_URL,
  };
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "").split("+")[0];
}

export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split(/[.-]/);
  const right = normalizeVersion(b).split(/[.-]/);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? "0";
    const rightPart = right[index] ?? "0";
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);

    if (Number.isInteger(leftNumber) && Number.isInteger(rightNumber)) {
      if (leftNumber > rightNumber) {
        return 1;
      }
      if (leftNumber < rightNumber) {
        return -1;
      }
      continue;
    }

    if (leftPart === rightPart) {
      continue;
    }
    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

function platformAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin" && arch === "arm64") {
    return "arashi-macos-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "arashi-linux-x64";
  }
  if (platform === "win32" && arch === "x64") {
    return "arashi-windows-x64.exe";
  }
  return null;
}

export async function fetchLatestRelease(fetchImpl: FetchImpl = fetch): Promise<ReleaseInfo> {
  const response = await fetchImpl(GITHUB_LATEST_RELEASE_API, {
    headers: { accept: "application/vnd.github+json" },
  });

  if (!response.ok) {
    throw new Error(`GitHub releases returned ${response.status} ${response.statusText}`.trim());
  }

  const release = (await response.json()) as {
    html_url?: string;
    name?: string;
    tag_name?: string;
  };
  const version = normalizeVersion(release.tag_name ?? release.name ?? "");
  if (!version) {
    throw new Error("GitHub release response did not include a tag");
  }

  return { htmlUrl: release.html_url ?? RELEASES_URL, version };
}

export async function runDirectUpdate(
  options: UpdateOptions,
  deps?: DirectUpdateDeps,
): Promise<void> {
  const { currentVersion = "", fetchImpl, log = info } = deps ?? { currentVersion: "" };
  const latest = await fetchLatestRelease(fetchImpl);

  if (currentVersion && compareVersions(currentVersion, latest.version) >= 0) {
    log(`arashi direct binary is already current (v${currentVersion}).`);
    return;
  }

  if (currentVersion) {
    log(`Update available: arashi v${currentVersion} -> v${latest.version}`);
  } else {
    log(`Latest arashi release: v${latest.version}`);
  }

  const platform = deps?.platform ?? process.platform;
  const assetName = platformAssetName(platform);
  const execPath = deps?.execPath ?? process.execPath;
  const plan = buildInstallerUpdatePlan(latest.version, execPath, {
    parentProcessId: process.pid,
    platform,
  });
  log(`Update method: ${plan.label}`);
  log(`Installer URL: ${plan.url}`);
  log(`Install directory: ${plan.installDir}`);
  if (assetName) {
    log(`Platform asset: ${assetName}`);
  }

  if (options.check) {
    log("Check only: no changes made.");
    return;
  }
  if (options.dryRun) {
    log("Dry run: no changes made.");
    return;
  }
  if (!options.yes) {
    const isInteractive = deps?.isInteractive ?? process.stdin.isTTY;
    if (!isInteractive) {
      log("Update not applied. Rerun with --yes to reinstall Arashi with the official installer.");
      return;
    }

    const confirmImpl = deps?.confirmImpl ?? promptConfirm;
    const confirmation = await confirmImpl(`Apply arashi update to v${latest.version}?`, false);
    if (confirmation.status === "cancelled") {
      log("Update cancelled.");
      return;
    }
    if (!confirmation.value) {
      log(
        "Update skipped. Rerun with --yes for non-interactive updates or use --dry-run to inspect the plan.",
      );
      return;
    }
  }

  const spawnSyncImpl = deps?.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(plan.command, plan.args, {
    encoding: "utf8",
    env: { ...process.env, ...plan.env },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`installer exited with code ${result.status ?? "unknown"}`);
  }

  if (plan.deferred) {
    log(
      `✓ Scheduled arashi update to v${latest.version}. The installer will continue after this process exits; keep the terminal open until it finishes.`,
    );
    return;
  }

  log(`✓ Updated arashi to v${latest.version}.`);
}

export function createCommand(currentVersion = ""): Command {
  return new Command("update")
    .description(UPDATE_COMMAND_DESCRIPTION)
    .option("--check", "check whether an update is available without changing files")
    .option("--dry-run", "show the installer update plan without changing files")
    .option("-y, --yes", "apply the update without prompting")
    .option("--json", "Output result as JSON")
    .action(async (options: UpdateOptions) => {
      if (options.json && options.yes) {
        writeJsonEnvelope(unsupportedJsonModeError("update", "installer-apply"));
        process.exitCode = 1;
        return;
      }

      try {
        if (options.json) {
          const messages: string[] = [];
          await runDirectUpdate(options, {
            currentVersion,
            log: (message) => messages.push(message),
          });
          writeJsonEnvelope(createJsonSuccessEnvelope("update", { messages }));
        } else {
          await runDirectUpdate(options, { currentVersion });
        }
      } catch (error) {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("update", unknownErrorToJsonError(error)));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          logError(`Failed to check latest arashi release: ${message}`);
          info(`Manual releases: ${RELEASES_URL}`);
        }
        process.exitCode = 1;
      }
    });
}
