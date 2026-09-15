import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import createBenchmarkEnvironment from "./environment.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { waitForProcessClose } from "./process.ts";

export type FixtureId = "small" | "medium" | "large";

export interface StatefulBenchmarkCase {
  prepare(): Promise<void>;
  verify(): Promise<void>;
}

export interface BenchmarkFixture {
  cleanup(): Promise<void>;
  coordinatedChildWorktreeCount: number;
  definitionVersion: number;
  environment: NodeJS.ProcessEnv;
  groupCount: number;
  id: FixtureId;
  refreshedRoot: string;
  repositoryCount: number;
  statefulCases: { create: StatefulBenchmarkCase; remove: StatefulBenchmarkCase };
  worktreeCount: number;
}

const definitions = {
  large: { groupCount: 2, repositoryCount: 8, worktreeCount: 6 },
  medium: { groupCount: 2, repositoryCount: 4, worktreeCount: 4 },
  small: { groupCount: 2, repositoryCount: 2, worktreeCount: 2 },
} as const;

interface RecursiveRemoveOptions {
  force: true;
  maxRetries: number;
  recursive: true;
  retryDelay: number;
}

type RemoveDirectory = (path: string, options: RecursiveRemoveOptions) => Promise<void>;

export async function cleanupFixtureDirectory(
  path: string,
  remove: RemoveDirectory = rm,
): Promise<void> {
  await remove(path, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  });
}

