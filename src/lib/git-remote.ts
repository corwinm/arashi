import { exec, getDefaultBranch } from "./git.ts";

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

export interface DefaultBranchTarget {
  branch: string;
  compareRef: string;
  refreshTarget: RemoteTrackingTarget | null;
}

export type DefaultBranchTargetResolution =
  | { ok: true; target: DefaultBranchTarget }
  | { ok: false; error: string; branch: string | null };

export type DefaultBranchComparison =
  | {
      state: "available";
      branch: string;
      ahead: number;
      behind: number;
    }
  | {
      state: "skipped";
      reason: "detached-head" | "on-default-branch" | "unresolved";
      branch: string | null;
    }
  | {
      state: "unavailable";
      branch: string;
      message: string;
    };

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

export async function resolveDefaultBranchTarget(
  repoPath: string,
): Promise<DefaultBranchTargetResolution> {
  let branch: string | null = null;

  try {
    branch = await getDefaultBranch(repoPath);
  } catch (error) {
    return {
      branch: null,
      error: error instanceof Error ? error.message : "Unable to detect default branch",
      ok: false,
    };
  }

  const remote = await resolveRemoteForBranch(repoPath, branch);
  if (remote) {
    return {
      ok: true,
      target: {
        branch,
        compareRef: `refs/remotes/${remote}/${branch}`,
        refreshTarget: {
          branch,
          remote,
          upstream: `${remote}/${branch}`,
        },
      },
    };
  }

  if (await refExists(repoPath, `refs/heads/${branch}`)) {
    return {
      ok: true,
      target: {
        branch,
        compareRef: `refs/heads/${branch}`,
        refreshTarget: null,
      },
    };
  }

  return {
    branch,
    error: `Unable to resolve default branch target for ${branch}`,
    ok: false,
  };
}

export async function compareCurrentBranchToDefaultBranch(
  repoPath: string,
  currentBranch: string,
  isDetached = false,
): Promise<DefaultBranchComparison> {
  if (isDetached) {
    return {
      branch: null,
      reason: "detached-head",
      state: "skipped",
    };
  }

  const resolution = await resolveDefaultBranchTarget(repoPath);
  if (!resolution.ok) {
    return {
      branch: resolution.branch,
      reason: "unresolved",
      state: "skipped",
    };
  }

  const { target } = resolution;
  if (currentBranch === target.branch) {
    return {
      branch: target.branch,
      reason: "on-default-branch",
      state: "skipped",
    };
  }

  if (target.refreshTarget) {
    const fetchResult = await fetchRemoteTrackingTarget(repoPath, target.refreshTarget);
    if (!fetchResult.ok) {
      return {
        branch: target.branch,
        message: fetchResult.message,
        state: "unavailable",
      };
    }
  }

  try {
    const result = await exec(
      ["rev-list", "--left-right", "--count", `HEAD...${target.compareRef}`],
      repoPath,
    );
    const { ahead, behind } = parseAheadBehind(result.stdout);
    return {
      ahead,
      behind,
      branch: target.branch,
      state: "available",
    };
  } catch (error) {
    return {
      branch: target.branch,
      message: error instanceof Error ? error.message : "Unable to compare with default branch",
      state: "unavailable",
    };
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
    const { ahead, behind } = parseAheadBehind(result.stdout);

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

function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const parts = output.trim().split(/\s+/);
  const ahead = Number.parseInt(parts[0] || "0", 10);
  const behind = Number.parseInt(parts[1] || "0", 10);

  return { ahead, behind };
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

async function resolveRemoteForBranch(repoPath: string, branch: string): Promise<string | null> {
  if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
    return "origin";
  }

  const remoteRefs = await listRemoteTrackingRefs(repoPath);
  const matchingRemotes = remoteRefs
    .filter((ref) => ref.branch === branch)
    .map((ref) => ref.remote);
  if (matchingRemotes.length === 0) {
    return null;
  }

  const defaultRemote = await pickDefaultRemote(repoPath);
  if (defaultRemote && matchingRemotes.includes(defaultRemote)) {
    return defaultRemote;
  }

  return matchingRemotes[0] || null;
}

async function listRemoteTrackingRefs(
  repoPath: string,
): Promise<{ remote: string; branch: string }[]> {
  try {
    const result = await exec(
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
      repoPath,
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseRemoteTrackingRef(line))
      .filter((value): value is { remote: string; branch: string } => value !== null)
      .filter((value) => value.branch !== "HEAD");
  } catch {
    return [];
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await exec(["show-ref", "--verify", ref], repoPath);
    return true;
  } catch {
    return false;
  }
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
