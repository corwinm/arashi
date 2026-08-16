import {
  planLifecycleHookSources,
  prepareLifecycleHookSources,
  type LifecycleHookSourceDescriptor as SourceDescriptor,
} from "../../src/lib/hooks.ts";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";

const workspaceRoot = "/workspace";
const targets = [
  {
    branchName: "feature/inline",
    repositoryName: "alpha",
    repositoryPath: "/workspace/repos/alpha",
    worktreePath: "/workspace/.arashi/worktrees/alpha-feature-inline",
  },
  {
    branchName: "feature/inline",
    repositoryName: "beta",
    repositoryPath: "/workspace/repos/beta",
    worktreePath: "/workspace/.arashi/worktrees/beta-feature-inline",
  },
] as const;

type Lifecycle = SourceDescriptor["lifecycle"];
type Scope = SourceDescriptor["scope"];

const inline = (
  lifecycle: Lifecycle,
  scope: "repository" | "workspace",
  ownerName: string | null,
): SourceDescriptor => ({
  configuredField:
    scope === "workspace" ? `hooks.scripts.${lifecycle}` : `repos.${ownerName}.hooks.${lifecycle}`,
  executionPath: scope === "workspace" ? workspaceRoot : `/workspace/repos/${ownerName as string}`,
  lifecycle,
  scope,
  sourceKind: "inline-config",
  sourceOwnerKind: scope,
  sourceOwnerName: ownerName,
  sourceScriptPath: null,
});

const file = (
  lifecycle: Lifecycle,
  scope: Scope,
  location: { executionPath: string; ownerName: string | null; targetRepositoryName?: string },
): SourceDescriptor => ({
  executionPath: location.executionPath,
  lifecycle,
  scope,
  sourceKind: "file",
  sourceOwnerKind: scope === "repository" || scope === "workspace" ? scope : "global",
  sourceOwnerName: location.ownerName,
  sourceScriptPath: `${location.executionPath}/.arashi/hooks/${lifecycle}.sh`,
  targetRepositoryName: location.targetRepositoryName,
});

const executionPathForScope = (scope: Scope, target: (typeof targets)[number]): string => {
  if (scope === "repository") {
    return target.repositoryPath;
  }
  if (scope === "workspace") {
    return workspaceRoot;
  }
  if (scope === "global-repository") {
    return `/home/hooks/${target.repositoryName}`;
  }
  return "/home/hooks";
};

const createSources = (): SourceDescriptor[] => [
  inline("pre-create", "workspace", null),
  inline("post-create", "workspace", null),
  ...targets.flatMap((target) => [
    inline("pre-create", "repository", target.repositoryName),
    inline("post-create", "repository", target.repositoryName),
  ]),
];

const removeSources = (): SourceDescriptor[] => [
  inline("pre-remove", "workspace", null),
  inline("post-remove", "workspace", null),
  ...targets.flatMap((target) => [
    inline("pre-remove", "repository", target.repositoryName),
    file("pre-remove", "global-repository", {
      executionPath: `/home/hooks/${target.repositoryName}`,
      ownerName: null,
      targetRepositoryName: target.repositoryName,
    }),
    file("pre-remove", "global-shared", {
      executionPath: "/home/hooks",
      ownerName: null,
      targetRepositoryName: target.repositoryName,
    }),
    inline("post-remove", "repository", target.repositoryName),
    file("post-remove", "global-repository", {
      executionPath: `/home/hooks/${target.repositoryName}`,
      ownerName: null,
      targetRepositoryName: target.repositoryName,
    }),
    file("post-remove", "global-shared", {
      executionPath: "/home/hooks",
      ownerName: null,
      targetRepositoryName: target.repositoryName,
    }),
  ]),
];

