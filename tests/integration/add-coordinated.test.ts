import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { executeAdd, type AddExecutionDependencies } from "../../src/commands/add.ts";
import { AddCommandError } from "../../src/lib/errors.ts";
import { clone as cloneRepository } from "../../src/lib/git.ts";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");
const temporaryRoots: string[] = [];

interface ProcessResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

type InjectableAddDependencies = AddExecutionDependencies & {
  isEffectivelyIgnored?: (workspaceRoot: string, path: string) => Promise<boolean>;
  refExists?: (repositoryPath: string, ref: string) => Promise<boolean>;
};

const run = async (cwd: string, command: string[]): Promise<ProcessResult> => {
  const process = runtime.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await run(cwd, ["git", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};

const initialize = async (path: string, bare = false): Promise<void> => {
  await mkdir(path, { recursive: true });
  await git(path, bare ? ["init", "--bare"] : ["init", "-b", "main"]);
  if (bare) return;
  await git(path, ["config", "user.email", "test@example.com"]);
  await git(path, ["config", "user.name", "Test User"]);
  await writeFile(join(path, "README.md"), "fixture\n");
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "initial"]);
};

const seedChildRemote = async (
  root: string,
  branches: string[] = [],
  includeSetup = true,
): Promise<string> => {
  const remote = join(root, "child.git");
  await initialize(remote, true);
  const seed = join(root, "child-seed");
  await git(root, ["clone", remote, seed]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await git(seed, ["config", "user.name", "Test User"]);
  await writeFile(join(seed, "README.md"), "child\n");
  if (includeSetup) await writeFile(join(seed, "setup.sh"), "#!/bin/sh\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "initial"]);
  await git(seed, ["branch", "-M", "main"]);
  await git(seed, ["push", "origin", "main"]);
  for (const branch of branches) await git(seed, ["push", "origin", `main:${branch}`]);
  await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return remote;
};

const createParentTopology = async (
  branch: string,
  options: { canonicalBranch?: string; trackedReposIgnore?: boolean } = {},
): Promise<{ active: string; canonical: string; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "arashi-add-coordinated-"));
  temporaryRoots.push(root);
  const canonical = join(root, "canonical-parent");
  await initialize(canonical);
  const canonicalBranch = options.canonicalBranch ?? "main";
  if (canonicalBranch !== "main") await git(canonical, ["branch", "-m", canonicalBranch]);
  await mkdir(join(canonical, ".arashi"), { recursive: true });
  await writeFile(
    join(canonical, ".arashi", "config.json"),
    `${JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }, null, 2)}\n`,
  );
  if (options.trackedReposIgnore !== false) {
    await writeFile(join(canonical, ".gitignore"), "repos/\n");
  }
  await git(canonical, ["add", "."]);
  await git(canonical, ["commit", "-m", "configure"]);
  const active = join(root, "custom", "active-parent");
  await mkdir(join(root, "custom"), { recursive: true });
  await git(canonical, ["worktree", "add", "-b", branch, active, canonicalBranch]);
  return { active, canonical, root };
};

const runAdd = (cwd: string, remote: string): Promise<ProcessResult> =>
  run(cwd, [process.execPath, CLI_ENTRY, "add", remote, "--json", "--force"]);

const runHumanAdd = (cwd: string, remote: string): Promise<ProcessResult> =>
  run(cwd, [process.execPath, CLI_ENTRY, "add", remote, "--force"]);

