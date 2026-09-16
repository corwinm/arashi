import {
  GitProbeContext,
  type GitIdentity,
  type EffectiveConfig,
  type RefFact,
} from "./git-probe-context.ts";
import type {
  DefaultBranchComparison,
  RemoteTrackingTarget,
  RemoteTrackingFetchResult,
} from "./git-remote.ts";
import { parseGitStatus, type RepoStatus } from "../commands/status.ts";
import { normalizeLogicalBranchName } from "./git-branch-name.ts";

type Target = {
  branch: string;
  compareRef: string;
  remote: string | null;
  remoteRef: string | null;
};
const target = (remote: string | null, branch: string): Target => ({
  branch,
  remote,
  remoteRef: remote ? `${remote}/${branch}` : null,
  compareRef: remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`,
});
const value = (config: EffectiveConfig, key: string) =>
  config.entries
    .filter((e) => e.key === key)
    .at(-1)
    ?.value?.toString() ?? null;
const remoteNames = (config: EffectiveConfig) =>
  [
    ...new Set(
      config.entries.flatMap((e) => {
        const m = /^remote\.(.+)\.url$/.exec(e.key);
        return m ? [m[1]!] : [];
      }),
    ),
  ].toSorted();
const preferred = (names: string[]) =>
  names.includes("origin") ? "origin" : names.length === 1 ? names[0]! : null;
const forBranch = (branch: string, refs: Map<string, RefFact>, names: string[]) => {
  const candidates = new Set([
    ...names,
    ...[...refs.keys()]
      .filter((ref) => ref.startsWith("refs/remotes/"))
      .map((ref) => ref.slice("refs/remotes/".length).split("/")[0]!),
  ]);
  const matches = [...candidates].filter((remote) => refs.has(`refs/remotes/${remote}/${branch}`));
  if (matches.includes("origin")) return "origin";
  const pick = preferred(names);
  return pick && matches.includes(pick) ? pick : matches.length === 1 ? matches[0]! : null;
};
async function defaultTarget(
  context: GitProbeContext,
  id: GitIdentity,
  refs: Map<string, RefFact>,
  names: string[],
  selected: string | null,
  probeRemoteHead = true,
): Promise<Target | null> {
  const symbolic = (remote: string) => {
    const ref = refs.get(`refs/remotes/${remote}/HEAD`)?.symref;
    const prefix = `refs/remotes/${remote}/`;
    return ref?.startsWith(prefix) ? ref.slice(prefix.length) : null;
  };
  for (const remote of new Set([selected, "origin"].filter((v): v is string => !!v))) {
    const branch =
      symbolic(remote) ?? (probeRemoteHead ? await context.remoteHead(id, remote) : null);
    if (branch) {
      if (
        selected === remote ||
        refs.has(`refs/remotes/${remote}/HEAD`) ||
        refs.has(`refs/remotes/${remote}/${branch}`)
      )
        return target(remote, branch);
      const resolved = forBranch(branch, refs, names);
      if (resolved || refs.has(`refs/heads/${branch}`)) return target(resolved, branch);
      return { ...target(null, branch), compareRef: "" };
    }
  }
  const snapshotRemotes = [...refs.keys()]
    .filter((ref) => ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD"))
    .map((ref) => ref.slice("refs/remotes/".length, -"/HEAD".length));
  const remaining = snapshotRemotes
    .filter((n) => n !== selected && n !== "origin")
    .flatMap((remote) => {
      const branch = symbolic(remote);
      return branch ? [target(remote, branch)] : [];
    });
  if (remaining.length === 1) return remaining[0]!;
  // Preserve the existing local compatibility ordering without extra Git probes.
  let branch = ["main", "master", "develop"].find((b) => refs.has(`refs/remotes/origin/${b}`));
  branch ??= ["main", "master", "develop"].find((b) => refs.has(`refs/heads/${b}`));
  branch ??= [...refs.keys()]
    .filter((r) => r.startsWith("refs/heads/"))
    .toSorted()[0]
    ?.slice("refs/heads/".length);
  branch ??= [...refs.keys()]
    .filter((r) => r.startsWith("refs/remotes/") && !r.endsWith("/HEAD"))
    .toSorted()[0]
    ?.slice("refs/remotes/".length)
    .replace(/^origin\//, "");
  if (!branch) return null;
  const remote = forBranch(branch, refs, names);
  return remote || refs.has(`refs/heads/${branch}`) ? target(remote, branch) : null;
}
export async function inspectStatusWithContext(
  name: string,
  path: string,
  context: GitProbeContext,
  options: {
    local?: boolean;
    verbose?: boolean;
    baseBranch?: string;
    baseBranchSource?: "repository-config" | "workspace-config";
  },
): Promise<RepoStatus> {
  const local = options.local === true;
  const id = await context.identity(path);
  const config = await context.configuration(id);
  const output = await context.porcelain(id);
  const parsed = parseGitStatus(output);
  const rawHead = output
    .split("\0")
    .find((line) => line.startsWith("# branch.oid "))
    ?.slice("# branch.oid ".length);
  const head = rawHead && rawHead !== "(initial)" ? rawHead : null;
  const refs = await context.refs(id, head);
  const names = remoteNames(config);
  let tracking: RemoteTrackingTarget | null = null;
  let trackingCompareRef: string | null = null;
  if (!parsed.branch.isDetached) {
    const upstream = parsed.branch.remoteBranch;
    const slash = upstream?.indexOf("/") ?? -1;
    if (upstream && slash > 0 && refs.has(`refs/remotes/${upstream}`)) {
      tracking = { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1), upstream };
      trackingCompareRef = `refs/remotes/${upstream}`;
    } else if (upstream && refs.has(`refs/heads/${upstream}`)) {
      trackingCompareRef = `refs/heads/${upstream}`;
    } else {
      const configured = value(config, `branch.${parsed.branch.localBranch}.remote`);
      const merge = value(config, `branch.${parsed.branch.localBranch}.merge`);
      const mergeBranch = merge?.startsWith("refs/heads/")
        ? merge.slice("refs/heads/".length)
        : parsed.branch.localBranch;
      if (configured === ".") {
        trackingCompareRef = merge?.startsWith("refs/heads/") ? merge : null;
      } else {
        const remote = configured ?? preferred(names);
        if (remote) {
          tracking = {
            remote,
            branch: mergeBranch,
            upstream: null,
          };
          trackingCompareRef = `refs/remotes/${remote}/${mergeBranch}`;
        }
      }
    }
  }
  const baseName = options.baseBranch ? normalizeLogicalBranchName(options.baseBranch) : null;
  const baseRemote = baseName ? (forBranch(baseName, refs, names) ?? preferred(names)) : null;
  const base = baseName && baseRemote ? target(baseRemote, baseName) : null;
  const fetches = new Map<string, RemoteTrackingFetchResult>();
  const refresh = async (t: Target) => {
    if (!local && t.remote && !fetches.has(t.compareRef))
      fetches.set(
        t.compareRef,
        await context.fetch(id, { remote: t.remote, branch: t.branch, upstream: t.remoteRef }),
      );
  };
  let defaultRef = parsed.branch.isDetached
    ? null
    : await defaultTarget(context, id, refs, names, tracking?.remote ?? null);
  if (tracking) await refresh(target(tracking.remote, tracking.branch));
  if (!parsed.branch.isDetached) {
    if (base) await refresh(base);
    if (defaultRef) await refresh(defaultRef);
  }
  const post = fetches.size ? await context.refs(id, head) : refs;
  if (fetches.size && !parsed.branch.isDetached) {
    const postFetchDefault = await defaultTarget(
      context,
      id,
      post,
      names,
      tracking?.remote ?? null,
      false,
    );
    if (
      postFetchDefault &&
      (!postFetchDefault.remote || fetches.has(postFetchDefault.compareRef))
    ) {
      defaultRef = postFetchDefault;
    }
  }
  if (parsed.branch.remoteBranch) {
    // Refreshed divergence is never copied from pre-fetch porcelain branch.ab.
    if (!local) {
      parsed.branch.ahead = 0;
      parsed.branch.behind = 0;
    }
    if (head && trackingCompareRef && post.has(trackingCompareRef)) {
      const counts = await context.compare(id, head, trackingCompareRef);
      Object.assign(parsed.branch, counts);
    }
  }
  const comparison = async (t: Target): Promise<DefaultBranchComparison> => {
    const failure = fetches.get(t.compareRef);
    if (failure && !failure.ok)
      return {
        ...t,
        state: "unavailable",
        reason: "refresh-failed",
        details: { error: failure.error, kind: failure.kind },
        message: failure.message,
      };
    if (!head || !post.has(t.compareRef))
      return {
        ...t,
        state: "unavailable",
        reason: "comparison-failed",
        details: { error: `Unable to compare with ${t.branch}` },
        message: `Unable to compare with ${t.branch}`,
      };
    try {
      return { ...t, ...(await context.compare(id, head, t.compareRef)), state: "available" };
    } catch {
      return {
        ...t,
        state: "unavailable",
        reason: "comparison-failed",
        details: { error: `Unable to compare with ${t.branch}` },
        message: `Unable to compare with ${t.branch}`,
      };
    }
  };
  let baseBranch: DefaultBranchComparison | null = null;
  if (baseName) {
    if (parsed.branch.isDetached) {
      baseBranch = {
        branch: baseName,
        compareRef: base?.compareRef ?? null,
        remote: base?.remote ?? null,
        remoteRef: base?.remoteRef ?? null,
        state: "skipped",
        reason: "detached-head",
      };
    } else if (!base) {
      const error = `No remote is available for configured base branch '${baseName}'`;
      baseBranch = {
        state: "unavailable",
        branch: baseName,
        compareRef: null,
        remote: null,
        remoteRef: null,
        reason: "unresolved-target",
        details: { error },
        message: error,
      };
    } else baseBranch = await comparison(base);
  }
  let defaultBranch: DefaultBranchComparison;
  if (parsed.branch.isDetached)
    defaultBranch = { state: "skipped", branch: null, reason: "detached-head" };
  else if (!defaultRef?.compareRef)
    defaultBranch = { state: "skipped", branch: defaultRef?.branch ?? null, reason: "unresolved" };
  else if (!defaultRef.remote && defaultRef.branch === parsed.branch.localBranch)
    defaultBranch = { ...defaultRef, state: "skipped", reason: "on-default-branch" };
  else if (baseBranch && base?.compareRef === defaultRef.compareRef)
    defaultBranch = { ...baseBranch };
  else defaultBranch = await comparison(defaultRef);
  const trackingResult = tracking
    ? fetches.get(target(tracking.remote, tracking.branch).compareRef)
    : undefined;
  const refreshWarning =
    trackingResult && !trackingResult.ok
      ? {
          kind:
            trackingResult.kind === "missing-remote-ref"
              ? ("missing-remote-ref" as const)
              : ("stale-remote-tracking" as const),
          message:
            trackingResult.kind === "missing-remote-ref"
              ? trackingResult.message
              : `Remote tracking may be stale: ${trackingResult.error}`,
        }
      : null;
  let fullStatus: string | undefined;
  if (options.verbose) {
    try {
      fullStatus = (await context.nativeStatus(id)).trim();
    } catch {
      fullStatus = "Git native status probe failed";
    }
  }
  return {
    name,
    path,
    branch: parsed.branch,
    files: parsed.files,
    baseBranch,
    baseBranchSource: options.baseBranchSource,
    defaultBranch,
    error: null,
    refreshWarning,
    fullStatus,
    freshness: {
      mode: local ? "local" : "refreshed",
      remoteRefsRefreshed:
        !local &&
        fetches.size > 0 &&
        [...fetches.values()].every((r) => r.ok) &&
        ![baseBranch, defaultBranch].some((c) => c?.state === "unavailable"),
    },
  };
}
