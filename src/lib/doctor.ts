import {
  GLOBAL_HOOKS,
  discoverConfiguredRepositoryRemoveHookCandidates,
  discoverLifecycleHookCandidates,
  discoverLifecycleHookCandidatesInDirectory,
  discoverLifecycleHook,
  getRepoSpecificHookName,
  lifecycleHookExtensions,
  prepareLifecycleHookSources,
  resolveScopedLifecycleHooks,
  validateHook,
} from "./hooks.ts";
import type { LifecycleHookPreparationCandidate } from "./hooks.ts";
import { basename, join, resolve } from "path";
import {
  checkAllRepos,
  isMissingRepositoryStatus,
  shouldIncludeWorkspaceRootInRepositoryChecks,
} from "../commands/status.ts";
import type { Config, WorkspaceRepositoryRoots } from "./config.ts";
import { getConfigPath, loadWorkspaceRepositories } from "./config.ts";
import { findConfiguredWorkspaceRoots } from "./workspace-context.ts";
import { discoverPrunableWorktrees } from "../core/remove.ts";
import { readdir } from "fs/promises";
import { inspectRepositoryManagedIgnore, type ManagedIgnoreInspection } from "./managed-ignore.ts";
import { DEFAULT_WORKTREES_DIR } from "./worktree-location.ts";
import {
  inspectUpstreamTrackingConfiguration,
  type UpstreamTrackingInspection,
} from "./git-remote.ts";
import { collectMaterializationDiagnostics } from "./materialization-doctor.ts";

const ZERO = 0;

export const quoteDoctorShellArgument = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

type RepoStatus = Awaited<ReturnType<typeof checkAllRepos>>[number];
type RepositoryTarget = Parameters<typeof discoverPrunableWorktrees>[0][number];

export type DoctorSeverity = "error" | "warning" | "info";
export type DoctorCategory =
  | "workspace"
  | "configuration"
  | "repository"
  | "worktree"
  | "hook"
  | "shell"
  | "install";

export interface DoctorFinding {
  code: string;
  severity: DoctorSeverity;
  category: DoctorCategory;
  scope: string;
  message: string;
  details?: Record<string, unknown>;
  suggestedCommands: string[];
}

