/**
 * Remove Command
 *
 * Removes worktrees and deletes branches across multiple repositories.
 */

import { Command } from 'commander';
import { basename, resolve } from 'path';
import chalk from 'chalk';
import { confirm as promptConfirm, multiSelect as promptMultiSelect, type Choice } from '../lib/prompts.ts';
import * as logger from '../lib/logger.ts';
import { loadConfig, findWorkspaceRoot, type Config } from '../lib/config.ts';
import { RemoveCommandError, RemoveCommandErrorCode } from '../lib/errors.ts';
import { getDefaultBranch } from '../lib/git.ts';
import type { RemoveCommandOptions, WorktreeInfo, RemovalOperation } from '../types/remove.ts';
import {
  attachDirtyStatus,
  branchExists,
  createRemovalSummary,
  deleteBranch,
  discoverAllWorktrees,
  discoverWorktreesByBranch,
  detachWorktree,
  formatRemovalSummaryHuman,
  formatRemovalSummaryJson,
  getCurrentBranch,
  removeWorktree,
  type RepositoryTarget,
} from '../core/remove.ts';

interface CliOptions {
  checkDirty?: boolean;
  keepWorktrees?: boolean;
  keepBranches?: boolean;
  force?: boolean;
  json?: boolean;
}

export function createCommand(): Command {
  return new Command('remove')
    .description('Remove worktrees and delete branches')
    .argument('[branch]', 'Branch name to remove (optional - prompts if omitted)')
    .option('--no-check-dirty', 'Skip uncommitted changes check')
    .option('--keep-worktrees', 'Delete branches but keep worktree directories')
    .option('--keep-branches', 'Remove worktrees but keep git branches')
    .option('-f, --force', 'Skip confirmation prompts')
    .option('--json', 'Output results as JSON')
    .action(async (branch?: string, options?: CliOptions) => {
      try {
        const exitCode = await executeRemove(branch, options || {});
        process.exit(exitCode);
      } catch (error) {
        handleError(error, options || {});
      }
    });
}

