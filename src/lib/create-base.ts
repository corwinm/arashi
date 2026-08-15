import { ArashiError } from "./errors.ts";
import { InvalidBranchNameError } from "../core/worktree.ts";
import type { Repository } from "../core/repository.ts";
import { exec as gitExec } from "./git.ts";
import { realpath } from "node:fs/promises";
import { normalizeLogicalBranchName } from "./git-branch-name.ts";

export type CreateBaseSource = "cli" | "config";

export interface CreateBaseResolution {
  repositoryName: string;
  repositoryPath: string;
  resolvedOid: string;
  resolvedRef: string;
}

export interface CreateBaseResolutionFailure {
  attemptedRefs: readonly [string, string];
  repositoryName: string;
  repositoryPath: string;
}

export interface CreateBaseResolutionPlan {
  byCanonicalPath: ReadonlyMap<string, CreateBaseResolution>;
  repositories: readonly CreateBaseResolution[];
  requestedBranch: string;
  source: CreateBaseSource;
}

export class CreateBaseResolutionError extends Error {
  readonly code = "CREATE_BASE_RESOLUTION_FAILED";
  readonly failures: readonly CreateBaseResolutionFailure[];
  readonly requestedBranch: string;
  readonly source: CreateBaseSource;

  constructor(
    requestedBranch: string,
    source: CreateBaseSource,
    failures: readonly CreateBaseResolutionFailure[],
  ) {
    super(
      `Base branch '${requestedBranch}' could not be resolved in: ${failures
        .map((failure) => failure.repositoryName)
        .join(", ")}`,
    );
    this.name = "CreateBaseResolutionError";
    this.failures = failures;
    this.requestedBranch = requestedBranch;
    this.source = source;
  }
}

export interface CreateBaseResolverDependencies {
  exec?: typeof gitExec;
  realpath?: typeof realpath;
}

const resolveExactCommit = async (
  repositoryPath: string,
  ref: string,
  exec: typeof gitExec,
): Promise<string | null> => {
  try {
    return (
      await exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repositoryPath)
    ).stdout.trim();
  } catch (error) {
    if (error instanceof ArashiError && error.context.exitCode === 1) {
      return null;
    }
    throw error;
  }
};

export const createBaseResolver = (dependencies: CreateBaseResolverDependencies = {}) =>
  async function resolveCreateBasePlan(
    repositories: readonly Repository[],
    requestedBranch: string,
    source: CreateBaseSource,
  ): Promise<CreateBaseResolutionPlan> {
    const exec = dependencies.exec ?? gitExec;
    const canonicalizePath = dependencies.realpath ?? realpath;
    const normalizedBranch = normalizeLogicalBranchName(requestedBranch);
    const validationPath = repositories[0]?.path ?? process.cwd();
    try {
      await exec(["check-ref-format", "--branch", normalizedBranch], validationPath);
    } catch (error) {
      if (!(error instanceof ArashiError) || error.context.exitCode !== 128) {
        throw error;
      }
      throw new InvalidBranchNameError(
        `Invalid base branch name: ${normalizedBranch}`,
        normalizedBranch,
        error instanceof Error ? error.message : String(error),
      );
    }

    const attemptedRefs = [
      `refs/heads/${normalizedBranch}`,
      `refs/remotes/origin/${normalizedBranch}`,
    ] as const;
    const results = await Promise.all(
      repositories.map(async (repository) => {
        const repositoryPath = await canonicalizePath(repository.path);
        for (const candidate of attemptedRefs) {
          const resolvedOid = await resolveExactCommit(repositoryPath, candidate, exec);
          if (resolvedOid) {
            return {
              resolution: {
                repositoryName: repository.name,
                repositoryPath,
                resolvedOid,
                resolvedRef: candidate,
              } satisfies CreateBaseResolution,
            };
          }
        }
        return {
          failure: {
            attemptedRefs,
            repositoryName: repository.name,
            repositoryPath,
          } satisfies CreateBaseResolutionFailure,
        };
      }),
    );

    const failures = results.flatMap((result) => (result.failure ? [result.failure] : []));
    if (failures.length > 0) {
      throw new CreateBaseResolutionError(normalizedBranch, source, failures);
    }

    const resolvedRepositories = results.flatMap((result) =>
      result.resolution ? [result.resolution] : [],
    );
    return {
      byCanonicalPath: new Map(
        resolvedRepositories.map((resolution) => [resolution.repositoryPath, resolution]),
      ),
      repositories: resolvedRepositories,
      requestedBranch: normalizedBranch,
      source,
    };
  };

export const resolveCreateBasePlan = createBaseResolver();
