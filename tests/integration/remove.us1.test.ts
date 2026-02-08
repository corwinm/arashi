/**
 * Integration test: User Story 1 - remove single branch
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { spawn } from 'bun';
import { executeRemove } from '../../src/commands/remove.ts';
import {
  createRemoveWorkspace,
  createWorktreesForBranch,
} from '../helpers/remove-test-workspace.ts';

describe('remove command - US1 single branch', () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(['repo-a', 'repo-b']);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test('removes worktrees and deletes branches across repositories', async () => {
    const branchName = 'feature-us1';
    const worktrees = await createWorktreesForBranch(workspace, branchName, true);

    const originalCwd = process.cwd();
    process.chdir(workspace.rootPath);

    try {
      const exitCode = await executeRemove(branchName, { force: true });
      expect(exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    for (const path of Object.values(worktrees)) {
      expect(existsSync(path)).toBe(false);
    }

    const reposToCheck = [workspace.rootPath, ...workspace.repos.map(r => r.path)];
    for (const repoPath of reposToCheck) {
      const proc = spawn(
        ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
        { cwd: repoPath, stdout: 'ignore', stderr: 'ignore' }
      );
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
    }
  });
});
