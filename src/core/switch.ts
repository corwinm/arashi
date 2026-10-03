import { SwitchCommandError, SwitchCommandErrorCode } from "../types/switch.ts";
import { basename, relative, resolve, sep } from "path";
import type { WorkspaceRepository } from "../lib/config.ts";
import type { WorktreeInfo } from "../types/remove.ts";
import { fitConfiguredParentWorktreePath } from "./worktree.ts";
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

export interface SelectSwitchCandidateOptions {
  interactive: boolean;
  workspaceRepoName?: string;
  /** Stable repository root, not the invocation directory or a linked checkout. */
  displayRoot?: string;
  worktreesBase?: string;
  repositories?: readonly WorkspaceRepository[];
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

const cleanDisplay = (value: string) =>
  value.replaceAll(/\p{Cc}\[[0-9;]*[A-Za-z]/gu, "").replaceAll(/\p{Cc}/gu, "");

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
    const choices = candidates.map((candidate) => ({
      branchName: cleanDisplay(candidate.branchName),
      repoName: cleanDisplay(candidate.repoName),
      worktreePath: cleanDisplay(candidate.worktreePath),
    }));
    throw new SwitchCommandError(
      `Found ${candidates.length} matching worktrees: ${choices.map((candidate) => `${candidate.branchName} in repository ${candidate.repoName} at ${candidate.worktreePath}`).join("; ")}. Select one exact checkout with --path <checkout>.`,
      SwitchCommandErrorCode.AMBIGUOUS_NON_INTERACTIVE,
      {
        matchCount: candidates.length,
        candidates: choices,
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
  const choiceNames = buildChoiceNames(sortedCandidates, options);
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

function worktreeNameMatchesBranch(
  candidate: SwitchCandidate,
  options: SelectSwitchCandidateOptions,
): boolean {
  const root = resolve(options.displayRoot!);
  const repository = options.repositories?.find((repo) => repo.name === candidate.repoName);
  const path = resolve(candidate.worktreePath);
  if (path === resolve(repository?.path ?? root)) return true;

  // A coordinated child ends in its configured repository path, not its branch.
  let namedPath = path;
  if (repository) {
    const childPath = relative(root, resolve(repository.path));
    if (
      childPath &&
      !childPath.startsWith(`..${sep}`) &&
      childPath !== ".." &&
      path.endsWith(`${sep}${childPath}`)
    ) {
      namedPath = path.slice(0, -childPath.length - 1);
    }
  }
  const primaryName = options.repositories?.find((repo) => resolve(repo.path) === root)?.name;
  const namespaces = [basename(root), ...(primaryName ? [primaryName] : [])].map((name) =>
    name.replace(/\.git$/i, ""),
  );
  const base = resolve(options.worktreesBase ?? root);
  // Existing checkouts retain their names when naming policy or path budgets change.
  return [candidate.branchName, candidate.branchName.replaceAll("/", "-")].some((branch) =>
    [
      branch,
      ...namespaces.flatMap((namespace) => [`${namespace}-${branch}`, `${namespace}/${branch}`]),
    ].some((name) => {
      const ordinaryPath = resolve(base, ...name.split("/"));
      if (namedPath === ordinaryPath) return true;
      // Validate the exact generated prefix AND hash using create's fitter. The
      // observed parent length recovers the available namespace budget, including
      // coordinated child-only/subset plans, without guessing the creation scope.
      if (
        namedPath.length < resolve(base, "-00000000").length ||
        namedPath.length >= ordinaryPath.length
      )
        return false;
      return (
        namedPath ===
        fitConfiguredParentWorktreePath({
          destinations: [{ repositoryName: candidate.repoName }],
          maxPathLength: namedPath.length,
          ordinaryParentWorktreePath: ordinaryPath,
          worktreeBasePath: base,
        })
      );
    }),
  );
}

function buildChoiceNames(
  candidates: SwitchCandidate[],
  options: SelectSwitchCandidateOptions,
): string[] {
  const uniqueRepos = new Set(candidates.map((candidate) => candidate.repoName));
  const useRepoPrefix = uniqueRepos.size > 1;
  const normalizedWorkspaceRepoName = options.workspaceRepoName?.trim();
  const displayPath = (candidate: SwitchCandidate) =>
    cleanDisplay(
      (relative(options.displayRoot!, candidate.worktreePath) || ".").split(sep).join("/"),
    );
  const baseNames = candidates.map((candidate) => {
    const branch = cleanDisplay(candidate.branchName);
    const label =
      !useRepoPrefix || candidate.repoName === normalizedWorkspaceRepoName
        ? branch
        : `${cleanDisplay(candidate.repoName)} (${branch})`;
    return options.displayRoot && !worktreeNameMatchesBranch(candidate, options)
      ? `${label} - ${displayPath(candidate)}`
      : label;
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

    return `${baseName} - ${options.displayRoot ? displayPath(candidate) : cleanDisplay(basename(candidate.worktreePath))}`;
  });
}
