import { Command } from "commander";
import { execFile } from "child_process";
import { promisify } from "util";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { normalizeConfig } from "../lib/config.ts";
import { normalizeLifecyclePath } from "../lib/hooks.ts";
import type { Config } from "../lib/config.ts";
import {
  canonicalPhysicalPath,
  discoverAllWorktrees,
  isDescendantWorktreePath,
} from "../core/remove.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { confirm, input, select } from "../lib/prompts.ts";
import { executeRemove } from "./remove.ts";
import type { FinishRemoveGate } from "./remove.ts";
import type { RemovalSummary } from "../types/remove.ts";
import { isValidGitBranchNameLiteral, normalizeLogicalBranchName } from "../lib/git-branch-name.ts";

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (
    await run("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "core.untrackedCache",
        GIT_CONFIG_VALUE_1: "false",
      },
    })
  ).stdout.replace(/\s+$/, "");
const gitValue = async (cwd: string, ...args: string[]) => (await git(cwd, ...args)).trim();
// Git status may execute clean/process filters for paths it inspects. Resolve the
// effective attributes without running a filter, including global and worktree attrs.
const assertNoExecutableFilters = async (cwd: string): Promise<void> => {
  let configured: string;
  try {
    configured = await git(
      cwd,
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process)$",
    );
  } catch (error) {
    if (Number((error as NodeJS.ErrnoException).code) === 1) return;
    throw error; // config errors are unsafe too
  }
  const filters = new Set<string>();
  for (const key of configured.split("\0")) {
    const match = /^filter\.(.*)\.(?:clean|process)$/i.exec(key);
    if (match) filters.add(match[1]);
  }
  if (!filters.size) return;
  const paths = [
    ...new Set(
      (await git(cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"))
        .split("\0")
        .filter(Boolean),
    ),
  ];
  for (let offset = 0; offset < paths.length; offset += 64) {
    const attrs = (
      await git(cwd, "check-attr", "-z", "filter", "--", ...paths.slice(offset, offset + 64))
    ).split("\0");
    for (let index = 0; index + 2 < attrs.length; index += 3) {
      if (filters.has(attrs[index + 2])) throw new Error("EXECUTABLE_FILTER_UNSAFE");
    }
  }
};
const oid = (value: string): boolean => /^[a-f0-9]{40,64}$/.test(value);
const safeLabel = (value: string): string | null =>
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) && !value.includes("..") ? value : null;
const within = (ancestor: string, candidate: string): boolean =>
  ancestor === candidate || isDescendantWorktreePath(ancestor, candidate);
export const finishHookPath = (
  value: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const normalized = normalizeLifecyclePath(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};
const reason = (code: string) => code;
export const validManualBaseRef = (ref: string): boolean =>
  ref.startsWith("refs/heads/") && isValidGitBranchNameLiteral(ref.slice("refs/heads/".length));
export interface FinishRepository {
  repository: string;
  path: string | null;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  dirtyDetails: { staged: boolean; unstaged: boolean; untracked: boolean } | null;
  upstream: { oid: string | null; ahead: number | null; behind: number | null } | null;
  base: {
    source: "repository-config" | "workspace-config" | "omitted" | "manual";
    remote: string | null;
    ref: string | null;
    oid: string | null;
  };
  integration: "proven" | "unknown" | "manually-confirmed" | "not-finished";
  integrationEvidence: {
    source: "git-ancestry" | "manual" | "none";
    fresh: boolean;
    correlation: "not-attempted" | "matched" | "unavailable";
  };
  reasons: string[];
}
export interface FinishReport {
  target: string;
  dryRun: boolean;
  readiness: "ready" | "blocked" | "unknown";
  repositories: FinishRepository[];
  nonparticipants: string[];
  blockers: string[];
  warnings: string[];
  confirmations: string[];
  cleanupPlan: {
    operations: {
      repository: string;
      type: "worktree_remove" | "branch_delete";
      path: string | null;
      branch: string | null;
      status: "pending";
    }[];
    hooks: unknown[];
    keepBranches: boolean;
  } | null;
  cleanupResult: unknown;
}
interface AssessmentOptions {
  dryRun?: boolean;
  keepBranches?: boolean;
  manualTargets?: Record<string, { remote: string; ref: string }>;
}
const assessedConfiguration = new WeakMap<FinishReport, string>();
const assessedRemotes = new WeakMap<FinishReport, string>();
const readFinishConfig = async (root: string): Promise<Config> =>
  normalizeConfig(JSON.parse(await readFile(join(root, ".arashi", "config.json"), "utf8")));
const registered = async (main: string, name: string) =>
  discoverAllWorktrees([{ name, path: main }], { strict: true });
// Only the disposable repository owns this configuration. Never pass expanded URLs to fetch.
const privateRemote = async (directory: string, url: string): Promise<void> => {
  const path = join(directory, "config");
  const config = await readFile(path, "utf8");
  const clean = config.replace(/\n\[remote "finish-source"\]\n\s*url = [^\n]*\n/g, "");
  await chmod(path, 0o600);
  await writeFile(path, `${clean}\n[remote "finish-source"]\n\turl = ${JSON.stringify(url)}\n`, {
    mode: 0o600,
  });
};
const gh = async (...args: string[]): Promise<string> =>
  (await run("gh", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 8000 })).stdout;
