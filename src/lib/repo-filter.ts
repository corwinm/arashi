import type { WorkspaceRepository } from "./config.ts";

export interface RepositoryFilterResult<T extends WorkspaceRepository = WorkspaceRepository> {
  selected: T[];
  missing: string[];
  unknownGroups: string[];
  emptyIntersection: boolean;
  filters: {
    only: string[];
    groups: string[];
  };
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
    unknownGroups.length > 0
      ? []
      : candidates.filter((repo) => repoMatchesAnyGroup(repo, normalizedGroups));

  return {
    emptyIntersection:
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
