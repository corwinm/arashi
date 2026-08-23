import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, describe, expect, test } from "vitest";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, join } from "path";

type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

let workspace: BareCreateWorkspace | null = null;
const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("create command from bare root", () => {
  test("creates requested worktree successfully", async () => {
    workspace = await createBareCreateWorkspace();
    const branch = "feature-bare-success";

    const command = runtime.spawn(
      [
        process.execPath,

        CLI_ENTRY,
        "create",
        branch,
        "--no-hooks",
        "--no-progress",
      ],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const exitCode = await command.exited;
    const stdout = await new Response(command.stdout).text();
    const stderr = await new Response(command.stderr).text();

    if (exitCode !== 0) {
      throw new Error(`create failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(exitCode).toBe(0);

    const expectedWorktreePath = join(
      workspace.bareRepoPath,
      ".arashi",
      "worktrees",
      `${basename(workspace.bareRepoPath)}-${branch}`,
    );
    expect(existsSync(expectedWorktreePath)).toBe(true);
  });

  test("moves changes from the enclosing linked worktree when invoked from a nested child", async () => {
    workspace = await createBareCreateWorkspace({ includeConfig: false });
    await mkdir(join(workspace.bareRepoPath, ".arashi"), { recursive: true });
    await writeFile(
      join(workspace.bareRepoPath, ".arashi", "config.json"),
      JSON.stringify({
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir: "..",
      }),
    );

    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    const initializeChild = runtime.spawnSync(["git", "init", "-b", "main"], {
      cwd: childPath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(initializeChild.exitCode).toBe(0);

    const changedContent = "# Dirty linked parent\n";
    await writeFile(join(workspace.worktreePath, "README.md"), changedContent);
    const branch = "feature-move-linked-changes";
    const command = runtime.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        "create",
        branch,
        "--move-changes",
        "--no-hooks",
        "--no-progress",
      ],
      { cwd: childPath, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      command.exited,
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    const targetPath = join(workspace.rootPath, `${basename(workspace.bareRepoPath)}-${branch}`);
    expect((await readFile(join(targetPath, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
      changedContent,
    );
    expect(
      (await readFile(join(workspace.worktreePath, "README.md"), "utf8")).replaceAll("\r\n", "\n"),
    ).toBe("# Bare Create Test\n");
    const sourceStatus = runtime.spawnSync(["git", "status", "--short"], {
      cwd: workspace.worktreePath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(new TextDecoder().decode(sourceStatus.stdout)).toBe("");
  });

  test("creates with stored tracked scope and no linked worktree without ignore-file writes", async () => {
    workspace = await createBareCreateWorkspace({ createLinkedWorktree: false });
    const branch = "feature-tracked-bare-worktree";
    for (const args of [
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      ["config", "--local", "arashi.ignoreScope", "tracked"],
    ]) {
      const git = runtime.spawnSync(["git", ...args], {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(git.exitCode).toBe(0);
    }

    const command = runtime.spawn(
      [process.execPath, CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"],
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
    const worktreePath = join(
      workspace.bareRepoPath,
      ".arashi",
      "worktrees",
      `${basename(workspace.bareRepoPath)}-${branch}`,
    );
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(workspace.bareRepoPath, ".gitignore"))).toBe(false);
    expect(existsSync(join(worktreePath, ".gitignore"))).toBe(false);
  });

  test("rejects tracked first-worktree creation when selected child repositories need ignore rules", async () => {
    workspace = await createBareCreateWorkspace({
      configRepos: { child: { path: "./repos/child" } },
      createLinkedWorktree: false,
    });
    const childPath = join(workspace.bareRepoPath, "repos", "child");
    await mkdir(join(workspace.bareRepoPath, "repos"), { recursive: true });
    const clone = runtime.spawnSync(
      ["git", "clone", "--branch", "main", workspace.bareRepoPath, childPath],
      {
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(clone.exitCode).toBe(0);
    const scope = runtime.spawnSync(["git", "config", "--local", "arashi.ignoreScope", "tracked"], {
      cwd: workspace.bareRepoPath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(scope.exitCode).toBe(0);

    const branch = "feature-tracked-with-child";
    const command = runtime.spawn(
      [process.execPath, CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"],
      { cwd: workspace.bareRepoPath, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      command.exited,
      new Response(command.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("require an existing linked worktree");
    expect(
      existsSync(
        join(
          workspace.bareRepoPath,
          ".arashi",
          "worktrees",
          `${basename(workspace.bareRepoPath)}-${branch}`,
        ),
      ),
    ).toBe(false);
  });

  test("creates the first worktree when the bare repository has no linked worktrees", async () => {
    workspace = await createBareCreateWorkspace({ createLinkedWorktree: false });
    const branch = "feature-first-bare-worktree";

    const command = runtime.spawn(
      [process.execPath, CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const exitCode = await command.exited;
    const stdout = await new Response(command.stdout).text();
    const stderr = await new Response(command.stderr).text();
    if (exitCode !== 0) {
      throw new Error(`create failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(
      existsSync(
        join(
          workspace.bareRepoPath,
          ".arashi",
          "worktrees",
          `${basename(workspace.bareRepoPath)}-${branch}`,
        ),
      ),
    ).toBe(true);
    const localExclude = await readFile(join(workspace.bareRepoPath, "info", "exclude"), "utf8");
    expect(localExclude).toContain("/.arashi/worktrees/");
  });
});