const githubIdentity = (url: string): string | null => {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url,
    );
  return match?.[1]?.toLowerCase() ?? null;
};
export async function correlateGithub(
  headUrl: string,
  branch: string,
  headOid: string,
  baseUrl: string,
  baseRef: string,
  _baseOid: string,
  reachable: (mergeOid: string) => Promise<boolean>,
  invoke: (...args: string[]) => Promise<string> = gh,
): Promise<FinishRepository["integrationEvidence"]["correlation"]> {
  const identity = githubIdentity(headUrl);
  if (!identity || identity !== githubIdentity(baseUrl) || !baseRef.startsWith("refs/heads/"))
    return "not-attempted";
  try {
    await invoke("auth", "status", "-h", "github.com");
    const candidates: unknown[] = [];
    for (let page = 1; page <= 3; page++) {
      const endpoint = `repos/${identity}/pulls?state=closed&head=${encodeURIComponent(identity.split("/")[0] + ":" + branch)}&base=${encodeURIComponent(baseRef.slice(11))}&per_page=100&page=${page}`;
      const entries: unknown = JSON.parse(await invoke("api", "-X", "GET", endpoint));
      if (!Array.isArray(entries) || entries.length > 100) return "unavailable";
      candidates.push(...entries);
      if (entries.length < 100) break;
      if (page === 3) return "unavailable";
    }
    const matching = candidates.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const pr = entry as {
        merged_at?: string;
        head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
        base?: { ref?: string; repo?: { full_name?: string } };
        merge_commit_sha?: string;
      };
      return (
        pr.merged_at &&
        pr.head?.sha === headOid &&
        pr.head.ref === branch &&
        pr.head.repo?.full_name?.toLowerCase() === identity &&
        pr.base?.repo?.full_name?.toLowerCase() === identity &&
        pr.base.ref === baseRef.slice(11) &&
        pr.merge_commit_sha &&
        oid(pr.merge_commit_sha)
      );
    }) as { merge_commit_sha: string }[];
    return matching.length === 1 && (await reachable(matching[0].merge_commit_sha))
      ? "matched"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

const remoteIdentity = async (source: string, remote: string): Promise<string> =>
  gitValue(source, "remote", "get-url", remote);
const remoteSnapshot = async (
  root: string,
  report: FinishReport,
  config: Config,
): Promise<string> =>
  JSON.stringify(
    await Promise.all(
      report.repositories.map(async (repo) => {
        const source = repo.path === "." ? root : resolve(root, config.repos[repo.repository].path);
        const remotes = new Set<string>();
        if (repo.base.remote) remotes.add(repo.base.remote);
        if (repo.branch) {
          const upstream = await gitValue(
            source,
            "for-each-ref",
            "--format=%(upstream:remotename)",
            `refs/heads/${repo.branch}`,
          );
          if (upstream && upstream !== ".") remotes.add(upstream);
        }
        const available = new Set((await gitValue(source, "remote")).split("\n").filter(Boolean));
        return Promise.all(
          [...remotes]
            .toSorted()
            .map(async (name) => [
              name,
              available.has(name) ? await remoteIdentity(source, name) : null,
            ]),
        );
      }),
    ),
  );

