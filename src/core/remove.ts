/**
 * Core helpers for remove command
 */

import type {
  RemovalOperation,
  RemovalSummary,
  WorktreeEntry,
  WorktreeGrouping,
  WorktreeInfo,
} from "../types/remove.ts";
import { ArashiError } from "../lib/errors.ts";
import { GitErrorCode } from "../types/git.ts";
import chalk from "chalk";
import { exec } from "../lib/git.ts";
import { realpathSync } from "fs";
import { resolve as resolvePath } from "path";
import { resolveWorktreeStatuses } from "./worktree.ts";

const ZERO = 0;
const ONE = 1;
const JSON_INDENT = 2;
const DETACHED_HEAD = "HEAD";

export interface RepositoryTarget {
  name: string;
  path: string;
}

export const parseWorktreeList = (
  output: string,
  repoName: string,
  repoPath: string,
): WorktreeInfo[] => {
  const worktrees: WorktreeInfo[] = [];
  const lines = output.trim().split("\n");
  let current: Partial<WorktreeInfo> = {};
  let isBare = false;
  let canonicalRepoPath = repoPath;

  try {
    canonicalRepoPath = realpathSync(repoPath);
  } catch {
    canonicalRepoPath = repoPath;
  }

  const pushCurrent = () => {
    if (!current.path || isBare) {
      return;
    }

    let canonicalWorktreePath = current.path;
    try {
      canonicalWorktreePath = realpathSync(current.path);
    } catch {
      canonicalWorktreePath = current.path;
    }

    const isMain = canonicalWorktreePath === canonicalRepoPath;
    worktrees.push({
      branch: current.branch || "",
      isMain,
      path: current.path,
      repository: repoName,
    });
  };

  for (const line of lines) {
    if (line === "") {
      pushCurrent();
      current = {};
      isBare = false;
    } else if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
      current.repository = repoName;
    } else if (line === "bare") {
      isBare = true;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace("refs/heads/", "");
    } else if (line.startsWith("detached")) {
      current.branch = "";
    }
  }

  pushCurrent();

  return worktrees;
};

export const discoverWorktreesByBranch = async (
  branchName: string,
  repositories: RepositoryTarget[],
): Promise<WorktreeInfo[]> => {
  const results: WorktreeInfo[] = [];

  for (const repo of repositories) {
    try {
      const result = await exec(["worktree", "list", "--porcelain"], repo.path);
      const worktrees = parseWorktreeList(result.stdout, repo.name, repo.path);
      results.push(...worktrees.filter((wt) => wt.branch === branchName));
    } catch {}
  }

  return results;
};

export const discoverWorktreesByPath = async (
  worktreePath: string,
  repositories: RepositoryTarget[],
): Promise<WorktreeInfo[]> => {
  const results: WorktreeInfo[] = [];
  const targetPath = normalizePath(worktreePath);

  for (const repo of repositories) {
    try {
      const result = await exec(["worktree", "list", "--porcelain"], repo.path);
      const worktrees = parseWorktreeList(result.stdout, repo.name, repo.path);
      for (const worktree of worktrees) {
        const candidatePath = normalizePath(worktree.path);
        if (candidatePath === targetPath) {
          results.push(worktree);
        }
      }
    } catch {}
  }

  return results;
};

export const discoverAllWorktrees = async (
  repositories: RepositoryTarget[],
): Promise<WorktreeInfo[]> => {
  const results: WorktreeInfo[] = [];

  for (const repo of repositories) {
    try {
      const result = await exec(["worktree", "list", "--porcelain"], repo.path);
      results.push(...parseWorktreeList(result.stdout, repo.name, repo.path));
    } catch {}
  }

  return results;
};

const normalizePath = (pathInput: string): string => {
  try {
    return realpathSync(pathInput);
  } catch {
    return resolvePath(pathInput);
  }
};

export const groupWorktreesByParent = (entries: WorktreeEntry[]): WorktreeGrouping => {
  const groups: WorktreeGrouping["groups"] = [];
  const orphans: WorktreeEntry[] = [];
  const entryByPath = new Map<string, WorktreeEntry>();
  const groupByParent = new Map<string, { parent: WorktreeEntry; children: WorktreeEntry[] }>();

  for (const entry of entries) {
    entryByPath.set(normalizePath(entry.path), entry);
  }

  for (const entry of entries) {
    if (entry.childrenPaths.length > 0) {
      groupByParent.set(normalizePath(entry.path), { children: [], parent: entry });
    }
  }

  for (const entry of entries) {
    if (entry.parentPath) {
      const parent = entryByPath.get(normalizePath(entry.parentPath));
      if (!parent) {
        orphans.push(entry);
      } else {
        let group = groupByParent.get(normalizePath(parent.path));
        if (!group) {
          group = { children: [], parent };
          groupByParent.set(normalizePath(parent.path), group);
        }
        group.children.push(entry);
      }
    }
  }

  for (const entry of entries) {
    if (!entry.parentPath && !groupByParent.has(normalizePath(entry.path))) {
      orphans.push(entry);
    }
  }

  for (const group of groupByParent.values()) {
    groups.push(group);
  }

  return { groups, orphans };
};

export const refreshRemainingChildStatuses = async (
  removed: WorktreeEntry,
  remaining: WorktreeEntry[],
  includeDirtyDetails: boolean,
): Promise<void> => {
  if (removed.childrenPaths.length === ZERO) {
    return;
  }

  const children = remaining.filter((entry) => removed.childrenPaths.includes(entry.path));
  if (children.length === ZERO) {
    return;
  }

  await resolveWorktreeStatuses(children, includeDirtyDetails);
};

