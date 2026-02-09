import type { WorkspaceRepository } from './config.ts';
import type { SetupScopeType, SetupTarget } from './setup-types.ts';
import { join } from 'path';

const DEFAULT_SETUP_PATTERNS = ['setup.sh', 'setup.bash', '.arashi/setup.sh'];

export interface SetupTargetDiscoveryResult {
  targets: SetupTarget[];
  missing: string[];
}

export async function discoverSetupTargets(
  repositories: WorkspaceRepository[],
  only: string[] | undefined
): Promise<SetupTargetDiscoveryResult> {
  const normalizedOnly = normalizeOnly(only);
  const missing = normalizedOnly.length === 0 ? [] : findMissingRepositories(repositories, normalizedOnly);

  const targets: SetupTarget[] = [];
  for (let index = 0; index < repositories.length; index += 1) {
    const repository = repositories[index];
    const selected = normalizedOnly.length === 0 || normalizedOnly.includes(repository.name);
    const setupScriptPath = selected ? await detectSetupScript(repository.path) : undefined;
    const hasSetupTask = selected ? Boolean(setupScriptPath) : false;

    let skipReason: string | undefined;
    if (!selected) {
      skipReason = 'excluded by --only filter';
    } else if (!hasSetupTask) {
      skipReason = 'no setup script found';
    }

    targets.push({
      ...repository,
      scopeType: index === 0 ? 'main' : 'sub',
      selected,
      hasSetupTask,
      setupScriptPath,
      skipReason,
    });
  }

  return { targets, missing };
}

export function orderSetupTargets(targets: SetupTarget[]): SetupTarget[] {
  const mainTargets = targets.filter(target => target.scopeType === 'main');
  const subTargets = targets.filter(target => target.scopeType === 'sub');
  return [...mainTargets, ...subTargets];
}

function normalizeOnly(only: string[] | undefined): string[] {
  if (!only || only.length === 0) {
    return [];
  }

  return Array.from(new Set(only.map(name => name.trim()).filter(Boolean)));
}

function findMissingRepositories(repositories: WorkspaceRepository[], only: string[]): string[] {
  const repositoryNames = new Set(repositories.map(repository => repository.name));
  return only.filter(name => !repositoryNames.has(name));
}

async function detectSetupScript(repositoryPath: string): Promise<string | undefined> {
  for (const pattern of DEFAULT_SETUP_PATTERNS) {
    const candidate = join(repositoryPath, pattern);
    const exists = await Bun.file(candidate).exists();
    if (exists) {
      return candidate;
    }
  }

  return undefined;
}

export function isExecutableTarget(target: SetupTarget): boolean {
  return target.selected && target.hasSetupTask && Boolean(target.setupScriptPath);
}

export function getScopeLabel(scope: SetupScopeType): string {
  return scope === 'main' ? 'main' : 'sub';
}