/** Assess a registered coordinated parent. No managed Git state is written. */
export async function assessFinish(
  parent: string,
  invocationPath: string,
  options: AssessmentOptions = {},
): Promise<FinishReport> {
  const parentPath = canonicalPhysicalPath(await realpath(parent));
  const configurationRoot = await discoverFinishRoot(parentPath);
  const config = await readFinishConfig(configurationRoot);
  const mainRecords = await registered(configurationRoot, basename(configurationRoot));
  const parentRecords = mainRecords.filter(
    (entry) =>
      !entry.isMain && !entry.pruneReason && canonicalPhysicalPath(entry.path) === parentPath,
  );
  if (parentRecords.length !== 1 || !parentRecords[0].branch)
    throw new Error("TARGET_NOT_REGISTERED");
  if (
    !within(parentPath, canonicalPhysicalPath(await realpath(invocationPath))) &&
    canonicalPhysicalPath(invocationPath) !== canonicalPhysicalPath(configurationRoot)
  )
    throw new Error("TARGET_OUTSIDE_WORKSPACE");
  const report: FinishReport = {
    target: safeLabel(basename(parentPath)) ?? "[redacted]",
    dryRun: options.dryRun === true,
    readiness: "ready",
    repositories: [],
    nonparticipants: [],
    blockers: [],
    warnings: ["REMOTE_METADATA_REFRESH; NOT_ATOMIC; REVERTS_NOT_CHECKED"],
    confirmations: [],
    cleanupPlan: null,
    cleanupResult: null,
  };
  const entries = [
    {
      repository: basename(configurationRoot),
      source: configurationRoot,
      path: parentPath,
      policy: config.meta?.baseBranch,
      isParent: true,
    },
    ...Object.entries(config.repos).map(([repository, value]) => ({
      repository,
      source: resolve(configurationRoot, value.path),
      path: resolve(parentPath, value.path),
      policy: value.baseBranch,
      isParent: false,
    })),
  ];
  const operations: NonNullable<FinishReport["cleanupPlan"]>["operations"] = [];
  const paths = new Set<string>();
  for (const item of entries) {
    const basePolicy = item.policy ?? config.baseBranch;
    const manual = options.manualTargets?.[item.repository];
    const base: FinishRepository["base"] = {
      source: manual
        ? "manual"
        : item.policy
          ? "repository-config"
          : config.baseBranch
            ? "workspace-config"
            : "omitted",
      remote: manual?.remote ?? (basePolicy ? "origin" : null),
      ref:
        manual?.ref ?? (basePolicy ? `refs/heads/${normalizeLogicalBranchName(basePolicy)}` : null),
      oid: null,
    };
    if (!item.isParent) {
      let sourceExists = false;
      let exists = false;
      try {
        if (!within(parentPath, item.path) || !within(configurationRoot, item.source))
          throw new Error("PATH_IDENTITY_INVALID");
        await stat(item.source);
        sourceExists = true;
        await lstat(item.path);
        exists = true;
        await stat(item.path);
      } catch (error) {
        if (sourceExists && !exists && (error as NodeJS.ErrnoException).code === "ENOENT") {
          report.nonparticipants.push(safeLabel(item.repository) ?? "[redacted]");
          continue;
        }
        report.blockers.push("PARTICIPANT_INACCESSIBLE");
        continue;
      }
    }
    const repo: FinishRepository = {
      repository: item.repository,
      path: relative(parentPath, item.path) || ".",
      head: null,
      branch: null,
      dirty: null,
      dirtyDetails: null,
      upstream: null,
      base,
      integration: "unknown",
      integrationEvidence: { source: "none", fresh: false, correlation: "not-attempted" },
      reasons: [],
    };
    report.repositories.push(repo);
    try {
      const physical = canonicalPhysicalPath(await realpath(item.path));
      if (!within(parentPath, physical) || paths.has(physical))
        throw new Error("PATH_IDENTITY_INVALID");
      paths.add(physical);
      const records = await registered(item.source, item.repository);
      const matches = records.filter(
        (entry) => !entry.pruneReason && canonicalPhysicalPath(entry.path) === physical,
      );
      if (matches.length !== 1 || matches[0].isMain || !matches[0].branch)
        throw new Error("REGISTRATION_INVALID");
      repo.branch = matches[0].branch;
      if (!repo.branch) throw new Error("BRANCH_INVALID");
      repo.head = await gitValue(item.path, "rev-parse", "HEAD");
      if (!oid(repo.head)) throw new Error("HEAD_INVALID");
      await assertNoExecutableFilters(item.path);
      const status = await git(
        item.path,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
        "--no-renames",
      );
      repo.dirty = status.length > 0;
      repo.dirtyDetails = {
        staged: status
          .split("\n")
          .some(
            (line) => line.length >= 2 && line[0] !== " " && line[0] !== "?" && line[0] !== "!",
          ),
        unstaged: status
          .split("\n")
          .some(
            (line) => line.length >= 2 && line[1] !== " " && line[1] !== "?" && line[1] !== "!",
          ),
        untracked: status
          .split("\n")
          .some((line) => line.startsWith("??") || line.startsWith("!!")),
      };
      const upstreamIdentity = await git(
        item.path,
        "for-each-ref",
        "--format=%(upstream:remotename)%00%(upstream:remoteref)",
        `refs/heads/${matches[0].branch}`,
      );
      const [upstreamRemote, upstreamRef] = upstreamIdentity.split("\0");
      if (!upstreamRemote || !upstreamRef) repo.reasons.push(reason("UPSTREAM_ABSENT"));
      if (repo.dirty) repo.reasons.push(reason("DIRTY"));
      if (!base.remote || !base.ref) repo.reasons.push(reason("BASE_OMITTED"));
      let privateRepo: string | null = null;
      try {
        privateRepo = await mkdtemp(join(tmpdir(), "arashi-finish-"));
        await git(privateRepo, "init", "--bare", "-q");
        await git(
          privateRepo,
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          item.source,
          `${repo.head}:refs/finish/head`,
        );
        if (
          upstreamRemote &&
          upstreamRef &&
          upstreamRemote !== "." &&
          upstreamRef.startsWith("refs/heads/")
        ) {
          try {
            const upstreamUrl = await remoteIdentity(item.source, upstreamRemote);
            await privateRemote(privateRepo, upstreamUrl);
            await git(
              privateRepo,
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              "finish-source",
              `${upstreamRef}:refs/finish/upstream`,
            );
            const upstreamOid = await gitValue(privateRepo, "rev-parse", "refs/finish/upstream");
            const counts = (
              await git(
                privateRepo,
                "rev-list",
                "--left-right",
                "--count",
                `refs/finish/upstream...refs/finish/head`,
              )
            )
              .split(/\s+/)
              .map(Number);
            repo.upstream = {
              oid: oid(upstreamOid) ? upstreamOid : null,
              ahead: counts[1] ?? null,
              behind: counts[0] ?? null,
            };
          } catch {
            repo.reasons.push(reason("UPSTREAM_UNAVAILABLE"));
          }
        } else if (upstreamRemote || upstreamRef) repo.reasons.push(reason("UPSTREAM_UNAVAILABLE"));
        if (base.remote && base.ref) {
          try {
            const remoteUrl = await remoteIdentity(item.source, base.remote);
            await privateRemote(privateRepo, remoteUrl);
            await git(
              privateRepo,
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              "finish-source",
              `${base.ref}:refs/finish/base`,
            );
            base.oid = await gitValue(privateRepo, "rev-parse", "refs/finish/base");
            const shallow = await gitValue(privateRepo, "rev-parse", "--is-shallow-repository");
            if (shallow === "true") throw new Error("HISTORY_INCOMPLETE");
            const missing = await git(
              privateRepo,
              "rev-list",
              "--objects",
              "--missing=print",
              "refs/finish/base",
              "refs/finish/head",
            );
            if (missing.split("\n").some((line) => line.startsWith("?")))
              throw new Error("HISTORY_INCOMPLETE");
            repo.integrationEvidence.fresh = true;
            try {
              await git(
                privateRepo,
                "merge-base",
                "--is-ancestor",
                "refs/finish/head",
                "refs/finish/base",
              );
              repo.integration = "proven";
              repo.integrationEvidence.source = "git-ancestry";
            } catch {
              repo.reasons.push(reason("ANCESTRY_NOT_PROVEN"));
              repo.integrationEvidence.correlation = await correlateGithub(
                await remoteIdentity(item.source, "origin").catch(() => ""),
                repo.branch!,
                repo.head!,
                remoteUrl,
                base.ref,
                base.oid,
                async (mergeOid) => {
                  try {
                    await git(
                      privateRepo!,
                      "merge-base",
                      "--is-ancestor",
                      mergeOid,
                      "refs/finish/base",
                    );
                    return true;
                  } catch {
                    return false;
                  }
                },
              );
            }
          } catch {
            repo.reasons.push(reason("FRESH_EVIDENCE_UNAVAILABLE"));
            base.oid = null;
          }
        }
      } catch {
        repo.reasons.push(reason("FRESH_EVIDENCE_UNAVAILABLE"));
      } finally {
        if (privateRepo) await rm(privateRepo, { recursive: true, force: true });
      }
      if (repo.upstream?.ahead || !repo.upstream) repo.reasons.push(reason("DISCARD_REQUIRED"));
      operations.push({
        repository: repo.repository,
        type: "worktree_remove",
        path: repo.path,
        branch: repo.branch,
        status: "pending",
      });
      if (!options.keepBranches)
        operations.push({
          repository: repo.repository,
          type: "branch_delete",
          path: null,
          branch: repo.branch,
          status: "pending",
        });
    } catch (error) {
      const code =
        (error as Error).message === "EXECUTABLE_FILTER_UNSAFE"
          ? "EXECUTABLE_FILTER_UNSAFE"
          : "PARTICIPANT_INVALID";
      repo.reasons.push(reason(code));
      report.blockers.push(code);
    }
    repo.reasons.sort();
  }
  if (report.repositories.length === 0 || report.repositories[0].head === null)
    report.blockers.push("PARENT_INVALID");
  if (report.blockers.length) report.readiness = "blocked";
  else if (report.repositories.some((r) => r.integration === "unknown"))
    report.readiness = "unknown";
  if (!report.blockers.length)
    report.cleanupPlan = {
      operations: [
        ...operations
          .filter((o) => o.type === "worktree_remove")
          .toSorted((a, b) => {
            const aPath = resolve(parentPath, a.path!);
            const bPath = resolve(parentPath, b.path!);
            return isDescendantWorktreePath(aPath, bPath)
              ? 1
              : isDescendantWorktreePath(bPath, aPath)
                ? -1
                : 0;
          }),
        ...operations.filter((o) => o.type === "branch_delete"),
      ],
      hooks: [],
      keepBranches: options.keepBranches === true,
    };
  report.blockers.sort();
  assessedConfiguration.set(report, JSON.stringify(config));
  assessedRemotes.set(
    report,
    await remoteSnapshot(configurationRoot, report, config).catch(() => "unavailable"),
  );
  return report;
}