export interface DoctorSummary {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export interface DoctorResult {
  checkedCategories: DoctorCategory[];
  findings: DoctorFinding[];
  summary: DoctorSummary;
  workspaceRoot: string | null;
}

export interface MaterializationDiagnostic {
  action: "copy" | "symlink" | null;
  actualKind?: "directory" | "file" | "junction" | "symlink";
  ancestorKind?: "directory" | "file" | "junction" | "symlink";
  capability?: "available" | "unavailable" | "unknown";
  destinationStatus?:
    | "ancestor-unsafe"
    | "broken"
    | "kind-mismatch"
    | "missing"
    | "misdirected"
    | "present";
  expectedKind?: "directory" | "file";
  normalizedWorktreePath?: string | null;
  path: string | null;
  repositoryId: string;
  sourceStatus?: "missing" | "present" | "unavailable";
  worktreePath?: string | null;
}

const ALL_CHECKED_CATEGORIES: DoctorCategory[] = [
  "workspace",
  "configuration",
  "repository",
  "worktree",
  "hook",
  "shell",
  "install",
];

const createFinding = (finding: DoctorFinding): DoctorFinding => finding;

const materializationDetails = (
  diagnostic: MaterializationDiagnostic,
): Record<string, unknown> => ({
  action: diagnostic.action,
  path: diagnostic.path,
  repositoryId: diagnostic.repositoryId,
  worktreePath: diagnostic.worktreePath ?? null,
});

const createMaterializationFinding = (
  diagnostic: MaterializationDiagnostic,
  finding: Omit<DoctorFinding, "details" | "suggestedCommands">,
  details: Record<string, unknown> = {},
): DoctorFinding[] => [
  createFinding({
    ...finding,
    details: { ...materializationDetails(diagnostic), ...details },
    suggestedCommands: [],
  }),
];

export const materializationToDoctorFindings = (
  diagnostic: MaterializationDiagnostic,
): DoctorFinding[] => {
  const repositoryScope = ["materialization", diagnostic.repositoryId];

  if (diagnostic.sourceStatus === "unavailable") {
    return createMaterializationFinding(diagnostic, {
      category: "repository",
      code: "MATERIALIZATION_SOURCE_CHECKOUT_UNAVAILABLE",
      message: "The canonical source checkout is unavailable for this repository.",
      scope: [...repositoryScope, "source-checkout"].join(":"),
      severity: "error",
    });
  }

  if (diagnostic.sourceStatus === "missing" && diagnostic.action && diagnostic.path) {
    return createMaterializationFinding(diagnostic, {
      category: "repository",
      code: "MATERIALIZATION_SOURCE_MISSING",
      message: "The optional configured materialization source is missing.",
      scope: [...repositoryScope, diagnostic.action, diagnostic.path].join(":"),
      severity: "info",
    });
  }

  if (diagnostic.capability === "unavailable") {
    return createMaterializationFinding(diagnostic, {
      category: "configuration",
      code: "MATERIALIZATION_SYMLINK_CAPABILITY_UNAVAILABLE",
      message: "Native symbolic-link capability is unavailable under the current platform policy.",
      scope: [...repositoryScope, "symlink-capability"].join(":"),
      severity: "error",
    });
  }

  if (diagnostic.capability === "unknown") {
    return createMaterializationFinding(diagnostic, {
      category: "configuration",
      code: "MATERIALIZATION_SYMLINK_CAPABILITY_UNKNOWN",
      message: "Native symbolic-link capability cannot be established without a mutation probe.",
      scope: [...repositoryScope, "symlink-capability"].join(":"),
      severity: "info",
    });
  }

  if (!diagnostic.action || !diagnostic.path || !diagnostic.normalizedWorktreePath) {
    return [];
  }

  const scope = [
    ...repositoryScope,
    diagnostic.normalizedWorktreePath,
    diagnostic.action,
    diagnostic.path,
  ].join(":");

  if (diagnostic.destinationStatus === "ancestor-unsafe") {
    return createMaterializationFinding(
      diagnostic,
      {
        category: "worktree",
        code: "MATERIALIZATION_DESTINATION_ANCESTOR_UNSAFE",
        message: "A materialization destination ancestor is not a safe real directory.",
        scope,
        severity: "error",
      },
      { ancestorKind: diagnostic.ancestorKind },
    );
  }

  if (diagnostic.action === "copy" && diagnostic.destinationStatus === "missing") {
    return createMaterializationFinding(diagnostic, {
      category: "worktree",
      code: "MATERIALIZATION_COPY_DESTINATION_MISSING",
      message: "The managed worktree is missing the configured copy destination.",
      scope,
      severity: "warning",
    });
  }

  if (diagnostic.action === "copy" && diagnostic.destinationStatus === "kind-mismatch") {
    return createMaterializationFinding(
      diagnostic,
      {
        category: "worktree",
        code: "MATERIALIZATION_COPY_DESTINATION_KIND_MISMATCH",
        message: "The configured copy source and destination kinds do not match.",
        scope,
        severity: "warning",
      },
      { actualKind: diagnostic.actualKind, expectedKind: diagnostic.expectedKind },
    );
  }

  if (diagnostic.action === "symlink" && diagnostic.destinationStatus === "broken") {
    return createMaterializationFinding(diagnostic, {
      category: "worktree",
      code: "MATERIALIZATION_SYMLINK_BROKEN",
      message: "The configured managed-worktree symbolic link is broken.",
      scope,
      severity: "warning",
    });
  }

  if (diagnostic.action === "symlink" && diagnostic.destinationStatus === "misdirected") {
    return createMaterializationFinding(diagnostic, {
      category: "worktree",
      code: "MATERIALIZATION_SYMLINK_MISDIRECTED",
      message: "The configured symbolic link does not target the exact canonical source.",
      scope,
      severity: "warning",
    });
  }

  return [];
};

export const managedIgnoreToDoctorFindings = (
  inspection: ManagedIgnoreInspection,
): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  for (const path of inspection.paths) {
    if (path.status === "unignored") {
      findings.push(
        createFinding({
          category: "configuration",
          code: "MANAGED_IGNORE_MISSING",
          details: { path: path.input, rule: path.rule, scope: inspection.scope },
          message: `Managed path '${path.rule}' is not effectively ignored (scope: ${inspection.scope}).`,
          scope: `managed-ignore:${path.rule}`,
          severity: "warning",
          suggestedCommands: ["arashi init --ignore-scope local"],
        }),
      );
    } else if (path.status === "unsafe") {
      findings.push(
        createFinding({
          category: "configuration",
          code: "MANAGED_IGNORE_UNSAFE_PATH",
          details: { path: path.input, safetyReason: path.safetyReason },
          message: `Configured managed path '${path.input}' is unsafe to ignore automatically (${path.safetyReason}).`,
          scope: `managed-ignore:${path.input}`,
          severity: "warning",
          suggestedCommands: ["arashi init --help", "edit .arashi/config.json"],
        }),
      );
    }
  }
  for (const stale of inspection.staleRules) {
    findings.push(
      createFinding({
        category: "configuration",
        code: "MANAGED_IGNORE_STALE_RULE",
        details: { ...stale },
        message: `Arashi-owned ignore rule '${stale.rule}' is stale in ${stale.path}.`,
        scope: `managed-ignore:${stale.target}`,
        severity: "warning",
        suggestedCommands: ["arashi init --ignore-scope local"],
      }),
    );
  }
  return findings;
};

const collectManagedIgnoreFindings = async (
  workspaceRoot: string,
  config: Config,
): Promise<DoctorFinding[]> => {
  try {
    const inspection = await inspectRepositoryManagedIgnore({
      reposDir: config.reposDir,
      workspaceRoot,
      worktreesDir: config.worktreesDir ?? DEFAULT_WORKTREES_DIR,
    });
    return managedIgnoreToDoctorFindings(inspection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Invalid clone-local arashi.ignoreScope")) {
      return [
        createFinding({
          category: "configuration",
          code: "MANAGED_IGNORE_SCOPE_INVALID",
          details: { error: message },
          message,
          scope: "managed-ignore:preference",
          severity: "warning",
          suggestedCommands: [
            "git config --local --unset arashi.ignoreScope",
            "arashi init --ignore-scope local",
          ],
        }),
      ];
    }
    throw error;
  }
};

export const summarizeDoctorFindings = (findings: DoctorFinding[]): DoctorSummary => ({
  error: findings.filter((finding) => finding.severity === "error").length,
  info: findings.filter((finding) => finding.severity === "info").length,
  total: findings.length,
  warning: findings.filter((finding) => finding.severity === "warning").length,
});