export async function executeRemove(
  branchArg: string | undefined,
  options: RemoveCommandOptions,
  promptHandlers?: {
    confirm: (message: string, defaultValue?: boolean) => Promise<boolean>;
    multiSelect: (message: string, choices: Choice<string>[]) => Promise<string[]>;
  }
): Promise<number> {
  const startTime = Date.now();

  if (options.keepBranches && options.keepWorktrees) {
    const summary = createRemovalSummary(0, 0);
    summary.duration = Date.now() - startTime;
    if (options.json) {
      console.log(formatRemovalSummaryJson(summary, { }));
    } else {
      logger.warn('Both --keep-worktrees and --keep-branches specified');
      logger.info('No operations will be performed. At least one removal type must be enabled.');
    }
    return 0;
  }

  const workspaceRoot = await getWorkspaceRoot();
  let config: Config;
  try {
    config = await loadConfig(workspaceRoot);
  } catch (error) {
    throw new RemoveCommandError(
      'Failed to load workspace configuration',
      RemoveCommandErrorCode.CONFIG_ERROR,
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
  const repositories = buildRepositoryTargets(workspaceRoot, config.discovered_repos);

  if (repositories.length === 0) {
    throw new RemoveCommandError(
      'No repositories found in workspace',
      RemoveCommandErrorCode.NO_REPOSITORIES
    );
  }

  const prompt = promptHandlers || { confirm: promptConfirm, multiSelect: promptMultiSelect };
  const defaultBranches = await getDefaultBranchMap(workspaceRoot, config.discovered_repos);
  let targetBranches: string[] = [];
  if (branchArg) {
    targetBranches = [branchArg];
  } else {
    const allWorktrees = await discoverAllWorktrees(repositories);
    const selectable = allWorktrees.filter(wt => !wt.isMain && wt.branch);

    if (selectable.length === 0) {
      logger.info('No worktrees found to remove');
      return 0;
    }

    await attachDirtyStatus(selectable);
    const choices = buildBranchChoices(selectable, defaultBranches);
    targetBranches = await prompt.multiSelect('Select worktrees to remove:', choices);

    if (targetBranches.length === 0) {
      logger.info('No branches selected');
      return 0;
    }
  }

  const worktreesToRemove: WorktreeInfo[] = [];
  const skippedMain: WorktreeInfo[] = [];
  const worktreeCounts: Record<string, number> = {};

  for (const branch of targetBranches) {
    const worktrees = await discoverWorktreesByBranch(branch, repositories);
    const mainWorktrees = worktrees.filter(wt => wt.isMain);
    const removable = worktrees.filter(wt => !wt.isMain);

    if (mainWorktrees.length > 0) {
      skippedMain.push(...mainWorktrees);
    }

    worktreesToRemove.push(...removable);
    worktreeCounts[branch] = removable.length;
  }

  const branchPresence: Record<string, string[]> = {};
  const missingBranches: Record<string, string[]> = {};

  for (const branch of targetBranches) {
    branchPresence[branch] = [];
    missingBranches[branch] = [];

    for (const repo of repositories) {
      const exists = await branchExists(repo.path, branch);
      if (exists) {
        branchPresence[branch].push(repo.name);
      } else {
        missingBranches[branch].push(repo.name);
      }
    }

    if (branchPresence[branch].length === 0 && worktreeCounts[branch] === 0) {
      throw new RemoveCommandError(
        `Branch '${branch}' not found in any repository`,
        RemoveCommandErrorCode.BRANCH_NOT_FOUND,
        { branch }
      );
    }
  }

  warnOnDefaultMainRemoval(skippedMain, defaultBranches);

  if (options.checkDirty !== false && worktreesToRemove.length > 0) {
    const s = logger.spinner('Checking for uncommitted changes...').start();
    await attachDirtyStatus(worktreesToRemove);
    s.succeed('Dirty check complete');
  }

  if (!options.force) {
    const confirmed = await promptConfirmation(
      worktreesToRemove,
      branchPresence,
      options.checkDirty !== false,
      prompt.confirm
    );
    if (!confirmed) {
      logger.info('Operation cancelled by user');
      return 0;
    }
  }

  const totalWorktrees = options.keepWorktrees ? 0 : worktreesToRemove.length;
  const totalBranches = options.keepBranches
    ? 0
    : Object.values(branchPresence).reduce((sum, repos) => sum + repos.length, 0);

  const summary = createRemovalSummary(totalWorktrees, totalBranches);

  if (options.keepWorktrees && worktreesToRemove.length > 0) {
    for (const worktree of worktreesToRemove) {
      try {
        await detachWorktree(worktree.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`${worktree.repository}: Failed to detach worktree (${message})`);
      }
    }
  }

  if (!options.keepWorktrees) {
    for (const worktree of worktreesToRemove) {
      const operation: RemovalOperation = {
        type: 'worktree_remove',
        repository: worktree.repository,
        branchName: worktree.branch,
        worktreePath: worktree.path,
        status: 'pending',
      };

      try {
        const forceRemove = options.checkDirty === false || worktree.isDirty === true;
        await removeWorktree(worktree, getRepoPath(repositories, worktree.repository), forceRemove || false);
        operation.status = 'success';
      } catch (error) {
        operation.status = 'failed';
        operation.error = formatWorktreeRemovalError(error);
      }

      summary.operations.push(operation);
      if (operation.status === 'success') {
        summary.successfulWorktrees += 1;
      }
      if (operation.status === 'failed' && operation.error) {
        summary.errors.push(`${operation.repository}: ${operation.error}`);
      }
    }
  }

  if (!options.keepBranches) {
    for (const branch of targetBranches) {
      for (const repoName of branchPresence[branch]) {
        const repoPath = getRepoPath(repositories, repoName);
        const operation: RemovalOperation = {
          type: 'branch_delete',
          repository: repoName,
          branchName: branch,
          status: 'pending',
        };

        const currentBranch = await getCurrentBranch(repoPath);
        if (currentBranch === branch) {
          operation.status = 'failed';
          operation.error = 'Branch is currently checked out';
        } else {
          try {
            await deleteBranch(repoPath, branch);
            operation.status = 'success';
          } catch (error) {
            operation.status = 'failed';
            operation.error = formatBranchDeletionError(error);
          }
        }

        summary.operations.push(operation);
        if (operation.status === 'success') {
          summary.successfulBranches += 1;
        }
        if (operation.status === 'failed' && operation.error) {
          summary.errors.push(`${operation.repository}: ${operation.error}`);
        }
      }
    }
  }

  summary.duration = Date.now() - startTime;

  if (options.json) {
    console.log(formatRemovalSummaryJson(summary, { skippedMain, missingBranches }));
  } else {
    console.log(formatRemovalSummaryHuman(summary, { skippedMain, missingBranches }));
  }

  return summary.errors.length > 0 ? 1 : 0;
}

function buildRepositoryTargets(
  workspaceRoot: string,
  repos: Record<string, { path: string }>
): RepositoryTarget[] {
  const targets: RepositoryTarget[] = [];
  const mainName = basename(workspaceRoot);
  targets.push({ name: mainName, path: workspaceRoot });

  for (const [name, repo] of Object.entries(repos)) {
    targets.push({ name, path: resolve(workspaceRoot, repo.path) });
  }

  return targets;
}

function getRepoPath(repositories: RepositoryTarget[], repoName: string): string {
  const repo = repositories.find(r => r.name === repoName);
  if (!repo) {
    return repoName;
  }
  return repo.path;
}

function buildBranchChoices(
  worktrees: WorktreeInfo[],
  defaultBranches: Record<string, string | null>
): Choice<string>[] {
  const grouped = new Map<string, WorktreeInfo[]>();

  for (const wt of worktrees) {
    if (!wt.branch) {
      continue;
    }
    if (!grouped.has(wt.branch)) {
      grouped.set(wt.branch, []);
    }
    grouped.get(wt.branch)!.push(wt);
  }

  const choices: Choice<string>[] = [];
  for (const [branch, items] of grouped.entries()) {
    const hasDirty = items.some(wt => wt.isDirty);
    const status = hasDirty ? chalk.yellow('dirty') : chalk.green('clean');
    const isDefault = items.some(wt => defaultBranches[wt.repository] === branch);
    const defaultTag = isDefault ? chalk.cyan('default') : null;
    const repoCount = items.length;
    const label = `${branch} (${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}) - ${status}${defaultTag ? `, ${defaultTag}` : ''}`;
    choices.push({ value: branch, name: label });
  }

  return choices;
}

async function getDefaultBranchMap(
  workspaceRoot: string,
  repos: Record<string, { path: string; default_branch?: string }>
): Promise<Record<string, string | null>> {
  const map: Record<string, string | null> = {};
  const mainName = basename(workspaceRoot);
  map[mainName] = await resolveDefaultBranch(workspaceRoot);

  for (const [name, repo] of Object.entries(repos)) {
    if (repo.default_branch) {
      map[name] = repo.default_branch;
    } else {
      const repoPath = resolve(workspaceRoot, repo.path);
      map[name] = await resolveDefaultBranch(repoPath);
    }
  }

  return map;
}

async function resolveDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    return await getDefaultBranch(repoPath);
  } catch {
    return null;
  }
}

