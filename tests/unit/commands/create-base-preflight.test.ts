import type { Config, LoadedConfig } from "../../../src/lib/config.ts";
import { describe, expect, test } from "vitest";
import {
  CreateBaseResolutionError,
  type CreateBaseRequest,
  type CreateBaseSource,
} from "../../../src/lib/create-base.ts";
import type { Repository } from "../../../src/core/repository.ts";
import { executeCreate } from "../../../src/commands/create.ts";
import { normalizeConfig } from "../../../src/lib/config.ts";

type CreateCommandDependencies = NonNullable<Parameters<typeof executeCreate>[2]>;

const workspaceRoot = "/workspace";
const repositories: Repository[] = [
  { defaultBranch: "main", hasSetupScript: false, name: "alpha", path: "/workspace/repos/alpha" },
  { defaultBranch: "main", hasSetupScript: false, name: "beta", path: "/workspace/repos/beta" },
  { defaultBranch: "main", hasSetupScript: false, name: "gamma", path: "/workspace/repos/gamma" },
];

function loadedConfig(baseBranch = "config/base"): LoadedConfig {
  const config: Config = {
    defaults: {
      create: { baseBranch },
      editors: { vscode: { create: { launch: "none" } } },
    },
    repos: Object.fromEntries(
      repositories.map((repository) => [repository.name, { path: repository.name }]),
    ),
    reposDir: "./repos",
    version: "1.0.0",
  };
  return { config, configPath: "/workspace/.arashi/config.json", source: "local-file" };
}

function planFor(
  selected: readonly Repository[],
  requestedBranch: string | readonly CreateBaseRequest[],
  source?: CreateBaseSource,
) {
  const first =
    typeof requestedBranch === "string" ? requestedBranch : requestedBranch[0]!.requestedBranch;
  const entries = selected.map((repository) => ({
    repositoryName: repository.name,
    repositoryPath: repository.path,
    resolvedOid: `${repository.name}-oid`,
    resolvedRef: `refs/heads/${first}`,
  }));
  return {
    byCanonicalPath: new Map(entries.map((entry) => [entry.repositoryPath, entry])),
    repositories: entries,
    requestedBranch: first,
    source: source ?? "cli",
  };
}

function dependencies(
  overrides: Partial<CreateCommandDependencies> = {},
): CreateCommandDependencies {
  return {
    applyRepositoryFilter: async (_filter, selected) => selected,
    createCoordinatedWorktrees: async (branchName, selected) => ({
      errorSummary: null,
      failureCount: 0,
      hookOutcomes: [],
      nextSteps: [],
      repositoryResults: selected.map((repository) => ({
        branchName,
        duration: 0,
        error: null,
        hookOutcomes: [],
        repository,
        status: "success" as const,
        targetAction: "created" as const,
        warnings: [],
        worktreePath: `/worktrees/${repository.name}`,
      })),
      rolledBack: false,
      skippedCount: 0,
      successCount: selected.length,
      targetActionByRepositoryPath: new Map(
        selected.map((repository) => [repository.path, "created" as const]),
      ),
      totalDuration: 0,
      totalRepositories: selected.length,
    }),
    discoverRepositories: async () => ({
      duration: 0,
      errors: [],
      repositories,
      scanDepth: 0,
      scannedDirectories: repositories.length,
      workspacePath: "/workspace/repos",
    }),
    isGitRepository: async () => false,
    loadConfigWithFallback: async () => loadedConfig(),
    reconcileManagedIgnore: async () => ({
      appliedRules: [],
      attempted: false,
      changed: false,
      fileChanges: { local: false, preference: false, tracked: false },
      localExcludePath: "/workspace/.git/info/exclude",
      paths: [],
      plannedRules: [],
      restored: false,
      scope: "local",
      staleRules: [],
      storedPreference: null,
      trackedIgnorePath: "/workspace/.gitignore",
      warnings: [],
    }),
    resolveCreateBasePlan: async (selected, requestedBranch, source) =>
      planFor(selected, requestedBranch, source),
    resolveCreateInvocationContext: async () => ({
      executionPath: workspaceRoot,
      invocationPath: workspaceRoot,
      repositoryType: "non-bare",
      workspaceRoot,
    }),
    resolveManagedIgnoreWorkspaceRoot: async () => workspaceRoot,
    resolveWorkspaceContext: async () => ({
      config: loadedConfig().config,
      invocationPath: workspaceRoot,
      mode: "configured",
      workspaceRoot,
    }),
    ...overrides,
  };
}

