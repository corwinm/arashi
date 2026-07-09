import type { RepoConfig } from "../config.ts";
import { normalizeFilterList } from "../repo-filter.ts";

export interface FilteredRepository {
  name: string;
  config: RepoConfig;
}

export interface FilterReposResult {
  repositories: FilteredRepository[];
  missing: string[];
  unknownGroups: string[];
  emptyIntersection: boolean;
  filters: {
    only: string[];
    groups: string[];
  };
}

export function normalizeOnlyList(only?: string | string[]): string[] {
  return normalizeFilterList(only);
}

const repoMatchesAnyGroup = (repo: RepoConfig, groups: string[]): boolean => {
  if (groups.length === 0) {
    return true;
  }
  const repoGroups = new Set((repo.groups ?? []).map((group) => group.toLowerCase()));
  return groups.some((group) => repoGroups.has(group.toLowerCase()));
};

export function filterRepositories(
  repos: Record<string, RepoConfig>,
  only?: string | string[],
  groups?: string | string[],
): FilterReposResult {
  const onlyList = normalizeOnlyList(only);
  const groupList = normalizeFilterList(groups);
  const configuredGroups = new Set(
    Object.values(repos)
      .flatMap((repo) => repo.groups ?? [])
      .map((group) => group.toLowerCase()),
  );
  const unknownGroups = groupList.filter((group) => !configuredGroups.has(group.toLowerCase()));

  const candidates: FilteredRepository[] = [];
  const missing: string[] = [];

  if (onlyList.length === 0) {
    candidates.push(...Object.entries(repos).map(([name, config]) => ({ config, name })));
  } else {
    for (const name of onlyList) {
      const config = repos[name];
      if (!config) {
        missing.push(name);
        continue;
      }
      candidates.push({ config, name });
    }
  }

  const repositories =
    unknownGroups.length > 0
      ? []
      : candidates.filter((repo) => repoMatchesAnyGroup(repo.config, groupList));

  return {
    emptyIntersection:
      missing.length === 0 &&
      unknownGroups.length === 0 &&
      (onlyList.length > 0 || groupList.length > 0) &&
      repositories.length === 0,
    filters: { groups: groupList, only: onlyList },
    missing,
    repositories,
    unknownGroups,
  };
}
