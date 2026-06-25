import { info, error as logError } from "../lib/logger.ts";
import { Command } from "commander";

export const UPDATE_COMMAND_DESCRIPTION = "Check for and apply Arashi updates";
const RELEASES_URL = "https://github.com/corwinm/arashi/releases";
const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/corwinm/arashi/releases/latest";

interface UpdateOptions {
  check?: boolean;
  dryRun?: boolean;
}

interface ReleaseInfo {
  htmlUrl: string;
  version: string;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

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
  deps?: { currentVersion: string; fetchImpl?: FetchImpl; log?: (message: string) => void },
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

  const assetName = platformAssetName();
  log("Automatic update is not available for direct-binary/manual installs.");
  log(`Manual releases: ${latest.htmlUrl}`);
  if (assetName) {
    log(`Download asset for this platform: ${assetName}`);
  }
  log(
    "Replace the existing arashi binary with the downloaded asset and make it executable if needed.",
  );

  if (options.check) {
    log("Check only: no changes made.");
  }
  if (options.dryRun) {
    log("Dry run: no changes made.");
  }
}

export function createCommand(currentVersion = ""): Command {
  return new Command("update")
    .description(UPDATE_COMMAND_DESCRIPTION)
    .option("--check", "check whether an update is available without changing files")
    .option("--dry-run", "show the direct-binary update guidance without changing files")
    .option(
      "-y, --yes",
      "accepted for npm-managed updates; direct binaries still require manual replacement",
    )
    .action(async (options: UpdateOptions) => {
      try {
        await runDirectUpdate(options, { currentVersion });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`Failed to check latest arashi release: ${message}`);
        info(`Manual releases: ${RELEASES_URL}`);
        process.exitCode = 1;
      }
    });
}