const countRepoChanges = (status: RepoStatus): Record<string, number> => ({
  staged: status.files.filter((fileStatus) => fileStatus.stagingStatus !== " ").length,
  unstaged: status.files.filter(
    (fileStatus) => fileStatus.workingStatus !== " " && fileStatus.workingStatus !== "?",
  ).length,
  untracked: status.files.filter((fileStatus) => fileStatus.workingStatus === "?").length,
});

const createRepositoryTargets = (workspaceRoot: string, config: Config): RepositoryTarget[] => {
  const targets: RepositoryTarget[] = [{ name: basename(workspaceRoot), path: workspaceRoot }];
  for (const [name, repoConfig] of Object.entries(config.repos)) {
    targets.push({ name, path: resolve(workspaceRoot, repoConfig.path) });
  }
  return targets;
};

export const repositoryStatusToDoctorFindings = (
  status: RepoStatus,
  upstreamInspection: UpstreamTrackingInspection = { kind: "not-applicable" },
  platform: NodeJS.Platform = process.platform,
): DoctorFinding[] => {
  const findings: DoctorFinding[] = [];
  const scope = `repository:${status.name}`;

  if (status.error) {
    if (isMissingRepositoryStatus(status)) {
      findings.push(
        createFinding({
          category: "repository",
          code: "REPOSITORY_MISSING",
          details: { path: status.path, repository: status.name },
          message: `Configured repository '${status.name}' is missing at ${status.path}.`,
          scope,
          severity: "error",
          suggestedCommands: ["arashi clone", `git clone <url> ${status.path}`],
        }),
      );
      return findings;
    }

    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_STATUS_FAILED",
        details: { error: status.error, path: status.path, repository: status.name },
        message: `Could not collect Git status for '${status.name}': ${status.error}`,
        scope,
        severity: "error",
        suggestedCommands: [`git -C ${status.path} status`],
      }),
    );
    return findings;
  }

  if (status.files.length > ZERO) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_DIRTY",
        details: { changes: countRepoChanges(status), path: status.path, repository: status.name },
        message: `Repository '${status.name}' has uncommitted changes.`,
        scope,
        severity: "warning",
        suggestedCommands: ["arashi status --verbose", `git -C ${status.path} status`],
      }),
    );
  }

  if (status.branch.isDetached) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_DETACHED_HEAD",
        details: { path: status.path, repository: status.name },
        message: `Repository '${status.name}' is in detached HEAD state.`,
        scope,
        severity: "warning",
        suggestedCommands: [`git -C ${status.path} switch <branch>`],
      }),
    );
  } else if (
    status.refreshWarning?.kind !== "missing-remote-ref" &&
    upstreamInspection.kind === "ambiguous-merge-configuration"
  ) {
    const quotedPath = quoteDoctorShellArgument(status.path);
    const mergeConfigKey = quoteDoctorShellArgument(
      `branch.${upstreamInspection.localBranch}.merge`,
    );
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
        details: {
          branch: upstreamInspection.localBranch,
          mergeRefs: upstreamInspection.mergeRefs,
          path: status.path,
          reason: upstreamInspection.kind,
          remote: upstreamInspection.remote,
          repository: status.name,
        },
        message: `Repository '${status.name}' branch '${upstreamInspection.localBranch}' has ambiguous multi-valued upstream merge configuration; review the configured merge refs manually.`,
        scope,
        severity: "warning",
        suggestedCommands:
          platform === "win32" ? [] : [`git -C ${quotedPath} config --get-all ${mergeConfigKey}`],
      }),
    );
  } else if (
    status.refreshWarning?.kind !== "missing-remote-ref" &&
    upstreamInspection.kind === "missing-fetch-mapping"
  ) {
    const fetchRefspec = `+${upstreamInspection.mergeRef}:${upstreamInspection.expectedRemoteTrackingRef}`;
    const quotedPath = quoteDoctorShellArgument(status.path);
    const quotedRemote = quoteDoctorShellArgument(upstreamInspection.remote);
    const conflictingFetchRefspecs = upstreamInspection.conflictingFetchRefspecs ?? [];
    const fetchConfigKey = quoteDoctorShellArgument(`remote.${upstreamInspection.remote}.fetch`);
    const hasConflictingDestination = conflictingFetchRefspecs.length > 0;
    const baseMessage = hasConflictingDestination
      ? `Repository '${status.name}' branch '${upstreamInspection.localBranch}' has upstream configuration, but Git cannot use ${upstreamInspection.remote}/${upstreamInspection.remoteBranch} because remote '${upstreamInspection.remote}' has fetch mappings that conflict at the expected tracking namespace; review the conflicting fetch mappings manually.`
      : `Repository '${status.name}' branch '${upstreamInspection.localBranch}' has upstream configuration, but Git cannot use ${upstreamInspection.remote}/${upstreamInspection.remoteBranch} because remote '${upstreamInspection.remote}' has no covering fetch mapping.`;
    const message =
      platform === "win32"
        ? `${baseMessage} Review the structured details and run equivalent Git commands in your active Windows shell; doctor does not emit shell-ambiguous copy-paste commands on Windows.`
        : baseMessage;
    const suggestedCommands =
      platform === "win32"
        ? []
        : hasConflictingDestination
          ? [`git -C ${quotedPath} config --get-all ${fetchConfigKey}`]
          : [
              `git -C ${quotedPath} config --add ${fetchConfigKey} ${quoteDoctorShellArgument(fetchRefspec)}`,
              `git -C ${quotedPath} fetch -- ${quotedRemote}`,
              ...(upstreamInspection.hasMultipleMergeRefs
                ? []
                : [
                    `git -C ${quotedPath} branch ${quoteDoctorShellArgument(`--set-upstream-to=${upstreamInspection.remote}/${upstreamInspection.remoteBranch}`)} -- ${quoteDoctorShellArgument(upstreamInspection.localBranch)}`,
                  ]),
            ];
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_UPSTREAM_TRACKING_UNAVAILABLE",
        details: {
          branch: upstreamInspection.localBranch,
          conflictingFetchRefspecs,
          expectedRemoteTrackingRef: upstreamInspection.expectedRemoteTrackingRef,
          mergeRef: upstreamInspection.mergeRef,
          path: status.path,
          reason: upstreamInspection.kind,
          remote: upstreamInspection.remote,
          repository: status.name,
        },
        message,
        scope,
        severity: "warning",
        suggestedCommands,
      }),
    );
  } else if (!status.branch.remoteBranch) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_NO_UPSTREAM",
        details: { branch: status.branch.localBranch, path: status.path, repository: status.name },
        message: `Repository '${status.name}' branch '${status.branch.localBranch}' has no upstream.`,
        scope,
        severity: "warning",
        suggestedCommands: [
          "arashi status",
          `git -C ${status.path} branch --set-upstream-to <upstream>`,
        ],
      }),
    );
  } else if (status.branch.ahead > ZERO && status.branch.behind > ZERO) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_DIVERGED",
        details: {
          ahead: status.branch.ahead,
          behind: status.branch.behind,
          remoteBranch: status.branch.remoteBranch,
          repository: status.name,
        },
        message: `Repository '${status.name}' has diverged from ${status.branch.remoteBranch}.`,
        scope,
        severity: "warning",
        suggestedCommands: [
          "arashi status",
          `git -C ${status.path} pull --rebase`,
          `git -C ${status.path} push`,
        ],
      }),
    );
  } else if (status.branch.ahead > ZERO) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_AHEAD",
        details: {
          ahead: status.branch.ahead,
          remoteBranch: status.branch.remoteBranch,
          repository: status.name,
        },
        message: `Repository '${status.name}' is ahead of ${status.branch.remoteBranch} by ${status.branch.ahead} commit(s).`,
        scope,
        severity: "warning",
        suggestedCommands: ["arashi status", `git -C ${status.path} push`],
      }),
    );
  } else if (status.branch.behind > ZERO) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_BEHIND",
        details: {
          behind: status.branch.behind,
          remoteBranch: status.branch.remoteBranch,
          repository: status.name,
        },
        message: `Repository '${status.name}' is behind ${status.branch.remoteBranch} by ${status.branch.behind} commit(s).`,
        scope,
        severity: "warning",
        suggestedCommands: ["arashi pull", `git -C ${status.path} pull --ff-only`],
      }),
    );
  }

  if (status.refreshWarning?.kind === "missing-remote-ref") {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_MISSING_REMOTE_REF",
        details: { message: status.refreshWarning.message, repository: status.name },
        message: `Repository '${status.name}' tracks a missing remote ref: ${status.refreshWarning.message}`,
        scope,
        severity: "warning",
        suggestedCommands: ["arashi status", `git -C ${status.path} branch -vv`],
      }),
    );
  } else if (status.refreshWarning) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_REMOTE_REFRESH_FAILED",
        details: { message: status.refreshWarning.message, repository: status.name },
        message: `Repository '${status.name}' remote tracking status may be stale: ${status.refreshWarning.message}`,
        scope,
        severity: "warning",
        suggestedCommands: ["arashi status", `git -C ${status.path} fetch`],
      }),
    );
  }

  const configuredBaseMatchesDefault = Boolean(
    status.baseBranch?.compareRef &&
    status.defaultBranch?.compareRef &&
    status.baseBranch.compareRef === status.defaultBranch.compareRef,
  );
  if (status.baseBranch?.state === "available" && status.baseBranch.behind > ZERO) {
    const baseRef = status.baseBranch.remoteRef ?? status.baseBranch.branch;
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_CONFIGURED_BASE_BEHIND",
        details: {
          ahead: status.baseBranch.ahead,
          alsoDefault: configuredBaseMatchesDefault,
          baseBranch: status.baseBranch.branch,
          behind: status.baseBranch.behind,
          compareRef: status.baseBranch.compareRef ?? null,
          currentBranch: status.branch.localBranch,
          remote: status.baseBranch.remote ?? null,
          remoteRef: status.baseBranch.remoteRef ?? null,
          repository: status.name,
          source: status.baseBranchSource ?? null,
        },
        message: `Repository '${status.name}' is behind configured base ${baseRef} by ${status.baseBranch.behind} commit(s).`,
        scope,
        severity: "warning",
        suggestedCommands: ["arashi status --verbose", "arashi pull"],
      }),
    );
  } else if (status.baseBranch?.state === "unavailable") {
    const baseRef = status.baseBranch.remoteRef ?? status.baseBranch.branch;
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_CONFIGURED_BASE_UNAVAILABLE",
        details: {
          alsoDefault: configuredBaseMatchesDefault,
          baseBranch: status.baseBranch.branch,
          compareRef: status.baseBranch.compareRef ?? null,
          failure: status.baseBranch.details,
          message: status.baseBranch.message,
          reason: status.baseBranch.reason,
          remote: status.baseBranch.remote ?? null,
          remoteRef: status.baseBranch.remoteRef ?? null,
          repository: status.name,
          source: status.baseBranchSource ?? null,
        },
        message: `Could not compare '${status.name}' with configured base ${baseRef}: ${status.baseBranch.message}`,
        scope,
        severity: "warning",
        suggestedCommands: ["arashi status --verbose", "arashi pull"],
      }),
    );
  }

  if (
    !configuredBaseMatchesDefault &&
    status.defaultBranch?.state === "available" &&
    status.defaultBranch.behind > ZERO
  ) {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_DEFAULT_BRANCH_BEHIND",
        details: {
          behind: status.defaultBranch.behind,
          defaultBranch: status.defaultBranch.branch,
          repository: status.name,
        },
        message: `Repository '${status.name}' is behind default branch ${status.defaultBranch.branch} by ${status.defaultBranch.behind} commit(s).`,
        scope,
        severity: "warning",
        suggestedCommands: [
          "arashi status",
          `git -C ${status.path} merge ${status.defaultBranch.branch}`,
        ],
      }),
    );
  } else if (!configuredBaseMatchesDefault && status.defaultBranch?.state === "unavailable") {
    findings.push(
      createFinding({
        category: "repository",
        code: "REPOSITORY_DEFAULT_BRANCH_UNAVAILABLE",
        details: {
          defaultBranch: status.defaultBranch.branch,
          message: status.defaultBranch.message,
          repository: status.name,
        },
        message: `Could not compare '${status.name}' with its default branch.`,
        scope,
        severity: "info",
        suggestedCommands: ["arashi status", `git -C ${status.path} fetch`],
      }),
    );
  }

  return findings;
};

