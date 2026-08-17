import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config, LoadedConfig } from "../../../src/lib/config.ts";
import type { Repository } from "../../../src/core/repository.ts";
import {
  executeCreate,
  resolveReusableMaterializationTarget,
} from "../../../src/commands/create.ts";

type CreateDependencies = NonNullable<Parameters<typeof executeCreate>[2]>;

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("configured create materialization precedence RED", () => {
  test("reports a blocking plan before managed-ignore mutation and preserves ignore files and preferences", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "arashi-materialization-precedence-"));
    cleanupRoots.push(workspaceRoot);
    const localExcludePath = join(workspaceRoot, ".git", "info", "exclude");
    const preferencePath = join(workspaceRoot, ".git", "config");
    await mkdir(join(workspaceRoot, ".git", "info"), { recursive: true });
    await writeFile(localExcludePath, "# original exclude\n");
    await writeFile(preferencePath, "[arashi]\n\tignoreScope = local\n");

    const repository: Repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "app",
      path: join(workspaceRoot, "repos", "app"),
    };
    const config = {
      repos: { app: { copy: ["config/local.json"], path: "./repos/app" } },
      reposDir: "./repos",
      version: "1.0.0",
    } as unknown as Config;
    const loaded: LoadedConfig = {
      config,
      configPath: join(workspaceRoot, ".arashi", "config.json"),
      source: "local-file",
    };
    const events: string[] = [];
    const blocker = Object.assign(new Error("Tracked destination blocks materialization"), {
      code: "MATERIALIZATION_PLAN_BLOCKED",
      details: {
        dryRunOutcome: {
          materializationPlans: [
            {
              outcomes: [
                {
                  action: "copy",
                  path: "config/local.json",
                  reasonCode: "destination_exists",
                  status: "blocked",
                },
              ],
              repositoryId: "app",
            },
          ],
        },
      },
    });

    const dependencies = {
      applyRepositoryFilter: async (_filter: unknown, selected: Repository[]) => selected,
      createCoordinatedWorktrees: async () => {
        events.push("create");
        return {
          errorSummary: null,
          failureCount: 0,
          hookOutcomes: [],
          nextSteps: [],
          repositoryResults: [],
          rolledBack: false,
          skippedCount: 0,
          successCount: 0,
          targetActionByRepositoryPath: new Map<string, "created">(),
          totalDuration: 0,
          totalRepositories: 0,
        };
      },
      discoverRepositories: async () => ({
        duration: 0,
        errors: [],
        repositories: [repository],
        scanDepth: 0,
        scannedDirectories: 1,
        workspacePath: join(workspaceRoot, "repos"),
      }),
      isGitRepository: async () => false,
      loadConfigWithFallback: async () => loaded,
      preflightMaterialization: async (input: { reuseExisting: boolean }) => {
        expect(input.reuseExisting).toBe(true);
        events.push("materialization-preflight");
        throw blocker;
      },
      reconcileManagedIgnore: async () => {
        events.push("managed-ignore");
        await writeFile(localExcludePath, "# mutated exclude\n");
        await writeFile(preferencePath, "[arashi]\n\tignoreScope = tracked\n");
        return {
          appliedRules: ["/.arashi/worktrees/"],
          attempted: true,
          changed: true,
          fileChanges: { local: true, preference: true, tracked: false },
          localExcludePath,
          paths: [localExcludePath, preferencePath],
          plannedRules: ["/.arashi/worktrees/"],
          restored: false,
          scope: "local" as const,
          staleRules: [],
          storedPreference: "local" as const,
          trackedIgnorePath: join(workspaceRoot, ".gitignore"),
          warnings: [],
        };
      },
      resolveCreateBasePlan: async () => ({
        byCanonicalPath: new Map([
          [
            repository.path,
            {
              repositoryName: repository.name,
              repositoryPath: repository.path,
              resolvedOid: "0123456789abcdef",
              resolvedRef: "refs/heads/main",
            },
          ],
        ]),
        repositories: [
          {
            repositoryName: repository.name,
            repositoryPath: repository.path,
            resolvedOid: "0123456789abcdef",
            resolvedRef: "refs/heads/main",
          },
        ],
        requestedBranch: "main",
        source: "repository-default" as const,
      }),
      resolveCreateInvocationContext: async () => ({
        executionPath: workspaceRoot,
        invocationPath: workspaceRoot,
        repositoryType: "non-bare" as const,
        workspaceRoot,
      }),
      resolveManagedIgnoreWorkspaceRoot: async () => workspaceRoot,
      stdinIsTTY: true,
      resolveWorkspaceContext: async () => ({
        config,
        invocationPath: workspaceRoot,
        mode: "configured" as const,
        workspaceRoot,
      }),
    } as unknown as CreateDependencies;

    const result = await executeCreate("feature/materialization", {}, dependencies).catch(
      (error: unknown) => error,
    );

    expect(result).toMatchObject({ code: "MATERIALIZATION_PLAN_BLOCKED" });
    expect(events).toEqual(["materialization-preflight"]);
    expect(await readFile(localExcludePath, "utf8")).toBe("# original exclude\n");
    expect(await readFile(preferencePath, "utf8")).toBe("[arashi]\n\tignoreScope = local\n");
  });

  test("ignores a stale remote-tracking branch when reuse has no local branch", async () => {
    const calls: string[][] = [];
    const repository = {
      defaultBranch: "main",
      hasSetupScript: false,
      name: "app",
      path: "/workspace/repos/app",
    } as Repository;
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[3]?.startsWith("refs/heads/")) throw new Error("missing local branch");
      return { stderr: "", stdout: "remote-target-oid\n" };
    };

    await expect(
      resolveReusableMaterializationTarget(repository, "feature/reuse", run as never),
    ).resolves.toBeUndefined();
    expect(calls.map((args) => args[3])).toEqual(["refs/heads/feature/reuse^{commit}"]);
  });
});