export function projectFinishResult(
  summary: RemovalSummary,
  parent: string,
): FinishReport["cleanupResult"] {
  return {
    operations: summary.operations.map((operation) => ({
      repository: safeLabel(operation.repository) ?? "[redacted]",
      type: operation.type,
      branch: operation.branchName ? (safeLabel(operation.branchName) ?? "[redacted]") : null,
      path:
        operation.worktreePath && within(resolve(parent), resolve(operation.worktreePath))
          ? relative(resolve(parent), resolve(operation.worktreePath)) || "."
          : null,
      status: operation.status,
      reason: operation.status === "failed" ? "REMOVE_OPERATION_FAILED" : null,
    })),
    hooks: summary.hookOutcomes.map((hook) => ({
      name:
        hook.hookName === "pre-remove" || hook.hookName === "post-remove"
          ? hook.hookName
          : "[redacted]",
      status: hook.hookStatus,
      reason: hook.reasonCode,
    })),
    failures: summary.errors.map(() => "REMOVE_FAILED"),
  };
}

/** Keep raw identities in the gate; sanitize only the outbound report. */
export function projectFinishReport(report: FinishReport): FinishReport {
  const label = (value: string) => safeLabel(value) ?? "[redacted]";
  return {
    ...report,
    repositories: report.repositories.map((repo) => ({
      ...repo,
      repository: label(repo.repository),
      branch: repo.branch && label(repo.branch),
    })),
    nonparticipants: report.nonparticipants.map(label),
    confirmations: report.confirmations.map((entry) =>
      entry.startsWith("MANUAL_COMPLETION:")
        ? `MANUAL_COMPLETION:${label(entry.slice("MANUAL_COMPLETION:".length))}`
        : entry,
    ),
    cleanupPlan: report.cleanupPlan && {
      ...report.cleanupPlan,
      operations: report.cleanupPlan.operations.map((entry) => ({
        ...entry,
        repository: label(entry.repository),
        branch: entry.branch && label(entry.branch),
      })),
    },
  };
}