const repositoryResult = (result: ProcessResult): Record<string, unknown> => {
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  const document = JSON.parse(result.stdout) as { data: { repository: Record<string, unknown> } };
  return document.data.repository;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("add coordinated linked materialization", () => {
  test("keeps the canonical clone on its default branch and creates a slash branch worktree", async () => {
    const topology = await createParentTopology("feature/example");
    const remote = await seedChildRemote(topology.root);
    const canonicalConfigBefore = await readFile(
      join(topology.canonical, ".arashi", "config.json"),
    );

    const repository = repositoryResult(await runAdd(topology.active, remote));
    const canonicalChild = join(topology.canonical, "repos", "child");
    const activeChild = join(topology.active, "repos", "child");

    expect(repository).toMatchObject({
      canonicalPath: await realpath(canonicalChild),
      coordinatedBranch: "feature/example",
      defaultBranch: "main",
      materialization: "coordinated-worktree",
      path: "repos/child",
      setupScript: "repos/child/setup.sh",
      setupScriptCreated: false,
      worktreePath: await realpath(activeChild),
    });
    expect(await git(canonicalChild, ["branch", "--show-current"])).toBe("main");
    expect(await git(activeChild, ["branch", "--show-current"])).toBe("feature/example");
    expect(await readFile(join(topology.canonical, ".arashi", "config.json"))).toEqual(
      canonicalConfigBefore,
    );
    expect(
      JSON.parse(await readFile(join(topology.active, ".arashi", "config.json"), "utf8")),
    ).toMatchObject({
      repos: { child: { gitUrl: remote, path: "repos/child" } },
    });
  });

  test("resolves the enclosing linked parent from a nested independent child", async () => {
    const topology = await createParentTopology("feature/nested");
    const nested = join(topology.active, "scratch", "independent");
    await initialize(nested);
    const remote = await seedChildRemote(topology.root);

    const repository = repositoryResult(await runAdd(nested, remote));

    expect(repository.canonicalPath).toBe(
      await realpath(join(topology.canonical, "repos", "child")),
    );
    expect(repository.worktreePath).toBe(await realpath(join(topology.active, "repos", "child")));
    expect(repository.coordinatedBranch).toBe("feature/nested");
  });

  test("tracks an exact matching remote branch", async () => {
    const topology = await createParentTopology("feature/remote");
    const remote = await seedChildRemote(topology.root, ["feature/remote"]);

    repositoryResult(await runAdd(topology.active, remote));
    const activeChild = join(topology.active, "repos", "child");

    expect(await git(activeChild, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
      "origin/feature/remote",
    );
  });

  test("rejects detached linked-parent HEAD before cloning", async () => {
    const topology = await createParentTopology("feature/detached");
    const remote = await seedChildRemote(topology.root);
    await git(topology.active, ["checkout", "--detach"]);

    const result = await runAdd(topology.active, remote);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "add",
      error: { details: { phase: "preflight" } },
      ok: false,
    });
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(false);
    expect(await runtime.file(join(topology.active, "repos", "child")).exists()).toBe(false);
  });

  test("creates the documented setup template when requested", async () => {
    const topology = await createParentTopology("unused-create-setup");
    await git(topology.canonical, ["worktree", "remove", "--force", topology.active]);
    const remote = await seedChildRemote(topology.root, [], false);

    const result = await run(topology.canonical, [
      process.execPath,
      CLI_ENTRY,
      "add",
      remote,
      "--json",
      "--force",
      "--create-setup",
    ]);
    const repository = repositoryResult(result);
    const setupPath = join(topology.canonical, "repos", "child", "setup.sh");

    expect(repository).toMatchObject({
      setupScript: "repos/child/setup.sh",
      setupScriptCreated: true,
    });
    expect(await readFile(setupPath, "utf8")).toContain("Add repository setup commands here");
  });

  test("creates the setup template in the invoking linked child worktree", async () => {
    const topology = await createParentTopology("feature/create-setup");
    const remote = await seedChildRemote(topology.root, [], false);

    const result = await run(topology.active, [
      process.execPath,
      CLI_ENTRY,
      "add",
      remote,
      "--json",
      "--force",
      "--create-setup",
    ]);
    const repository = repositoryResult(result);
    const activeSetup = join(topology.active, "repos", "child", "setup.sh");
    const canonicalSetup = join(topology.canonical, "repos", "child", "setup.sh");

    expect(repository).toMatchObject({
      materialization: "coordinated-worktree",
      setupScript: "repos/child/setup.sh",
      setupScriptCreated: true,
    });
    expect(await readFile(activeSetup, "utf8")).toContain("Add repository setup commands here");
    expect(await runtime.file(canonicalSetup).exists()).toBe(false);
  });

  test("creates the setup template from a nested invocation in the active child worktree", async () => {
    const topology = await createParentTopology("feature/nested-create-setup");
    const remote = await seedChildRemote(topology.root, [], false);
    const nested = join(topology.active, "nested", "directory");
    await mkdir(nested, { recursive: true });

    const result = await run(nested, [
      process.execPath,
      CLI_ENTRY,
      "add",
      remote,
      "--json",
      "--force",
      "--create-setup",
    ]);
    const repository = repositoryResult(result);
    const activeSetup = join(topology.active, "repos", "child", "setup.sh");

    expect(repository).toMatchObject({
      materialization: "coordinated-worktree",
      setupScript: "repos/child/setup.sh",
      setupScriptCreated: true,
    });
    expect(await readFile(activeSetup, "utf8")).toContain("Add repository setup commands here");
    expect(await runtime.file(join(nested, "repos", "child", "setup.sh")).exists()).toBe(false);
  });

  test("fails closed when parent Git topology cannot be observed", async () => {
    const topology = await createParentTopology("feature/topology-observe");
    const remote = await seedChildRemote(topology.root);
    let cloneCalled = false;

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        cloneRepository: async () => {
          cloneCalled = true;
          throw new Error("clone must not run");
        },
        resolveMainWorktree: async () => Promise.reject(new Error("topology unavailable")),
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect(cloneCalled).toBe(false);
    expect(failure).toMatchObject({
      code: "CLONE_FAILED",
      context: { phase: "preflight" },
    });
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(false);
    expect(await runtime.file(join(topology.active, "repos", "child")).exists()).toBe(false);
  });

  test("reports a structured rollback when canonical parent creation fails after ignore mutation", async () => {
    const topology = await createParentTopology("feature/parent-mkdir", {
      trackedReposIgnore: false,
    });
    const remote = await seedChildRemote(topology.root);
    await writeFile(join(topology.canonical, "repos"), "blocking file\n");

    const result = await runAdd(topology.active, remote);
    const document = JSON.parse(result.stdout) as {
      error: { code: string; details: Record<string, unknown> };
      ok: boolean;
    };

    expect(result.exitCode).not.toBe(0);
    expect(document).toMatchObject({
      error: {
        code: "CLONE_FAILED",
        details: {
          phase: "clone",
          rollback: {
            complete: true,
            finalState: { managedIgnore: { changed: true, restored: true } },
          },
        },
      },
      ok: false,
    });
  });

  test("reports direct-main role fields with null linked values", async () => {
    const topology = await createParentTopology("unused");
    await git(topology.canonical, ["worktree", "remove", "--force", topology.active]);
    const remote = await seedChildRemote(topology.root);

    const repository = repositoryResult(await runAdd(topology.canonical, remote));

    expect(repository).toMatchObject({
      canonicalPath: await realpath(join(topology.canonical, "repos", "child")),
      coordinatedBranch: null,
      defaultBranch: "main",
      materialization: "clone",
      path: "repos/child",
      setupScript: "repos/child/setup.sh",
      setupScriptCreated: false,
      worktreePath: null,
    });
  });

  test("retains single-placement behavior for an absolute repositories directory", async () => {
    const topology = await createParentTopology("feature/absolute-repos");
    const remote = await seedChildRemote(topology.root);
    const absoluteRepos = join(topology.root, "shared-repositories");
    const activeConfigPath = join(topology.active, ".arashi", "config.json");
    const activeConfig = JSON.parse(await readFile(activeConfigPath, "utf8")) as {
      repos: Record<string, unknown>;
      reposDir: string;
    };
    activeConfig.reposDir = absoluteRepos;
    await writeFile(activeConfigPath, JSON.stringify(activeConfig, null, 2));

    const result = await runAdd(topology.active, remote);
    const repository = repositoryResult(result);

    expect(repository).toMatchObject({
      canonicalPath: join(absoluteRepos, "child"),
      materialization: "clone",
      worktreePath: null,
    });
    expect(await runtime.file(join(absoluteRepos, "child", ".git")).exists()).toBe(true);
    const persisted = JSON.parse(await readFile(activeConfigPath, "utf8")) as {
      repos: Record<string, { path: string }>;
    };
    expect(persisted.repos.child?.path).toBe(join(absoluteRepos, "child"));
  });

  test("retains single-placement behavior for an unsafe relative repositories directory", async () => {
    const topology = await createParentTopology("feature/root-repos");
    const remote = await seedChildRemote(topology.root);
    const activeConfigPath = join(topology.active, ".arashi", "config.json");
    const activeConfig = JSON.parse(await readFile(activeConfigPath, "utf8")) as {
      repos: Record<string, unknown>;
      reposDir: string;
    };
    activeConfig.reposDir = ".";
    await writeFile(activeConfigPath, JSON.stringify(activeConfig, null, 2));

    const result = await runAdd(topology.active, remote);
    const repository = repositoryResult(result);

    expect(repository).toMatchObject({
      canonicalPath: join(await realpath(topology.active), "child"),
      materialization: "clone",
      worktreePath: null,
    });
    expect(await runtime.file(join(topology.active, "child", ".git")).exists()).toBe(true);
  });

  test("treats a dash-prefixed repositories directory as a path during ignore inspection", async () => {
    const topology = await createParentTopology("feature/dash-repos");
    const remote = await seedChildRemote(topology.root);
    const activeConfigPath = join(topology.active, ".arashi", "config.json");
    const activeConfig = JSON.parse(await readFile(activeConfigPath, "utf8")) as {
      repos: Record<string, unknown>;
      reposDir: string;
    };
    activeConfig.reposDir = "-repos";
    await writeFile(activeConfigPath, JSON.stringify(activeConfig, null, 2));

    const repository = repositoryResult(await runAdd(topology.active, remote));

    expect(repository).toMatchObject({
      materialization: "coordinated-worktree",
      path: "-repos/child",
    });
  });

  test("rejects canonical and active destination conflicts before mutation", async () => {
    for (const role of ["canonical", "active"] as const) {
      const topology = await createParentTopology(`feature/${role}`);
      const remote = await seedChildRemote(topology.root);
      const destination = join(
        role === "canonical" ? topology.canonical : topology.active,
        "repos",
        "child",
      );
      await mkdir(destination, { recursive: true });
      const configBefore = await readFile(join(topology.active, ".arashi", "config.json"));

      const result = await runAdd(topology.active, remote);

      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { details: { phase: "preflight" } },
        ok: false,
      });
      expect(await readFile(join(topology.active, ".arashi", "config.json"))).toEqual(configBefore);
      expect(
        await runtime.file(join(topology.canonical, ".git", "info", "exclude")).text(),
      ).not.toContain("Arashi managed");
    }
  });

  test("rolls back a coordinated/default branch collision with structured final state", async () => {
    const topology = await createParentTopology("main", { canonicalBranch: "parent-base" });
    const remote = await seedChildRemote(topology.root);
    const canonicalRoot = await realpath(topology.canonical);
    const activeRoot = await realpath(topology.active);

    const result = await runAdd(topology.active, remote);

    expect(result.exitCode).not.toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .filter((line) => line === "{"),
    ).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "add",
      error: {
        details: {
          phase: "branch",
          rollback: {
            complete: true,
            failures: [],
            finalState: {
              canonical: { exists: false, path: join(canonicalRoot, "repos", "child") },
              configEntryPresent: false,
              coordinatedBranch: {
                createdByInvocation: false,
                exists: false,
                name: "main",
              },
              managedIgnore: { changed: true, restored: true },
              worktree: {
                exists: false,
                metadataPresent: false,
                path: join(activeRoot, "repos", "child"),
              },
            },
          },
        },
      },
      ok: false,
    });
  });

  test("local scope reconciles common exclude coverage for both destinations", async () => {
    const topology = await createParentTopology("feature/local", { trackedReposIgnore: false });
    const remote = await seedChildRemote(topology.root);

    const result = await runAdd(topology.active, remote);

    expect(repositoryResult(result).materialization).toBe("coordinated-worktree");
    const exclude = await git(topology.active, ["rev-parse", "--git-path", "info/exclude"]);
    expect(await readFile(resolve(topology.active, exclude), "utf8")).toContain("/repos/");
  });

  test("tracked scope fails before mutation when canonical main lacks coverage", async () => {
    const topology = await createParentTopology("feature/tracked", { trackedReposIgnore: false });
    const remote = await seedChildRemote(topology.root);
    await git(topology.active, ["config", "arashi.ignoreScope", "tracked"]);
    await writeFile(join(topology.active, ".gitignore"), "repos/\n");
    const activeIgnoreBefore = await readFile(join(topology.active, ".gitignore"));

    const result = await runAdd(topology.active, remote);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { details: { managedIgnoreScope: "tracked", phase: "preflight" } },
      ok: false,
    });
    expect(await readFile(join(topology.active, ".gitignore"))).toEqual(activeIgnoreBefore);
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(false);
  });

  test("fails closed when effective ignore inspection fails", async () => {
    const topology = await createParentTopology("feature/ignore-inspection");
    const remote = await seedChildRemote(topology.root);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        isEffectivelyIgnored: async () =>
          Promise.reject(new Error("injected ignore inspection failure")),
      } as InjectableAddDependencies,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "preflight",
      rollback: {
        complete: true,
        finalState: {
          canonical: { exists: false },
          worktree: { exists: false, metadataPresent: false },
        },
      },
    });
  });

  test("none scope performs no ignore writes and reports both unignored destinations", async () => {
    const topology = await createParentTopology("feature/none", { trackedReposIgnore: false });
    const remote = await seedChildRemote(topology.root);
    await git(topology.active, ["config", "arashi.ignoreScope", "none"]);
    const excludePath = resolve(
      topology.active,
      await git(topology.active, ["rev-parse", "--git-path", "info/exclude"]),
    );
    const excludeBefore = await readFile(excludePath);

    const result = await runAdd(topology.active, remote);
    const document = JSON.parse(result.stdout) as {
      data: { managedIgnore: { warnings: string[] } };
    };

    expect(result.exitCode).toBe(0);
    expect(document.data.managedIgnore.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("canonical destination"),
        expect.stringContaining("active destination"),
      ]),
    );
    expect(await readFile(excludePath)).toEqual(excludeBefore);
    expect(await runtime.file(join(topology.active, ".gitignore")).exists()).toBe(false);
    expect(await runtime.file(join(topology.canonical, ".gitignore")).exists()).toBe(false);
  });

  test("human none-scope output reports both unignored destination roles", async () => {
    const topology = await createParentTopology("feature/none-human", {
      trackedReposIgnore: false,
    });
    const remote = await seedChildRemote(topology.root);
    await git(topology.active, ["config", "arashi.ignoreScope", "none"]);

    const result = await runHumanAdd(topology.active, remote);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).toBe(0);
    expect(output).toContain("canonical destination");
    expect(output).toContain("active destination");
  });

  test("restores exact config bytes and fully rolls back an injected config-write failure", async () => {
    const topology = await createParentTopology("feature/config-failure");
    const remote = await seedChildRemote(topology.root);
    const configPath = join(topology.active, ".arashi", "config.json");
    const configBefore = await readFile(configPath);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      { afterConfigPersist: async () => Promise.reject(new Error("injected config failure")) },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "config",
      rollback: {
        complete: true,
        failures: [],
        finalState: {
          canonical: { exists: false },
          configEntryPresent: false,
          coordinatedBranch: { createdByInvocation: true, exists: false },
          managedIgnore: { changed: true, restored: true },
          worktree: { exists: false, metadataPresent: false },
        },
      },
    });
    expect(await readFile(configPath)).toEqual(configBefore);
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(false);
    expect(await runtime.file(join(topology.active, "repos", "child")).exists()).toBe(false);
  });

  test("retains canonical clone, branch, and ignore coverage when worktree removal fails", async () => {
    const topology = await createParentTopology("feature/retain");
    const remote = await seedChildRemote(topology.root);
    const configPath = join(topology.active, ".arashi", "config.json");
    const configBefore = await readFile(configPath);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        removeWorktree: async () => Promise.reject(new Error("injected removal failure")),
        afterConfigPersist: async () => Promise.reject(new Error("injected config failure")),
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "config",
      rollback: {
        complete: false,
        failures: [{ message: "injected removal failure", phase: "worktree-remove" }],
        finalState: {
          canonical: { exists: true },
          configEntryPresent: false,
          coordinatedBranch: { createdByInvocation: true, exists: true },
          managedIgnore: { changed: true, restored: false },
          worktree: { exists: true, metadataPresent: true },
        },
      },
    });
    expect(await readFile(configPath)).toEqual(configBefore);
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(true);
    expect(await git(join(topology.active, "repos", "child"), ["branch", "--show-current"])).toBe(
      "feature/retain",
    );
  });

  test("fails closed when final worktree-metadata observation fails", async () => {
    const topology = await createParentTopology("feature/observe");
    const remote = await seedChildRemote(topology.root);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        observeWorktreeMetadata: async () =>
          Promise.reject(new Error("injected observation failure")),
        removeWorktree: async () => Promise.reject(new Error("injected removal failure")),
        afterConfigPersist: async () => Promise.reject(new Error("injected config failure")),
      },
    ).catch((error: unknown) => error);

    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        failures: [
          { phase: "worktree-remove" },
          { message: "injected observation failure", phase: "final-state-observe" },
        ],
        finalState: {
          canonical: { exists: true },
          coordinatedBranch: { exists: true },
          managedIgnore: { restored: false },
          worktree: { exists: true, metadataPresent: null },
        },
      },
    });
  });

  test("records active-path observation failures without aborting structured rollback", async () => {
    const topology = await createParentTopology("feature/path-observe");
    const remote = await seedChildRemote(topology.root);
    const activeDestination = join(await realpath(topology.active), "repos", "child");
    let activeObservations = 0;

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        observePath: async (path) => {
          if (path === activeDestination && ++activeObservations === 2) {
            throw new Error("injected active path observation failure");
          }
          return runtime.file(path).exists();
        },
        afterConfigPersist: async () => Promise.reject(new Error("injected config failure")),
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "config",
      rollback: {
        complete: false,
        failures: [
          {
            message: "injected active path observation failure",
            phase: "final-state-observe",
          },
        ],
        finalState: {
          canonical: { exists: true },
          worktree: { exists: false, metadataPresent: false },
        },
      },
    });
  });

  test("retains a canonical clone when the coordinated branch appears checked out elsewhere", async () => {
    const topology = await createParentTopology("feature/concurrent");
    const remote = await seedChildRemote(topology.root);
    const conflictingWorktree = join(topology.root, "concurrent-child-worktree");

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        cloneRepository: async (url, path) => {
          const result = await cloneRepository(url, path);
          await git(path, ["branch", "feature/concurrent", "main"]);
          await git(path, ["worktree", "add", conflictingWorktree, "feature/concurrent"]);
          return result;
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      conflictingWorktree: await realpath(conflictingWorktree),
      phase: "branch",
      rollback: {
        complete: false,
        finalState: {
          canonical: { exists: true },
          coordinatedBranch: { createdByInvocation: false, exists: true },
          managedIgnore: { restored: false },
        },
      },
    });
    expect(await runtime.file(conflictingWorktree).exists()).toBe(true);
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(true);
  });

  test("preserves a concurrent branch and worktree created after ref preflight", async () => {
    const topology = await createParentTopology("feature/branch-race");
    const remote = await seedChildRemote(topology.root);
    const conflictingWorktree = join(topology.root, "branch-race-worktree");

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        createCoordinatedBranch: async (canonicalPath, branch) => {
          await git(canonicalPath, ["branch", branch, "main"]);
          await git(canonicalPath, ["worktree", "add", conflictingWorktree, branch]);
          throw new Error("concurrent branch won the race");
        },
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "branch",
      rollback: {
        complete: false,
        finalState: {
          canonical: { exists: true },
          coordinatedBranch: { createdByInvocation: false, exists: true },
        },
      },
    });
    expect(await runtime.file(conflictingWorktree).exists()).toBe(true);
  });

  test("does not remove a concurrently registered worktree when worktree creation throws", async () => {
    const topology = await createParentTopology("feature/worktree-race");
    const remote = await seedChildRemote(topology.root);
    const activeDestination = join(await realpath(topology.active), "repos", "child");

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        createWorktree: async (canonicalPath, worktreePath, branch) => {
          await git(canonicalPath, ["worktree", "add", worktreePath, branch]);
          throw new Error("concurrent worktree won the race");
        },
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "worktree",
      rollback: {
        complete: false,
        finalState: {
          canonical: { exists: true },
          worktree: { exists: true, metadataPresent: true },
        },
      },
    });
    expect(await runtime.file(activeDestination).exists()).toBe(true);
  });

  test("retains ignore state when config restoration and final config observation fail", async () => {
    const topology = await createParentTopology("feature/config-observe");
    const remote = await seedChildRemote(topology.root);
    const configPath = join(topology.active, ".arashi", "config.json");

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        restoreConfigBytes: async () => Promise.reject(new Error("injected restore failure")),
        afterConfigPersist: async () => {
          await writeFile(configPath, "not-json\n");
          throw new Error("injected config failure");
        },
      },
    ).catch((error: unknown) => error);

    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        failures: [
          { message: "injected restore failure", phase: "config-restore" },
          { phase: "final-state-observe" },
        ],
        finalState: {
          configEntryPresent: null,
          managedIgnore: { changed: true, restored: false },
        },
      },
    });
  });

  test("reports clone-phase rollback with an observed-absent active metadata record", async () => {
    const topology = await createParentTopology("feature/clone-failure");
    const missingRemote = join(topology.root, "missing.git");

    const result = await runAdd(topology.active, missingRemote);
    const document = JSON.parse(result.stdout);

    expect(result.exitCode).not.toBe(0);
    expect(document).toMatchObject({
      error: {
        details: {
          phase: "clone",
          rollback: {
            complete: true,
            failures: [],
            finalState: {
              canonical: { exists: false },
              worktree: { exists: false, metadataPresent: false },
            },
          },
        },
      },
      ok: false,
    });
  });

  test("reports branch-phase rollback when a cloned repository has no default branch", async () => {
    const topology = await createParentTopology("feature/no-default");
    const emptyRemote = join(topology.root, "empty.git");
    await initialize(emptyRemote, true);

    const result = await runAdd(topology.active, emptyRemote);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        details: {
          phase: "branch",
          rollback: {
            complete: true,
            finalState: {
              canonical: { exists: false },
              worktree: { exists: false, metadataPresent: false },
            },
          },
        },
      },
      ok: false,
    });
  });

  test("fails closed when coordinated ref inspection fails", async () => {
    const topology = await createParentTopology("feature/ref-inspection");
    const remote = await seedChildRemote(topology.root);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        refExists: async () => Promise.reject(new Error("injected ref inspection failure")),
      } as InjectableAddDependencies,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "branch",
      rollback: {
        complete: true,
        finalState: { canonical: { exists: false } },
      },
    });
  });

  test("records final coordinated-ref observation failures", async () => {
    const topology = await createParentTopology("feature/ref-observe");
    const remote = await seedChildRemote(topology.root);
    let refObservations = 0;

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        refExists: async () => {
          refObservations += 1;
          if (refObservations <= 2) return false;
          throw new Error("injected ref observation failure");
        },
        removeWorktree: async () => Promise.reject(new Error("injected removal failure")),
        afterConfigPersist: async () => Promise.reject(new Error("injected config failure")),
      } as InjectableAddDependencies,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        failures: [
          { phase: "worktree-remove" },
          {
            message: "injected ref observation failure",
            phase: "final-state-observe",
          },
        ],
        finalState: {
          canonical: { exists: true },
          coordinatedBranch: { exists: null },
        },
      },
    });
  });

  test("preserves a concurrent destination that wins the clone reservation race", async () => {
    const topology = await createParentTopology("feature/clone-race");
    const remote = await seedChildRemote(topology.root);
    const canonicalPath = join(await realpath(topology.canonical), "repos", "child");
    const sentinel = join(canonicalPath, "external-owner");
    let raced = false;

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        observePath: async (path: string) => {
          if (!raced && path === canonicalPath) {
            raced = true;
            await mkdir(canonicalPath, { recursive: true });
            await writeFile(sentinel, "external\n");
            return false;
          }
          return runtime.file(path).exists();
        },
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect(failure).toBeInstanceOf(AddCommandError);
    expect(await runtime.file(sentinel).exists()).toBe(true);
    expect((failure as AddCommandError).context).toMatchObject({
      rollback: { finalState: { canonical: { exists: true } } },
    });
  });

  test("removes an invocation-owned partial destination after injected clone failure", async () => {
    const topology = await createParentTopology("feature/partial-clone");
    const remote = await seedChildRemote(topology.root);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        cloneRepository: async (_url, destination) => {
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, "partial"), "owned\n");
          throw new Error("injected partial clone failure");
        },
        observeWorktreeMetadata: async () => {
          throw new Error("metadata inspection must not run before worktree creation");
        },
      },
    ).catch((error: unknown) => error);

    expect((failure as AddCommandError).context).toMatchObject({
      phase: "clone",
      rollback: {
        complete: true,
        failures: [],
        finalState: {
          canonical: { exists: false },
          managedIgnore: { changed: true, restored: true },
          worktree: { exists: false, metadataPresent: false },
        },
      },
    });
  });

  test("labels canonical and active roles in human output", async () => {
    const topology = await createParentTopology("feature/human");
    const remote = await seedChildRemote(topology.root);

    const result = await runHumanAdd(topology.active, remote);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).toBe(0);
    expect(output).toContain("Config path:");
    expect(output).toContain("Canonical clone:");
    expect(output).toContain("Default branch:");
    expect(output).toContain("Active worktree:");
    expect(output).toContain("Coordinated branch:");
  });

  test("rejects malformed active config before ignore or repository mutation", async () => {
    const topology = await createParentTopology("feature/invalid-config");
    const remote = await seedChildRemote(topology.root);
    const excludePath = resolve(
      topology.active,
      await git(topology.active, ["rev-parse", "--git-path", "info/exclude"]),
    );
    const excludeBefore = await readFile(excludePath);
    await writeFile(join(topology.active, ".arashi", "config.json"), "{invalid\n");

    const result = await runAdd(topology.active, remote);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
    expect(await readFile(excludePath)).toEqual(excludeBefore);
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(false);
    expect(await runtime.file(join(topology.active, "repos", "child")).exists()).toBe(false);
  });

  test("reports incomplete rollback when canonical cleanup returns but owned clone survives", async () => {
    const topology = await createParentTopology("feature/noop-clone-cleanup");
    const remote = await seedChildRemote(topology.root);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        removeCanonicalClone: async () => undefined,
        afterConfigPersist: async () => Promise.reject(new Error("injected config failure")),
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        finalState: { canonical: { exists: true } },
      },
    });
  });

  test("preserves a concurrent config update detected before persistence", async () => {
    const topology = await createParentTopology("feature/config-conflict");
    const remote = await seedChildRemote(topology.root);
    const configPath = join(topology.active, ".arashi", "config.json");

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        cloneRepository: async (url, path) => {
          const result = await cloneRepository(url, path);
          const concurrent = JSON.parse(await readFile(configPath, "utf8")) as {
            repos: Record<string, unknown>;
          };
          concurrent.repos.concurrent = { gitUrl: "concurrent.git", path: "repos/concurrent" };
          await writeFile(configPath, JSON.stringify(concurrent, null, 2));
          return result;
        },
      },
    ).catch((error: unknown) => error as AddCommandError);

    const finalConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Record<string, unknown>;
    };
    expect(finalConfig.repos).toHaveProperty("concurrent");
    expect(finalConfig.repos).not.toHaveProperty("child");
    expect((failure as AddCommandError).context).toMatchObject({
      phase: "config",
      rollback: { complete: true, finalState: { configEntryPresent: false } },
    });
  });

  test("fails before mutation when config changes between load and snapshot", async () => {
    const topology = await createParentTopology("feature/config-load-race");
    const remote = await seedChildRemote(topology.root);
    const configPath = join(topology.active, ".arashi", "config.json");

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        afterConfigLoad: async () => {
          const concurrent = JSON.parse(await readFile(configPath, "utf8")) as {
            repos: Record<string, unknown>;
          };
          concurrent.repos.concurrent = { gitUrl: "concurrent.git", path: "repos/concurrent" };
          await writeFile(configPath, JSON.stringify(concurrent, null, 2));
        },
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect(failure).toBeInstanceOf(AddCommandError);
    const finalConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Record<string, unknown>;
    };
    expect(finalConfig.repos).toHaveProperty("concurrent");
    expect(finalConfig.repos).not.toHaveProperty("child");
    expect(await runtime.file(join(topology.canonical, "repos", "child")).exists()).toBe(false);
  });

  test("serializes concurrent add config persistence without losing an entry", async () => {
    const topology = await createParentTopology("feature/config-lock");
    const firstRoot = join(topology.root, "first-remote");
    const secondRoot = join(topology.root, "second-remote");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstRemote = await seedChildRemote(firstRoot);
    const secondRemote = await seedChildRemote(secondRoot);
    const first = run(topology.active, [
      process.execPath,
      CLI_ENTRY,
      "add",
      firstRemote,
      "--name",
      "child-one",
      "--json",
      "--force",
    ]);
    const second = run(topology.active, [
      process.execPath,
      CLI_ENTRY,
      "add",
      secondRemote,
      "--name",
      "child-two",
      "--json",
      "--force",
    ]);
    const firstClone = join(topology.canonical, "repos", "child-one");
    const secondClone = join(topology.canonical, "repos", "child-two");
    const results = await Promise.all([first, second]);
    const successfulNames = results.flatMap((result, index) =>
      result.exitCode === 0 ? [index === 0 ? "child-one" : "child-two"] : [],
    );
    expect(successfulNames.length).toBeGreaterThan(0);

    const config = JSON.parse(
      await readFile(join(topology.active, ".arashi", "config.json"), "utf8"),
    ) as { repos: Record<string, unknown> };
    const persistedNames = ["child-one", "child-two"].filter((name) => name in config.repos);
    expect(persistedNames.toSorted()).toEqual(successfulNames.toSorted());
    expect(await runtime.file(firstClone).exists()).toBe(results[0]?.exitCode === 0);
    expect(await runtime.file(secondClone).exists()).toBe(results[1]?.exitCode === 0);
  });

  test("serializes ignore reconciliation with the complete add transaction", async () => {
    const topology = await createParentTopology("feature/ignore-transaction-lock");
    const firstRoot = join(topology.root, "ignore-first-remote");
    const secondRoot = join(topology.root, "ignore-second-remote");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstRemote = await seedChildRemote(firstRoot);
    const secondRemote = await seedChildRemote(secondRoot);
    let releaseFirst!: () => void;
    let markFirstReached!: () => void;
    const firstReached = new Promise<void>((resolveReached) => {
      markFirstReached = resolveReached;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });

    const first = executeAdd(
      firstRemote,
      { force: true, json: true, name: "ignore-one" },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        afterIgnoreReconcile: async () => {
          markFirstReached();
          await release;
        },
      },
    );
    await firstReached;
    const second = executeAdd(
      secondRemote,
      { force: true, json: true, name: "ignore-two" },
      { configurationRoot: topology.active, executionRoot: topology.active },
    );
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    const config = JSON.parse(
      await readFile(join(topology.active, ".arashi", "config.json"), "utf8"),
    ) as { repos: Record<string, unknown> };
    expect(config.repos).toHaveProperty("ignore-one");
    expect(config.repos).toHaveProperty("ignore-two");
    await expect(
      git(topology.canonical, ["check-ignore", "--no-index", "repos/ignore-two"]),
    ).resolves.toBeDefined();
  });

  test("shares the add transaction lock between canonical and linked parent checkouts", async () => {
    const topology = await createParentTopology("feature/shared-transaction-lock");
    const firstRoot = join(topology.root, "shared-first-remote");
    const secondRoot = join(topology.root, "shared-second-remote");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstRemote = await seedChildRemote(firstRoot);
    const secondRemote = await seedChildRemote(secondRoot);
    let releaseFirst!: () => void;
    let markFirstReached!: () => void;
    let secondReached = false;
    const firstReached = new Promise<void>((resolveReached) => {
      markFirstReached = resolveReached;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseFirst = resolveRelease;
    });

    const first = executeAdd(
      firstRemote,
      { force: true, json: true, name: "shared-one" },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        afterIgnoreReconcile: async () => {
          markFirstReached();
          await release;
        },
      },
    );
    await firstReached;
    const second = executeAdd(
      secondRemote,
      { force: true, json: true, name: "shared-two" },
      { configurationRoot: topology.canonical, executionRoot: topology.canonical },
      {
        afterIgnoreReconcile: async () => {
          secondReached = true;
        },
      },
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    expect(secondReached).toBe(false);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(secondReached).toBe(true);
  });

  test("reclaims an abandoned configuration lock", async () => {
    const topology = await createParentTopology("feature/stale-config-lock");
    const remote = await seedChildRemote(topology.root);
    const lockPath = join(topology.active, ".arashi-config.add.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: "abandoned-test-owner" }),
    );

    const result = await runAdd(topology.active, remote);

    expect(repositoryResult(result)).toMatchObject({ name: "child" });
    expect(await runtime.file(lockPath).exists()).toBe(false);
  });

  test("preserves malformed lock age while claiming it for recovery", async () => {
    const topology = await createParentTopology("feature/stale-malformed-lock");
    const remote = await seedChildRemote(topology.root);
    const lockPath = join(topology.active, ".arashi-config.add.lock");
    await writeFile(lockPath, "incomplete");
    const staleTime = new Date(Date.now() - 31_000);
    await utimes(lockPath, staleTime, staleTime);

    const result = await runAdd(topology.active, remote);

    expect(result.exitCode).toBe(0);
    expect(await runtime.file(lockPath).exists()).toBe(false);
  });

  test("waits through the remaining incomplete-lock grace period", async () => {
    const topology = await createParentTopology("feature/incomplete-config-lock-grace");
    const remote = await seedChildRemote(topology.root);
    const lockPath = join(topology.active, ".arashi-config.add.lock");
    await writeFile(lockPath, "incomplete");
    const halfwayThroughGrace = new Date(Date.now() - 15_000);
    await utimes(lockPath, halfwayThroughGrace, halfwayThroughGrace);

    const result = await runAdd(topology.active, remote);

    expect(repositoryResult(result)).toMatchObject({ name: "child" });
    expect(await runtime.file(lockPath).exists()).toBe(false);
  }, 25_000);

  test("recovers a claim left by an interrupted lock reclaimer", async () => {
    const topology = await createParentTopology("feature/orphaned-reclaim-claim");
    const remote = await seedChildRemote(topology.root);
    const lockPath = join(topology.active, ".arashi-config.add.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, token: "abandoned-test-owner" }),
    );
    const lockStat = await stat(lockPath);
    const legacyClaimPath = `${lockPath}.reclaim-${lockStat.dev}-${lockStat.ino}`;
    const interruptedClaimPath = `${legacyClaimPath}-2147483647-interrupted`;
    await link(lockPath, legacyClaimPath);
    await link(lockPath, interruptedClaimPath);

    const result = await runAdd(topology.active, remote);

    expect(repositoryResult(result)).toMatchObject({ name: "child" });
    expect(await runtime.file(lockPath).exists()).toBe(false);
    expect(await runtime.file(legacyClaimPath).exists()).toBe(false);
    expect(await runtime.file(interruptedClaimPath).exists()).toBe(false);
  });

  test("atomically reclaims one abandoned transaction lock for concurrent waiters", async () => {
    const topology = await createParentTopology("feature/stale-transaction-lock");
    const firstRoot = join(topology.root, "stale-first-remote");
    const secondRoot = join(topology.root, "stale-second-remote");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstRemote = await seedChildRemote(firstRoot);
    const secondRemote = await seedChildRemote(secondRoot);
    const commonDirectory = resolve(
      topology.active,
      await git(topology.active, ["rev-parse", "--git-common-dir"]),
    );
    const lockPath = join(commonDirectory, ".arashi-add.transaction.lock");
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "abandoned" }));

    const results = await Promise.all([
      executeAdd(
        firstRemote,
        { force: true, json: true, name: "stale-one" },
        { configurationRoot: topology.active, executionRoot: topology.active },
      ),
      executeAdd(
        secondRemote,
        { force: true, json: true, name: "stale-two" },
        { configurationRoot: topology.canonical, executionRoot: topology.canonical },
      ),
    ]);

    expect(results).toHaveLength(2);
    expect(await runtime.file(lockPath).exists()).toBe(false);
  });

  test("preserves concurrent config bytes instead of falsely completing rollback", async () => {
    const topology = await createParentTopology("feature/config-rollback-conflict");
    const remote = await seedChildRemote(topology.root);
    const configPath = join(topology.active, ".arashi", "config.json");

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        afterConfigPersist: async () => {
          const concurrent = JSON.parse(await readFile(configPath, "utf8")) as {
            repos: Record<string, unknown>;
          };
          concurrent.repos.concurrent = { gitUrl: "concurrent.git", path: "repos/concurrent" };
          await writeFile(configPath, JSON.stringify(concurrent, null, 2));
          throw new Error("injected post-write failure");
        },
      },
    ).catch((error: unknown) => error as AddCommandError);

    const finalConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      repos: Record<string, unknown>;
    };
    expect(finalConfig.repos).toHaveProperty("concurrent");
    expect(finalConfig.repos).not.toHaveProperty("child");
    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        failures: [{ phase: "config-restore" }],
        finalState: { configEntryPresent: false, configRestored: false },
      },
    });
  });

  test("detects a no-op exact config restoration", async () => {
    const topology = await createParentTopology("feature/noop-config-restore");
    const remote = await seedChildRemote(topology.root);
    const configPath = join(topology.active, ".arashi", "config.json");
    const originalConfig = JSON.parse(await readFile(configPath, "utf8")) as object;

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        restoreConfigBytes: async () => undefined,
        afterConfigPersist: async () => {
          await writeFile(configPath, JSON.stringify(originalConfig));
          throw new Error("injected config failure");
        },
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        failures: [{ phase: "config-restore" }],
        finalState: { configEntryPresent: false, configRestored: false },
      },
    });
  });

  test("detects a no-op managed-ignore restoration", async () => {
    const topology = await createParentTopology("feature/noop-ignore-restore", {
      trackedReposIgnore: false,
    });
    const remote = await seedChildRemote(topology.root);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        cloneRepository: async () => Promise.reject(new Error("injected clone failure")),
        restoreIgnore: async () => undefined,
      },
    ).catch((error: unknown) => error as AddCommandError);

    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        failures: [{ phase: "managed-ignore-restore" }],
        finalState: { managedIgnore: { changed: true, restored: false } },
      },
    });
  });

  test("human failures report incomplete rollback and surviving-state observations", async () => {
    const topology = await createParentTopology("feature/human-rollback");
    const remote = await seedChildRemote(topology.root);
    const configDirectory = join(topology.active, ".arashi");
    const configPath = join(configDirectory, "config.json");
    const wrapperDirectory = join(topology.root, "git-wrapper");
    await mkdir(wrapperDirectory);
    const gitBinary = (await run(topology.root, ["/usr/bin/which", "git"])).stdout.trim();
    const wrapperPath = join(wrapperDirectory, "git");
    await writeFile(
      wrapperPath,
      `#!/bin/sh\ncase " $* " in *" worktree remove --force "*) exit 44;; esac\nexec "${gitBinary}" "$@"\n`,
    );
    await chmod(wrapperPath, 0o755);
    await chmod(configPath, 0o444);
    await chmod(configDirectory, 0o555);
    const originalPath = process.env.PATH;
    let result: ProcessResult;
    try {
      process.env.PATH = `${wrapperDirectory}:${originalPath ?? ""}`;
      result = await runHumanAdd(topology.active, remote);
    } finally {
      process.env.PATH = originalPath;
      await chmod(configDirectory, 0o755);
      await chmod(configPath, 0o644);
    }
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("Rollback: incomplete");
    expect(output).toContain("Cleanup failure (worktree-remove)");
    expect(output).toContain("Canonical clone: present");
    expect(output).toContain("Config bytes restored: yes");
  });

  test.each([
    {
      dependencies: { deleteBranch: async () => Promise.reject(new Error("branch cleanup")) },
      expectedCanonical: true,
      expectedPhase: "branch-delete",
      name: "branch deletion",
    },
    {
      dependencies: {
        removeCanonicalClone: async () => Promise.reject(new Error("clone cleanup")),
      },
      expectedCanonical: true,
      expectedPhase: "clone-remove",
      name: "clone removal",
    },
    {
      dependencies: { restoreIgnore: async () => Promise.reject(new Error("ignore cleanup")) },
      expectedCanonical: false,
      expectedPhase: "managed-ignore-restore",
      name: "managed-ignore restoration",
    },
  ] as const)("reports injected $name cleanup failures", async (fixture) => {
    const topology = await createParentTopology(`feature/${fixture.expectedPhase}`);
    const remote = await seedChildRemote(topology.root);

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        ...fixture.dependencies,
        afterConfigPersist: async () => Promise.reject(new Error("config failure")),
      },
    ).catch((error: unknown) => error);

    expect((failure as AddCommandError).context).toMatchObject({
      rollback: {
        complete: false,
        failures: [{ phase: fixture.expectedPhase }],
        finalState: {
          canonical: { exists: fixture.expectedCanonical },
          managedIgnore: { changed: true, restored: false },
        },
      },
    });
  });

  test("fails closed on a concurrent active-path conflict during worktree creation", async () => {
    const topology = await createParentTopology("feature/concurrent-path");
    const remote = await seedChildRemote(topology.root);
    const activeDestination = join(await realpath(topology.active), "repos", "child");
    await mkdir(activeDestination, { recursive: true });
    await writeFile(join(activeDestination, "pre-existing"), "preserve\n");
    let activePreflightObserved = false;

    const failure = await executeAdd(
      remote,
      { force: true, json: true },
      { configurationRoot: topology.active, executionRoot: topology.active },
      {
        observePath: async (path) => {
          if (path === activeDestination && !activePreflightObserved) {
            activePreflightObserved = true;
            return false;
          }
          return runtime.file(path).exists();
        },
      },
    ).catch((error: unknown) => error);

    expect((failure as AddCommandError).context).toMatchObject({
      phase: "worktree",
      rollback: {
        complete: false,
        finalState: {
          canonical: { exists: true },
          configEntryPresent: false,
          coordinatedBranch: { createdByInvocation: true, exists: true },
          worktree: { exists: true, metadataPresent: false },
        },
      },
    });
    expect(await readFile(join(activeDestination, "pre-existing"), "utf8")).toBe("preserve\n");
  });
});