const collectRepositoryFindings = async (
  workspaceRoot: string,
  config: Config,
): Promise<DoctorFinding[]> => {
  const includeWorkspaceRoot = await shouldIncludeWorkspaceRootInRepositoryChecks(workspaceRoot);
  const statuses = await checkAllRepos(workspaceRoot, config, false, includeWorkspaceRoot);
  const findings = await Promise.all(
    statuses.map(async (status) => {
      let upstreamInspection: UpstreamTrackingInspection = { kind: "not-applicable" };
      if (
        !status.error &&
        !status.branch.isDetached &&
        status.refreshWarning?.kind !== "missing-remote-ref" &&
        (!status.branch.remoteBranch || Boolean(status.refreshWarning))
      ) {
        upstreamInspection = await inspectUpstreamTrackingConfiguration(status.path);
      }
      return repositoryStatusToDoctorFindings(status, upstreamInspection);
    }),
  );
  return findings.flat();
};

const collectWorktreeFindings = async (
  workspaceRoot: string,
  config: Config,
): Promise<DoctorFinding[]> => {
  const results = await discoverPrunableWorktrees(createRepositoryTargets(workspaceRoot, config));
  return results.flatMap((repo) => {
    if (repo.status === "failed") {
      return [
        createFinding({
          category: "worktree",
          code: "WORKTREE_DISCOVERY_FAILED",
          details: { error: repo.error, path: repo.path, repository: repo.name },
          message: `Could not inspect worktree metadata for '${repo.name}': ${repo.error ?? "unknown error"}`,
          scope: `repository:${repo.name}`,
          severity: "error",
          suggestedCommands: [`git -C ${repo.path} worktree list --porcelain`],
        }),
      ];
    }

    return repo.prunable.map((worktree) =>
      createFinding({
        category: "worktree",
        code: "WORKTREE_STALE_METADATA",
        details: {
          path: worktree.path,
          pruneReason: worktree.pruneReason,
          repository: repo.name,
        },
        message: `Repository '${repo.name}' has stale worktree metadata for ${worktree.path}.`,
        scope: `repository:${repo.name}`,
        severity: "warning",
        suggestedCommands: ["arashi prune --dry-run", "arashi prune"],
      }),
    );
  });
};

