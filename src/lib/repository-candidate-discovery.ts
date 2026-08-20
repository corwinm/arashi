import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
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
}
const LIKELY_LOCAL =
  /^(?:\.env(?:\..+)?|\.cache|\.local|local(?:\..+)?|.*\.local\.(?:json|ya?ml|toml))$/i;
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const defaults: RepositoryCandidateDiscoveryDependencies = {
  openRoot: (root) => opendir(root),
  checkIgnored: async (paths, root) => {
    const { stdout } = await exec("git", ["check-ignore", "--", ...paths], {
      cwd: root,
      maxBuffer: 16_384,
    }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    return stdout.split(/\r?\n/).filter(Boolean);
  },
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
    entries.sort((left, right) => compare(left.name, right.name));
    const likely = entries.filter((entry) => LIKELY_LOCAL.test(entry.name));
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
