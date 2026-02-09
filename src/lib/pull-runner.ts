import { exec } from './git.ts';
import { isAbsolute, resolve } from 'path';

export interface PullExecutionOptions {
  timeoutMs?: number;
  verbose?: boolean;
}

export interface PullExecutionResult {
  status: 'updated' | 'manual-update' | 'failed';
  output: string;
  errorMessage?: string;
}

export async function runPullWithRollback(
  repoPath: string,
  options: PullExecutionOptions = {}
): Promise<PullExecutionResult> {
  const wasClean = await isWorkingTreeClean(repoPath);
  const originalHead = await getHeadCommit(repoPath);

  const pullResult = await runGitCommand(
    ['pull', '--no-rebase'],
    repoPath,
    options.timeoutMs
  );

  if (pullResult.exitCode === 0) {
    return {
      status: 'updated',
      output: pullResult.output,
    };
  }

  const rollbackSucceeded = await rollbackPull(repoPath, originalHead, wasClean);
  const status = pullResult.timedOut ? 'failed' : 'manual-update';
  return {
    status,
    output: pullResult.output,
    errorMessage: rollbackSucceeded
      ? pullResult.error || 'Pull failed and was rolled back'
      : `${pullResult.error || 'Pull failed'} (rollback failed)`,
  };
}

async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  try {
    const result = await exec(['status', '--porcelain'], repoPath);
    return result.stdout.trim().length === 0;
  } catch {
    return false;
  }
}

async function getHeadCommit(repoPath: string): Promise<string> {
  const result = await exec(['rev-parse', 'HEAD'], repoPath);
  return result.stdout.trim();
}

async function rollbackPull(
  repoPath: string,
  originalHead: string,
  wasClean: boolean
): Promise<boolean> {
  const mergeAborted = await abortMergeIfNeeded(repoPath);
  if (mergeAborted) {
    return true;
  }

  if (wasClean) {
    try {
      await exec(['reset', '--hard', originalHead], repoPath);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

async function abortMergeIfNeeded(repoPath: string): Promise<boolean> {
  try {
    const mergeHeadPathResult = await exec(['rev-parse', '--git-path', 'MERGE_HEAD'], repoPath);
    const mergeHeadPath = mergeHeadPathResult.stdout.trim();
    if (!mergeHeadPath) {
      return false;
    }

    const resolvedPath = isAbsolute(mergeHeadPath) ? mergeHeadPath : resolve(repoPath, mergeHeadPath);
    const mergeHeadFile = Bun.file(resolvedPath);
    if (await mergeHeadFile.exists()) {
      await exec(['merge', '--abort'], repoPath);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function runGitCommand(
  args: string[],
  cwd: string,
  timeoutMs?: number
): Promise<{ exitCode: number; output: string; error?: string; timedOut?: boolean }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env as Record<string, string>,
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<number>((resolve) => {
    if (!timeoutMs) {
      return;
    }
    timeoutId = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Ignore kill errors
      }
      resolve(-1);
    }, timeoutMs);
  });

  const exitCode = await Promise.race([proc.exited, timeoutPromise]) as number;
  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  const output = [stdout, stderr].filter(Boolean).join('\n').trim();

  if (exitCode !== 0) {
    if (exitCode === -1 && timeoutMs) {
      return {
        exitCode,
        output,
        error: `Timed out after ${timeoutMs}ms`,
        timedOut: true,
      };
    }
    return {
      exitCode,
      output,
      error: stderr.trim() || stdout.trim() || 'Git command failed',
    };
  }

  return { exitCode, output };
}