describe("AC-03/04/07/11 shared lifecycle source planner RED", () => {
  test("AC-03 plans workspace once around materialized per-repository create boundaries with exact context and rollback ownership", async () => {
    const plan = planLifecycleHookSources({
      consumer: "create",
      sources: createSources(),
      targets,
      workspaceRoot,
    });

    expect(plan.classification).toBe("ready");
    expect(
      plan.entries.map(({ context, failureDisposition, hookName, slot }) => ({
        context,
        failureDisposition,
        hookName,
        slot,
      })),
    ).toEqual([
      {
        context: {
          branchName: "feature/inline",
          cwd: workspaceRoot,
          repositoryName: null,
          repositoryPath: null,
          workspaceRoot,
          worktreePath: null,
        },
        failureDisposition: "rollback-owned-create",
        hookName: "pre-create",
        slot: "create.workspace.pre",
      },
      ...targets.flatMap((target) => [
        {
          context: {
            branchName: target.branchName,
            cwd: target.worktreePath,
            repositoryName: target.repositoryName,
            repositoryPath: target.repositoryPath,
            workspaceRoot,
            worktreePath: target.worktreePath,
          },
          failureDisposition: "rollback-owned-create" as const,
          hookName: `pre-create.${target.repositoryName}`,
          slot: "create.repository.pre-after-materialization" as const,
        },
        {
          context: {
            branchName: target.branchName,
            cwd: target.worktreePath,
            repositoryName: target.repositoryName,
            repositoryPath: target.repositoryPath,
            workspaceRoot,
            worktreePath: target.worktreePath,
          },
          failureDisposition: "rollback-owned-create" as const,
          hookName: `post-create.${target.repositoryName}`,
          slot: "create.repository.post-materialization" as const,
        },
      ]),
      {
        context: {
          branchName: "feature/inline",
          cwd: workspaceRoot,
          repositoryName: null,
          repositoryPath: null,
          workspaceRoot,
          worktreePath: null,
        },
        failureDisposition: "rollback-owned-create",
        hookName: "post-create",
        slot: "create.workspace.post",
      },
    ]);
    expect(plan.entries.filter((entry) => entry.scope === "workspace")).toHaveLength(2);
  });

  test("AC-04 plans every remove target in repository to workspace to targeted-global to shared-global order behind one all-target destructive gate", async () => {
    const plan = planLifecycleHookSources({
      consumer: "remove",
      sources: removeSources(),
      targets,
      workspaceRoot,
    });

    expect(plan.classification).toBe("ready");
    if (plan.classification !== "ready") {
      throw new Error("Expected a ready remove lifecycle plan");
    }
    expect(plan.removeGate).toEqual({
      destructiveMutationAfterAllPreflight: true,
      postFinalizationRetainsOperationFailures: true,
      preflightSourceCount: 16,
    });
    expect(
      plan.entries.map((entry) =>
        [
          entry.lifecycle,
          entry.context.repositoryName,
          entry.scope,
          entry.context.cwd,
          entry.slot,
          entry.failureDisposition,
        ].join("|"),
      ),
    ).toEqual([
      ...targets.flatMap((target) =>
        (["repository", "workspace", "global-repository", "global-shared"] as const).map((scope) =>
          [
            "pre-remove",
            target.repositoryName,
            scope,
            executionPathForScope(scope, target),
            "remove.target.pre-destruction",
            "gate-all-targets",
          ].join("|"),
        ),
      ),
      ...targets.flatMap((target) =>
        (["repository", "workspace", "global-repository", "global-shared"] as const).map((scope) =>
          [
            "post-remove",
            target.repositoryName,
            scope,
            executionPathForScope(scope, target),
            "remove.target.post-finalization",
            "retain-finalization",
          ].join("|"),
        ),
      ),
    ]);
    expect(
      plan.entries.filter(
        (entry) => entry.scope === "workspace" && entry.lifecycle === "pre-remove",
      ),
    ).toHaveLength(targets.length);
    expect(
      plan.entries.filter(
        (entry) => entry.scope === "workspace" && entry.lifecycle === "post-remove",
      ),
    ).toHaveLength(targets.length);
    const globalEntries = plan.entries.filter((entry) => entry.sourceOwnerKind === "global");
    expect(globalEntries).toHaveLength(targets.length * 4);
    for (const entry of globalEntries) {
      expect(entry.sourceOwnerName).toBeNull();
      expect(entry.targetRepositoryName).toBe(entry.context.repositoryName);
    }
  });

  test("AC-07 classifies same-location ambiguity per consumer before process or mutation while different scopes compose", async () => {
    const plan = planLifecycleHookSources;
    for (const [consumer, lifecycle, code] of [
      ["create", "pre-create", "CREATE_FAILED"],
      ["remove", "pre-remove", "HOOK_CONFIGURATION_INVALID"],
      ["remove-dry-run", "pre-remove", "HOOK_CONFIGURATION_INVALID"],
      ["doctor", "pre-remove", "HOOK_AMBIGUOUS"],
    ] as const) {
      const inlineSource = inline(lifecycle, "workspace", null);
      const fileSource = file(lifecycle, "workspace", {
        executionPath: workspaceRoot,
        ownerName: null,
      });
      const ambiguous = plan({
        consumer,
        sources: [inlineSource, fileSource],
        targets: [targets[0]],
        workspaceRoot,
      });
      expect(ambiguous).toMatchObject({
        classification: "ambiguous",
        entries: [],
        failure: {
          code,
          hookName: lifecycle,
          scope: "workspace",
          sourceKinds: ["file", "inline-config"],
          sourceOwnerKind: "workspace",
          sourceOwnerName: null,
          sourceScriptPath: fileSource.sourceScriptPath,
        },
      });
    }

    const firstFile = file("pre-remove", "workspace", {
      executionPath: workspaceRoot,
      ownerName: null,
    });
    firstFile.sourceScriptPath = `${workspaceRoot}/.arashi/hooks/pre-remove.ps1`;
    const secondFile = { ...firstFile };
    secondFile.sourceScriptPath = `${workspaceRoot}/.arashi/hooks/pre-remove.cmd`;
    const fileAmbiguity = plan({
      consumer: "doctor",
      sources: [firstFile, secondFile],
      targets: [targets[0]],
      workspaceRoot,
    });
    expect(fileAmbiguity).toMatchObject({
      classification: "ambiguous",
      entries: [],
      failure: {
        code: "HOOK_AMBIGUOUS",
        hookName: "pre-remove",
        scope: "workspace",
        sourceKinds: ["file", "file"],
        sourceOwnerKind: "workspace",
        sourceOwnerName: null,
        sourceScriptPath: firstFile.sourceScriptPath,
      },
    });

    const fileSource = file("pre-remove", "workspace", {
      executionPath: workspaceRoot,
      ownerName: null,
    });
    const composed = plan({
      consumer: "remove",
      sources: [inline("pre-remove", "repository", "alpha"), fileSource],
      targets: [targets[0]],
      workspaceRoot,
    });
    expect(composed.classification).toBe("ready");
    expect(composed.entries.map((entry) => `${entry.scope}:${entry.sourceKind}`)).toEqual([
      "repository:inline-config",
      "workspace:file",
    ]);
  });

  test("AC-11 maps every root and repository lifecycle field to its exact outward name and lifecycle slot", async () => {
    const plan = planLifecycleHookSources;
    const allSources = (
      ["pre-create", "post-create", "pre-remove", "post-remove"] as const
    ).flatMap((lifecycle) => [
      inline(lifecycle, "workspace", null),
      inline(lifecycle, "repository", "alpha"),
    ]);
    const createPlan = plan({
      consumer: "create",
      sources: allSources,
      targets: [targets[0]],
      workspaceRoot,
    });
    const removePlan = plan({
      consumer: "remove",
      sources: allSources,
      targets: [targets[0]],
      workspaceRoot,
    });

    expect(
      [...createPlan.entries, ...removePlan.entries].map((entry) => ({
        configuredField: entry.configuredField,
        hookName: entry.hookName,
        slot: entry.slot,
      })),
    ).toEqual([
      {
        configuredField: "hooks.scripts.pre-create",
        hookName: "pre-create",
        slot: "create.workspace.pre",
      },
      {
        configuredField: "repos.alpha.hooks.pre-create",
        hookName: "pre-create.alpha",
        slot: "create.repository.pre-after-materialization",
      },
      {
        configuredField: "repos.alpha.hooks.post-create",
        hookName: "post-create.alpha",
        slot: "create.repository.post-materialization",
      },
      {
        configuredField: "hooks.scripts.post-create",
        hookName: "post-create",
        slot: "create.workspace.post",
      },
      {
        configuredField: "repos.alpha.hooks.pre-remove",
        hookName: "pre-remove",
        slot: "remove.target.pre-destruction",
      },
      {
        configuredField: "hooks.scripts.pre-remove",
        hookName: "pre-remove",
        slot: "remove.target.pre-destruction",
      },
      {
        configuredField: "repos.alpha.hooks.post-remove",
        hookName: "post-remove",
        slot: "remove.target.post-finalization",
      },
      {
        configuredField: "hooks.scripts.post-remove",
        hookName: "post-remove",
        slot: "remove.target.post-finalization",
      },
    ]);
  });

  test("prepares planner-ordered immutable entries with one frozen inline resolution and a secret-free plan", async () => {
    const executableDirectory = await mkdtemp(join(tmpdir(), "arashi-hook-planner-"));
    const executablePath = join(executableDirectory, "bash");
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);
    const snippet = "printf 'private payload'";
    const source = {
      ...inline("pre-create", "workspace", null),
      sourceKind: "inline-config" as const,
    };

    const prepared = await prepareLifecycleHookSources({
      candidates: [
        {
          interpreters: { bash: snippet },
          kind: "inline-config",
          source,
        },
      ],
      consumer: "create",
      env: { PATH: executableDirectory },
      platform: "linux",
      targets: [targets[0]],
      workspaceRoot,
    });

    expect(prepared.classification).toBe("ready");
    if (prepared.classification !== "ready") {
      throw new Error("Expected a ready prepared lifecycle plan");
    }
    expect(prepared.entries).toHaveLength(1);
    const [entry] = prepared.entries;
    expect(entry).toMatchObject({
      kind: "inline-config",
      plan: { hookName: "pre-create", slot: "create.workspace.pre" },
      resolution: {
        available: true,
        executablePath: await realpath(executablePath),
        interpreter: "bash",
      },
      snippet,
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.entries)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.plan)).toBe(true);
    expect(entry?.kind).toBe("inline-config");
    if (entry?.kind !== "inline-config") throw new Error("Expected an inline prepared entry");
    expect(Object.isFrozen(entry.resolution)).toBe(true);
    expect(JSON.stringify(prepared.plan)).not.toContain(snippet);
  });
});
