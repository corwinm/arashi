import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { basename, resolve } from "path";
import type { WorkspaceRepository } from "../lib/config.ts";
import type { WorktreeInfo } from "../types/remove.ts";
import { discoverAllWorktrees } from "./remove.ts";
import { select as promptSelect } from "../lib/prompts.ts";

interface Choice<T> {
  value: T;
  name: string;
  description?: string;
}

type PromptOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "cancelled"; reason: "exit" | "abort" };

interface RepositoryTarget {
  name: string;
  path: string;
}

export interface SwitchCandidate {
  branchName: string;
  worktreePath: string;
  repoName: string;
  herdrSource?: { status: "available"; path: string } | { status: "unavailable" };
}

export interface SwitchCandidateDiscoveryResult {
  candidates: SwitchCandidate[];
  skippedCount: number;
}

interface DiscoverSwitchCandidatesDependencies {
  discoverAllWorktrees?: (repositories: RepositoryTarget[]) => Promise<WorktreeInfo[]>;
}

interface SelectSwitchCandidateOptions {
  interactive: boolean;
  workspaceRepoName?: string;
}

interface SelectSwitchCandidateDependencies {
  selectPrompt?: (
    message: string,
    choices: Choice<SwitchCandidate>[],
  ) => Promise<PromptOutcome<SwitchCandidate>>;
}

export async function discoverSwitchCandidates(
  repositories: WorkspaceRepository[],
  deps: DiscoverSwitchCandidatesDependencies = {},
): Promise<SwitchCandidateDiscoveryResult> {
  const discoverWorktrees = deps.discoverAllWorktrees ?? discoverAllWorktrees;
  const targets: RepositoryTarget[] = repositories.map((repo) => ({
    name: repo.name,
    path: repo.path,
  }));
  const worktrees = await discoverWorktrees(targets);
  return buildSwitchCandidates(worktrees);
}

export function buildSwitchCandidates(worktrees: WorktreeInfo[]): SwitchCandidateDiscoveryResult {
  const candidates: SwitchCandidate[] = [];
  const seen = new Set<string>();
  let skippedCount = 0;

  for (const worktree of worktrees) {
    if (
      !worktree.path ||
      worktree.path.trim().length === 0 ||
      !worktree.branch ||
      worktree.branch.trim().length === 0 ||
      !worktree.repository ||
      worktree.repository.trim().length === 0
    ) {
      skippedCount += 1;
      continue;
    }

    const repoName = worktree.repository.trim();
    const worktreePath = resolve(worktree.path);
    const candidate: SwitchCandidate = {
      branchName: worktree.branch.trim(),
      repoName,
      worktreePath,
    };
    const dedupeKey = `${candidate.repoName}\u0000${candidate.worktreePath}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    candidates.push(candidate);
  }

  return { candidates, skippedCount };
}

export function filterSwitchCandidates(
  candidates: SwitchCandidate[],
  filter: string | undefined,
): SwitchCandidate[] {
  if (!filter || filter.trim().length === 0) {
    return [...candidates];
  }

  const query = filter.trim().toLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.branchName.toLowerCase().includes(query) ||
      candidate.worktreePath.toLowerCase().includes(query),
  );
}

export async function selectSwitchCandidate(
  candidates: SwitchCandidate[],
  options: SelectSwitchCandidateOptions,
  deps: SelectSwitchCandidateDependencies = {},
): Promise<SwitchCandidate> {
  if (candidates.length === 0) {
    throw new SwitchCommandError(
      "No switch targets were found in this workspace.",
      SwitchCommandErrorCode.NO_TARGETS,
    );
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (!options.interactive) {
    throw new SwitchCommandError(
      `Found ${candidates.length} matching worktrees. Provide a more specific filter, for example: arashi switch <branch>.`,
      SwitchCommandErrorCode.AMBIGUOUS_NON_INTERACTIVE,
      {
        matchCount: candidates.length,
      },
    );
  }

  const prompt = deps.selectPrompt ?? promptSelect;
  const normalizedWorkspaceRepoName = options.workspaceRepoName?.trim();
  const sortedCandidates = [...candidates].toSorted((left, right) => {
    if (normalizedWorkspaceRepoName) {
      const leftIsWorkspace = left.repoName === normalizedWorkspaceRepoName;
      const rightIsWorkspace = right.repoName === normalizedWorkspaceRepoName;

      if (leftIsWorkspace !== rightIsWorkspace) {
        return leftIsWorkspace ? -1 : 1;
      }
    }

    const repoCompare = left.repoName.localeCompare(right.repoName);
    if (repoCompare !== 0) {
      return repoCompare;
    }

    const branchCompare = left.branchName.localeCompare(right.branchName);
    if (branchCompare !== 0) {
      return branchCompare;
    }

    return left.worktreePath.localeCompare(right.worktreePath);
  });
  const choiceNames = buildChoiceNames(sortedCandidates, normalizedWorkspaceRepoName);
  const choices: Choice<SwitchCandidate>[] = sortedCandidates.map((candidate, index) => ({
    description: candidate.worktreePath,
    name: choiceNames[index],
    value: candidate,
  }));

  const outcome = await prompt("Select a worktree to switch to:", choices);
  if (outcome.status === "cancelled") {
    throw new SwitchCommandError(
      "Switch cancelled by user.",
      SwitchCommandErrorCode.USER_CANCELLED,
    );
  }

  return outcome.value;
}

function buildChoiceNames(candidates: SwitchCandidate[], workspaceRepoName?: string): string[] {
  const uniqueRepos = new Set(candidates.map((candidate) => candidate.repoName));
  const useRepoPrefix = uniqueRepos.size > 1;
  const normalizedWorkspaceRepoName = workspaceRepoName?.trim();
  const baseNames = candidates.map((candidate) => {
    if (!useRepoPrefix) {
      return candidate.branchName;
    }

    if (normalizedWorkspaceRepoName && candidate.repoName === normalizedWorkspaceRepoName) {
      return candidate.branchName;
    }

    return `${candidate.repoName} (${candidate.branchName})`;
  });

  const nameCounts = new Map<string, number>();
  for (const name of baseNames) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return candidates.map((candidate, index) => {
    const baseName = baseNames[index];
    if ((nameCounts.get(baseName) ?? 0) <= 1) {
      return baseName;
    }

    return `${baseName} - ${basename(candidate.worktreePath)}`;
  });
}
