import { exec, getDefaultBranch } from "./git.ts";
import { normalizeLogicalBranchName } from "./git-branch-name.ts";

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
  errorKind?: "comparison-failed" | "detached-head" | "refresh-failed" | "unresolved-target";
  compareRef?: string | null;
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
      compareRef?: string;
      remote?: string | null;
      remoteRef?: string | null;
    }
  | {
      state: "skipped";
      reason: "detached-head" | "duplicate-target" | "on-default-branch" | "unresolved";
      branch: string | null;
      compareRef?: string | null;
      remote?: string | null;
      remoteRef?: string | null;
    }
  | {
      state: "unavailable";
      branch: string;
      message: string;
      reason: "comparison-failed" | "refresh-failed" | "unresolved-target";
      details: {
        error: string;
        kind?: "generic" | "missing-remote-ref";
      };
      compareRef?: string | null;
      remote?: string | null;
      remoteRef?: string | null;
    };

export type RemoteTrackingFetchResult =
  | { ok: true }
  | {
      ok: false;
      kind: "generic" | "missing-remote-ref";
      error: string;
      message: string;
    };

export type UpstreamTrackingInspection =
  | { kind: "not-applicable" }
  | {
      kind: "ambiguous-merge-configuration";
      localBranch: string;
      mergeRefs: string[];
      remote: string;
    }
  | {
      conflictingFetchRefspecs?: string[];
      expectedRemoteTrackingRef: string;
      hasMultipleMergeRefs?: boolean;
      kind: "missing-fetch-mapping";
      localBranch: string;
      mergeRef: string;
      remote: string;
      remoteBranch: string;
    };

type ReadOnlyGitRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>;

const readOptionalGitValue = async (
  runGit: ReadOnlyGitRunner,
  repoPath: string,
  args: string[],
): Promise<string | null> => {
  try {
    const result = await runGit(args, repoPath);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
};

const wildcardPatternMatches = (pattern: string, value: string): boolean => {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) {
    return pattern === value;
  }
  if (pattern.indexOf("*", wildcard + 1) !== -1) {
    return false;
  }

  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return (
    value.length >= prefix.length + suffix.length &&
    value.startsWith(prefix) &&
    value.endsWith(suffix)
  );
};

const fetchRefspecRequiresManualReview = async (
  refspec: string,
  mergeRef: string,
  repoPath: string,
  runGit: ReadOnlyGitRunner,
): Promise<boolean> => {
  if (refspec !== refspec.trim() || !refspec || refspec.startsWith("!")) {
    return true;
  }

  const forced = refspec.startsWith("+");
  const normalized = refspec.replace(/^\+/, "");
  if (normalized.startsWith("^")) {
    const sourcePattern = normalized.slice(1);
    if (
      forced ||
      !sourcePattern ||
      sourcePattern.includes(":") ||
      sourcePattern.split("*").length - 1 > 1
    ) {
      return true;
    }
    try {
      await runGit(["check-ref-format", sourcePattern.replace("*", "arashi-wildcard")], repoPath);
    } catch {
      return true;
    }
    return wildcardPatternMatches(sourcePattern, mergeRef);
  }

  const separator = normalized.indexOf(":");
  if (separator === -1 || separator === normalized.length - 1) {
    const sourcePattern = separator === -1 ? normalized : normalized.slice(0, -1);
    if (!sourcePattern || sourcePattern.includes("*")) {
      return true;
    }
    try {
      await runGit(["check-ref-format", sourcePattern.replace("*", "arashi-wildcard")], repoPath);
      return wildcardPatternMatches(sourcePattern, mergeRef);
    } catch {
      return true;
    }
  }
  if (separator <= 0 || separator !== normalized.lastIndexOf(":")) {
    return true;
  }

  const sourcePattern = normalized.slice(0, separator);
  const destinationPattern = normalized.slice(separator + 1);
  const sourceWildcards = sourcePattern.split("*").length - 1;
  const destinationWildcards = destinationPattern.split("*").length - 1;
  if (sourceWildcards > 1 || destinationWildcards > 1 || sourceWildcards !== destinationWildcards) {
    return true;
  }

  try {
    for (const candidate of [sourcePattern, destinationPattern]) {
      await runGit(["check-ref-format", candidate.replace("*", "arashi-wildcard")], repoPath);
    }
    return false;
  } catch {
    return true;
  }
};

