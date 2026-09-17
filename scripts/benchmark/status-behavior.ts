import { invoke } from "./invoke.ts";
import type { RepoStatus } from "../../src/commands/status.ts";
import { realpath } from "node:fs/promises";

interface StatusBehaviorOptions {
  canonicalizePath?: (path: string) => Promise<string>;
  configuredBase?: boolean;
  expectedDefaultResolution?: "available" | "unresolved";
  environment: NodeJS.ProcessEnv;
  expectedRepositoryPaths: string[];
  local: boolean;
  verbose: boolean;
}

function assertStatusEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Status benchmark mismatch: ${label}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
}

export async function validateCliStatusOutput(
  stdout: string,
  options: StatusBehaviorOptions,
): Promise<Record<string, unknown>> {
  const envelope = JSON.parse(stdout) as {
    data: {
      freshness: { mode: string; remoteRefsRefreshed: boolean };
      repositories: RepoStatus[];
    };
    warnings?: unknown[];
  };
  const { freshness, repositories } = envelope.data;
  const canonicalPaths = await Promise.all(
    repositories.map(({ path }) => (options.canonicalizePath ?? realpath)(path)),
  );
  const expectedDefault = options.expectedDefaultResolution ?? "available";
  const expectedFreshness = {
    mode: options.local ? "local" : "refreshed",
    remoteRefsRefreshed: !options.local,
  };
  assertStatusEqual(freshness, expectedFreshness, "command freshness");
  assertStatusEqual(envelope.warnings ?? [], [], "warnings");
  assertStatusEqual(
    canonicalPaths.toSorted(),
    options.expectedRepositoryPaths.toSorted(),
    "repository paths",
  );
  for (const repo of repositories) {
    assertStatusEqual(repo.freshness, expectedFreshness, "repository freshness");
    if (repo.error || repo.refreshWarning) {
      throw new Error("Status benchmark lost refresh/diagnostic semantics");
    }
    if (
      repo.branch.localBranch !== "main" ||
      repo.branch.remoteBranch !== "origin/main" ||
      repo.branch.ahead !== 0 ||
      repo.branch.behind !== 0 ||
      repo.branch.isDetached
    ) {
      throw new Error("Unexpected branch state");
    }
    const expectedComparison = options.configuredBase
      ? {
          baseBranch: {
            branch: "main",
            compareRef: "refs/remotes/origin/main",
            state: "available",
          },
          defaultBranch: {
            branch: "main",
            compareRef: "refs/remotes/origin/main",
            state: "available",
          },
        }
      : expectedDefault === "available"
        ? {
            baseBranch: null,
            defaultBranch: {
              branch: "main",
              compareRef: "refs/remotes/origin/main",
              state: "available",
            },
          }
        : {
            baseBranch: null,
            defaultBranch: {
              branch: null,
              reason: "unresolved",
              state: "skipped",
            },
          };
    const comparisonMatches = options.configuredBase
      ? repo.baseBranch?.branch === "main" &&
        repo.baseBranch.compareRef === "refs/remotes/origin/main" &&
        repo.baseBranch.state === "available" &&
        repo.defaultBranch?.branch === "main" &&
        repo.defaultBranch.compareRef === "refs/remotes/origin/main" &&
        repo.defaultBranch.state === "available"
      : expectedDefault === "available"
        ? repo.baseBranch === null &&
          repo.defaultBranch?.state === "available" &&
          repo.defaultBranch.branch === "main" &&
          repo.defaultBranch.compareRef === "refs/remotes/origin/main"
        : repo.baseBranch === null &&
          repo.defaultBranch?.state === "skipped" &&
          repo.defaultBranch.branch === null &&
          repo.defaultBranch.reason === "unresolved";
    if (!comparisonMatches) {
      throw new Error(
        `Unexpected comparison state: actual=${JSON.stringify({ baseBranch: repo.baseBranch, defaultBranch: repo.defaultBranch })} expected=${JSON.stringify(expectedComparison)}`,
      );
    }
    assertStatusEqual(repo.files, [], "dirty files");
    if (options.verbose) {
      const native = await invoke(
        { command: "git", args: [] },
        ["status"],
        repo.path,
        options.environment,
      );
      if (native.exitCode !== 0 || repo.fullStatus !== native.stdout.trim()) {
        throw new Error("Verbose output differs from native Git status");
      }
    } else if (repo.fullStatus !== undefined) {
      throw new Error("Normal status unexpectedly collected verbose output");
    }
  }
  return {
    freshness,
    nativeStatus: options.verbose,
    repositories: repositories.map((repo) => repo.name),
    repositoryPaths: canonicalPaths,
    statuses: repositories.map(
      ({ name, branch, baseBranch, defaultBranch, files, error, refreshWarning }, index) => ({
        name,
        path: canonicalPaths[index],
        branch,
        baseBranch,
        defaultBranch,
        files,
        error,
        refreshWarning,
      }),
    ),
    warnings: envelope.warnings ?? [],
  };
}
