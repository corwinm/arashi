import type { WorkspaceRepository } from './config.ts';

export interface RepositoryFilterResult {
  selected: WorkspaceRepository[];
  missing: string[];
}

export function filterRepositories(
  repositories: WorkspaceRepository[],
  only: string[] | undefined
): RepositoryFilterResult {
  if (!only || only.length === 0) {
    return { selected: repositories, missing: [] };
  }

  const normalizedOnly = Array.from(new Set(only.map(name => name.trim()).filter(Boolean)));
  const repoMap = new Map(repositories.map(repo => [repo.name, repo]));
  const selected: WorkspaceRepository[] = [];
  const missing: string[] = [];

  for (const name of normalizedOnly) {
    const repo = repoMap.get(name);
    if (repo) {
      selected.push(repo);
    } else {
      missing.push(name);
    }
  }

  return { selected, missing };
}
