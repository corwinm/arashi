/**
 * Prune Command
 *
 * Cleans stale Git worktree metadata across an Arashi workspace.
 */

// eslint-disable-next-line import/consistent-type-specifier-style
import {
  type PruneRepositoryResult,
  type RepositoryTarget,
  discoverPrunableWorktrees,
  pruneRepositoryWorktrees,
} from "../core/remove.ts";
import { findWorkspaceRoot, loadConfig } from "../lib/config.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { info, error as logError } from "../lib/logger.ts";
import { basename, resolve } from "path";
import { Command } from "commander";

const ZERO = 0;
const ONE = 1;
const USAGE_EXIT_CODE = 2;

interface PruneOptions {
  dryRun?: boolean;
  expire?: string;
  json?: boolean;
}

interface PruneData {
  dryRun: boolean;
  expire: string;
  overallStatus: "success" | "partial-failure" | "failure";
  repositories: PruneRepositoryResult[];
  totalFailed: number;
  totalPrunable: number;
  totalPruned: number;
  totalRepositories: number;
  workspaceRoot: string;
}

const buildRepositoryTargets = (
  workspaceRoot: string,
  repos: Record<string, { path: string }>,
): RepositoryTarget[] => {
  const targets: RepositoryTarget[] = [{ name: basename(workspaceRoot), path: workspaceRoot }];
  for (const [name, repo] of Object.entries(repos)) {
    targets.push({ name, path: resolve(workspaceRoot, repo.path) });
  }
  return targets;
};

interface SummarizeOptions {
  dryRun: boolean;
  expire: string;
  repositories: PruneRepositoryResult[];
  workspaceRoot: string;
}

const summarize = ({
  dryRun,
  expire,
  repositories,
  workspaceRoot,
}: SummarizeOptions): PruneData => {
  const totalFailed = repositories.filter((repo) => repo.status === "failed").length;
  const totalPrunable = repositories.reduce((sum, repo) => sum + repo.prunable.length, ZERO);
  const totalPruned = repositories.reduce((sum, repo) => sum + repo.prunedCount, ZERO);
  let overallStatus: PruneData["overallStatus"] = "success";
  if (totalFailed === repositories.length && repositories.length > ZERO) {
    overallStatus = "failure";
  } else if (totalFailed > ZERO) {
    overallStatus = "partial-failure";
  }

  return {
    dryRun,
    expire,
    overallStatus,
    repositories,
    totalFailed,
    totalPrunable,
    totalPruned,
    totalRepositories: repositories.length,
    workspaceRoot,
  };
};

const formatHumanOutput = (data: PruneData): string => {
  const lines: string[] = [];
  const action = data.dryRun ? "Prunable worktree metadata" : "Pruned worktree metadata";

  if (data.totalPrunable === ZERO && data.totalFailed === ZERO) {
    return "No stale worktree entries to prune";
  }

  lines.push(`${action}:`);
  for (const repo of data.repositories) {
    if (repo.status === "failed") {
      lines.push(`  ✗ ${repo.name}: ${repo.error ?? "prune failed"}`);
      continue;
    }
    if (repo.prunable.length === ZERO) {
      lines.push(`  • ${repo.name}: nothing to prune`);
      continue;
    }
    lines.push(
      `  • ${repo.name}: ${repo.prunable.length} stale entr${repo.prunable.length === ONE ? "y" : "ies"}`,
    );
    for (const worktree of repo.prunable) {
      const reason = worktree.pruneReason ? ` (${worktree.pruneReason})` : "";
      lines.push(`    - ${worktree.path}${reason}`);
    }
  }

  if (!data.dryRun) {
    lines.push(
      `Summary: pruned ${data.totalPruned} stale entr${data.totalPruned === ONE ? "y" : "ies"}`,
    );
  }

  return lines.join("\n");
};

export const executePrune = async (options: PruneOptions): Promise<number> => {
  let workspaceRoot = "";
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    if (options.json) {
      writeJsonEnvelope(
        createJsonErrorEnvelope("prune", {
          code: "NOT_IN_WORKSPACE",
          message: "Not in an arashi workspace",
        }),
      );
    } else {
      logError("Not in an arashi workspace");
      info("Run 'arashi init' to initialize a workspace");
    }
    return USAGE_EXIT_CODE;
  }

  try {
    const config = await loadConfig(workspaceRoot);
    const repositories = buildRepositoryTargets(workspaceRoot, config.repos);
    const dryRun = options.dryRun === true;
    const expire = options.expire ?? "now";
    const results = await discoverPrunableWorktrees(repositories);

    if (dryRun) {
      for (const repo of results) {
        if (repo.status !== "failed") {
          repo.status = "skipped";
        }
      }
    } else {
      await Promise.all(
        results.map(async (repo) => {
          if (repo.status === "failed" || repo.prunable.length === ZERO) {
            if (repo.status !== "failed") {
              repo.status = "skipped";
            }
            return;
          }
          try {
            await pruneRepositoryWorktrees(repo.path, expire);
            repo.prunedCount = repo.prunable.length;
            repo.status = "pruned";
          } catch (error) {
            repo.error = error instanceof Error ? error.message : String(error);
            repo.status = "failed";
          }
        }),
      );
    }

    const data = summarize({ dryRun, expire, repositories: results, workspaceRoot });
    if (options.json) {
      const hasFailures = data.totalFailed > ZERO;
      if (hasFailures) {
        writeJsonEnvelope(
          createJsonErrorEnvelope("prune", {
            code: "PRUNE_FAILED",
            details: data as unknown as Record<string, unknown>,
            message: "One or more repositories failed to prune",
          }),
        );
      } else {
        writeJsonEnvelope(
          createJsonSuccessEnvelope("prune", data as unknown as Record<string, unknown>),
        );
      }
    } else {
      console.log(formatHumanOutput(data));
    }

    return data.totalFailed > ZERO ? ONE : ZERO;
  } catch (error) {
    if (options.json) {
      writeJsonEnvelope(createJsonErrorEnvelope("prune", unknownErrorToJsonError(error)));
    } else {
      logError(error instanceof Error ? error.message : String(error));
    }
    return ONE;
  }
};

export const createCommand = (): Command =>
  new Command("prune")
    .description("Clean stale Git worktree metadata across the workspace")
    .option("--dry-run", "Report stale worktree metadata without pruning")
    .option("--expire <time>", "Git worktree prune expiry time", "now")
    .option("--json", "Output a structured JSON envelope")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi prune --dry-run       # Show stale worktree metadata
  $ arashi prune                 # Prune stale worktree metadata now
  $ arashi prune --json          # Automation-safe prune result
      `,
    )
    .action(async (options: PruneOptions) => {
      const exitCode = await executePrune(options);
      process.exit(exitCode);
    });
