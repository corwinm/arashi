import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdir, realpath } from "fs/promises";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { existsSync } from "fs";
import { findWorkspaceRoot } from "../../src/lib/config.ts";
import { join, resolve } from "path";
import { pathToFileURL } from "node:url";
import { runtime } from "../helpers/node-runtime.ts";

type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
let workspace: BareCreateWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

async function configureBareWorkspace(
  repos: Record<string, { path: string }> = {},
): Promise<BareCreateWorkspace> {
  const createdWorkspace = await createBareCreateWorkspace({ includeConfig: false });
  await mkdir(join(createdWorkspace.bareRepoPath, ".arashi"), { recursive: true });
  await mkdir(join(createdWorkspace.bareRepoPath, "repos"), { recursive: true });
  await runtime.write(
    join(createdWorkspace.bareRepoPath, ".arashi", "config.json"),
    JSON.stringify(
      {
        repos,
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir: ".arashi/worktrees",
      },
      null,
      2,
    ),
  );
  return createdWorkspace;
}

async function execGit(args: string[], cwd: string): Promise<void> {
  const proc = runtime.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit=${exitCode}): ${stderr}`);
  }
}

async function runCli(cwd: string, args: string[]) {
  const command = runtime.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    command.exited,
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function configureRepository(repoPath: string): Promise<void> {
  await execGit(["config", "user.name", "Test User"], repoPath);
  await execGit(["config", "user.email", "test@example.com"], repoPath);
  await execGit(["config", "commit.gpgsign", "false"], repoPath);
}

async function commitFile(repoPath: string, fileName: string, content: string): Promise<void> {
  await runtime.write(join(repoPath, fileName), content);
  await execGit(["add", fileName], repoPath);
  await execGit(["commit", "-m", `Add ${fileName}`], repoPath);
}

describe("configured bare workspace discovery from linked worktrees", () => {
  test("finds the parent bare workspace from a nested child repository", async () => {
    workspace = await configureBareWorkspace();
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);

    await expect(findWorkspaceRoot(childPath)).resolves.toBe(
      await realpath(workspace.bareRepoPath),
    );
  });

  test("adds a repository when invoked from a linked worktree", async () => {
    workspace = await configureBareWorkspace();
    const sourcePath = join(workspace.rootPath, "source-repository");
    await mkdir(sourcePath, { recursive: true });
    await execGit(["init", "-b", "main"], sourcePath);
    await execGit(["config", "user.name", "Test User"], sourcePath);
    await execGit(["config", "user.email", "test@example.com"], sourcePath);
    await execGit(["config", "commit.gpgsign", "false"], sourcePath);
    await runtime.write(join(sourcePath, "README.md"), "# Source repository\n");
    await execGit(["add", "."], sourcePath);
    await execGit(["commit", "-m", "Initial content"], sourcePath);

    const command = runtime.spawn(
      [process.execPath, CLI_ENTRY, "add", pathToFileURL(sourcePath).href, "--force", "--json"],
      {
        cwd: workspace.worktreePath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(existsSync(join(workspace.bareRepoPath, "repos", "source-repository"))).toBe(true);
    const config = JSON.parse(
      await runtime.file(join(workspace.bareRepoPath, ".arashi", "config.json")).text(),
    ) as { repos: Record<string, { path: string }> };
    expect(resolve(workspace.bareRepoPath, config.repos["source-repository"]?.path ?? "")).toBe(
      resolve(workspace.bareRepoPath, "repos", "source-repository"),
    );
  });

  test("exec loads config from the bare root but runs in the linked parent and its child", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);

    const command = runtime.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        "exec",
        "--json",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.cwd())",
      ],
      {
        cwd: childPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toBe("");
    const envelope = JSON.parse(stdout) as {
      data: { results: { path: string; repositoryId: string; stdout: string }[] };
    };
    const canonicalResults = await Promise.all(
      envelope.data.results.map(async (result) => ({
        ...result,
        path: await realpath(result.path),
        stdout: await realpath(result.stdout),
      })),
    );
    const linkedParentPath = await realpath(workspace.worktreePath);
    const linkedChildPath = await realpath(childPath);
    expect(canonicalResults).toEqual([
      {
        command: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
        elapsedMs: expect.any(Number),
        exitCode: 0,
        path: linkedParentPath,
        repositoryId: "main-worktree",
        status: "passed",
        stderr: "",
        stdout: linkedParentPath,
      },
      {
        command: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
        elapsedMs: expect.any(Number),
        exitCode: 0,
        path: linkedChildPath,
        repositoryId: "child",
        status: "passed",
        stderr: "",
        stdout: linkedChildPath,
      },
    ]);
  });

  test("push loads config from the bare root but plans linked parent and child pushes", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    const parentRemote = join(workspace.rootPath, "parent-origin.git");
    const childRemote = join(workspace.rootPath, "child-origin.git");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "--bare", parentRemote], workspace.rootPath);
    await execGit(["init", "--bare", childRemote], workspace.rootPath);
    await execGit(["remote", "add", "origin", parentRemote], workspace.worktreePath);
    await execGit(["push", "--set-upstream", "origin", "main"], workspace.worktreePath);
    await execGit(["init", "-b", "main"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child main\n");
    await execGit(["remote", "add", "origin", childRemote], childPath);
    await execGit(["push", "--set-upstream", "origin", "main"], childPath);
    await execGit(["checkout", "-b", "feature/lifecycle-roots"], workspace.worktreePath);
    await configureRepository(workspace.worktreePath);
    await commitFile(workspace.worktreePath, "parent-feature.txt", "parent feature\n");
    await execGit(["checkout", "-b", "feature/lifecycle-roots"], childPath);
    await commitFile(childPath, "child-feature.txt", "child feature\n");

    const result = await runCli(childPath, ["push", "--dry-run", "--set-upstream", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      data: { results: { repositoryId: string; status: string }[] };
    };
    expect(envelope.data.results).toMatchObject([
      { repositoryId: "main-worktree", status: "planned" },
      { repositoryId: "child", status: "planned" },
    ]);
  });

  test("pull loads config from the bare root but updates the linked child repository", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const reposPath = join(workspace.worktreePath, "repos");
    const childPath = join(reposPath, "child");
    const childRemote = join(workspace.rootPath, "child-pull-origin.git");
    const seedPath = join(workspace.rootPath, "child-pull-seed");
    const updaterPath = join(workspace.rootPath, "child-pull-updater");
    await mkdir(reposPath, { recursive: true });
    await execGit(["init", "--bare", childRemote], workspace.rootPath);
    await mkdir(seedPath, { recursive: true });
    await execGit(["init", "-b", "main"], seedPath);
    await configureRepository(seedPath);
    await commitFile(seedPath, "README.md", "child main\n");
    await execGit(["remote", "add", "origin", childRemote], seedPath);
    await execGit(["push", "--set-upstream", "origin", "main"], seedPath);
    await execGit(["symbolic-ref", "HEAD", "refs/heads/main"], childRemote);
    await execGit(["clone", childRemote, childPath], reposPath);
    await execGit(["clone", childRemote, updaterPath], workspace.rootPath);
    await configureRepository(updaterPath);
    await commitFile(updaterPath, "remote-update.txt", "remote update\n");
    await execGit(["push", "origin", "main"], updaterPath);

    const result = await runCli(childPath, ["pull", "--only", "child", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await runtime.file(join(childPath, "remote-update.txt")).text()).toBe("remote update\n");
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { results: [{ repositoryId: "child", status: "updated" }] },
    });
  });

  test("setup loads config from the bare root but runs scripts in the linked repositories", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);
    await runtime.write(
      join(workspace.worktreePath, "setup.sh"),
      "#!/bin/sh\nprintf parent > parent-setup.marker\n",
    );
    await runtime.write(
      join(childPath, "setup.sh"),
      "#!/bin/sh\nprintf child > child-setup.marker\n",
    );
    await chmod(join(workspace.worktreePath, "setup.sh"), 0o755);
    await chmod(join(childPath, "setup.sh"), 0o755);

    const result = await runCli(childPath, ["setup", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(await runtime.file(join(workspace.worktreePath, "parent-setup.marker")).text()).toBe(
      "parent",
    );
    expect(await runtime.file(join(childPath, "child-setup.marker")).text()).toBe("child");
  });

  test("sync loads config from the bare root but aligns linked children to the linked parent", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child main\n");
    await execGit(["branch", "feature/lifecycle-roots"], childPath);
    await execGit(["checkout", "-b", "feature/lifecycle-roots"], workspace.worktreePath);

    const result = await runCli(childPath, ["sync", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    const branch = runtime.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: childPath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(new TextDecoder().decode(branch.stdout).trim()).toBe("feature/lifecycle-roots");
  });

  test("exec invoked at the bare root continues to use the bare repository tree", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.bareRepoPath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);

    const command = runtime.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        "exec",
        "--json",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.cwd())",
      ],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toBe("");
    const envelope = JSON.parse(stdout) as {
      data: { results: { path: string; repositoryId: string; stdout: string }[] };
    };
    const canonicalResults = await Promise.all(
      envelope.data.results.map(async (result) => ({
        ...result,
        path: await realpath(result.path),
        stdout: await realpath(result.stdout),
      })),
    );
    const bareRootPath = await realpath(workspace.bareRepoPath);
    const bareChildPath = await realpath(childPath);
    expect(canonicalResults).toMatchObject([
      {
        path: bareRootPath,
        repositoryId: "main.git",
        status: "passed",
        stdout: bareRootPath,
      },
      {
        path: bareChildPath,
        repositoryId: "child",
        status: "passed",
        stdout: bareChildPath,
      },
    ]);
  });
});