describe("configured create base preflight", () => {
  test("rejects an invalid configured base before repository discovery or downstream dependencies", async () => {
    const reached: string[] = [];
    const sentinel = (name: string): never => {
      reached.push(name);
      throw new Error(`${name} must not be reached`);
    };

    const error = await executeCreate(
      "feature/target",
      {},
      dependencies({
        applyRepositoryFilter: async () => sentinel("repository filter"),
        createCoordinatedWorktrees: async () => sentinel("Git/hooks/mutation"),
        discoverRepositories: async () => sentinel("repository discovery"),
        isGitRepository: async () => sentinel("Git repository detection"),
        loadConfigWithFallback: async () => ({
          config: normalizeConfig({
            defaults: { create: { baseBranch: "invalid branch" } },
            repos: {},
            reposDir: "./repos",
            version: "1.0.0",
          }),
          configPath: "/workspace/.arashi/config.json",
          source: "local-file",
        }),
        reconcileManagedIgnore: async () => sentinel("managed-ignore mutation"),
        resolveCreateBasePlan: async () => sentinel("base resolver"),
        resolveCurrentBranch: async () => sentinel("current branch resolver"),
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "defaults.create.baseBranch: must be a valid Git branch name",
    );
    expect(reached).toEqual([]);
  });

  test("validates repository overrides after an empty interactive selection", async () => {
    const error = await executeCreate(
      "feature/target",
      { interactive: true, repoBase: ["missing=main"] },
      dependencies({ applyRepositoryFilter: async () => [] }),
    ).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: "BASE_BRANCH_POLICY_INVALID" });
  });

  test("uses CLI over generic config and validates only the final filtered interactive selection", async () => {
    const calls: {
      names: string[];
      requestedBranch: string | readonly CreateBaseRequest[];
      source?: CreateBaseSource;
    }[] = [];

    await expect(
      executeCreate(
        "feature/target",
        { base: "cli/base", interactive: true, only: ["alpha", "beta"] },
        dependencies({
          applyRepositoryFilter: async (_filter, narrowed) => [
            narrowed.find((repository) => repository.name === "beta")!,
          ],
          resolveCreateBasePlan: async (selected, requestedBranch, source) => {
            calls.push({
              names: selected.map((repository) => repository.name),
              requestedBranch,
              source,
            });
            return planFor(selected, requestedBranch, source);
          },
        }),
      ),
    ).resolves.toBe(0);

    expect(calls).toEqual([
      {
        names: ["beta"],
        requestedBranch: [
          {
            repositoryIdentity: "beta",
            repositoryName: "beta",
            repositoryPath: "/workspace/repos/beta",
            requestedBranch: "cli/base",
            source: "cli",
          },
        ],
        source: undefined,
      },
    ]);
  });

  test("uses the workspace-generic config base even in an editor-hosted invocation", async () => {
    const requests: {
      requestedBranch: string | readonly CreateBaseRequest[];
      source?: CreateBaseSource;
    }[] = [];

    await executeCreate(
      "feature/target",
      { editorHost: "vscode", only: ["gamma"] },
      dependencies({
        resolveCreateBasePlan: async (selected, requestedBranch, source) => {
          requests.push({ requestedBranch, source });
          return planFor(selected, requestedBranch, source);
        },
      }),
    );

    expect(requests).toEqual([
      {
        requestedBranch: [
          {
            repositoryIdentity: "gamma",
            repositoryName: "gamma",
            repositoryPath: "/workspace/repos/gamma",
            requestedBranch: "config/base",
            source: "workspace-config",
          },
        ],
        source: undefined,
      },
    ]);
  });

  test("keeps a meta basename collision distinct from the child repository ID", async () => {
    const child: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "workspace",
      path: "/workspace/repos/workspace",
    };
    const captured: Array<readonly CreateBaseRequest[]> = [];
    await executeCreate(
      "feature/collision",
      { repoBase: ["@meta=meta/base", "workspace=child/base"] },
      dependencies({
        discoverRepositories: async () => ({
          duration: 0,
          errors: [],
          repositories: [child],
          scanDepth: 0,
          scannedDirectories: 1,
          workspacePath: "/workspace/repos",
        }),
        isGitRepository: async () => true,
        loadConfigWithFallback: async () => ({
          config: {
            repos: { workspace: { path: "/workspace/repos/workspace" } },
            reposDir: "./repos",
            version: "1.0.0",
          },
          configPath: "/workspace/.arashi/config.json",
          source: "local-file",
        }),
        resolveCreateBasePlan: async (selected, request) => {
          if (typeof request !== "string") captured.push(request);
          return planFor(selected, request);
        },
        resolveCurrentBranch: async () => "main",
      }),
    );

    expect(captured).toEqual([
      [
        expect.objectContaining({
          repositoryIdentity: "@meta",
          repositoryPath: "/workspace",
          requestedBranch: "meta/base",
        }),
        expect.objectContaining({
          repositoryIdentity: "workspace",
          repositoryPath: "/workspace/repos/workspace",
          requestedBranch: "child/base",
        }),
      ],
    ]);
  });

  test("preflights every selected repository including mixed reuse candidates before downstream work", async () => {
    const events: string[] = [];

    await executeCreate(
      "feature/existing-in-beta",
      { base: "feature/base", conflict: "REUSE_EXISTING" },
      dependencies({
        createCoordinatedWorktrees: async (...args) => {
          events.push(`create:${args[1].map((repository) => repository.name).join(",")}`);
          events.push(
            `create-plan:${args[2]?.createBasePlan?.repositories
              .map((repository) => repository.repositoryName)
              .join(",")}`,
          );
          return dependencies().createCoordinatedWorktrees!(...args);
        },
        reconcileManagedIgnore: async (...args) => {
          events.push("reconcile");
          return dependencies().reconcileManagedIgnore!(...args);
        },
        resolveCreateBasePlan: async (selected, requestedBranch, source) => {
          events.push(`base:${selected.map((repository) => repository.name).join(",")}`);
          return planFor(selected, requestedBranch, source);
        },
        resolveManagedIgnoreWorkspaceRoot: async () => {
          events.push("managed-root");
          return workspaceRoot;
        },
      }),
    );

    expect(events).toEqual([
      "base:alpha,beta,gamma",
      "managed-root",
      "reconcile",
      "create:alpha,beta,gamma",
      "create-plan:alpha,beta,gamma",
    ]);
  });

  test("aggregates selected repository failures before managed-ignore or conflict handling", async () => {
    const downstream: string[] = [];
    const attemptedRefs = ["refs/heads/missing", "refs/remotes/origin/missing"] as const;

    const error = await executeCreate(
      "feature/conflicting-target",
      { base: "missing", conflict: "ABORT" },
      dependencies({
        createCoordinatedWorktrees: async (...args) => {
          downstream.push("conflict-or-create");
          return dependencies().createCoordinatedWorktrees!(...args);
        },
        reconcileManagedIgnore: async (...args) => {
          downstream.push("reconcile");
          return dependencies().reconcileManagedIgnore!(...args);
        },
        resolveCreateBasePlan: async (selected, requestedBranch, source) => {
          const first =
            typeof requestedBranch === "string"
              ? requestedBranch
              : requestedBranch[0]!.requestedBranch;
          const firstSource =
            source ?? (typeof requestedBranch === "string" ? "cli" : requestedBranch[0]!.source);
          throw new CreateBaseResolutionError(
            first,
            firstSource,
            selected.map((repository) => ({
              attemptedRefs,
              repositoryName: repository.name,
              repositoryPath: repository.path,
            })),
          );
        },
        resolveManagedIgnoreWorkspaceRoot: async () => {
          downstream.push("managed-root");
          return workspaceRoot;
        },
      }),
    ).catch((error: unknown) => error);

    expect(error).toMatchObject({
      code: "CREATE_BASE_RESOLUTION_FAILED",
      failures: repositories.map((repository) => ({
        attemptedRefs,
        repositoryName: repository.name,
        repositoryPath: repository.path,
      })),
    });
    expect(downstream).toEqual([]);
  });
});
