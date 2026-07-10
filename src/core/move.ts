/**
 * Core helpers for moving uncommitted changes between coordinated worktrees.
 */

import { basename, isAbsolute, resolve } from "path";
import { existsSync, realpathSync } from "fs";
import { exec } from "../lib/git.ts";

export interface RepositoryTarget {
  name: string;
  path: string;
}

export interface DirtyDetails {
  modifiedFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  deletedFiles: number;
  totalFiles: number;
  summary: string;
}

export interface WorkspaceRepository {
  repositoryName: string;
  path: string;
  branch: string | null;
  isMain: boolean;
  dirty: boolean;
  dirtyDetails: DirtyDetails;
}

export interface WorkspaceSelection {
  label: string;
  ref: string;
  primaryPath: string;
  branch: string | null;
  repositories: WorkspaceRepository[];
  dirtyRepositories: WorkspaceRepository[];
}

export interface MovePlanItem {
  repositoryName: string;
  sourcePath: string;
  targetPath: string;
  dirtyDetails: DirtyDetails;
}

export type MoveRepositoryStatus = "moved" | "skipped" | "failed" | "restored" | "manual-recovery";

export interface MoveRepositoryResult {
  repositoryName: string;
  sourcePath?: string;
  targetPath?: string;
  status: MoveRepositoryStatus;
  message: string;
  stashRef?: string;
  recoveryCommand?: string;
}

export interface MovePlan {
  source: WorkspaceSelection;
  target: WorkspaceSelection;
  items: MovePlanItem[];
  skipped: MoveRepositoryResult[];
}

export interface MoveSummary {
  source: Pick<WorkspaceSelection, "label" | "primaryPath" | "branch">;
  target: Pick<WorkspaceSelection, "label" | "primaryPath" | "branch">;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  results: MoveRepositoryResult[];
}

export class MovePlanningError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MovePlanningError";
  }
}

const ZERO = 0;

const normalizePath = (pathInput: string): string => {
  try {
    return realpathSync.native(pathInput).replaceAll("\\", "/");
  } catch {
    return resolve(pathInput).replaceAll("\\", "/");
  }
};

const toComparablePath = (pathInput: string): string => normalizePath(pathInput).toLowerCase();

const parseWorktreeList = (
  output: string,
  repositoryName: string,
  repositoryPath: string,
): WorkspaceRepository[] => {
  const worktrees: WorkspaceRepository[] = [];
  const lines = output.trim().split("\n");
  let current: Partial<WorkspaceRepository> = {};
  let isBare = false;
  const canonicalRepositoryPath = toComparablePath(repositoryPath);

  const pushCurrent = () => {
    if (!current.path || isBare) {
      return;
    }
    worktrees.push({
      branch: current.branch ?? null,
      dirty: false,
      dirtyDetails: emptyDirtyDetails(),
      isMain: toComparablePath(current.path) === canonicalRepositoryPath,
      path: current.path,
      repositoryName,
    });
  };

  for (const line of lines) {
    if (line === "") {
      pushCurrent();
      current = {};
      isBare = false;
    } else if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line === "bare") {
      isBare = true;
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line.startsWith("detached")) {
      current.branch = null;
    }
  }

  pushCurrent();
  return worktrees;
};

export const emptyDirtyDetails = (): DirtyDetails => ({
  deletedFiles: ZERO,
  modifiedFiles: ZERO,
  stagedFiles: ZERO,
  summary: "clean",
  totalFiles: ZERO,
  untrackedFiles: ZERO,
});

const summarizeDirtyDetails = (details: Omit<DirtyDetails, "summary">): string => {
  const parts: string[] = [];
  if (details.stagedFiles > ZERO) {
    parts.push(`${details.stagedFiles} staged`);
  }
  if (details.modifiedFiles > ZERO) {
    parts.push(`${details.modifiedFiles} modified`);
  }
  if (details.deletedFiles > ZERO) {
    parts.push(`${details.deletedFiles} deleted`);
  }
  if (details.untrackedFiles > ZERO) {
    parts.push(`${details.untrackedFiles} untracked`);
  }
  return parts.length > ZERO ? parts.join(", ") : "clean";
};

