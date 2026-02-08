/**
 * Core helpers for remove command
 */

import { realpathSync } from 'fs';
import chalk from 'chalk';
import { basename, resolve as resolvePath } from 'path';
import * as git from '../lib/git.ts';
import { ArashiError } from '../lib/errors.ts';
import { GitErrorCode } from '../types/git.ts';
import type {
  WorktreeEntry,
  WorktreeGrouping,
  WorktreeInfo,
  RemovalSummary,
  RemovalOperation,
} from '../types/remove.ts';
import { buildWorktreeEntries, resolveWorktreeStatuses } from './worktree.ts';

export interface RepositoryTarget {
  name: string;
  path: string;
}

export function parseWorktreeList(
  output: string,
  repoName: string,
  repoPath: string
): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const lines = output.trim().split('\n');
  let current: Partial<WorktreeInfo> = {};
  let isBare = false;
  let canonicalRepoPath = repoPath;

  try {
    canonicalRepoPath = realpathSync(repoPath);
  } catch {
    canonicalRepoPath = repoPath;
  }

  const pushCurrent = () => {
    if (!current.path || isBare) {
      return;
    }

    let canonicalWorktreePath = current.path;
    try {
      canonicalWorktreePath = realpathSync(current.path);
    } catch {
      canonicalWorktreePath = current.path;
    }

    const isMain = canonicalWorktreePath === canonicalRepoPath;
    worktrees.push({
      path: current.path,
      branch: current.branch || '',
      repository: repoName,
      isMain,
    });
  };

  for (const line of lines) {
    if (line === '') {
      pushCurrent();
      current = {};
      isBare = false;
      continue;
    }

    if (line.startsWith('worktree ')) {
      current.path = line.substring('worktree '.length);
      current.repository = repoName;
      continue;
    }

    if (line === 'bare') {
      isBare = true;
      continue;
    }

    if (line.startsWith('branch ')) {
      const ref = line.substring('branch '.length);
      current.branch = ref.replace('refs/heads/', '');
      continue;
    }

    if (line.startsWith('detached')) {
      current.branch = '';
      continue;
    }
  }

  pushCurrent();

  return worktrees;
}

export async function discoverWorktreesByBranch(
  branchName: string,
  repositories: RepositoryTarget[]
): Promise<WorktreeInfo[]> {
  const results: WorktreeInfo[] = [];

  for (const repo of repositories) {
    try {
      const result = await git.exec(['worktree', 'list', '--porcelain'], repo.path);
      const worktrees = parseWorktreeList(result.stdout, repo.name, repo.path);
      results.push(...worktrees.filter(wt => wt.branch === branchName));
    } catch {
      continue;
    }
  }

  return results;
}

