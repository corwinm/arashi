import { afterEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdir, realpath } from "fs/promises";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { existsSync } from "fs";
import { createCommand as createAddCommand } from "../../src/commands/add.ts";
import { executeSwitch } from "../../src/commands/switch.ts";
import { findWorkspaceRoot } from "../../src/lib/config.ts";
import { basename, join, resolve } from "path";
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
  repos: Record<string, { gitUrl?: string; path: string }> = {},
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

  test("list routes nested-child invocation through the enclosing linked parent", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child main\n");

    const result = await runCli(childPath, ["list", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as { data: { worktrees: { path: string }[] } };
    const listedPaths = await Promise.all(
      envelope.data.worktrees.map(async (worktree) => realpath(worktree.path)),
    );
    expect(listedPaths, JSON.stringify(listedPaths)).toContain(
      await realpath(workspace.worktreePath),
    );
    expect(listedPaths).not.toContain(await realpath(childPath));
  });

  test("clone materializes a missing linked child from the configured bare-root clone", async () => {
    workspace = await configureBareWorkspace();
    const childSourcePath = join(workspace.rootPath, "child-source");
    const centralChildPath = join(workspace.bareRepoPath, "repos", "child");
    const linkedChildPath = join(workspace.worktreePath, "repos", "child");
    const nestedCallerPath = join(workspace.worktreePath, "repos", "caller");
    await mkdir(childSourcePath, { recursive: true });
    await execGit(["init", "-b", "main"], childSourcePath);
    await configureRepository(childSourcePath);
    await commitFile(childSourcePath, "README.md", "child main\n");
    await execGit(["branch", "feature/clone-linked-child"], childSourcePath);
    await execGit(["clone", childSourcePath, centralChildPath], workspace.bareRepoPath);
    await mkdir(nestedCallerPath, { recursive: true });
    await execGit(["init", "-b", "main"], nestedCallerPath);
    await execGit(["checkout", "-b", "feature/clone-linked-child"], workspace.worktreePath);
    await runtime.write(
      join(workspace.bareRepoPath, ".arashi", "config.json"),
      JSON.stringify(
        {
          repos: {
            caller: { path: "./repos/caller" },
            child: { gitUrl: pathToFileURL(childSourcePath).href, path: "./repos/child" },
          },
          reposDir: "./repos",
          version: "1.0.0",
          worktreesDir: "..",
        },
        null,
        2,
      ),
    );

    const result = await runCli(nestedCallerPath, ["clone", "--all", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { cloned: ["child"], failed: [], status: "success" },
    });
    expect(existsSync(centralChildPath)).toBe(true);
    expect(existsSync(linkedChildPath)).toBe(true);
    const branch = runtime.spawnSync(["git", "branch", "--show-current"], {
      cwd: linkedChildPath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(branch.exitCode).toBe(0);
    expect(new TextDecoder().decode(branch.stdout).trim()).toBe("feature/clone-linked-child");
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

  test("duplicate add clone fallback materializes a missing child from a nested repository", async () => {
    workspace = await configureBareWorkspace();
    const childSourcePath = join(workspace.rootPath, "child-source");
    const centralChildPath = join(workspace.bareRepoPath, "repos", "child");
    const linkedChildPath = join(workspace.worktreePath, "repos", "child");
    const nestedCallerPath = join(workspace.worktreePath, "repos", "caller");
    await mkdir(childSourcePath, { recursive: true });
    await execGit(["init", "-b", "main"], childSourcePath);
    await configureRepository(childSourcePath);
    await commitFile(childSourcePath, "README.md", "child main\n");
    await execGit(["branch", "feature/add-clone-fallback"], childSourcePath);
    await execGit(["clone", childSourcePath, centralChildPath], workspace.bareRepoPath);
    await mkdir(nestedCallerPath, { recursive: true });
    await execGit(["init", "-b", "main"], nestedCallerPath);
    await execGit(["checkout", "-b", "feature/add-clone-fallback"], workspace.worktreePath);
    await runtime.write(
      join(workspace.bareRepoPath, ".arashi", "config.json"),
      JSON.stringify(
        {
          repos: {
            caller: { path: "./repos/caller" },
            child: { gitUrl: pathToFileURL(childSourcePath).href, path: "./repos/child" },
          },
          reposDir: "./repos",
          version: "1.0.0",
          worktreesDir: "..",
        },
        null,
        2,
      ),
    );

    const originalCwd = process.cwd();
    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;
    const prompts = await import("../../src/lib/prompts.ts");
    const confirm = vi.spyOn(prompts, "confirm").mockResolvedValue({ status: "ok", value: true });
    const multiSelect = vi
      .spyOn(prompts, "multiSelect")
      .mockResolvedValue({ status: "ok", value: ["child"] });
    const select = vi.spyOn(prompts, "select").mockResolvedValue({ status: "ok", value: "ssh" });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      process.chdir(nestedCallerPath);
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      await createAddCommand().parseAsync(
        ["node", "arashi", pathToFileURL(childSourcePath).href, "--name", "child"],
        { from: "node" },
      );

      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      process.chdir(originalCwd);
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalStdinIsTTY,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalStdoutIsTTY,
      });
      confirm.mockRestore();
      multiSelect.mockRestore();
      select.mockRestore();
      exit.mockRestore();
    }

    expect(existsSync(centralChildPath)).toBe(true);
    expect(existsSync(linkedChildPath)).toBe(true);
    const branch = runtime.spawnSync(["git", "branch", "--show-current"], {
      cwd: linkedChildPath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(branch.exitCode).toBe(0);
    expect(new TextDecoder().decode(branch.stdout).trim()).toBe("feature/add-clone-fallback");
  });

  test("status loads config from the bare root but inspects the dirty linked parent and child", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child main\n");
    await runtime.write(join(workspace.worktreePath, "parent-dirty.txt"), "parent dirty\n");
    await runtime.write(join(childPath, "child-dirty.txt"), "child dirty\n");

    const result = await runCli(childPath, ["status", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      data: {
        repositories: { files: { path: string }[]; name: string; path: string }[];
        workspaceRoot: string;
      };
    };
    const canonicalWorkspaceRoot = await realpath(workspace.worktreePath);
    const canonicalRepositories = await Promise.all(
      envelope.data.repositories.map(async (repository) => ({
        ...repository,
        path: await realpath(repository.path),
      })),
    );
    expect(await realpath(envelope.data.workspaceRoot)).toBe(
      await realpath(workspace.bareRepoPath),
    );
    expect(canonicalRepositories).toMatchObject([
      {
        files: expect.arrayContaining([expect.objectContaining({ path: "parent-dirty.txt" })]),
        name: "Main Repository",
        path: canonicalWorkspaceRoot,
      },
      {
        files: expect.arrayContaining([expect.objectContaining({ path: "child-dirty.txt" })]),
        name: "child",
        path: await realpath(childPath),
      },
    ]);
  });

  test("doctor loads config from the bare root but inspects the dirty linked parent and child", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child main\n");
    await runtime.write(join(workspace.worktreePath, "parent-dirty.txt"), "parent dirty\n");
    await runtime.write(join(childPath, "child-dirty.txt"), "child dirty\n");

    const result = await runCli(childPath, ["doctor", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      data: {
        findings: { code: string; details?: { path?: string }; scope: string }[];
        workspaceRoot: string;
      };
    };
    const canonicalWorkspaceRoot = await realpath(workspace.worktreePath);
    expect(await realpath(envelope.data.workspaceRoot)).toBe(
      await realpath(workspace.bareRepoPath),
    );
    const dirtyFindings = envelope.data.findings.filter(
      (finding) => finding.code === "REPOSITORY_DIRTY",
    );
    expect(dirtyFindings).toHaveLength(2);
    expect(dirtyFindings.map((finding) => finding.scope)).toEqual([
      "repository:Main Repository",
      "repository:child",
    ]);
    expect(
      await Promise.all(
        dirtyFindings.map(async (finding) => realpath(finding.details?.path ?? "")),
      ),
    ).toEqual([canonicalWorkspaceRoot, await realpath(childPath)]);
  });

  test("handoff loads config from the bare root but reports the active linked parent and child", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child main\n");
    await runtime.write(join(workspace.worktreePath, "parent-dirty.txt"), "parent dirty\n");
    await runtime.write(join(childPath, "child-dirty.txt"), "child dirty\n");

    const result = await runCli(childPath, ["handoff", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      data: {
        repositories: { files: { path: string }[]; name: string; path: string }[];
        workspaceRoot: string;
      };
    };
    expect(await realpath(envelope.data.workspaceRoot)).toBe(
      await realpath(workspace.bareRepoPath),
    );
    expect(envelope.data.repositories).toMatchObject([
      {
        files: expect.arrayContaining([expect.objectContaining({ path: "parent-dirty.txt" })]),
        name: "Main Repository",
      },
      {
        files: expect.arrayContaining([expect.objectContaining({ path: "child-dirty.txt" })]),
        name: "child",
      },
    ]);
    expect(
      await Promise.all(
        envelope.data.repositories.map(async (repository) => realpath(repository.path)),
      ),
    ).toEqual([await realpath(workspace.worktreePath), await realpath(childPath)]);
  });

  test("handoff invoked at the bare root never derives the workspace branch from a child", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.bareRepoPath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "child-only"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child branch\n");
    await execGit(["symbolic-ref", "HEAD", "refs/heads/main"], workspace.bareRepoPath);

    const result = await runCli(workspace.bareRepoPath, ["handoff", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      data: {
        repositories: { branch: { localBranch: string }; name: string }[];
        workspace: { branch: string };
      };
    };
    expect(envelope.data.repositories).toMatchObject([
      { branch: { localBranch: "child-only" }, name: "child" },
    ]);
    expect(envelope.data.workspace.branch).toBe("main");
  });

  test("switch --repos scopes candidates to the invoking linked worktree", async () => {
    workspace = await configureBareWorkspace({ child: { path: "./repos/child" } });
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    await execGit(["init", "-b", "main"], childPath);
    await configureRepository(childPath);
    await commitFile(childPath, "README.md", "child main\n");
    const originalCwd = process.cwd();
    let launchedPath: string | undefined;

    try {
      process.chdir(workspace.worktreePath);
      const result = await executeSwitch(
        await realpath(childPath),
        { json: false, path: true, repos: true },
        {
          launchSwitchTarget: async (target) => {
            launchedPath = target.worktreePath;
            return { command: ["noop"], mode: "fallback" };
          },
        },
      );
      expect(result).toMatchObject({ launchMode: "fallback" });
    } finally {
      process.chdir(originalCwd);
    }

    expect(await realpath(launchedPath!)).toBe(await realpath(childPath));
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
        repositoryId: basename(workspace.bareRepoPath),
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
      { repositoryId: basename(workspace.bareRepoPath), status: "planned" },
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
