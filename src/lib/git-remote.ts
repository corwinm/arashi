import { exec } from './git.ts';

export interface RemoteChangeStatus {
  repositoryId: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemoteChanges: boolean;
  error?: string;
}

export async function checkRemoteChanges(
  repositoryId: string,
  repoPath: string
): Promise<RemoteChangeStatus> {
  let upstream: string | null = null;

  try {
    const upstreamResult = await exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath);
    upstream = upstreamResult.stdout.trim() || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No upstream configured';
    return {
      repositoryId,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemoteChanges: false,
      error: message,
    };
  }

  try {
    await exec(['fetch', '--prune'], repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote fetch failed';
    return {
      repositoryId,
      upstream,
      ahead: 0,
      behind: 0,
      hasRemoteChanges: false,
      error: message,
    };
  }

  try {
    const result = await exec(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], repoPath);
    const parts = result.stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(parts[0] || '0', 10);
    const behind = Number.parseInt(parts[1] || '0', 10);

    return {
      repositoryId,
      upstream,
      ahead,
      behind,
      hasRemoteChanges: behind > 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Remote change detection failed';
    return {
      repositoryId,
      upstream,
      ahead: 0,
      behind: 0,
      hasRemoteChanges: false,
      error: message,
    };
  }
}
