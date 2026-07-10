import {
  GLOBAL_HOOKS,
  getRepoSpecificHookName,
  resolveScopedLifecycleHooks,
  validateHook,
} from "./hooks.ts";
import { basename, join, resolve } from "path";
import { checkAllRepos, isMissingRepositoryStatus } from "../commands/status.ts";
import { findWorkspaceRoot, getConfigPath, loadConfig } from "./config.ts";
import { discoverPrunableWorktrees } from "../core/remove.ts";
import { readdir } from "fs/promises";

const ZERO = 0;

type Config = Awaited<ReturnType<typeof loadConfig>>;
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

export const repositoryStatusToDoctorFindings = (status: RepoStatus): DoctorFinding[] => {
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

  if (status.defaultBranch?.state === "available" && status.defaultBranch.behind > ZERO) {
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
  } else if (status.defaultBranch?.state === "unavailable") {
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
  const statuses = await checkAllRepos(workspaceRoot, config, false);
  return statuses.flatMap((status) => repositoryStatusToDoctorFindings(status));
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

const allowedHookFileNames = (repoNames: string[]): Set<string> => {
  const names = new Set<string>(Object.values(GLOBAL_HOOKS).map((hookName) => `${hookName}.sh`));
  for (const repoName of repoNames) {
    names.add(`${getRepoSpecificHookName("pre-create", repoName)}.sh`);
    names.add(`${getRepoSpecificHookName("post-create", repoName)}.sh`);
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
    const allowed = allowedHookFileNames(repoNames);
    const findings: DoctorFinding[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.name.endsWith(".example")) {
        continue;
      }
      const hookFile = join(hookDir, entry.name);
      if (!allowed.has(entry.name)) {
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

const collectHookFindings = async (
  workspaceRoot: string,
  config: Config,
): Promise<DoctorFinding[]> => {
  const targetRepositories = createRepositoryTargets(workspaceRoot, config);
  const repoNames = Object.keys(config.repos);
  const findings: DoctorFinding[] = [];
  const hookNames = Object.values(GLOBAL_HOOKS);

  for (const hookName of hookNames) {
    const resolvedHooks = await resolveScopedLifecycleHooks({
      hookName,
      targetRepositories,
      workspaceRoot,
    });
    for (const hook of resolvedHooks) {
      const validation = await validateHook(hook.scriptPath);
      if (validation.valid) {
        continue;
      }
      const permissionIssue = validation.error?.includes("not executable") === true;
      findings.push(
        createFinding({
          category: "hook",
          code: permissionIssue ? "HOOK_NOT_EXECUTABLE" : "HOOK_INVALID",
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

  findings.push(
    ...(await scanHookDirectoryForUnsupportedFiles(
      join(workspaceRoot, ".arashi", "hooks"),
      "workspace",
      repoNames,
    )),
  );
  for (const target of targetRepositories.filter((target) => target.path !== workspaceRoot)) {
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

  try {
    workspaceRoot = await findWorkspaceRoot();
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

  let config: Config | undefined = undefined;
  try {
    config = await loadConfig(workspaceRoot);
  } catch (error) {
    findings.push(
      createFinding({
        category: "configuration",
        code: "CONFIG_LOAD_FAILED",
        details: {
          configPath: getConfigPath(workspaceRoot),
          error: error instanceof Error ? error.message : String(error),
        },
        message: `Failed to load Arashi configuration: ${error instanceof Error ? error.message : String(error)}`,
        scope: "configuration:.arashi/config.json",
        severity: "error",
        suggestedCommands: ["arashi init", `cat ${getConfigPath(workspaceRoot)}`],
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
    collectRepositoryFindings(workspaceRoot, config),
    collectWorktreeFindings(workspaceRoot, config),
    collectHookFindings(workspaceRoot, config),
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
