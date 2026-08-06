import type { WorkspaceRepository } from "./config.ts";

export type RepositoryFilterName = "only" | "group";

export interface RepositoryFilterResult<T extends WorkspaceRepository = WorkspaceRepository> {
  selected: T[];
  emptyFilters: RepositoryFilterName[];
  missing: string[];
  unknownGroups: string[];
  emptyIntersection: boolean;
  filters: {
    only: string[];
    groups: string[];
  };
}

export class EmptyRepositoryFiltersError extends Error {
  readonly code = "EMPTY_REPOSITORY_FILTERS";
  readonly details: { emptyFilters: RepositoryFilterName[] };

  constructor(emptyFilters: RepositoryFilterName[]) {
    const options = emptyFilters.map((filter) => `--${filter}`);
    super(
      `Explicitly empty repository ${options.length === 1 ? "filter" : "filters"}: ${options.join(", ")}`,
    );
    this.name = "EmptyRepositoryFiltersError";
    this.details = { emptyFilters };
  }
}

export function normalizeFilterList(values?: string | string[]): string[] {
  if (!values) {
    return [];
  }

  const raw = Array.isArray(values)
    ? values.flatMap((value) => value.split(","))
    : values.split(",");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of raw) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

export function collectRepositoryFilterValues(value: string, previous: string[] = []): string[] {
  return normalizeFilterList([...previous, value]);
}

export function findEmptyRepositoryFilters(
  only?: string | string[],
  groups?: string | string[],
): RepositoryFilterName[] {
  const emptyFilters: RepositoryFilterName[] = [];
  if (only !== undefined && normalizeFilterList(only).length === 0) {
    emptyFilters.push("only");
  }
  if (groups !== undefined && normalizeFilterList(groups).length === 0) {
    emptyFilters.push("group");
  }
  return emptyFilters;
}

const repoMatchesAnyGroup = (repo: WorkspaceRepository, groups: string[]): boolean => {
  if (groups.length === 0) {
    return true;
  }

  const repoGroups = new Set((repo.groups ?? []).map((group) => group.toLowerCase()));
  return groups.some((group) => repoGroups.has(group.toLowerCase()));
};

export function filterRepositories<T extends WorkspaceRepository>(
  repositories: T[],
  only: string[] | string | undefined,
  groups?: string[] | string,
): RepositoryFilterResult<T> {
  const normalizedOnly = normalizeFilterList(only);
  const normalizedGroups = normalizeFilterList(groups);
  const emptyFilters = findEmptyRepositoryFilters(only, groups);
  const repoMap = new Map(repositories.map((repo) => [repo.name, repo]));
  const configuredGroups = new Set(
    repositories.flatMap((repo) => repo.groups ?? []).map((group) => group.toLowerCase()),
  );
  const unknownGroups = normalizedGroups.filter(
    (group) => !configuredGroups.has(group.toLowerCase()),
  );

  let candidates: T[] = repositories;
  const missing: string[] = [];

  if (normalizedOnly.length > 0) {
    candidates = [];
    for (const name of normalizedOnly) {
      const repo = repoMap.get(name);
      if (repo) {
        candidates.push(repo);
      } else {
        missing.push(name);
      }
    }
  }

  const selected =
    emptyFilters.length > 0 || unknownGroups.length > 0
      ? []
      : candidates.filter((repo) => repoMatchesAnyGroup(repo, normalizedGroups));

  return {
    emptyFilters,
    emptyIntersection:
      emptyFilters.length === 0 &&
      missing.length === 0 &&
      unknownGroups.length === 0 &&
      (normalizedOnly.length > 0 || normalizedGroups.length > 0) &&
      selected.length === 0,
    filters: { groups: normalizedGroups, only: normalizedOnly },
    missing,
    selected,
    unknownGroups,
  };
}