export async function runFinishRemoval(
  report: FinishReport,
  parent: string,
  options: {
    dryRun?: boolean;
    force?: boolean;
    json?: boolean;
    keepBranches?: boolean;
    hookInput?: boolean;
  },
  invocationPath: string,
  manualTargets: Record<string, { remote: string; ref: string }> = {},
): Promise<{ code: number; result: RemovalSummary | null; invalidated: boolean }> {
  if (!report.cleanupPlan || report.blockers.length)
    return { code: 1, result: null, invalidated: true };
  const physicalParent = canonicalPhysicalPath(await realpath(parent));
  const configurationRoot = await discoverFinishRoot(parent);
  const acceptedConfig = await readFinishConfig(configurationRoot);
  try {
    for (const repo of report.repositories) {
      await assertNoExecutableFilters(
        repo.path === "." ? physicalParent : resolve(physicalParent, repo.path!),
      );
    }
  } catch {
    return { code: 1, result: null, invalidated: true };
  }
  const acceptedConfigText = JSON.stringify(acceptedConfig);
  if (assessedConfiguration.get(report) !== acceptedConfigText)
    return { code: 1, result: null, invalidated: true };
  const acceptedRemotes = assessedRemotes.get(report);
  if (
    acceptedRemotes === "unavailable" ||
    (await remoteSnapshot(configurationRoot, report, acceptedConfig).catch(() => "unavailable")) !==
      acceptedRemotes
  )
    return { code: 1, result: null, invalidated: true };
  const accepted = JSON.stringify(
    report.repositories.map((r) => ({
      ...r,
      integration: r.integration === "manually-confirmed" ? "unknown" : r.integration,
      integrationEvidence: {
        ...r.integrationEvidence,
        source: r.integrationEvidence.source === "manual" ? "none" : r.integrationEvidence.source,
      },
    })),
  );
  const expected = report.cleanupPlan.operations;
  let result: RemovalSummary | null = null;
  let invalidated = false;
  const gate: FinishRemoveGate = {
    roots: {
      configurationRoot,
      executionRoot: configurationRoot,
      config: acceptedConfig,
    },
    inspect: async (plan, phase) => {
      if (JSON.stringify(await readFinishConfig(configurationRoot)) !== acceptedConfigText) {
        invalidated = true;
        throw new Error("FINISH_CONFIG_INVALIDATED");
      }
      if (
        (await remoteSnapshot(configurationRoot, report, acceptedConfig).catch(
          () => "unavailable",
        )) !== acceptedRemotes
      ) {
        invalidated = true;
        throw new Error("FINISH_REMOTE_INVALIDATED");
      }
      const actual = [
        ...plan.worktrees.map((entry) => ({
          repository: entry.repository,
          type: "worktree_remove",
          path: relative(physicalParent, canonicalPhysicalPath(entry.path)) || ".",
          branch: entry.branch,
          status: "pending",
        })),
        ...(options.keepBranches
          ? []
          : plan.branches.map((entry) => ({
              repository: entry.repository,
              type: "branch_delete",
              path: null,
              branch: entry.branch,
              status: "pending",
            }))),
      ];
      const expectedHooks = expected
        .filter((entry) => entry.type === "worktree_remove")
        .map((entry) => ({
          repository: entry.repository,
          branchName: entry.branch,
          worktreePath: finishHookPath(resolve(physicalParent, entry.path!)),
        }));
      const actualHooks = plan.hooks.map((entry) => ({
        repository: entry.repository,
        branchName: entry.branchName,
        worktreePath: entry.worktreePath && finishHookPath(entry.worktreePath),
      }));
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        JSON.stringify(actualHooks) !== JSON.stringify(expectedHooks)
      ) {
        invalidated = true;
        throw new Error("FINISH_PLAN_INVALIDATED");
      }
      if (phase === "post-hook") {
        const refreshed = await assessFinish(parent, invocationPath, {
          keepBranches: options.keepBranches,
          manualTargets,
        });
        if (
          JSON.stringify(refreshed.repositories) !== accepted ||
          JSON.stringify(refreshed.cleanupPlan?.operations) !== JSON.stringify(expected)
        ) {
          invalidated = true;
          throw new Error("FINISH_EVIDENCE_INVALIDATED");
        }
      }
    },
    report: (summary) => {
      result = summary;
    },
  };
  const previous = process.cwd();
  try {
    process.chdir(configurationRoot);
    const code = await executeRemove(
      parent,
      {
        checkDirty: false,
        dryRun: options.dryRun,
        force: true,
        json: options.json,
        keepBranches: options.keepBranches,
        hookInput: options.hookInput,
      },
      undefined,
      gate,
    );
    return { code, result, invalidated };
  } catch {
    return { code: 1, result, invalidated: true };
  } finally {
    try {
      process.chdir(previous);
    } catch {
      process.chdir(configurationRoot);
    }
  }
}