const normalizeHookFileName = (name: string): string =>
  process.platform === "win32" ? name.toLowerCase() : name;

const allowedHookFileNames = (
  repoNames: string[],
  includeQualifiedRemove: boolean,
): Set<string> => {
  const extensions = lifecycleHookExtensions();
  const names = new Set<string>(
    Object.values(GLOBAL_HOOKS).flatMap((hookName) =>
      extensions.map((extension) => normalizeHookFileName(`${hookName}${extension}`)),
    ),
  );
  for (const repoName of repoNames) {
    for (const extension of extensions) {
      names.add(
        normalizeHookFileName(`${getRepoSpecificHookName("pre-create", repoName)}${extension}`),
      );
      names.add(
        normalizeHookFileName(`${getRepoSpecificHookName("post-create", repoName)}${extension}`),
      );
      if (includeQualifiedRemove) {
        names.add(normalizeHookFileName(`pre-remove.${repoName}${extension}`));
        names.add(normalizeHookFileName(`post-remove.${repoName}${extension}`));
      }
    }
  }
  return names;
};

const scanHookDirectoryForUnsupportedFiles = async (
  hookDir: string,
  scope: string,
  repoNames: string[],
): Promise<DoctorFinding[]> => {
  try {
    const entries = await readdir(hookDir, { withFileTypes: true });
    const allowed = allowedHookFileNames(repoNames, scope === "workspace");
    const findings: DoctorFinding[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.name.endsWith(".example")) {
        continue;
      }
      const hookFile = join(hookDir, entry.name);
      const entryName = normalizeHookFileName(entry.name);
      if (!allowed.has(entryName)) {
        findings.push(
          createFinding({
            category: "hook",
            code: "HOOK_UNSUPPORTED_DEFINITION",
            details: { hookFile, scope },
            message: `Unsupported hook definition '${entry.name}' found in ${hookDir}.`,
            scope: `hook:${scope}`,
            severity: "error",
            suggestedCommands: ["arashi init --help"],
          }),
        );
        continue;
      }
      if (entry.isSymbolicLink()) {
        const validation = await validateHook(hookFile);
        if (!validation.valid) {
          findings.push(
            createFinding({
              category: "hook",
              code: "HOOK_MISSING",
              details: { error: validation.error, hookFile, scope },
              message: `Configured hook '${entry.name}' could not be resolved at ${hookFile}.`,
              scope: `hook:${scope}:${entry.name}`,
              severity: "warning",
              suggestedCommands: ["arashi init --help"],
            }),
          );
        }
      }
    }
    return findings;
  } catch {
    return [];
  }
};

