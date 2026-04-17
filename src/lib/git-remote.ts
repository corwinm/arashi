import { exec } from "./git.ts";

export interface RemoteTrackingTarget {
  upstream: string | null;
  remote: string;
  branch: string;
}

export type RemoteTrackingTargetResolution =
  | { ok: true; target: RemoteTrackingTarget }
  | { ok: false; error: string; upstream: string | null };

export interface RemoteChangeStatus {
  repositoryId: string;
  upstream: string | null;
  remote?: string | null;
  branch?: string | null;
  ahead: number;
  behind: number;
  hasRemoteChanges: boolean;
  error?: string;
}

export type RemoteTrackingFetchResult =
  | { ok: true }
  | {
      ok: false;
      kind: "generic" | "missing-remote-ref";
      error: string;
      message: string;
    };

export function classifyRemoteTrackingFetchFailure(
  error: string,
  target: RemoteTrackingTarget,
): Exclude<RemoteTrackingFetchResult, { ok: true }> {
  const missingRemoteRefMatch = error.match(/could(?:n't| not) find remote ref\s+(\S+)/i);
  if (missingRemoteRefMatch) {
    const remoteRef = missingRemoteRefMatch[1] || `refs/heads/${target.branch}`;
    return {
      error,
      kind: "missing-remote-ref",
      message: `couldn't find remote ref ${remoteRef}`,
      ok: false,
    };
  }

  return {
    error,
    kind: "generic",
    message: error,
    ok: false,
  };
}

export async function resolveRemoteTrackingTarget(
  repoPath: string,
): Promise<RemoteTrackingTargetResolution> {
  let upstream: string | null = null;
  let remote: string | null = null;
  let branch: string | null = null;

  try {
    const upstreamResult = await exec(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      repoPath,
    );
    upstream = upstreamResult.stdout.trim() || null;
    const parsed = parseRemoteTrackingRef(upstream);
    if (parsed) {
      ({ remote } = parsed);
      ({ branch } = parsed);
    }
  } catch {
    // No upstream configured; fall back to branch/remote resolution below.
  }

  if (!remote || !branch) {
    const fallback = await resolveRemoteAndBranch(repoPath);
    if (!fallback.ok) {
      return { error: fallback.error, ok: false, upstream };
    }
    ({ remote } = fallback);
    ({ branch } = fallback);
  }

  if (!remote || !branch) {
    return { error: "Unable to determine remote tracking branch", ok: false, upstream };
  }

  return {
    ok: true,
    target: {
      branch,
      remote,
      upstream,
    },
  };
}

export async function fetchRemoteTrackingTarget(
  repoPath: string,
  target: RemoteTrackingTarget,
): Promise<RemoteTrackingFetchResult> {
  try {
    await exec(
      [
        "fetch",
        "--prune",
        target.remote,
        `+refs/heads/${target.branch}:refs/remotes/${target.remote}/${target.branch}`,
      ],
      repoPath,
    );
    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Remote fetch failed";
    return classifyRemoteTrackingFetchFailure(errorMessage, target);
  }
}

export async function checkRemoteChanges(
  repositoryId: string,
  repoPath: string,
): Promise<RemoteChangeStatus> {
  const resolution = await resolveRemoteTrackingTarget(repoPath);
  if (!resolution.ok) {
    return {
      ahead: 0,
      behind: 0,
      branch: null,
      error: resolution.error,
      hasRemoteChanges: false,
      remote: null,
      repositoryId,
      upstream: resolution.upstream,
    };
  }

  const { target } = resolution;
  const fetchResult = await fetchRemoteTrackingTarget(repoPath, target);
  if (!fetchResult.ok) {
    return {
      ahead: 0,
      behind: 0,
      branch: target.branch,
      error: fetchResult.error,
      hasRemoteChanges: false,
      remote: target.remote,
      repositoryId,
      upstream: target.upstream,
    };
  }

  const { branch, remote, upstream } = target;

  try {
    const compareRef = `refs/remotes/${remote}/${branch}`;
    const result = await exec(
      ["rev-list", "--left-right", "--count", `HEAD...${compareRef}`],
      repoPath,
    );
    const parts = result.stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(parts[0] || "0", 10);
    const behind = Number.parseInt(parts[1] || "0", 10);

    return {
      ahead,
      behind,
      branch,
      hasRemoteChanges: behind > 0,
      remote,
      repositoryId,
      upstream,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Remote change detection failed";
    return {
      ahead: 0,
      behind: 0,
      branch,
      error: message,
      hasRemoteChanges: false,
      remote,
      repositoryId,
      upstream,
    };
  }
}

function parseRemoteTrackingRef(ref: string | null): { remote: string; branch: string } | null {
  if (!ref) {
    return null;
  }

  if (ref.startsWith("refs/heads/")) {
    return null;
  }

  const normalized = ref.startsWith("refs/remotes/") ? ref.replace(/^refs\/remotes\//, "") : ref;
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  const remote = normalized.slice(0, slashIndex).trim();
  const branch = normalized.slice(slashIndex + 1).trim();
  if (!remote || !branch) {
    return null;
  }

  return { branch, remote };
}

async function resolveRemoteAndBranch(
  repoPath: string,
): Promise<{ ok: true; remote: string; branch: string } | { ok: false; error: string }> {
  const currentBranch = await getCurrentBranch(repoPath);
  if (!currentBranch) {
    return { error: "Detached HEAD: cannot determine branch for remote comparison", ok: false };
  }

  const configuredRemote = await getBranchRemote(repoPath, currentBranch);
  let remote = configuredRemote && configuredRemote !== "." ? configuredRemote : null;
  if (!remote) {
    remote = await pickDefaultRemote(repoPath);
  }

  if (!remote) {
    return { error: "No remotes configured for repository", ok: false };
  }

  const mergeRef = await getBranchMergeRef(repoPath, currentBranch);
  const mergeBranch =
    mergeRef && mergeRef.startsWith("refs/heads/") ? mergeRef.replace("refs/heads/", "") : null;
  const branch = mergeBranch || currentBranch;

  return { branch, ok: true, remote };
}

async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const result = await exec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
    const branch = result.stdout.trim();
    if (!branch || branch === "HEAD") {
      return null;
    }
    return branch;
  } catch {
    return null;
  }
}

async function getBranchRemote(repoPath: string, branch: string): Promise<string | null> {
  try {
    const result = await exec(["config", "--get", `branch.${branch}.remote`], repoPath);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getBranchMergeRef(repoPath: string, branch: string): Promise<string | null> {
  try {
    const result = await exec(["config", "--get", `branch.${branch}.merge`], repoPath);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function pickDefaultRemote(repoPath: string): Promise<string | null> {
  try {
    const result = await exec(["remote"], repoPath);
    const remotes = result.stdout
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean);

    if (remotes.includes("origin")) {
      return "origin";
    }

    if (remotes.length === 1) {
      return remotes[0];
    }
  } catch {
    return null;
  }

  return null;
}
