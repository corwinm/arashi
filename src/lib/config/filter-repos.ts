import type { RepoConfig } from "../config.ts";

export interface FilteredRepository {
  name: string;
  config: RepoConfig;
}

export interface FilterReposResult {
  repositories: FilteredRepository[];
  missing: string[];
}

export function normalizeOnlyList(only?: string | string[]): string[] {
  if (!only) {
    return [];
  }

  const raw = Array.isArray(only) ? only : only.split(",");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of raw) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}

export function filterRepositories(
  repos: Record<string, RepoConfig>,
  only?: string | string[],
): FilterReposResult {
  const onlyList = normalizeOnlyList(only);

  if (onlyList.length === 0) {
    return {
      missing: [],
      repositories: Object.entries(repos).map(([name, config]) => ({
        config,
        name,
      })),
    };
  }

  const repositories: FilteredRepository[] = [];
  const missing: string[] = [];

  for (const name of onlyList) {
    const config = repos[name];
    if (!config) {
      missing.push(name);
      continue;
    }
    repositories.push({ config, name });
  }

  return { missing, repositories };
}
