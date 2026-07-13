import type { RepoConfig } from "../config.ts";
import {
  filterRepositories as filterWorkspaceRepositories,
  normalizeFilterList,
} from "../repo-filter.ts";
import type { RepositoryFilterName } from "../repo-filter.ts";

export interface FilteredRepository {
  name: string;
  config: RepoConfig;
}

export interface FilterReposResult {
  repositories: FilteredRepository[];
  emptyFilters: RepositoryFilterName[];
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

export function filterRepositories(
  repos: Record<string, RepoConfig>,
  only?: string | string[],
  groups?: string | string[],
): FilterReposResult {
  const result = filterWorkspaceRepositories(
    Object.entries(repos).map(([name, config]) => ({ ...config, name })),
    only,
    groups,
  );

  return {
    emptyFilters: result.emptyFilters,
    emptyIntersection: result.emptyIntersection,
    filters: result.filters,
    missing: result.missing,
    repositories: result.selected.map(({ name }) => ({ config: repos[name], name })),
    unknownGroups: result.unknownGroups,
  };
}