export async function discoverWorktreesByPath(
  worktreePath: string,
  repositories: RepositoryTarget[]
): Promise<WorktreeInfo[]> {
  const results: WorktreeInfo[] = [];
  const targetPath = normalizePath(worktreePath);

  for (const repo of repositories) {
    try {
      const result = await git.exec(['worktree', 'list', '--porcelain'], repo.path);
      const worktrees = parseWorktreeList(result.stdout, repo.name, repo.path);
      for (const worktree of worktrees) {
        const candidatePath = normalizePath(worktree.path);
        if (candidatePath === targetPath) {
          results.push(worktree);
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

export async function discoverAllWorktrees(
  repositories: RepositoryTarget[]
): Promise<WorktreeInfo[]> {
  const results: WorktreeInfo[] = [];

  for (const repo of repositories) {
    try {
      const result = await git.exec(['worktree', 'list', '--porcelain'], repo.path);
      results.push(...parseWorktreeList(result.stdout, repo.name, repo.path));
    } catch {
      continue;
    }
  }

  return results;
}

function normalizePath(pathInput: string): string {
  try {
    return realpathSync(pathInput);
  } catch {
    return resolvePath(pathInput);
  }
}

export function groupWorktreesByParent(entries: WorktreeEntry[]): WorktreeGrouping {
  const groups: WorktreeGrouping['groups'] = [];
  const orphans: WorktreeEntry[] = [];
  const entryByPath = new Map<string, WorktreeEntry>();
  const groupByParent = new Map<string, { parent: WorktreeEntry; children: WorktreeEntry[] }>();

  for (const entry of entries) {
    entryByPath.set(normalizePath(entry.path), entry);
  }

  for (const entry of entries) {
    if (entry.childrenPaths.length > 0) {
      groupByParent.set(normalizePath(entry.path), { parent: entry, children: [] });
    }
  }

  for (const entry of entries) {
    if (!entry.parentPath) {
      continue;
    }

    const parent = entryByPath.get(normalizePath(entry.parentPath));
    if (!parent) {
      orphans.push(entry);
      continue;
    }

    let group = groupByParent.get(normalizePath(parent.path));
    if (!group) {
      group = { parent, children: [] };
      groupByParent.set(normalizePath(parent.path), group);
    }
    group.children.push(entry);
  }

  for (const entry of entries) {
    if (entry.parentPath) {
      continue;
    }
    if (groupByParent.has(normalizePath(entry.path))) {
      continue;
    }
    orphans.push(entry);
  }

  for (const group of groupByParent.values()) {
    groups.push(group);
  }

  return { groups, orphans };
}

export async function refreshRemainingChildStatuses(
  removed: WorktreeEntry,
  remaining: WorktreeEntry[],
  includeDirtyDetails: boolean
): Promise<void> {
  if (removed.childrenPaths.length === 0) {
    return;
  }

  const children = remaining.filter(entry => removed.childrenPaths.includes(entry.path));
  if (children.length === 0) {
    return;
  }

  await resolveWorktreeStatuses(children, includeDirtyDetails);
}

export async function removeWorktree(
  worktree: WorktreeInfo,
  repoPath: string,
  force: boolean
): Promise<void> {
  const args = ['worktree', 'remove', worktree.path];
  if (force) {
    args.push('--force');
  }

  try {
    await git.exec(args, repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('locked')) {
      await git.exec([...args, '--force'], repoPath);
    } else {
      throw error;
    }
  }
}

export async function deleteBranch(repoPath: string, branchName: string): Promise<void> {
  await git.exec(['branch', '-D', branchName], repoPath);
}

export async function detachWorktree(worktreePath: string): Promise<void> {
  await git.exec(['checkout', '--detach'], worktreePath);
}

export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await git.exec(['show-ref', '--verify', `refs/heads/${branchName}`], repoPath);
    return true;
  } catch (error) {
    if (error instanceof ArashiError && error.code === GitErrorCode.NOT_FOUND) {
      return false;
    }
    return false;
  }
}

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const result = await git.exec(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    const branch = result.stdout.trim();
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

export function createRemovalSummary(totalWorktrees: number, totalBranches: number): RemovalSummary {
  return {
    totalWorktrees,
    successfulWorktrees: 0,
    totalBranches,
    successfulBranches: 0,
    operations: [],
    errors: [],
    duration: 0,
  };
}

export function recordOperation(summary: RemovalSummary, operation: RemovalOperation): void {
  summary.operations.push(operation);
  if (operation.type === 'worktree_remove' && operation.status === 'success') {
    summary.successfulWorktrees += 1;
  }
  if (operation.type === 'branch_delete' && operation.status === 'success') {
    summary.successfulBranches += 1;
  }
  if (operation.status === 'failed' && operation.error) {
    summary.errors.push(`${operation.repository}: ${operation.error}`);
  }
}

export function formatRemovalSummaryHuman(
  summary: RemovalSummary,
  extras?: {
    skippedMain?: WorktreeInfo[];
    missingBranches?: Record<string, string[]>;
  }
): string {
  const lines: string[] = [];
  const hasErrors = summary.errors.length > 0;

  if (hasErrors) {
    lines.push(chalk.red(`✗ Partial removal completed with ${summary.errors.length} errors`));
  } else {
    lines.push(chalk.green(`✓ Successfully removed ${summary.successfulWorktrees} worktrees and deleted ${summary.successfulBranches} branches`));
  }

  if (summary.successfulWorktrees > 0) {
    lines.push('');
    lines.push('Removed worktrees:');
    for (const op of summary.operations) {
      if (op.type === 'worktree_remove' && op.status === 'success') {
        lines.push(`  • ${op.repository}: ${op.worktreePath}`);
      }
    }
  }

  if (summary.successfulBranches > 0) {
    lines.push('');
    lines.push('Deleted branches:');
    for (const op of summary.operations) {
      if (op.type === 'branch_delete' && op.status === 'success') {
        lines.push(`  • ${op.repository}: ${op.branchName}`);
      }
    }
  }

  if (extras?.skippedMain && extras.skippedMain.length > 0) {
    lines.push('');
    for (const wt of extras.skippedMain) {
      lines.push(`Skipping main worktree: ${wt.path} (cannot be removed)`);
    }
  }

  if (extras?.missingBranches) {
    const entries = Object.entries(extras.missingBranches);
    for (const [branch, repos] of entries) {
      if (repos.length > 0) {
        lines.push('');
        lines.push(`Note: Branch '${branch}' not found in: ${repos.join(', ')}`);
      }
    }
  }

  if (hasErrors) {
    lines.push('');
    lines.push('Errors:');
    for (const error of summary.errors) {
      lines.push(`  • ${error}`);
    }
  }

  lines.push('');
  lines.push(`Total duration: ${(summary.duration / 1000).toFixed(2)}s`);

  return lines.join('\n');
}

export function formatRemovalSummaryJson(
  summary: RemovalSummary,
  extras?: {
    skippedMain?: WorktreeInfo[];
    missingBranches?: Record<string, string[]>;
  }
): string {
  const payload: Record<string, any> = {
    success: summary.errors.length === 0,
    summary: {
      totalWorktrees: summary.totalWorktrees,
      successfulWorktrees: summary.successfulWorktrees,
      totalBranches: summary.totalBranches,
      successfulBranches: summary.successfulBranches,
      duration: summary.duration,
    },
    operations: summary.operations,
    errors: summary.errors,
  };

  if (extras?.skippedMain && extras.skippedMain.length > 0) {
    payload.skippedMain = extras.skippedMain.map(wt => ({
      repository: wt.repository,
      path: wt.path,
    }));
  }

  if (extras?.missingBranches) {
    payload.missingBranches = extras.missingBranches;
  }

  return JSON.stringify(payload, null, 2);
}