export async function previewFinishPlan(
  report: FinishReport,
  parent: string,
  options: { keepBranches?: boolean; hookInput?: boolean },
): Promise<void> {
  if (!report.cleanupPlan) return;
  const preview = await runFinishRemoval(report, parent, { ...options, dryRun: true }, parent);
  if (preview.code || !preview.result || preview.result.errors.length) {
    report.blockers.push("REMOVE_PLAN_UNAVAILABLE");
    report.readiness = "blocked";
    report.cleanupPlan = null;
    return;
  }
  report.cleanupPlan.hooks = (preview.result.hookPreviews ?? []).map((hook) => ({
    name: hook.hookName,
    repository: safeLabel(hook.repository) ?? "[redacted]",
    scope: hook.scope,
    availability: hook.availability,
    reason: hook.reasonCode,
  }));
}

export async function discoverFinishRoot(invocation: string): Promise<string> {
  let cursor = resolve(invocation);
  while (true) {
    try {
      const common = await gitValue(cursor, "rev-parse", "--git-common-dir");
      const commonPath = resolve(cursor, common);
      // A bare common directory is itself the configured root; ordinary .git
      // directories instead point to their containing checkout.
      for (const candidate of [commonPath, resolve(commonPath, "..")]) {
        try {
          await readFinishConfig(candidate);
          return candidate;
        } catch {
          /* check next candidate */
        }
      }
    } catch {
      /* try the enclosing directory */
    }
    try {
      await readFinishConfig(cursor);
      return cursor;
    } catch {
      /* continue to parent */
    }
    const next = resolve(cursor, "..");
    if (next === cursor) throw new Error("CONFIGURED_WORKSPACE_REQUIRED");
    cursor = next;
  }
}