const collectInlineHookFindings = async (
  configurationRoot: string,
  executionRoot: string,
  config: Config,
): Promise<DoctorFinding[]> => {
  const findings: DoctorFinding[] = [];
  const repoNames = Object.keys(config.repos);
  const inspect = async (options: {
    executionPath: string;
    filePaths: readonly string[];
    interpreters?: Partial<Record<"bash" | "cmd" | "powershell", string>>;
    lifecycle: "post-create" | "post-remove" | "pre-create" | "pre-remove";
    ownerKind: "repository" | "workspace";
    ownerName: string | null;
  }): Promise<void> => {
    const candidates: LifecycleHookPreparationCandidate[] = [
      ...options.filePaths.map(
        (sourceScriptPath): LifecycleHookPreparationCandidate => ({
          kind: "file",
          source: {
            executionPath: options.executionPath,
            lifecycle: options.lifecycle,
            scope: options.ownerKind,
            sourceKind: "file",
            sourceOwnerKind: options.ownerKind,
            sourceOwnerName: options.ownerName,
            sourceScriptPath,
          },
        }),
      ),
      ...(options.interpreters
        ? [
            {
              interpreters: options.interpreters,
              kind: "inline-config" as const,
              source: {
                executionPath: options.executionPath,
                lifecycle: options.lifecycle,
                scope: options.ownerKind,
                sourceKind: "inline-config" as const,
                sourceOwnerKind: options.ownerKind,
                sourceOwnerName: options.ownerName,
                sourceScriptPath: null,
              },
            },
          ]
        : []),
    ];
    const repositoryName = options.ownerName ?? repoNames[ZERO] ?? basename(executionRoot);
    const repositoryPath = options.ownerName
      ? resolve(executionRoot, config.repos[options.ownerName]?.path ?? ".")
      : executionRoot;
    const preparation = await prepareLifecycleHookSources({
      candidates,
      consumer: "doctor",
      env: process.env,
      platform: process.platform,
      targets: [{ branchName: "", repositoryName, repositoryPath, worktreePath: repositoryPath }],
      workspaceRoot: executionRoot,
    });
    const findingScope = `hook:${options.ownerKind}:${options.ownerName ?? "workspace"}:${options.lifecycle}`;
    if (preparation.classification === "ambiguous") {
      const failure = preparation.plan.failure;
      findings.push(
        createFinding({
          category: "hook",
          code: "HOOK_AMBIGUOUS",
          details: {
            hookName: failure.hookName,
            scope: failure.scope,
            sourceKinds: failure.sourceKinds,
            sourceOwnerKind: failure.sourceOwnerKind,
            sourceOwnerName: failure.sourceOwnerName,
            sourceScriptPath: failure.sourceScriptPath,
            sourceScriptPaths: failure.sourceScriptPaths,
          },
          message: `Hook source is ambiguous for ${failure.hookName}.`,
          scope: findingScope,
          severity: "error",
          suggestedCommands: ["Remove all but one hook source at this logical location"],
        }),
      );
      return;
    }
    if (preparation.classification === "interpreter-unavailable") {
      findings.push(
        createFinding({
          category: "hook",
          code: "HOOK_INTERPRETER_UNAVAILABLE",
          details: {
            configuredInterpreterKeys: Object.keys(options.interpreters ?? {}).toSorted(),
            hookName: options.lifecycle,
            scope: options.ownerKind,
            sourceKind: "inline-config",
            sourceOwnerKind: options.ownerKind,
            sourceOwnerName: options.ownerName,
            sourceScriptPath: null,
          },
          message: `No configured interpreter is available for ${options.lifecycle}.`,
          scope: findingScope,
          severity: "error",
          suggestedCommands: [
            "Install one configured interpreter or update the hook configuration",
          ],
        }),
      );
      return;
    }
    if (preparation.classification === "ready" && options.interpreters) {
      findings.push(
        createFinding({
          category: "hook",
          code: "HOOK_CONFIGURED",
          details: {
            hookName: options.lifecycle,
            scope: options.ownerKind,
            sourceKind: "inline-config",
            sourceOwnerKind: options.ownerKind,
            sourceOwnerName: options.ownerName,
            sourceScriptPath: null,
          },
          message: `Configured inline hook '${options.lifecycle}' is available.`,
          scope: findingScope,
          severity: "info",
          suggestedCommands: [],
        }),
      );
    }
  };

  for (const lifecycle of ["pre-create", "post-create"] as const) {
    const workspaceInline = config.hooks?.scripts?.[lifecycle];
    if (workspaceInline) {
      await inspect({
        executionPath: executionRoot,
        filePaths: await discoverLifecycleHookCandidates(lifecycle, configurationRoot),
        interpreters:
          typeof workspaceInline === "string" ? { bash: workspaceInline } : workspaceInline,
        lifecycle,
        ownerKind: "workspace",
        ownerName: null,
      });
    }
    for (const [repository, repositoryConfig] of Object.entries(config.repos)) {
      const inline = repositoryConfig.hooks?.[lifecycle];
      if (!inline) continue;
      await inspect({
        executionPath: resolve(executionRoot, repositoryConfig.path),
        filePaths: await discoverLifecycleHookCandidates(
          getRepoSpecificHookName(lifecycle, repository),
          configurationRoot,
        ),
        interpreters: typeof inline === "string" ? { bash: inline } : inline,
        lifecycle,
        ownerKind: "repository",
        ownerName: repository,
      });
    }
  }
  for (const lifecycle of ["pre-remove", "post-remove"] as const) {
    const workspaceInline = config.hooks?.scripts?.[lifecycle];
    if (workspaceInline) {
      await inspect({
        executionPath: executionRoot,
        filePaths: await discoverLifecycleHookCandidatesInDirectory(
          lifecycle,
          join(configurationRoot, ".arashi", "hooks"),
        ),
        interpreters:
          typeof workspaceInline === "string" ? { bash: workspaceInline } : workspaceInline,
        lifecycle,
        ownerKind: "workspace",
        ownerName: null,
      });
    }
    for (const [repository, repositoryConfig] of Object.entries(config.repos)) {
      const inline = repositoryConfig.hooks?.[lifecycle];
      const repositoryPath = resolve(executionRoot, repositoryConfig.path);
      const filePaths = await discoverConfiguredRepositoryRemoveHookCandidates({
        activeRepositoryPath: repositoryPath,
        configurationRoot,
        lifecycle,
        repositoryName: repository,
      });
      if (!inline && filePaths.length < 2) continue;
      await inspect({
        executionPath: repositoryPath,
        filePaths,
        ...(inline ? { interpreters: typeof inline === "string" ? { bash: inline } : inline } : {}),
        lifecycle,
        ownerKind: "repository",
        ownerName: repository,
      });
    }
  }
  return findings;
};