async function gitResult(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = spawn("git", args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await waitForProcessClose(child);
  return { exitCode, stderr, stdout };
}

async function git(cwd: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const result = await gitResult(cwd, args, environment);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
}

async function initializeRepository(path: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-b", "main"], environment);
  await git(path, ["config", "user.name", "Arashi Benchmark"], environment);
  await git(path, ["config", "user.email", "benchmark@arashi.invalid"], environment);
  await git(
    path,
    ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"],
    environment,
  );
}

async function addLocalRemote(
  repository: string,
  remote: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare"], environment);
  await git(repository, ["remote", "add", "origin", remote], environment);
  await git(repository, ["push", "--set-upstream", "origin", "main"], environment);
}

async function createWorkspace(options: {
  base: string;
  environment: NodeJS.ProcessEnv;
  groupCount: number;
  repositoryCount: number;
  withRemotes: boolean;
  worktreeCount: number;
}): Promise<string> {
  const root = join(options.base, "workspace");
  const remotes = join(options.base, "remotes");
  const worktrees = join(options.base, "worktrees");
  await initializeRepository(root, options.environment);
  await mkdir(join(root, ".arashi"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "repos/\n", "utf8");

  const repositories: { name: string; path: string }[] = [];
  const repos: Record<string, { groups: string[]; path: string }> = {};
  for (let index = 1; index <= options.repositoryCount; index += 1) {
    const name = `repo-${String(index).padStart(2, "0")}`;
    const path = join(root, "repos", name);
    await initializeRepository(path, options.environment);
    if (options.withRemotes) {
      await addLocalRemote(path, join(remotes, `${name}.git`), options.environment);
    }
    repositories.push({ name, path });
    repos[name] = {
      groups: [index % options.groupCount === 1 ? "benchmark-core" : "benchmark-support"],
      path: `repos/${name}`,
    };
  }

  await writeFile(
    join(root, ".arashi", "config.json"),
    `${JSON.stringify({ repos, reposDir: "./repos", version: "1.0.0", worktreesDir: "../worktrees" }, null, 2)}\n`,
    "utf8",
  );
  await git(root, ["add", ".arashi/config.json", ".gitignore"], options.environment);
  await git(
    root,
    ["-c", "commit.gpgsign=false", "commit", "-m", "configure fixture"],
    options.environment,
  );
  if (options.withRemotes) {
    await addLocalRemote(root, join(remotes, "workspace.git"), options.environment);
  }

  await mkdir(worktrees, { recursive: true });
  for (let index = 1; index < options.worktreeCount; index += 1) {
    const branch = `fixture-${String(index).padStart(2, "0")}`;
    const linkedRoot = join(worktrees, branch);
    await git(root, ["worktree", "add", "-b", branch, linkedRoot], options.environment);
    for (const repository of repositories) {
      await mkdir(join(linkedRoot, "repos"), { recursive: true });
      await git(
        repository.path,
        ["worktree", "add", "-b", branch, join(linkedRoot, "repos", repository.name)],
        options.environment,
      );
    }
  }
  return root;
}

export async function createBenchmarkFixture(id: FixtureId): Promise<BenchmarkFixture> {
  const definition = definitions[id];
  const base = await mkdtemp(join(tmpdir(), `arashi-benchmark-${id}-`));
  const globalConfig = join(base, "gitconfig");
  const hooksPath = join(base, "hooks");
  const userHome = join(base, "home");
  await writeFile(globalConfig, "", "utf8");
  await mkdir(hooksPath);
  await mkdir(userHome);
  const environment = createBenchmarkEnvironment(process.env, {
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_VALUE_0: hooksPath,
    GIT_TERMINAL_PROMPT: "0",
    HOME: userHome,
    USERPROFILE: userHome,
  });

  try {
    const refreshedRoot = await createWorkspace({
      ...definition,
      base,
      environment,
      withRemotes: true,
    });
    const repositoryPaths = Array.from({ length: definition.repositoryCount }, (_, index) =>
      join(refreshedRoot, "repos", `repo-${String(index + 1).padStart(2, "0")}`),
    );
    const branchPath = (branch: string) => join(base, "worktrees", branch);
    const branchTargets = (branch: string) =>
      repositoryPaths.slice(0, 2).map((repository, index) => ({
        path: join(branchPath(branch), "repos", `repo-${String(index + 1).padStart(2, "0")}`),
        repository,
      }));
    const resetBranch = async (branch: string): Promise<void> => {
      for (const target of branchTargets(branch).toReversed()) {
        await gitResult(
          target.repository,
          ["worktree", "remove", "--force", target.path],
          environment,
        );
      }
      await cleanupFixtureDirectory(branchPath(branch));
      for (const target of branchTargets(branch)) {
        await gitResult(target.repository, ["branch", "-D", branch], environment);
      }
    };
    const materializeBranch = async (branch: string): Promise<void> => {
      await mkdir(join(branchPath(branch), "repos"), { recursive: true });
      for (const target of branchTargets(branch)) {
        await git(target.repository, ["worktree", "add", "-b", branch, target.path], environment);
      }
    };
    const verifyBranch = async (branch: string, present: boolean): Promise<void> => {
      for (const target of branchTargets(branch)) {
        const branchExists =
          (
            await gitResult(
              target.repository,
              ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
              environment,
            )
          ).exitCode === 0;
        if (branchExists !== present || existsSync(target.path) !== present) {
          throw new Error(
            `Benchmark branch ${branch} did not reach expected ${present ? "present" : "absent"} state in ${target.repository}.`,
          );
        }
      }
    };
    const createBranch = "benchmark-create";
    const removeBranch = "benchmark-remove";
    return {
      cleanup: () => cleanupFixtureDirectory(base),
      coordinatedChildWorktreeCount: definition.repositoryCount * (definition.worktreeCount - 1),
      definitionVersion: 4,
      environment,
      id,
      refreshedRoot,
      statefulCases: {
        create: {
          prepare: async () => {
            await resetBranch(createBranch);
            await verifyBranch(createBranch, false);
          },
          verify: () => verifyBranch(createBranch, true),
        },
        remove: {
          prepare: async () => {
            await resetBranch(removeBranch);
            await materializeBranch(removeBranch);
            await verifyBranch(removeBranch, true);
          },
          verify: () => verifyBranch(removeBranch, false),
        },
      },
      ...definition,
    };
  } catch (error) {
    await cleanupFixtureDirectory(base);
    throw error;
  }
}