export const removeWorktree = async (
  worktree: WorktreeInfo,
  repoPath: string,
  force: boolean,
): Promise<void> => {
  const args = ["worktree", "remove", worktree.path];
  if (force) {
    args.push("--force");
  }

  try {
    await exec(args, repoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("locked")) {
      await exec([...args, "--force"], repoPath);
    } else {
      throw error;
    }
  }
};

export const deleteBranch = async (repoPath: string, branchName: string): Promise<void> => {
  await exec(["branch", "-D", branchName], repoPath);
};

export const detachWorktree = async (worktreePath: string): Promise<void> => {
  await exec(["checkout", "--detach"], worktreePath);
};

export const branchExists = async (repoPath: string, branchName: string): Promise<boolean> => {
  try {
    await exec(["show-ref", "--verify", `refs/heads/${branchName}`], repoPath);
    return true;
  } catch (error) {
    if (error instanceof ArashiError && error.code === GitErrorCode.NOT_FOUND) {
      return false;
    }
    return false;
  }
};

export const getCurrentBranch = async (repoPath: string): Promise<string | null> => {
  try {
    const result = await exec(["rev-parse", "--abbrev-ref", DETACHED_HEAD], repoPath);
    const branch = result.stdout.trim();
    if (branch === DETACHED_HEAD) {
      return null;
    }

    return branch;
  } catch {
    return null;
  }
};

export const createRemovalSummary = (
  totalWorktrees: number,
  totalBranches: number,
): RemovalSummary => ({
  duration: ZERO,
  errors: [],
  operations: [],
  successfulBranches: ZERO,
  successfulWorktrees: ZERO,
  totalBranches,
  totalWorktrees,
});

export const recordOperation = (summary: RemovalSummary, operation: RemovalOperation): void => {
  summary.operations.push(operation);
  if (operation.type === "worktree_remove" && operation.status === "success") {
    summary.successfulWorktrees += ONE;
  }
  if (operation.type === "branch_delete" && operation.status === "success") {
    summary.successfulBranches += ONE;
  }
  if (operation.status === "failed" && operation.error) {
    summary.errors.push(`${operation.repository}: ${operation.error}`);
  }
};

export const formatRemovalSummaryHuman = (
  summary: RemovalSummary,
  extras?: {
    skippedMain?: WorktreeInfo[];
    missingBranches?: Record<string, string[]>;
  },
): string => {
  const lines: string[] = [];
  const hasErrors = summary.errors.length > ZERO;

  if (hasErrors) {
    lines.push(chalk.red(`✗ Partial removal completed with ${summary.errors.length} errors`));
  } else {
    lines.push(
      chalk.green(
        `✓ Successfully removed ${summary.successfulWorktrees} worktrees and deleted ${summary.successfulBranches} branches`,
      ),
    );
  }

  if (summary.successfulWorktrees > ZERO) {
    lines.push("");
    lines.push("Removed worktrees:");
    for (const op of summary.operations) {
      if (op.type === "worktree_remove" && op.status === "success") {
        lines.push(`  • ${op.repository}: ${op.worktreePath}`);
      }
    }
  }

  if (summary.successfulBranches > ZERO) {
    lines.push("");
    lines.push("Deleted branches:");
    for (const op of summary.operations) {
      if (op.type === "branch_delete" && op.status === "success") {
        lines.push(`  • ${op.repository}: ${op.branchName}`);
      }
    }
  }

  if (extras?.skippedMain && extras.skippedMain.length > ZERO) {
    lines.push("");
    for (const wt of extras.skippedMain) {
      lines.push(`Skipping main worktree: ${wt.path} (cannot be removed)`);
    }
  }

  if (extras?.missingBranches) {
    const entries = Object.entries(extras.missingBranches);
    for (const [branch, repos] of entries) {
      if (repos.length > ZERO) {
        lines.push("");
        lines.push(`Note: Branch '${branch}' not found in: ${repos.join(", ")}`);
      }
    }
  }

  if (hasErrors) {
    lines.push("");
    lines.push("Errors:");
    for (const error of summary.errors) {
      lines.push(`  • ${error}`);
    }
  }

  lines.push("");
  lines.push(`Total duration: ${(summary.duration / 1000).toFixed(JSON_INDENT)}s`);

  return lines.join("\n");
};

export const formatRemovalSummaryJson = (
  summary: RemovalSummary,
  extras?: {
    skippedMain?: WorktreeInfo[];
    missingBranches?: Record<string, string[]>;
  },
): string => {
  const payload: Record<string, unknown> = {
    errors: summary.errors,
    operations: summary.operations,
    success: summary.errors.length === ZERO,
    summary: {
      duration: summary.duration,
      successfulBranches: summary.successfulBranches,
      successfulWorktrees: summary.successfulWorktrees,
      totalBranches: summary.totalBranches,
      totalWorktrees: summary.totalWorktrees,
    },
  };

  if (extras?.skippedMain && extras.skippedMain.length > ZERO) {
    payload.skippedMain = extras.skippedMain.map((wt) => ({
      path: wt.path,
      repository: wt.repository,
    }));
  }

  if (extras?.missingBranches) {
    payload.missingBranches = extras.missingBranches;
  }

  return JSON.stringify(payload, null, JSON_INDENT);
};