export const getDirtyDetails = async (path: string): Promise<DirtyDetails> => {
  if (!existsSync(path)) {
    return emptyDirtyDetails();
  }

  const result = await exec(["status", "--porcelain=v1", "-uall"], path);
  const lines = result.stdout.split("\n").filter((line) => line.trim().length > ZERO);
  const counts = {
    deletedFiles: ZERO,
    modifiedFiles: ZERO,
    stagedFiles: ZERO,
    totalFiles: lines.length,
    untrackedFiles: ZERO,
  };

  for (const line of lines) {
    const indexStatus = line[0] ?? " ";
    const worktreeStatus = line[1] ?? " ";
    if (line.startsWith("??")) {
      counts.untrackedFiles += 1;
      continue;
    }
    if (indexStatus !== " " && indexStatus !== "?") {
      counts.stagedFiles += 1;
    }
    if (indexStatus === "D" || worktreeStatus === "D") {
      counts.deletedFiles += 1;
    }
    if (worktreeStatus !== " " || (indexStatus !== " " && indexStatus !== "D")) {
      counts.modifiedFiles += 1;
    }
  }

  return {
    ...counts,
    summary: summarizeDirtyDetails(counts),
  };
};

export const buildRepositoryTargets = (
  workspaceRoot: string,
  repos: Record<string, { path: string }>,
): RepositoryTarget[] => {
  const targets: RepositoryTarget[] = [{ name: basename(workspaceRoot), path: workspaceRoot }];
  for (const [name, repo] of Object.entries(repos)) {
    targets.push({ name, path: resolve(workspaceRoot, repo.path) });
  }
  return targets;
};

