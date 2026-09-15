import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForProcessClose } from "./process.ts";

export type FixtureId = "small" | "larger";

export interface BenchmarkFixture {
  cleanup(): Promise<void>;
  coordinatedChildWorktreeCount: number;
  definitionVersion: number;
  groupCount: number;
  id: FixtureId;
  refreshedRoot: string;
  repositoryCount: number;
  worktreeCount: number;
}

const definitions = {
  small: { groupCount: 2, repositoryCount: 2, worktreeCount: 2 },
  larger: { groupCount: 2, repositoryCount: 8, worktreeCount: 6 },
} as const;

async function git(cwd: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn("git", args, {
    cwd,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await waitForProcessClose(child);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
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

  const repositories: Array<{ name: string; path: string }> = [];
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
  await writeFile(globalConfig, "", "utf8");
  await mkdir(hooksPath);
  const environment = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_VALUE_0: hooksPath,
    GIT_TERMINAL_PROMPT: "0",
  };

  try {
    const refreshedRoot = await createWorkspace({
      ...definition,
      base,
      environment,
      withRemotes: true,
    });
    return {
      cleanup: () => rm(base, { force: true, recursive: true }),
      coordinatedChildWorktreeCount: definition.repositoryCount * (definition.worktreeCount - 1),
      definitionVersion: 3,
      id,
      refreshedRoot,
      ...definition,
    };
  } catch (error) {
    await rm(base, { force: true, recursive: true });
    throw error;
  }
}