const fetchRefspecCovers = (refspec: string, source: string, destination: string): boolean => {
  const normalized = refspec.trim().replace(/^\+/, "");
  if (!normalized || normalized.startsWith("^")) {
    return false;
  }

  const separator = normalized.indexOf(":");
  if (separator === -1) {
    return false;
  }

  const sourcePattern = normalized.slice(0, separator);
  const destinationPattern = normalized.slice(separator + 1);
  const sourceWildcard = sourcePattern.indexOf("*");
  const destinationWildcard = destinationPattern.indexOf("*");

  if (sourceWildcard === -1 || destinationWildcard === -1) {
    return sourcePattern === source && destinationPattern === destination;
  }
  if (
    sourcePattern.indexOf("*", sourceWildcard + 1) !== -1 ||
    destinationPattern.indexOf("*", destinationWildcard + 1) !== -1
  ) {
    return false;
  }

  const sourcePrefix = sourcePattern.slice(0, sourceWildcard);
  const sourceSuffix = sourcePattern.slice(sourceWildcard + 1);
  if (
    source.length < sourcePrefix.length + sourceSuffix.length ||
    !source.startsWith(sourcePrefix) ||
    !source.endsWith(sourceSuffix)
  ) {
    return false;
  }

  const wildcardValue = source.slice(sourcePrefix.length, source.length - sourceSuffix.length);
  return destinationPattern.replace("*", wildcardValue) === destination;
};

const refNamespacesConflict = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

const fetchRefspecTargetsDestination = (refspec: string, destination: string): boolean => {
  const normalized = refspec.trim().replace(/^\+/, "");
  if (!normalized || normalized.startsWith("^")) {
    return false;
  }

  const separator = normalized.indexOf(":");
  if (separator === -1) {
    return false;
  }

  const destinationPattern = normalized.slice(separator + 1);
  const wildcard = destinationPattern.indexOf("*");
  if (wildcard === -1) {
    return refNamespacesConflict(destinationPattern, destination);
  }
  if (destinationPattern.indexOf("*", wildcard + 1) !== -1) {
    return false;
  }

  if (wildcardPatternMatches(destinationPattern, destination)) {
    return true;
  }

  const destinationPrefix = destinationPattern.slice(0, wildcard);
  const descendantPrefix = `${destination}/`;
  if (
    destinationPrefix.startsWith(descendantPrefix) ||
    descendantPrefix.startsWith(destinationPrefix)
  ) {
    return true;
  }

  for (let separator = destination.lastIndexOf("/"); separator > 0; ) {
    const ancestor = destination.slice(0, separator);
    if (wildcardPatternMatches(destinationPattern, ancestor)) {
      return true;
    }
    separator = destination.lastIndexOf("/", separator - 1);
  }
  return false;
};

const fetchRefspecDestinationPattern = (refspec: string): string | null => {
  const normalized = refspec.trim().replace(/^\+/, "");
  if (!normalized || normalized.startsWith("^")) return null;
  const separator = normalized.indexOf(":");
  if (separator <= 0 || separator === normalized.length - 1) return null;
  return normalized.slice(separator + 1);
};

const destinationPatternsCouldConflict = (left: string, right: string): boolean => {
  const leftWildcard = left.indexOf("*");
  const rightWildcard = right.indexOf("*");
  if (leftWildcard === -1 && rightWildcard === -1) {
    return refNamespacesConflict(left, right);
  }
  if (leftWildcard === -1) {
    return fetchRefspecTargetsDestination(`refs/heads/arashi-wildcard:${right}`, left);
  }
  if (rightWildcard === -1) {
    return fetchRefspecTargetsDestination(`refs/heads/arashi-wildcard:${left}`, right);
  }
  const leftPrefix = left.slice(0, leftWildcard);
  const rightPrefix = right.slice(0, rightWildcard);
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
};