export const discoverWorkspaces = async (
  repositories: RepositoryTarget[],
): Promise<WorkspaceSelection[]> => {
  const byKey = new Map<string, WorkspaceSelection>();

  for (const repository of repositories) {
    let worktrees: WorkspaceRepository[] = [];
    try {
      const result = await exec(["worktree", "list", "--porcelain"], repository.path);
      worktrees = parseWorktreeList(result.stdout, repository.name, repository.path);
    } catch {
      continue;
    }

    for (const worktree of worktrees) {
      const dirtyDetails = await getDirtyDetails(worktree.path);
      const enriched = {
        ...worktree,
        dirty: dirtyDetails.totalFiles > ZERO,
        dirtyDetails,
      };
      const key = enriched.branch
        ? `branch:${enriched.branch}`
        : `path:${normalizePath(enriched.path)}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.repositories.push(enriched);
        if (enriched.dirty) {
          existing.dirtyRepositories.push(enriched);
        }
        if (enriched.isMain) {
          existing.primaryPath = enriched.path;
        }
      } else {
        byKey.set(key, {
          branch: enriched.branch,
          dirtyRepositories: enriched.dirty ? [enriched] : [],
          label: enriched.branch ?? basename(enriched.path),
          primaryPath: enriched.path,
          ref: enriched.branch ?? enriched.path,
          repositories: [enriched],
        });
      }
    }
  }

  return [...byKey.values()].toSorted((left, right) => left.label.localeCompare(right.label));
};

export const findWorkspaceByPath = async (
  repositories: RepositoryTarget[],
  path: string,
): Promise<WorkspaceSelection | null> => {
  const comparablePath = toComparablePath(path);
  const workspaces = await discoverWorkspaces(repositories);
  return (
    workspaces.find((workspace) =>
      workspace.repositories.some(
        (repository) => toComparablePath(repository.path) === comparablePath,
      ),
    ) ?? null
  );
};

export const resolveWorkspaceReference = async (
  repositories: RepositoryTarget[],
  ref: string,
): Promise<WorkspaceSelection> => {
  const workspaces = await discoverWorkspaces(repositories);
  const comparableRef = isAbsolute(ref) ? toComparablePath(ref) : null;
  const matches = workspaces.filter((workspace) => {
    if (
      workspace.branch === ref ||
      workspace.label === ref ||
      basename(workspace.primaryPath) === ref
    ) {
      return true;
    }
    return comparableRef
      ? workspace.repositories.some(
          (repository) => toComparablePath(repository.path) === comparableRef,
        )
      : false;
  });

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new MovePlanningError(`Workspace reference is ambiguous: ${ref}`, "AMBIGUOUS_WORKSPACE", {
      matches: matches.map((match) => ({ branch: match.branch, path: match.primaryPath })),
      ref,
    });
  }
  throw new MovePlanningError(`Workspace not found: ${ref}`, "WORKSPACE_NOT_FOUND", { ref });
};

export const buildMovePlan = (source: WorkspaceSelection, target: WorkspaceSelection): MovePlan => {
  if (toComparablePath(source.primaryPath) === toComparablePath(target.primaryPath)) {
    throw new MovePlanningError("Source and target workspaces are the same", "SAME_WORKSPACE", {
      source: source.primaryPath,
      target: target.primaryPath,
    });
  }

  const targetByRepository = new Map(
    target.repositories.map((repository) => [repository.repositoryName, repository]),
  );
  const skipped: MoveRepositoryResult[] = [];
  const items: MovePlanItem[] = [];

  for (const sourceRepository of source.repositories) {
    if (!sourceRepository.dirty) {
      skipped.push({
        message: "Source repository is clean",
        repositoryName: sourceRepository.repositoryName,
        sourcePath: sourceRepository.path,
        status: "skipped",
      });
      continue;
    }

    const targetRepository = targetByRepository.get(sourceRepository.repositoryName);
    if (!targetRepository) {
      skipped.push({
        message: "Target workspace does not contain this repository",
        repositoryName: sourceRepository.repositoryName,
        sourcePath: sourceRepository.path,
        status: "skipped",
      });
      continue;
    }

    if (targetRepository.dirty) {
      throw new MovePlanningError(
        `Target repository has uncommitted changes: ${targetRepository.repositoryName}`,
        "DIRTY_TARGET_REPOSITORY",
        {
          repositoryName: targetRepository.repositoryName,
          targetPath: targetRepository.path,
        },
      );
    }

    items.push({
      dirtyDetails: sourceRepository.dirtyDetails,
      repositoryName: sourceRepository.repositoryName,
      sourcePath: sourceRepository.path,
      targetPath: targetRepository.path,
    });
  }

  if (items.length === ZERO) {
    throw new MovePlanningError(
      "No compatible changed repositories were found to move",
      "NO_COMPATIBLE_CHANGES",
      { skipped },
    );
  }

  return { items, skipped, source, target };
};

const makeStashMessage = (repositoryName: string): string =>
  `arashi-move:${repositoryName}:${Date.now()}`;

const getLatestStashRef = async (repositoryPath: string): Promise<string> => {
  const result = await exec(["stash", "list", "--format=%gd", "-n", "1"], repositoryPath);
  return result.stdout.trim() || "stash@{0}";
};

export const executeMovePlan = async (plan: MovePlan): Promise<MoveSummary> => {
  const results: MoveRepositoryResult[] = [];

  for (const item of plan.items) {
    let stashRef: string | undefined = undefined;
    try {
      await exec(
        ["stash", "push", "--include-untracked", "-m", makeStashMessage(item.repositoryName)],
        item.sourcePath,
      );
      stashRef = await getLatestStashRef(item.sourcePath);
      await exec(["stash", "apply", "--index", stashRef], item.targetPath);
      await exec(["stash", "drop", stashRef], item.sourcePath);
      results.push({
        message: `Moved ${item.dirtyDetails.summary}`,
        repositoryName: item.repositoryName,
        sourcePath: item.sourcePath,
        status: "moved",
        targetPath: item.targetPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (stashRef) {
        try {
          await exec(["stash", "apply", "--index", stashRef], item.sourcePath);
          results.push({
            message: `Target apply failed; source changes were restored. ${message}`,
            recoveryCommand: `git -C ${JSON.stringify(item.sourcePath)} stash apply --index ${stashRef}`,
            repositoryName: item.repositoryName,
            sourcePath: item.sourcePath,
            stashRef,
            status: "restored",
            targetPath: item.targetPath,
          });
        } catch {
          results.push({
            message: `Move failed; recovery stash was preserved. ${message}`,
            recoveryCommand: `git -C ${JSON.stringify(item.sourcePath)} stash apply --index ${stashRef}`,
            repositoryName: item.repositoryName,
            sourcePath: item.sourcePath,
            stashRef,
            status: "manual-recovery",
            targetPath: item.targetPath,
          });
        }
      } else {
        results.push({
          message,
          repositoryName: item.repositoryName,
          sourcePath: item.sourcePath,
          status: "failed",
          targetPath: item.targetPath,
        });
      }
    }
  }

  results.push(...plan.skipped);

  return {
    failedCount: results.filter((result) =>
      ["failed", "manual-recovery", "restored"].includes(result.status),
    ).length,
    movedCount: results.filter((result) => result.status === "moved").length,
    results,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    source: {
      branch: plan.source.branch,
      label: plan.source.label,
      primaryPath: plan.source.primaryPath,
    },
    target: {
      branch: plan.target.branch,
      label: plan.target.label,
      primaryPath: plan.target.primaryPath,
    },
  };
};

export const buildDirtyGuidance = (
  source: WorkspaceSelection,
  target: WorkspaceSelection,
): null | {
  changedRepositories: { repositoryName: string; path: string; summary: string }[];
  command: string;
  target: string;
} => {
  const targetRepoNames = new Set(
    target.repositories.map((repository) => repository.repositoryName),
  );
  const changedRepositories = source.dirtyRepositories
    .filter((repository) => targetRepoNames.has(repository.repositoryName))
    .map((repository) => ({
      path: repository.path,
      repositoryName: repository.repositoryName,
      summary: repository.dirtyDetails.summary,
    }));

  if (changedRepositories.length === ZERO) {
    return null;
  }

  const targetRef = target.branch ?? target.primaryPath;
  return {
    changedRepositories,
    command: `arashi move --to ${targetRef}`,
    target: targetRef,
  };
};
