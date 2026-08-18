import { ArashiError } from "./errors.ts";
import { InvalidBranchNameError } from "../core/worktree.ts";
import type { Repository } from "../core/repository.ts";
import { exec as gitExec } from "./git.ts";
import { realpath } from "node:fs/promises";
import { normalizeLogicalBranchName } from "./git-branch-name.ts";
import type { BaseBranchPolicySource } from "./base-branch-policy.ts";

export type CreateBaseSource = BaseBranchPolicySource | "config";

export interface CreateBaseRequest {
  repositoryIdentity?: string;
  repositoryName: string;
  repositoryPath?: string;
  requestedBranch: string;
  source: CreateBaseSource;
}

export interface CreateBaseResolution {
  repositoryIdentity?: string;
  repositoryName: string;
  repositoryPath: string;
  resolvedOid: string;
  resolvedRef: string;
  requestedBranch?: string;
  source?: CreateBaseSource;
}

export interface CreateBasePolicyResolution extends Omit<
  CreateBaseResolution,
  "resolvedOid" | "resolvedRef"
> {
  repositoryIdentity: string;
  requestedBranch: string;
  source: CreateBaseSource;
  resolvedOid?: string;
  resolvedRef?: string;
}

export interface CreateBaseResolutionFailure {
  attemptedRefs: readonly [string, string];
  repositoryName: string;
  repositoryIdentity?: string;
  repositoryPath: string;
  requestedBranch?: string;
  source?: CreateBaseSource;
}

export interface CreateBaseResolutionPlan {
  byCanonicalPath: ReadonlyMap<string, CreateBaseResolution>;
  repositories: readonly CreateBaseResolution[];
  effectiveRepositories?: readonly CreateBasePolicyResolution[];
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
      `Base branch resolution failed in: ${failures
        .map(
          (failure) => `${failure.repositoryName} (${failure.requestedBranch ?? requestedBranch})`,
        )
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
    if (error instanceof ArashiError && error.context.exitCode === 1) return null;
    throw error;
  }
};

const validateBranch = async (
  requestedBranch: string,
  validationPath: string,
  exec: typeof gitExec,
  normalizeRequest: boolean,
): Promise<string> => {
  const normalizedBranch = normalizeRequest
    ? normalizeLogicalBranchName(requestedBranch)
    : requestedBranch;
  try {
    await exec(["check-ref-format", "--branch", normalizedBranch], validationPath);
  } catch (error) {
    if (!(error instanceof ArashiError) || error.context.exitCode !== 128) throw error;
    throw new InvalidBranchNameError(
      `Invalid base branch name: ${normalizedBranch}`,
      normalizedBranch,
      error instanceof Error ? error.message : String(error),
    );
  }
  return normalizedBranch;
};

export const createBaseResolver = (dependencies: CreateBaseResolverDependencies = {}) =>
  async function resolveCreateBasePlan(
    repositories: readonly Repository[],
    requestedBranchOrRequests: string | readonly CreateBaseRequest[],
    legacySource?: CreateBaseSource,
  ): Promise<CreateBaseResolutionPlan> {
    const exec = dependencies.exec ?? gitExec;
    const canonicalizePath = dependencies.realpath ?? realpath;
    const perRepository = Array.isArray(requestedBranchOrRequests);
    const requests: readonly CreateBaseRequest[] = perRepository
      ? (requestedBranchOrRequests as readonly CreateBaseRequest[])
      : repositories.map((repository) => ({
          repositoryName: repository.name,
          requestedBranch: requestedBranchOrRequests as string,
          source: legacySource ?? "cli",
        }));
    const requestByPath = new Map(
      requests.flatMap((request) =>
        request.repositoryPath ? [[request.repositoryPath, request] as const] : [],
      ),
    );
    const requestsByName = new Map<string, CreateBaseRequest[]>();
    for (const request of requests) {
      const entries = requestsByName.get(request.repositoryName) ?? [];
      entries.push(request);
      requestsByName.set(request.repositoryName, entries);
    }
    const requestFor = (repository: Repository): CreateBaseRequest | undefined =>
      requestByPath.get(repository.path) ?? requestsByName.get(repository.name)?.shift();
    const requestByRepository = new Map(
      repositories.flatMap((repository) => {
        const request = requestFor(repository);
        return request ? [[repository, request] as const] : [];
      }),
    );
    const missingRequests = repositories.filter(
      (repository) => !requestByRepository.has(repository),
    );
    if (missingRequests.length > 0) {
      throw new Error(
        `Missing create-base requests for selected repositories: ${missingRequests.map((item) => item.name).join(", ")}`,
      );
    }

    const validationPath = repositories[0]?.path ?? process.cwd();
    const normalizedByRequest = new Map<CreateBaseRequest, string>();
    for (const request of requests) {
      normalizedByRequest.set(
        request,
        await validateBranch(request.requestedBranch, validationPath, exec, !perRepository),
      );
    }

    const results = await Promise.all(
      repositories.map(async (repository) => {
        const request = requestByRepository.get(repository)!;
        const normalizedBranch = normalizedByRequest.get(request)!;
        const attemptedRefs = [
          `refs/heads/${normalizedBranch}`,
          `refs/remotes/origin/${normalizedBranch}`,
        ] as const;
        const repositoryPath = await canonicalizePath(repository.path);
        for (const candidate of attemptedRefs) {
          const resolvedOid = await resolveExactCommit(repositoryPath, candidate, exec);
          if (resolvedOid) {
            return {
              resolution: {
                repositoryName: repository.name,
                ...(request.repositoryIdentity
                  ? { repositoryIdentity: request.repositoryIdentity }
                  : {}),
                repositoryPath,
                resolvedOid,
                resolvedRef: candidate,
                ...(perRepository
                  ? { requestedBranch: normalizedBranch, source: request.source }
                  : {}),
              } satisfies CreateBaseResolution,
            };
          }
        }
        return {
          failure: {
            attemptedRefs,
            repositoryName: repository.name,
            ...(request.repositoryIdentity
              ? { repositoryIdentity: request.repositoryIdentity }
              : {}),
            repositoryPath,
            ...(perRepository ? { requestedBranch: normalizedBranch, source: request.source } : {}),
          } satisfies CreateBaseResolutionFailure,
        };
      }),
    );

    const failures = results.flatMap((result) => (result.failure ? [result.failure] : []));
    const firstRequest = requests[0] ?? {
      repositoryName: "",
      requestedBranch: "",
      source: legacySource ?? "cli",
    };
    const firstNormalized = normalizedByRequest.get(firstRequest) ?? "";
    if (failures.length > 0) {
      const firstFailure = failures[0]!;
      throw new CreateBaseResolutionError(
        firstFailure.requestedBranch ?? firstNormalized,
        firstFailure.source ?? firstRequest.source,
        failures,
      );
    }

    const resolvedRepositories = results.flatMap((result) =>
      result.resolution ? [result.resolution] : [],
    );
    return {
      byCanonicalPath: new Map(
        resolvedRepositories.map((resolution) => [resolution.repositoryPath, resolution]),
      ),
      repositories: resolvedRepositories,
      requestedBranch: firstNormalized,
      source: firstRequest.source,
    };
  };

export const resolveCreateBasePlan = createBaseResolver();
