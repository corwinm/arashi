import type { Config, RepoConfig } from "./config.ts";
import { join, resolve } from "path";
import { readdir, stat } from "fs/promises";

export type CloneProtocol = "ssh" | "https";

export interface ConfiguredRepositoryState {
  name: string;
  path: string;
  config: RepoConfig;
}

export interface UnmanagedRepositoryState {
  name: string;
  path: string;
}

export interface CloneRepositoryDiscovery {
  configuredPresent: ConfiguredRepositoryState[];
  configuredMissing: ConfiguredRepositoryState[];
  unmanagedLocal: UnmanagedRepositoryState[];
}

export interface ProtocolPreference {
  protocol: CloneProtocol | null;
  reason: "inferred-ssh" | "inferred-https" | "mixed" | "none";
}

export async function discoverCloneRepositories(
  workspaceRoot: string,
  config: Config,
): Promise<CloneRepositoryDiscovery> {
  const configuredPresent: ConfiguredRepositoryState[] = [];
  const configuredMissing: ConfiguredRepositoryState[] = [];

  const configuredNames = new Set<string>();
  for (const [name, repoConfig] of Object.entries(config.repos)) {
    configuredNames.add(name);
    const repoPath = resolve(workspaceRoot, repoConfig.path);
    const repoExists = await pathExists(repoPath);

    const state: ConfiguredRepositoryState = {
      config: repoConfig,
      name,
      path: repoPath,
    };

    if (repoExists) {
      configuredPresent.push(state);
    } else {
      configuredMissing.push(state);
    }
  }

  const unmanagedLocal: UnmanagedRepositoryState[] = [];
  const reposRoot = resolve(workspaceRoot, config.reposDir);
  const reposRootExists = await pathExists(reposRoot);
  if (reposRootExists) {
    const entries = await readdir(reposRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !configuredNames.has(entry.name)) {
        const candidatePath = join(reposRoot, entry.name);
        const gitMarkerExists = await pathExists(join(candidatePath, ".git"));
        if (gitMarkerExists) {
          unmanagedLocal.push({
            name: entry.name,
            path: candidatePath,
          });
        }
      }
    }
  }

  configuredPresent.sort((a, b) => a.name.localeCompare(b.name));
  configuredMissing.sort((a, b) => a.name.localeCompare(b.name));
  unmanagedLocal.sort((a, b) => a.name.localeCompare(b.name));

  return {
    configuredMissing,
    configuredPresent,
    unmanagedLocal,
  };
}

export function inferCloneProtocolPreference(urls: (string | undefined)[]): ProtocolPreference {
  const protocols = new Set<CloneProtocol>();

  for (const url of urls) {
    if (url) {
      const protocol = detectCloneProtocol(url);
      if (protocol) {
        protocols.add(protocol);
      }
    }
  }

  if (protocols.size === 0) {
    return { protocol: null, reason: "none" };
  }

  if (protocols.size > 1) {
    return { protocol: null, reason: "mixed" };
  }

  const protocol = protocols.values().next().value as CloneProtocol;
  return {
    protocol,
    reason: protocol === "ssh" ? "inferred-ssh" : "inferred-https",
  };
}

export function applyCloneProtocol(gitUrl: string, protocol: CloneProtocol): string {
  const sourceProtocol = detectCloneProtocol(gitUrl);
  if (sourceProtocol === protocol || sourceProtocol === "ssh") {
    return gitUrl;
  }

  const parsed = parseHostedGitUrl(gitUrl);
  if (!parsed || protocol !== "ssh") {
    return gitUrl;
  }

  return `git@${parsed.host}:${parsed.path}.git`;
}

function detectCloneProtocol(url: string): CloneProtocol | null {
  const trimmed = url.trim();
  if (trimmed.startsWith("https://")) {
    return "https";
  }
  if (trimmed.startsWith("ssh://") || /^(?:[^@\s/:]+@)?[^@\s/:]+:[^\s]+$/.test(trimmed)) {
    return "ssh";
  }
  return null;
}

function parseHostedGitUrl(gitUrl: string): { host: string; path: string } | null {
  const trimmed = gitUrl.trim();

  const httpsMatch = trimmed.match(/^https:\/\/([^/]+)\/(.+)$/);
  if (httpsMatch) {
    return {
      host: httpsMatch[1],
      path: stripGitSuffix(httpsMatch[2]),
    };
  }

  const scpMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    return {
      host: scpMatch[1],
      path: stripGitSuffix(scpMatch[2]),
    };
  }

  const sshMatch = trimmed.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/);
  if (sshMatch) {
    return {
      host: sshMatch[1],
      path: stripGitSuffix(sshMatch[2]),
    };
  }

  return null;
}

function stripGitSuffix(path: string): string {
  return path.replace(/^\/+/, "").replace(/\.git$/, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