const fetchRefspecMapsSource = (refspec: string, source: string): boolean => {
  const normalized = refspec.trim().replace(/^\+/, "");
  if (!normalized || normalized.startsWith("^")) {
    return false;
  }

  const separator = normalized.indexOf(":");
  if (separator === -1) {
    return false;
  }

  const sourcePattern = normalized.slice(0, separator);
  const wildcard = sourcePattern.indexOf("*");
  if (wildcard === -1) {
    return sourcePattern === source;
  }
  if (sourcePattern.indexOf("*", wildcard + 1) !== -1) {
    return false;
  }

  return wildcardPatternMatches(sourcePattern, source);
};
export const inspectUpstreamTrackingConfiguration = async (
  repoPath: string,
  runGit: ReadOnlyGitRunner = exec,
): Promise<UpstreamTrackingInspection> => {
  const localBranch = await readOptionalGitValue(runGit, repoPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (!localBranch) {
    return { kind: "not-applicable" };
  }

  const strictUpstream = await readOptionalGitValue(runGit, repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  if (strictUpstream) {
    return { kind: "not-applicable" };
  }

  const remote = await readOptionalGitValue(runGit, repoPath, [
    "config",
    "--get",
    `branch.${localBranch}.remote`,
  ]);
  let mergeRefs: string[] = [];
  try {
    const mergeRefOutput = (
      await runGit(["config", "--get-all", `branch.${localBranch}.merge`], repoPath)
    ).stdout.replace(/(?:\r?\n)$/, "");
    mergeRefs = mergeRefOutput.split(/\r?\n/);
  } catch {
    mergeRefs = [];
  }
  const mergeRef = mergeRefs[0] ?? null;
  if (!remote || remote === ".") {
    return { kind: "not-applicable" };
  }
  if (mergeRefs.length > 1 && !mergeRef?.startsWith("refs/heads/")) {
    return { kind: "ambiguous-merge-configuration", localBranch, mergeRefs, remote };
  }
  if (!mergeRef?.startsWith("refs/heads/")) {
    return { kind: "not-applicable" };
  }

  const remoteBranch = mergeRef.slice("refs/heads/".length);
  if (!remoteBranch) {
    return { kind: "not-applicable" };
  }
  const expectedRemoteTrackingRef = `refs/remotes/${remote}/${remoteBranch}`;
  const trackingRef = await readOptionalGitValue(runGit, repoPath, [
    "show-ref",
    "--verify",
    expectedRemoteTrackingRef,
  ]);
  if (!trackingRef) {
    return { kind: "not-applicable" };
  }

  let fetchRefspecs: string[] = [];
  try {
    const fetchRefspecOutput = (
      await runGit(["config", "--get-all", `remote.${remote}.fetch`], repoPath)
    ).stdout.replace(/(?:\r?\n)$/, "");
    fetchRefspecs = fetchRefspecOutput.split(/\r?\n/);
  } catch {
    // An absent fetch mapping is diagnosed below as an unambiguous missing mapping.
  }
  const manualReviewRefspecs: string[] = [];
  for (const refspec of fetchRefspecs) {
    if (await fetchRefspecRequiresManualReview(refspec, mergeRef, repoPath, runGit)) {
      manualReviewRefspecs.push(refspec);
    }
  }
  for (let leftIndex = 0; leftIndex < fetchRefspecs.length; leftIndex += 1) {
    const left = fetchRefspecs[leftIndex];
    const leftDestination = left ? fetchRefspecDestinationPattern(left) : null;
    if (!left || !leftDestination) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < fetchRefspecs.length; rightIndex += 1) {
      const right = fetchRefspecs[rightIndex];
      const rightDestination = right ? fetchRefspecDestinationPattern(right) : null;
      if (
        right &&
        rightDestination &&
        destinationPatternsCouldConflict(leftDestination, rightDestination)
      ) {
        manualReviewRefspecs.push(left, right);
      }
    }
  }
  const manualReviewRefspecSet = new Set(manualReviewRefspecs);
  if (
    manualReviewRefspecs.length === 0 &&
    fetchRefspecs.some((refspec) =>
      fetchRefspecCovers(refspec, mergeRef, expectedRemoteTrackingRef),
    )
  ) {
    return { kind: "not-applicable" };
  }
  const conflictingFetchRefspecs = fetchRefspecs.filter(
    (refspec) =>
      manualReviewRefspecSet.has(refspec) ||
      (!fetchRefspecCovers(refspec, mergeRef, expectedRemoteTrackingRef) &&
        (fetchRefspecTargetsDestination(refspec, expectedRemoteTrackingRef) ||
          fetchRefspecMapsSource(refspec, mergeRef))),
  );

  return {
    conflictingFetchRefspecs,
    expectedRemoteTrackingRef,
    ...(mergeRefs.length > 1 ? { hasMultipleMergeRefs: true } : {}),
    kind: "missing-fetch-mapping",
    localBranch,
    mergeRef,
    remote,
    remoteBranch,
  };
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

export async function resolveConfiguredRemoteTrackingTarget(
  repoPath: string,
  branch: string,
): Promise<RemoteTrackingTargetResolution> {
  const requestedBranch = normalizeLogicalBranchName(branch);
  const remote =
    (await resolveRemoteForBranch(repoPath, requestedBranch)) ??
    (await pickDefaultRemote(repoPath));
  if (!remote) {
    return {
      error: `No remote is available for configured base branch '${requestedBranch}'`,
      ok: false,
      upstream: null,
    };
  }

  return {
    ok: true,
    target: {
      branch: requestedBranch,
      remote,
      upstream: `${remote}/${requestedBranch}`,
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

export async function resolveConfiguredBranchTarget(
  repoPath: string,
  branch: string,
): Promise<DefaultBranchTargetResolution> {
  const remoteResolution = await resolveConfiguredRemoteTrackingTarget(repoPath, branch);
  if (remoteResolution.ok) {
    const { target } = remoteResolution;
    return {
      ok: true,
      target: {
        branch: target.branch,
        compareRef: `refs/remotes/${target.remote}/${target.branch}`,
        refreshTarget: target,
      },
    };
  }

  return {
    branch: normalizeLogicalBranchName(branch),
    error: remoteResolution.error,
    ok: false,
  };
}

export async function compareCurrentBranchToConfiguredBranch(
  repoPath: string,
  _currentBranch: string,
  branch: string,
  isDetached = false,
  skipCompareRefs: readonly string[] = [],
): Promise<DefaultBranchComparison> {
  const requestedBranch = normalizeLogicalBranchName(branch);
  const resolution = await resolveConfiguredBranchTarget(repoPath, requestedBranch);
  if (!resolution.ok) {
    return {
      branch: requestedBranch,
      compareRef: null,
      details: { error: resolution.error },
      message: resolution.error,
      reason: "unresolved-target",
      remote: null,
      remoteRef: null,
      state: "unavailable",
    };
  }

  const { target } = resolution;
  const metadata = {
    compareRef: target.compareRef,
    remote: target.refreshTarget?.remote ?? null,
    remoteRef: target.refreshTarget?.upstream ?? null,
  };
  if (isDetached) {
    return {
      branch: requestedBranch,
      ...metadata,
      reason: "detached-head",
      state: "skipped",
    };
  }

  if (skipCompareRefs.includes(target.compareRef)) {
    return {
      branch: requestedBranch,
      ...metadata,
      reason: "duplicate-target",
      state: "skipped",
    };
  }

  if (target.refreshTarget) {
    const fetchResult = await fetchRemoteTrackingTarget(repoPath, target.refreshTarget);
    if (!fetchResult.ok) {
      return {
        branch: target.branch,
        ...metadata,
        details: { error: fetchResult.error, kind: fetchResult.kind },
        message: fetchResult.message,
        reason: "refresh-failed",
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
    return { ahead, behind, branch: target.branch, ...metadata, state: "available" };
  } catch (error) {
    return {
      branch: target.branch,
      ...metadata,
      details: {
        error: error instanceof Error ? error.message : `Unable to compare with ${target.branch}`,
      },
      message: error instanceof Error ? error.message : `Unable to compare with ${target.branch}`,
      reason: "comparison-failed",
      state: "unavailable",
    };
  }
}

export async function compareCurrentBranchToDefaultBranch(
  repoPath: string,
  currentBranch: string,
  isDetached = false,
  skipCompareRefs: readonly string[] = [],
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
  const metadata = {
    compareRef: target.compareRef,
    remote: target.refreshTarget?.remote ?? null,
    remoteRef: target.refreshTarget?.upstream ?? null,
  };
  if (!target.refreshTarget && currentBranch === target.branch) {
    return {
      branch: target.branch,
      ...metadata,
      reason: "on-default-branch",
      state: "skipped",
    };
  }
  if (skipCompareRefs.includes(target.compareRef)) {
    return {
      branch: target.branch,
      ...metadata,
      reason: "duplicate-target",
      state: "skipped",
    };
  }

  if (target.refreshTarget) {
    const fetchResult = await fetchRemoteTrackingTarget(repoPath, target.refreshTarget);
    if (!fetchResult.ok) {
      return {
        branch: target.branch,
        ...metadata,
        details: { error: fetchResult.error, kind: fetchResult.kind },
        message: fetchResult.message,
        reason: "refresh-failed",
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
      ...metadata,
      state: "available",
    };
  } catch (error) {
    return {
      branch: target.branch,
      ...metadata,
      details: {
        error: error instanceof Error ? error.message : "Unable to compare with default branch",
      },
      message: error instanceof Error ? error.message : "Unable to compare with default branch",
      reason: "comparison-failed",
      state: "unavailable",
    };
  }
}

export async function checkRemoteChanges(
  repositoryId: string,
  repoPath: string,
  configuredBranch?: string,
): Promise<RemoteChangeStatus> {
  if (configuredBranch && !(await getCurrentBranch(repoPath))) {
    return {
      ahead: 0,
      behind: 0,
      branch: normalizeLogicalBranchName(configuredBranch),
      compareRef: null,
      error: "Cannot pull a configured base while HEAD is detached",
      errorKind: "detached-head",
      hasRemoteChanges: false,
      remote: null,
      repositoryId,
      upstream: null,
    };
  }
  const resolution = configuredBranch
    ? await resolveConfiguredRemoteTrackingTarget(repoPath, configuredBranch)
    : await resolveRemoteTrackingTarget(repoPath);
  if (!resolution.ok) {
    return {
      ahead: 0,
      behind: 0,
      branch: null,
      compareRef: null,
      error: resolution.error,
      errorKind: "unresolved-target",
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
      compareRef: `refs/remotes/${target.remote}/${target.branch}`,
      error: fetchResult.error,
      errorKind: "refresh-failed",
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
      compareRef,
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
      compareRef: `refs/remotes/${remote}/${branch}`,
      error: message,
      errorKind: "comparison-failed",
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