function warnOnDefaultMainRemoval(
  skippedMain: WorktreeInfo[],
  defaultBranches: Record<string, string | null>
): void {
  const warnings = skippedMain.filter(wt => defaultBranches[wt.repository] === wt.branch);
  if (warnings.length === 0) {
    return;
  }

  logger.warn('Default branch main worktree selected; main worktrees cannot be removed:');
  for (const wt of warnings) {
    logger.info(`  • ${wt.repository}: ${wt.branch} (${wt.path})`);
  }
}

async function promptConfirmation(
  worktrees: WorktreeInfo[],
  branchPresence: Record<string, string[]>,
  checkDirty: boolean,
  confirm: typeof promptConfirm
): Promise<boolean> {
  if (checkDirty) {
    const dirty = worktrees.filter(wt => wt.isDirty);
    if (dirty.length > 0) {
      logger.warn(`Uncommitted changes detected in ${dirty.length} worktrees:`);
      for (const wt of dirty) {
        const details = wt.dirtyDetails;
        const parts: string[] = [];
        if (details) {
          if (details.modifiedFiles > 0) parts.push(`${details.modifiedFiles} modified files`);
          if (details.untrackedFiles > 0) parts.push(`${details.untrackedFiles} untracked files`);
          if (details.stagedFiles > 0) parts.push(`${details.stagedFiles} staged files`);
        }
        const detailText = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        logger.info(`  • ${wt.repository}: ${wt.path}${detailText}`);
      }

      return await confirm(
        'Are you sure you want to remove these worktrees? This will discard all uncommitted changes.',
        false
      );
    }
  }

  const worktreeCount = worktrees.length;
  const branchCount = Object.values(branchPresence).reduce((sum, repos) => sum + repos.length, 0);

  return await confirm(
    `Remove ${worktreeCount} ${worktreeCount === 1 ? 'worktree' : 'worktrees'} and delete ${branchCount} ${branchCount === 1 ? 'branch' : 'branches'}?`,
    false
  );
}

async function getWorkspaceRoot(): Promise<string> {
  try {
    return await findWorkspaceRoot();
  } catch (error) {
    throw new RemoveCommandError(
      'Arashi configuration not found. Run "arashi init" to create configuration.',
      RemoveCommandErrorCode.CONFIG_ERROR,
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
}

function handleError(error: unknown, options: RemoveCommandOptions): void {
  if (error instanceof RemoveCommandError) {
    if (options.json) {
      console.log(JSON.stringify({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          context: error.context,
        },
      }, null, 2));
    } else {
      logger.error(error.message);
      if (error.code === RemoveCommandErrorCode.BRANCH_NOT_FOUND) {
        logger.info('Hint: Run "arashi list" to see all worktrees');
      }
    }

    process.exit(error.code === RemoveCommandErrorCode.BRANCH_NOT_FOUND ? 2 : 1);
  }

  const message = error instanceof Error ? error.message : 'Unknown error';
  if (options.json) {
    console.log(JSON.stringify({
      success: false,
      error: {
        code: 'UNKNOWN_ERROR',
        message,
      },
    }, null, 2));
  } else {
    logger.error(`Unexpected error: ${message}`);
  }
  process.exit(1);
}

function formatWorktreeRemovalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('in use') || lower.includes('busy')) {
    return 'Worktree is in use by another process';
  }

  if (lower.includes('locked')) {
    return 'Worktree is locked (use --force to override)';
  }

  return message;
}

function formatBranchDeletionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('checked out')) {
    return 'Branch is currently checked out';
  }

  return message;
}
