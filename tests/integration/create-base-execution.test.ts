import { afterEach, describe, expect, test } from "vitest";
import type { Repository } from "../../src/core/repository.ts";
import { access } from "node:fs/promises";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { createCoordinatedWorktrees } from "../../src/core/worktree.ts";
import { createRepoSpecificHookInRepo } from "../helpers/hooks.ts";
import { exec } from "../../src/lib/git.ts";
import { join } from "node:path";
import { resolveCreateBasePlan } from "../../src/lib/create-base.ts";

type Workspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;

let workspace: Workspace | null = null;

afterEach(async () => {
  if (workspace) {
    await workspace.cleanup();
    workspace = null;
  }
});

const repositoriesFor = (current: Workspace, childNames = current.childRepoNames): Repository[] => [
  {
    defaultBranch: "main",
    hasSetupScript: false,
    name: current.workspaceName,
    path: current.workspacePath,
  },
  ...childNames.map((name) => ({
    defaultBranch: "main",
    hasSetupScript: false,
    name,
    path: current.childRepoPaths[name]!,
  })),
];

const oid = async (repositoryPath: string, ref: string): Promise<string> =>
  (await exec(["rev-parse", ref], repositoryPath)).stdout.trim();

const createBaseBranch = async (repository: Repository, branchName: string): Promise<void> => {
  await exec(["branch", branchName, repository.defaultBranch], repository.path);
};

const moveBaseBranch = async (repository: Repository, branchName: string): Promise<void> => {
  await exec(["commit", "--allow-empty", "-m", `Move ${branchName}`], repository.path);
  await exec(["branch", "-f", branchName, repository.defaultBranch], repository.path);
};

const createUnrelatedBranch = async (
  repository: Repository,
  branchName: string,
): Promise<string> => {
  await exec(["switch", "--orphan", branchName], repository.path);
  await exec(["rm", "-rf", "."], repository.path).catch(() => {});
  await exec(["commit", "--allow-empty", "-m", `Unrelated ${branchName}`], repository.path);
  const branchOid = await oid(repository.path, branchName);
  await exec(["switch", repository.defaultBranch], repository.path);
  return branchOid;
};

const pathExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("immutable configured create-base execution", () => {
  test("creates new parent and child targets from captured OIDs after their resolved refs move", async () => {
    workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    const repositories = repositoriesFor(workspace);
    const baseBranch = "feature/base";
    const targetBranch = "feature/target";

    for (const repository of repositories) {
      await createBaseBranch(repository, baseBranch);
    }
    const plan = await resolveCreateBasePlan(repositories, baseBranch, "cli");
    const captured = new Map(plan.repositories.map((entry) => [entry.repositoryName, entry]));

    for (const repository of repositories) {
      await moveBaseBranch(repository, baseBranch);
      expect(await oid(repository.path, baseBranch)).not.toBe(
        captured.get(repository.name)?.resolvedOid,
      );
    }

    const result = await createCoordinatedWorktrees(targetBranch, repositories, {
      createBasePlan: plan,
      executeHooks: false,
      showProgress: false,
      workspaceRoot: workspace.workspacePath,
    });

    expect(result.failureCount).toBe(0);
    for (const repository of repositories) {
      const resolution = captured.get(repository.name)!;
      expect(await oid(repository.path, targetBranch)).toBe(resolution.resolvedOid);
      expect(resolution.resolvedRef).toBe(`refs/heads/${baseBranch}`);
    }
  });

  test("preserves an unrelated reused child target while creating the parent from its captured OID", async () => {
    workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    const repositories = repositoriesFor(workspace);
    const [parent, child] = repositories;
    const baseBranch = "feature/base";
    const targetBranch = "feature/mixed-target";

    for (const repository of repositories) {
      await createBaseBranch(repository, baseBranch);
    }
    const reusedOid = await createUnrelatedBranch(child!, targetBranch);
    const plan = await resolveCreateBasePlan(repositories, baseBranch, "config");
    await exec(["commit", "--allow-empty", "-m", "Move parent default"], parent!.path);
    expect(await oid(parent!.path, parent!.defaultBranch)).not.toBe(
      plan.repositories[0]!.resolvedOid,
    );

    const result = await createCoordinatedWorktrees(targetBranch, repositories, {
      conflictResolution: "REUSE_EXISTING",
      createBasePlan: plan,
      executeHooks: false,
      showProgress: false,
      workspaceRoot: workspace.workspacePath,
    });

    expect(result.failureCount).toBe(0);
    expect(await oid(parent!.path, targetBranch)).toBe(plan.repositories[0]!.resolvedOid);
    expect(await oid(child!.path, targetBranch)).toBe(reusedOid);
    await expect(
      exec(["merge-base", "--is-ancestor", baseBranch, targetBranch], child!.path),
    ).rejects.toThrow();
  });

  test("rolls back only invocation-created targets after a later hook failure", async () => {
    workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    const repositories = repositoriesFor(workspace);
    const [parent, reusedChild, failingChild] = repositories;
    const baseBranch = "feature/base";
    const targetBranch = "feature/rollback-target";

    for (const repository of repositories) {
      await createBaseBranch(repository, baseBranch);
    }
    const reusedOid = await createUnrelatedBranch(reusedChild!, targetBranch);
    const unrelatedPath = join(workspace.rootPath, "unrelated-parent-worktree");
    await exec(
      ["worktree", "add", "-b", "unrelated-worktree", unrelatedPath, "main"],
      parent!.path,
    );
    const unrelatedOid = await oid(parent!.path, "unrelated-worktree");
    const plan = await resolveCreateBasePlan(repositories, baseBranch, "cli");
    const baseOids = new Map(
      repositories.map((repository) => [repository.path, oid(repository.path, baseBranch)]),
    );
    const resolvedBaseOids = new Map(
      await Promise.all([...baseOids].map(async ([path, value]) => [path, await value] as const)),
    );

    createRepoSpecificHookInRepo(
      workspace.hookRootPath,
      "post-create",
      failingChild!.name,
      "exit 23",
    );

    const result = await createCoordinatedWorktrees(targetBranch, repositories, {
      conflictResolution: "REUSE_EXISTING",
      createBasePlan: plan,
      executeHooks: true,
      showProgress: false,
      workspaceRoot: workspace.workspacePath,
    });

    expect(result.rolledBack).toBe(true);
    await expect(
      exec(["show-ref", "--verify", `refs/heads/${targetBranch}`], parent!.path),
    ).rejects.toThrow();
    await expect(
      exec(["show-ref", "--verify", `refs/heads/${targetBranch}`], failingChild!.path),
    ).rejects.toThrow();
    expect(await oid(reusedChild!.path, targetBranch)).toBe(reusedOid);
    expect(await pathExists(workspace.getChildWorktreePath(reusedChild!.name, targetBranch))).toBe(
      false,
    );
    expect(await pathExists(unrelatedPath)).toBe(true);
    expect(await oid(parent!.path, "unrelated-worktree")).toBe(unrelatedOid);
    for (const repository of repositories) {
      expect(await oid(repository.path, baseBranch)).toBe(resolvedBaseOids.get(repository.path));
    }
  });

  test("fails clearly and rolls back earlier targets when a participating repository is missing from the plan", async () => {
    workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    const repositories = repositoriesFor(workspace);
    const [parent, child] = repositories;
    const baseBranch = "feature/base";
    const targetBranch = "feature/incomplete-plan";

    for (const repository of repositories) {
      await createBaseBranch(repository, baseBranch);
    }
    const completePlan = await resolveCreateBasePlan(repositories, baseBranch, "cli");
    const parentResolution = completePlan.repositories.find(
      (resolution) => resolution.repositoryName === parent!.name,
    )!;
    const incompletePlan = {
      ...completePlan,
      byCanonicalPath: new Map([[parentResolution.repositoryPath, parentResolution]]),
      repositories: [parentResolution],
    };

    const result = await createCoordinatedWorktrees(targetBranch, repositories, {
      createBasePlan: incompletePlan,
      executeHooks: false,
      showProgress: false,
      workspaceRoot: workspace.workspacePath,
    });

    expect(result.rolledBack).toBe(true);
    expect(result.errorSummary).toContain("missing immutable create-base plan entry");
    for (const repository of [parent!, child!]) {
      await expect(
        exec(["show-ref", "--verify", `refs/heads/${targetBranch}`], repository.path),
      ).rejects.toThrow();
    }
  });
});