const collectHookFindings = async (
  configurationRoot: string,
  executionRoot: string,
  config: Config,
): Promise<DoctorFinding[]> => {
  const targetRepositories = createRepositoryTargets(executionRoot, config);
  const repoNames = [...new Set(targetRepositories.map((repository) => repository.name))];
  const findings: DoctorFinding[] = await collectInlineHookFindings(
    configurationRoot,
    executionRoot,
    config,
  );
  const hookNames = [GLOBAL_HOOKS.preRemove, GLOBAL_HOOKS.postRemove];

  for (const hookName of hookNames) {
    let resolvedHooks;
    try {
      resolvedHooks = await resolveScopedLifecycleHooks({
        hookName,
        targetRepositories,
        workspaceRoot: configurationRoot,
      });
    } catch (error) {
      const alreadyReported = findings.some(
        (finding) => finding.code === "HOOK_AMBIGUOUS" && finding.details?.hookName === hookName,
      );
      if (alreadyReported) continue;
      findings.push(
        createFinding({
          category: "hook",
          code: "HOOK_AMBIGUOUS",
          details: { error: error instanceof Error ? error.message : String(error), hookName },
          message: error instanceof Error ? error.message : String(error),
          scope: `hook:remove:${hookName}`,
          severity: "error",
          suggestedCommands: ["Remove all but one platform-native hook candidate"],
        }),
      );
      continue;
    }
    for (const hook of resolvedHooks) {
      const validation = await validateHook(hook.scriptPath);
      if (validation.valid) {
        continue;
      }
      const permissionIssue = validation.error?.includes("not executable") === true;
      const interpreterIssue = validation.reasonCode === "interpreter_unavailable";
      findings.push(
        createFinding({
          category: "hook",
          code: permissionIssue
            ? "HOOK_NOT_EXECUTABLE"
            : interpreterIssue
              ? "HOOK_INTERPRETER_UNAVAILABLE"
              : "HOOK_INVALID",
          details: {
            error: validation.error,
            hookName: hook.hookName,
            path: hook.scriptPath,
            repository: hook.targetRepositoryName,
            scope: hook.scope,
          },
          message: `Hook '${hook.hookName}' for '${hook.targetRepositoryName}' is invalid: ${validation.error ?? "unknown error"}`,
          scope: `hook:${hook.scope}:${hook.targetRepositoryName}:${hook.hookName}`,
          severity: permissionIssue ? "warning" : "error",
          suggestedCommands: permissionIssue
            ? [`chmod +x ${hook.scriptPath}`]
            : ["arashi init --help"],
        }),
      );
    }
  }

  const configuredCreateLocations = [
    { hookName: GLOBAL_HOOKS.preCreate, repository: "workspace", scope: "workspace" },
    ...repoNames.flatMap((repository) => [
      {
        hookName: getRepoSpecificHookName("pre-create", repository),
        repository,
        scope: "repository",
      },
      {
        hookName: getRepoSpecificHookName("post-create", repository),
        repository,
        scope: "repository",
      },
    ]),
    { hookName: GLOBAL_HOOKS.postCreate, repository: "workspace", scope: "workspace" },
  ];
  for (const location of configuredCreateLocations) {
    let hookPath: string | null = null;
    try {
      hookPath = await discoverLifecycleHook(location.hookName, configurationRoot);
    } catch (error) {
      findings.push(
        createFinding({
          category: "hook",
          code: "HOOK_AMBIGUOUS",
          details: {
            error: error instanceof Error ? error.message : String(error),
            hookName: location.hookName,
            repository: location.repository,
            scope: location.scope,
          },
          message: error instanceof Error ? error.message : String(error),
          scope: `hook:${location.scope}:${location.repository}:${location.hookName}`,
          severity: "error",
          suggestedCommands: ["Remove all but one platform-native hook candidate"],
        }),
      );
      continue;
    }
    if (!hookPath) continue;
    const validation = await validateHook(hookPath);
    if (validation.valid) continue;
    const permissionIssue = validation.error?.includes("not executable") === true;
    const interpreterIssue = validation.reasonCode === "interpreter_unavailable";
    findings.push(
      createFinding({
        category: "hook",
        code: permissionIssue
          ? "HOOK_NOT_EXECUTABLE"
          : interpreterIssue
            ? "HOOK_INTERPRETER_UNAVAILABLE"
            : "HOOK_INVALID",
        details: {
          error: validation.error,
          hookName: location.hookName,
          path: hookPath,
          repository: location.repository,
          scope: location.scope,
        },
        message: `Hook '${location.hookName}' for '${location.repository}' is invalid: ${validation.error ?? "unknown error"}`,
        scope: `hook:${location.scope}:${location.repository}:${location.hookName}`,
        severity: permissionIssue ? "warning" : "error",
        suggestedCommands: permissionIssue ? [`chmod +x ${hookPath}`] : ["arashi init --help"],
      }),
    );
  }

  findings.push(
    ...(await scanHookDirectoryForUnsupportedFiles(
      join(configurationRoot, ".arashi", "hooks"),
      "workspace",
      repoNames,
    )),
  );
  for (const target of targetRepositories.filter((target) => target.path !== executionRoot)) {
    findings.push(
      ...(await scanHookDirectoryForUnsupportedFiles(
        join(target.path, ".arashi", "hooks"),
        `repository:${target.name}`,
        repoNames,
      )),
    );
  }

  return findings;
};

