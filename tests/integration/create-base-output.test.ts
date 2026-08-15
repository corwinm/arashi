import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { basename, join } from "node:path";
import { createChildHookWorkspace } from "../helpers/create-child-hook-workspace.ts";
import { createRepoSpecificHookInRepo } from "../helpers/hooks.ts";
import { runtime } from "../helpers/node-runtime.ts";
import { tmpdir } from "node:os";

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
type Workspace = Awaited<ReturnType<typeof createChildHookWorkspace>>;
const cleanups: (() => Promise<void>)[] = [];

const run = async (cwd: string, command: string[]) => {
  const process = runtime.spawn(command, {
    cwd,
    env: {
      ...globalThis.process.env,
      HOME: tmpdir(),
      NO_COLOR: "1",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const git = (cwd: string, ...args: string[]) => run(cwd, ["git", ...args]);
const arashi = (cwd: string, ...args: string[]) =>
  run(cwd, [globalThis.process.execPath, CLI_ENTRY, ...args]);
const oid = async (cwd: string, ref: string) => (await git(cwd, "rev-parse", ref)).stdout.trim();
const branchExists = async (cwd: string, branch: string) =>
  (await git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)).exitCode === 0;

const parseSingleDocument = (stdout: string) => {
  expect(stdout.endsWith("\n")).toBe(true);
  const value = JSON.parse(stdout);
  expect(stdout).toBe(`${JSON.stringify(value, null, 2)}\n`);
  return value;
};

const repositories = (workspace: Workspace) => [
  { name: workspace.workspaceName, path: workspace.workspacePath },
  ...workspace.childRepoNames
    .toSorted()
    .map((name) => ({ name, path: workspace.childRepoPaths[name]! })),
];

const configureBase = async (workspace: Workspace, baseBranch: string) => {
  const configPath = join(workspace.workspacePath, ".arashi", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.defaults = { create: { baseBranch } };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
};

const createMixedBaseRefs = async (workspace: Workspace, baseBranch: string) => {
  const entries = repositories(workspace);
  for (const entry of entries) {
    await git(entry.path, "branch", baseBranch, "main");
  }
  const remoteOnlyRepository = workspace.childRepoPaths[workspace.childRepoNames[0]!]!;
  const remoteOnlyOid = await oid(remoteOnlyRepository, baseBranch);
  await git(remoteOnlyRepository, "update-ref", `refs/remotes/origin/${baseBranch}`, remoteOnlyOid);
  await git(remoteOnlyRepository, "branch", "-D", baseBranch);
  return new Map(
    await Promise.all(
      entries.map(
        async (entry) =>
          [
            entry.path,
            await oid(
              entry.path,
              entry.path === remoteOnlyRepository
                ? `refs/remotes/origin/${baseBranch}`
                : `refs/heads/${baseBranch}`,
            ),
          ] as const,
      ),
    ),
  );
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("create base output contracts", () => {
  test("configured human dry-run reports normalized requested/resolved bases and planned actions without mutation", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    cleanups.push(workspace.cleanup);
    const base = "feature/base";
    const target = "feature/human-preview";
    await configureBase(workspace, `origin/${base}`);
    const baseOids = await createMixedBaseRefs(workspace, base);
    await git(workspace.childRepoPaths.beta!, "branch", target, "main");
    const reusedOid = await oid(workspace.childRepoPaths.beta!, target);

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--dry-run",
      "--conflict",
      "REUSE_EXISTING",
      "--no-progress",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Requested base: ${base} (config)`);
    for (const entry of repositories(workspace)) {
      const resolvedRef =
        entry.name === "alpha" ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
      const action = entry.name === "beta" ? "reused" : "created";
      expect(result.stdout).toContain(
        `  • ${entry.name}: ${resolvedRef} @ ${baseOids.get(entry.path)} [${action}]`,
      );
      expect(await branchExists(entry.path, target)).toBe(entry.name === "beta");
    }
    expect(await oid(workspace.childRepoPaths.beta!, target)).toBe(reusedOid);
    await expect(access(workspace.getMainWorktreePath(target))).rejects.toThrow();
  });

  test("configured dry-run JSON reports exact normalized ordered base metadata", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    cleanups.push(workspace.cleanup);
    const base = "feature/json-preview-base";
    const target = "feature/json-preview";
    const baseOids = await createMixedBaseRefs(workspace, base);
    await git(workspace.childRepoPaths.beta!, "branch", target, "main");

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--base",
      `origin/${base}`,
      "--only",
      `${workspace.workspaceName},alpha,beta`,
      "--dry-run",
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const envelope = parseSingleDocument(result.stdout);
    expect(envelope.data.base).toEqual({
      repositories: repositories(workspace).map((entry) => ({
        repositoryName: entry.name,
        repositoryPath: expect.stringMatching(/^\//),
        resolvedOid: baseOids.get(entry.path),
        resolvedRef: entry.name === "alpha" ? `refs/remotes/origin/${base}` : `refs/heads/${base}`,
        targetAction: entry.name === "beta" ? "reused" : "created",
      })),
      requestedBranch: base,
      source: "cli",
    });
    expect(
      envelope.data.base.repositories.map(
        (entry: { repositoryPath: string }) => entry.repositoryPath,
      ),
    ).toEqual(await Promise.all(repositories(workspace).map((entry) => realpath(entry.path))));
    expect(result.stdout).not.toMatch(/Found |Planning worktrees|Dry-run plan/);
  });

  test("configured dry-run JSON plans a remote-only target as created under reuse", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    cleanups.push(workspace.cleanup);
    const repositoryPath = workspace.childRepoPaths.alpha!;
    const remote = await mkdtemp(join(tmpdir(), "arashi-create-base-output-target-remote-"));
    cleanups.push(() => rm(remote, { force: true, recursive: true }));
    const base = "feature/remote-target-base";
    const target = "feature/remote-only-target";
    await git(repositoryPath, "branch", base, "main");
    await git(remote, "init", "--bare");
    await git(repositoryPath, "remote", "add", "origin", remote);
    await git(repositoryPath, "branch", target, "main");
    await git(repositoryPath, "push", "origin", target);
    await git(repositoryPath, "branch", "-D", target);

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--base",
      base,
      "--only",
      "alpha",
      "--dry-run",
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(parseSingleDocument(result.stdout).data.base.repositories).toEqual([
      expect.objectContaining({ repositoryName: "alpha", targetAction: "created" }),
    ]);
    expect(await branchExists(repositoryPath, target)).toBe(false);
  });

  test("configured JSON success reports config source and actual mixed created/reused actions", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["workspace", "beta"] });
    cleanups.push(workspace.cleanup);
    const base = "feature/config-base";
    const target = "feature/json-created";
    await configureBase(workspace, `origin/${base}`);
    const baseOids = await createMixedBaseRefs(workspace, base);
    await git(workspace.childRepoPaths.beta!, "branch", target, "main");
    const reusedOid = await oid(workspace.childRepoPaths.beta!, target);

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--conflict",
      "REUSE_EXISTING",
      "--no-hooks",
      "--json",
    );

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const envelope = parseSingleDocument(result.stdout);
    expect(envelope.data.base).toEqual({
      repositories: repositories(workspace).map((entry) => ({
        repositoryName: entry.name,
        repositoryPath: expect.stringMatching(/^\//),
        resolvedOid: baseOids.get(entry.path),
        resolvedRef:
          entry.path === workspace.childRepoPaths.workspace
            ? `refs/remotes/origin/${base}`
            : `refs/heads/${base}`,
        targetAction: entry.path === workspace.childRepoPaths.beta ? "reused" : "created",
      })),
      requestedBranch: base,
      source: "config",
    });
    expect(await oid(workspace.childRepoPaths.beta!, target)).toBe(reusedOid);
  });

  test("configured JSON failure retains reused target action after its post-create hook fails", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    cleanups.push(workspace.cleanup);
    const repositoryPath = workspace.childRepoPaths.alpha!;
    const base = "feature/failure-base";
    const target = "feature/reused-then-failed";
    await git(repositoryPath, "branch", base, "main");
    await git(repositoryPath, "branch", target, "main");
    const reusedOid = await oid(repositoryPath, target);
    createRepoSpecificHookInRepo(workspace.hookRootPath, "post-create", "alpha", "exit 23");

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--base",
      base,
      "--only",
      "alpha",
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    );

    expect(result.exitCode).toBe(1);
    const envelope = parseSingleDocument(result.stdout);
    expect(envelope).toMatchObject({
      error: {
        code: "CREATE_FAILED",
        details: {
          base: {
            repositories: [
              {
                repositoryName: "alpha",
                repositoryPath: await realpath(repositoryPath),
                resolvedOid: await oid(repositoryPath, base),
                resolvedRef: `refs/heads/${base}`,
                targetAction: "reused",
              },
            ],
            requestedBranch: base,
            source: "cli",
          },
        },
      },
      ok: false,
    });
    expect(await oid(repositoryPath, target)).toBe(reusedOid);
    await expect(access(workspace.getChildWorktreePath("alpha", target))).rejects.toThrow();
  });

  test("configured JSON invalid target preserves validation failure and complete pre-action base ledger", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    cleanups.push(workspace.cleanup);
    const base = "feature/valid-invalid-target-base";
    const target = "bad branch";
    for (const entry of repositories(workspace)) {
      await git(entry.path, "branch", base, "main");
    }

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--base",
      base,
      "--only",
      `${workspace.workspaceName},alpha,beta`,
      "--json",
    );

    expect(result.exitCode).toBe(1);
    const envelope = parseSingleDocument(result.stdout);
    const expectedBaseRepositories = await Promise.all(
      repositories(workspace).map(async (entry) => ({
        repositoryName: entry.name,
        repositoryPath: await realpath(entry.path),
        resolvedOid: await oid(entry.path, base),
        resolvedRef: `refs/heads/${base}`,
        targetAction: "created",
      })),
    );
    expect(envelope).toMatchObject({
      error: {
        code: "CREATE_FAILED",
        details: {
          base: {
            repositories: expectedBaseRepositories,
            requestedBranch: base,
            source: "cli",
          },
        },
        message: `Invalid branch name: ${target}`,
      },
      ok: false,
    });
    expect(envelope.error.code).not.toBe("UNKNOWN_ERROR");
    expect(result.stderr).toBe("");
    for (const entry of repositories(workspace)) {
      expect(await branchExists(entry.path, target)).toBe(false);
    }
    await expect(access(workspace.getMainWorktreePath(target))).rejects.toThrow();
    for (const childName of workspace.childRepoNames) {
      await expect(access(workspace.getChildWorktreePath(childName, target))).rejects.toThrow();
    }
  });

  test("global pre-create failure reports complete planned actions in selected order", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    cleanups.push(workspace.cleanup);
    const base = "feature/early-failure-base";
    const target = "feature/early-failure-target";
    for (const entry of repositories(workspace)) {
      await git(entry.path, "branch", base, "main");
    }
    await git(workspace.workspacePath, "branch", target, "main");
    await git(workspace.childRepoPaths.beta!, "branch", target, "main");
    const preCreateHook = join(workspace.hookRootPath, ".arashi", "hooks", "pre-create.sh");
    await writeFile(preCreateHook, "#!/bin/sh\nexit 29\n");
    await chmod(preCreateHook, 0o755);

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--base",
      base,
      "--only",
      `${workspace.workspaceName},alpha,beta`,
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    );

    expect(result.exitCode).toBe(1);
    const envelope = parseSingleDocument(result.stdout);
    expect(envelope.error.details.base.repositories).toEqual(
      repositories(workspace).map((entry) =>
        expect.objectContaining({
          repositoryName: entry.name,
          targetAction:
            entry.name === workspace.workspaceName || entry.name === "beta" ? "reused" : "created",
        }),
      ),
    );
    expect(envelope.error.details.repositories).toEqual([]);
  });

  test("aggregated JSON base failure is one uncontaminated affected-only envelope with exact attempts", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha", "beta"] });
    cleanups.push(workspace.cleanup);
    const base = "feature/partially-missing";
    const target = "feature/must-not-exist";
    await git(workspace.childRepoPaths.alpha!, "branch", base, "main");

    const result = await arashi(
      workspace.workspacePath,
      "create",
      target,
      "--base",
      `origin/${base}`,
      "--json",
    );

    expect(result.exitCode).toBe(1);
    const envelope = parseSingleDocument(result.stdout);
    const affected = [repositories(workspace)[0]!, repositories(workspace)[2]!];
    expect(envelope).toEqual({
      command: "create",
      error: {
        code: "CREATE_BASE_RESOLUTION_FAILED",
        details: {
          repositories: affected.map((entry) => ({
            attemptedRefs: [`refs/heads/${base}`, `refs/remotes/origin/${base}`],
            repositoryName: entry.name,
            repositoryPath: expect.stringMatching(/^\//),
          })),
          requestedBranch: base,
          source: "cli",
        },
        message: `Base branch '${base}' could not be resolved in: ${affected.map((entry) => entry.name).join(", ")}`,
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
    expect(
      envelope.error.details.repositories.map(
        (entry: { repositoryPath: string }) => entry.repositoryPath,
      ),
    ).toEqual(await Promise.all(affected.map((entry) => realpath(entry.path))));
    expect(result.stdout).not.toMatch(/Found |Creating worktrees|Planning worktrees/);
    for (const entry of repositories(workspace)) {
      expect(await branchExists(entry.path, target)).toBe(false);
    }
  });

  test("human base failure enumerates every affected repository and attempted ref without mutation", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    cleanups.push(workspace.cleanup);
    const base = "feature/missing-human";
    const target = "feature/human-failure";

    const result = await arashi(workspace.workspacePath, "create", target, "--base", base);

    expect(result.exitCode).toBe(1);
    for (const entry of repositories(workspace)) {
      expect(result.stderr).toContain(entry.name);
      expect(result.stderr).toContain(`refs/heads/${base}`);
      expect(result.stderr).toContain(`refs/remotes/origin/${base}`);
      expect(await branchExists(entry.path, target)).toBe(false);
    }
  });

  test("omitted base preserves the configured dry-run JSON data shape exactly", async () => {
    const workspace = await createChildHookWorkspace({ childRepoNames: ["alpha"] });
    cleanups.push(workspace.cleanup);
    const result = await arashi(
      workspace.workspacePath,
      "create",
      "feature/legacy-shape",
      "--dry-run",
      "--json",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const { data } = parseSingleDocument(result.stdout);
    expect(data).not.toHaveProperty("base");
    expect(Object.keys(data).toSorted()).toEqual(
      [
        "branchName",
        "dirtyWorkspaceGuidance",
        "dryRun",
        "errorSummary",
        "failureCount",
        "hookOutcomes",
        "managedIgnore",
        "mode",
        "moveSummary",
        "nextSteps",
        "repositories",
        "repositoriesBase",
        "rolledBack",
        "skippedCount",
        "successCount",
        "totalDuration",
        "totalRepositories",
        "workspaceRoot",
        "worktreesBase",
      ].toSorted(),
    );
  });

  test("standalone explicit base uses the same success/error shape and human dry-run is mutation-free", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-create-base-output-standalone-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.name", "Test User");
    await git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "README.md"), "fixture\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "initial");
    expect((await arashi(root, "init", "--zero-config", "--json")).exitCode).toBe(0);
    const base = "feature/standalone-base";
    await git(root, "branch", base, "main");
    const baseOid = await oid(root, base);

    const preview = await arashi(
      root,
      "create",
      "feature/standalone-preview",
      "--base",
      `origin/${base}`,
      "--dry-run",
    );
    expect(preview.exitCode, `${preview.stdout}\n${preview.stderr}`).toBe(0);
    expect(preview.stdout).toContain(`Requested base: ${base} (cli)`);
    expect(preview.stdout).toContain(`refs/heads/${base} @ ${baseOid} [created]`);
    expect(await branchExists(root, "feature/standalone-preview")).toBe(false);

    const created = await arashi(
      root,
      "create",
      "feature/standalone-created",
      "--base",
      `origin/${base}`,
      "--json",
    );
    expect(created.exitCode, created.stderr).toBe(0);
    const { data } = parseSingleDocument(created.stdout);
    expect(data.base).toEqual({
      repositories: [
        {
          repositoryName: basename(root),
          repositoryPath: await realpath(root),
          resolvedOid: baseOid,
          resolvedRef: `refs/heads/${base}`,
          targetAction: "created",
        },
      ],
      requestedBranch: base,
      source: "cli",
    });

    await git(root, "branch", "feature/standalone-reused", "main");
    const reused = await arashi(
      root,
      "create",
      "feature/standalone-reused",
      "--base",
      base,
      "--dry-run",
      "--json",
    );
    expect(reused.exitCode, reused.stderr).toBe(0);
    expect(parseSingleDocument(reused.stdout).data.base.repositories[0].targetAction).toBe(
      "reused",
    );

    const failed = await arashi(
      root,
      "create",
      "feature/standalone-failed",
      "--base",
      "missing",
      "--json",
    );
    expect(failed.exitCode).toBe(1);
    expect(parseSingleDocument(failed.stdout).error).toEqual({
      code: "CREATE_BASE_RESOLUTION_FAILED",
      details: {
        repositories: [
          {
            attemptedRefs: ["refs/heads/missing", "refs/remotes/origin/missing"],
            repositoryName: basename(root),
            repositoryPath: await realpath(root),
          },
        ],
        requestedBranch: "missing",
        source: "cli",
      },
      message: `Base branch 'missing' could not be resolved in: ${basename(root)}`,
    });
  });
});
