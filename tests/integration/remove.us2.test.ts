/**
 * Integration test: User Story 2 - interactive multi-select
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { spawn } from 'bun';
import { executeRemove } from '../../src/commands/remove.ts';
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from '../helpers/remove-test-workspace.ts';

describe('remove command - US2 multi-select', () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(['repo-a', 'repo-b']);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test('removes selected branches when no args provided', async () => {
    const branchA = 'feature-a';
    const branchB = 'feature-b';
    const worktreesA = await createWorktreesForBranch(workspace, branchA, true);
    const worktreesB = await createWorktreesForBranch(workspace, branchB, true);

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(undefined, { force: false }, {
        multiSelect: async () => ({ status: 'ok', value: [branchA, branchB] }),
        confirm: async () => ({ status: 'ok', value: true }),
      });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    for (const path of [...Object.values(worktreesA), ...Object.values(worktreesB)]) {
      expect(existsSync(path)).toBe(false);
    }

    const reposToCheck = [workspace.rootPath, ...workspace.repos.map(r => r.path)];
    for (const repoPath of reposToCheck) {
      for (const branch of [branchA, branchB]) {
        const proc = spawn(
          ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
          { cwd: repoPath, stdout: 'ignore', stderr: 'ignore' }
        );
        const exitCode = await proc.exited;
        expect(exitCode).not.toBe(0);
      }
    }
  });

  test('exits cleanly when no branches are selected', async () => {
    const branchName = 'feature-none';
    await createWorktreesForBranch(workspace, branchName, true);

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(undefined, { force: false }, {
        multiSelect: async () => ({ status: 'ok', value: [] }),
        confirm: async () => ({ status: 'ok', value: true }),
      });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    const reposToCheck = [workspace.rootPath, ...workspace.repos.map(r => r.path)];
    for (const repoPath of reposToCheck) {
      const proc = spawn(
        ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
        { cwd: repoPath, stdout: 'ignore', stderr: 'ignore' }
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    }
  });
});
