import { opendir } from "node:fs/promises";
import { spawn } from "node:child_process";

export interface RepositoryLocalCandidate {
  kind: "file" | "directory";
  path: string;
  selected: false;
}
export interface RepositoryCandidateDiscovery {
  candidates: RepositoryLocalCandidate[];
  inspectedEntries: number;
  diagnostic?: string;
}
export interface DiscoveryLimits {
  maxRootEntries?: number;
  maxSuggestions?: number;
}
interface RootMetadataEntry {
  name: string;
  isDirectory(): boolean;
}
export interface RepositoryCandidateDiscoveryDependencies {
  openRoot(
    root: string,
  ): Promise<AsyncIterable<RootMetadataEntry>> | AsyncIterable<RootMetadataEntry>;
  checkIgnored(paths: readonly string[], root: string): Promise<readonly string[]>;
  probeLikelyPaths?(
    root: string,
  ): Promise<readonly RootMetadataEntry[]> | readonly RootMetadataEntry[];
}
const LIKELY_LOCAL =
  /^(?:\.env(?:\..+)?|\.cache|\.local|local(?:\..+)?|.*\.local\.(?:json|ya?ml|toml))$/i;
const CLONE_SURVIVING_PROBES: readonly RootMetadataEntry[] = [
  { isDirectory: () => true, name: ".cache" },
  { isDirectory: () => false, name: ".env" },
  { isDirectory: () => false, name: ".env.local" },
  { isDirectory: () => true, name: ".local" },
  { isDirectory: () => false, name: "config.local.json" },
  { isDirectory: () => false, name: "config.local.toml" },
  { isDirectory: () => false, name: "config.local.yaml" },
  { isDirectory: () => false, name: "config.local.yml" },
  { isDirectory: () => false, name: "local.json" },
  { isDirectory: () => false, name: "local.toml" },
  { isDirectory: () => false, name: "local.yaml" },
  { isDirectory: () => false, name: "local.yml" },
];
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const checkIgnored = (paths: readonly string[], root: string): Promise<readonly string[]> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["check-ignore", "--stdin", "-z"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        reject(error);
      }
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode !== 0 && exitCode !== 1) {
        reject(new Error("git check-ignore failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").split("\0").filter(Boolean));
    });
    child.stdin.end(Buffer.from(`${paths.join("\0")}\0`));
  });
const defaults: RepositoryCandidateDiscoveryDependencies = {
  checkIgnored,
  openRoot: (root) => opendir(root),
  probeLikelyPaths: () => CLONE_SURVIVING_PROBES,
};

export const discoverRepositoryLocalCandidates = async (
  root: string,
  limits: DiscoveryLimits = {},
  dependencies: RepositoryCandidateDiscoveryDependencies = defaults,
): Promise<RepositoryCandidateDiscovery> => {
  const maxRootEntries = Math.max(0, limits.maxRootEntries ?? 128);
  const maxSuggestions = Math.max(0, limits.maxSuggestions ?? 16);
  try {
    const entries: RootMetadataEntry[] = [];
    let inspectedEntries = 0;
    if (maxRootEntries > 0) {
      const directory = await dependencies.openRoot(root);
      for await (const entry of directory) {
        inspectedEntries += 1;
        if (entry.name !== "node_modules") entries.push(entry);
        if (inspectedEntries >= maxRootEntries) break;
      }
    }
    const probes = (await dependencies.probeLikelyPaths?.(root)) ?? [];
    const byName = new Map(probes.map((entry) => [entry.name, entry]));
    for (const entry of entries) byName.set(entry.name, entry);
    const likely = [...byName.values()]
      .filter((entry) => LIKELY_LOCAL.test(entry.name))
      .toSorted((left, right) => compare(left.name, right.name));
    if (likely.length === 0 || maxSuggestions === 0) {
      return { candidates: [], inspectedEntries };
    }
    const ignored = new Set(
      await dependencies.checkIgnored(
        likely.map(({ name }) => name),
        root,
      ),
    );
    const candidates = likely
      .filter(({ name }) => ignored.has(name))
      .slice(0, maxSuggestions)
      .map(
        (entry): RepositoryLocalCandidate => ({
          kind: entry.isDirectory() ? "directory" : "file",
          path: entry.name,
          selected: false,
        }),
      );
    return { candidates, inspectedEntries };
  } catch {
    return {
      candidates: [],
      diagnostic: "Local path suggestions are unavailable; manual entry remains available.",
      inspectedEntries: 0,
    };
  }
};