export async function confirmUnknownCompletion(
  report: FinishReport,
  ask: (message: string) => Promise<{ status: string; value?: boolean }>,
): Promise<boolean> {
  const unknown = report.repositories.filter((entry) => entry.integration === "unknown");
  if (!unknown.length) return true;
  const message = unknown
    .map(
      (repo) =>
        `${repo.repository} -> ${repo.base.remote}:${repo.base.ref} (${repo.reasons.join(", ") || "UNKNOWN"})`,
    )
    .join("; ");
  const confirmation = await ask(`Manually confirm completion for ALL: ${message}?`);
  if (confirmation.status !== "ok" || !confirmation.value) return false;
  for (const repo of unknown) {
    repo.integration = "manually-confirmed";
    repo.integrationEvidence.source = "manual";
    report.confirmations.push(`MANUAL_COMPLETION:${repo.repository}`);
  }
  return true;
}

export function createCommand(): Command {
  return new Command("finish")
    .description("Assess and retire one coordinated workspace")
    .argument("[target]", "Registered parent path or unique branch")
    .option("-n, --dry-run", "Assess without cleanup prompts or mutation")
    .option("-j, --json", "Emit one JSON envelope without prompts")
    .option("-f, --force", "Authorize discard and remove confirmation (not completion)")
    .option("--keep-branches", "Retain local branches")
    .option("--no-hook-input", "Run hooks with input disabled")
    .action(
      async (
        target: string | undefined,
        options: {
          dryRun?: boolean;
          json?: boolean;
          force?: boolean;
          keepBranches?: boolean;
          hookInput?: boolean;
        },
      ) => {
        const done = (code: number, report?: FinishReport, errorCode?: string) => {
          const visible = report && projectFinishReport(report);
          if (options.json)
            writeJsonEnvelope(
              errorCode
                ? createJsonErrorEnvelope("finish", {
                    code: errorCode,
                    message: errorCode,
                    details: visible as unknown as Record<string, unknown>,
                  })
                : createJsonSuccessEnvelope(
                    "finish",
                    visible as unknown as Record<string, unknown>,
                  ),
            );
          else if (visible) console.log(JSON.stringify(visible, null, 2));
          else console.error(errorCode);
          process.exitCode = code;
        };
        let selectedReport: FinishReport | undefined;
        try {
          const configurationRoot = await discoverFinishRoot(process.cwd());
          const records = (await registered(configurationRoot, basename(configurationRoot))).filter(
            (entry) => !entry.isMain && !entry.pruneReason && entry.branch,
          );
          let candidates = records;
          if (target) {
            const explicitPath =
              isAbsolute(target) || target.startsWith(".") || /^~[/\\]/.test(target);
            const targetPath = /^~[/\\]/.test(target)
              ? resolve(homedir(), target.slice(2))
              : target;
            const exact = records.filter((entry) => {
              try {
                return canonicalPhysicalPath(entry.path) === canonicalPhysicalPath(targetPath);
              } catch {
                return false;
              }
            });
            candidates =
              exact.length || explicitPath
                ? exact
                : records.filter((entry) => entry.branch.includes(target));
          } else if (options.json || !process.stdin.isTTY)
            return done(2, undefined, "TARGET_REQUIRED");
          if (!target && candidates.length) {
            const context = await realpath(process.cwd());
            const contextual = candidates.filter((entry) =>
              within(canonicalPhysicalPath(entry.path), context),
            );
            if (contextual.length === 1) candidates = contextual;
            else {
              const choice = await select(
                "Choose coordinated workspace",
                candidates.map((entry) => ({
                  name: safeLabel(entry.branch) ?? "[redacted]",
                  value: entry.path,
                })),
              );
              if (choice.status !== "ok") return done(2, undefined, "SELECTION_DECLINED");
              candidates = candidates.filter((entry) => entry.path === choice.value);
            }
          }
          if (candidates.length !== 1)
            return done(2, undefined, candidates.length ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND");
          let report = await assessFinish(candidates[0].path, candidates[0].path, {
            dryRun: options.dryRun,
            keepBranches: options.keepBranches,
          });
          selectedReport = report;
          await previewFinishPlan(report, candidates[0].path, options);
          if (options.dryRun) return done(0, report);
          if (report.readiness === "blocked") return done(1, report, "FINISH_INELIGIBLE");
          const manualTargets: Record<string, { remote: string; ref: string }> = {};
          if (!options.json && process.stdin.isTTY && !options.dryRun) {
            for (const repo of report.repositories.filter((entry) => !entry.base.ref)) {
              const chosen = await input(`Full base ref for ${repo.repository} (refs/heads/...):`);
              if (chosen.status !== "ok" || !validManualBaseRef(chosen.value))
                return done(2, report, "CONFIRMATION_DECLINED");
              const remote = await input(`Remote for ${repo.repository}:`);
              if (remote.status !== "ok" || !safeLabel(remote.value))
                return done(2, report, "CONFIRMATION_DECLINED");
              manualTargets[repo.repository] = { ref: chosen.value, remote: remote.value };
            }
            if (Object.keys(manualTargets).length)
              report = await assessFinish(candidates[0].path, candidates[0].path, {
                keepBranches: options.keepBranches,
                manualTargets,
              });
            selectedReport = report;
          }
          if (report.readiness === "unknown") {
            if (
              options.json ||
              !process.stdin.isTTY ||
              report.repositories.some((repo) => !repo.base.ref)
            )
              return done(2, report, "CONFIRMATION_REQUIRED");
            if (!(await confirmUnknownCompletion(report, (message) => confirm(message, false))))
              return done(2, report, "CONFIRMATION_DECLINED");
          }
          const discards = report.repositories.filter(
            (repo) =>
              repo.dirty ||
              !repo.upstream ||
              repo.upstream.ahead === null ||
              repo.upstream.ahead > 0,
          );
          if (discards.length && !options.force) {
            if (options.json || !process.stdin.isTTY)
              return done(2, report, "DISCARD_CONFIRMATION_REQUIRED");
            const consent = await confirm(
              `Discard dirty or unpublished changes in ${discards.map((repo) => repo.repository).join(", ")}?`,
              false,
            );
            if (consent.status !== "ok" || !consent.value)
              return done(2, report, "CONFIRMATION_DECLINED");
          }
          if (!options.force) {
            if (options.json || !process.stdin.isTTY)
              return done(2, report, "REMOVE_CONFIRMATION_REQUIRED");
            const consent = await confirm(`Remove coordinated workspace ${report.target}?`, false);
            if (consent.status !== "ok" || !consent.value)
              return done(2, report, "CONFIRMATION_DECLINED");
          }
          const reassessed = await assessFinish(candidates[0].path, candidates[0].path, {
            keepBranches: options.keepBranches,
            manualTargets,
          });
          if (
            JSON.stringify(reassessed.repositories) !==
            JSON.stringify(
              report.repositories.map((repo) => ({
                ...repo,
                integration:
                  repo.integration === "manually-confirmed" ? "unknown" : repo.integration,
                integrationEvidence: {
                  ...repo.integrationEvidence,
                  source:
                    repo.integrationEvidence.source === "manual"
                      ? "none"
                      : repo.integrationEvidence.source,
                },
              })),
            )
          )
            return done(1, report, "FINISH_EVIDENCE_INVALIDATED");
          const removal = await runFinishRemoval(
            report,
            candidates[0].path,
            options,
            candidates[0].path,
            manualTargets,
          );
          if (removal.result)
            report.cleanupResult = projectFinishResult(removal.result, candidates[0].path);
          return done(
            removal.code,
            report,
            removal.code
              ? removal.invalidated
                ? "FINISH_EVIDENCE_INVALIDATED"
                : "REMOVE_FAILED"
              : undefined,
          );
        } catch {
          return done(1, selectedReport, "FINISH_INSPECTION_FAILED");
        }
      },
    );
}