const collectShellAndInstallHints = (): DoctorFinding[] => [];

export const runDoctor = async (): Promise<DoctorResult> => {
  const findings: DoctorFinding[] = [];
  let workspaceRoot: string | null = null;
  let workspaceRoots: WorkspaceRepositoryRoots;

  try {
    workspaceRoots = await findConfiguredWorkspaceRoots("doctor");
  } catch (error) {
    findings.push(
      createFinding({
        category: "workspace",
        code: "DOCTOR_NOT_IN_WORKSPACE",
        details: { error: error instanceof Error ? error.message : String(error) },
        message: "No Arashi workspace was found from the current directory.",
        scope: "workspace",
        severity: "error",
        suggestedCommands: ["arashi init", "cd <arashi-workspace>"],
      }),
    );
    return {
      checkedCategories: ["workspace"],
      findings,
      summary: summarizeDoctorFindings(findings),
      workspaceRoot,
    };
  }

  const { configurationRoot, executionRoot } = workspaceRoots;
  workspaceRoot = configurationRoot;

  let config: Config | undefined = undefined;
  let materializationRepositories: Awaited<
    ReturnType<typeof loadWorkspaceRepositories>
  >["repositories"] = [];
  try {
    ({ config, repositories: materializationRepositories } = await loadWorkspaceRepositories(
      workspaceRoots,
      {
        allowUnavailableMaterializationSource: true,
      },
    ));
  } catch (error) {
    findings.push(
      createFinding({
        category: "configuration",
        code: "CONFIG_LOAD_FAILED",
        details: {
          configPath: getConfigPath(configurationRoot),
          error: error instanceof Error ? error.message : String(error),
        },
        message: `Failed to load Arashi configuration: ${error instanceof Error ? error.message : String(error)}`,
        scope: "configuration:.arashi/config.json",
        severity: "error",
        suggestedCommands: ["arashi init", `cat ${getConfigPath(configurationRoot)}`],
      }),
    );
    return {
      checkedCategories: ["workspace", "configuration"],
      findings,
      summary: summarizeDoctorFindings(findings),
      workspaceRoot,
    };
  }

  const phaseResults = await Promise.allSettled([
    collectManagedIgnoreFindings(configurationRoot, config),
    collectRepositoryFindings(executionRoot, config),
    collectWorktreeFindings(executionRoot, config),
    collectHookFindings(configurationRoot, executionRoot, config),
    collectMaterializationDiagnostics(
      materializationRepositories,
      configurationRoot,
      config.worktreesDir,
    ).then((diagnostics) =>
      diagnostics.flatMap((diagnostic) => materializationToDoctorFindings(diagnostic)),
    ),
  ]);

  for (const phaseResult of phaseResults) {
    if (phaseResult.status === "fulfilled") {
      findings.push(...phaseResult.value);
    } else {
      findings.push(
        createFinding({
          category: "workspace",
          code: "DOCTOR_PHASE_FAILED",
          details: {
            error:
              phaseResult.reason instanceof Error
                ? phaseResult.reason.message
                : String(phaseResult.reason),
          },
          message: `A doctor diagnostic phase failed: ${phaseResult.reason instanceof Error ? phaseResult.reason.message : String(phaseResult.reason)}`,
          scope: "workspace",
          severity: "error",
          suggestedCommands: ["arashi status --verbose", "arashi prune --dry-run"],
        }),
      );
    }
  }

  findings.push(...collectShellAndInstallHints());

  return {
    checkedCategories: ALL_CHECKED_CATEGORIES,
    findings,
    summary: summarizeDoctorFindings(findings),
    workspaceRoot,
  };
};
