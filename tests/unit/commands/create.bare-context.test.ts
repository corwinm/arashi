import { afterEach, describe, expect, test } from "vitest";
import { mkdir, realpath } from "fs/promises";
import {
  resolveCreateInvocationContext,
  resolveManagedIgnoreWorkspaceRoot,
} from "../../../src/commands/create.ts";
import { createBareCreateWorkspace } from "../../helpers/create-bare-create-workspace.ts";
import { join, resolve } from "path";
import { runtime } from "../../helpers/node-runtime.ts";
type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

let workspace: BareCreateWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("create command bare context resolver", () => {
  test("detects bare repository invocation", async () => {
    workspace = await createBareCreateWorkspace();

    const context = await resolveCreateInvocationContext(workspace.bareRepoPath);

    const canonicalBareRoot = await realpath(workspace.bareRepoPath);
    expect(context.repositoryType).toBe("bare");
    expect(context.workspaceRoot).toBe(canonicalBareRoot);
    expect(context.executionPath).toBe(canonicalBareRoot);
  });

  test("canonicalizes nested bare invocation to the absolute Git directory", async () => {
    workspace = await createBareCreateWorkspace();
    const nestedPath = join(workspace.bareRepoPath, "nested", "inside");
    await mkdir(nestedPath, { recursive: true });

    const context = await resolveCreateInvocationContext(nestedPath);
    const canonicalBareRoot = await realpath(workspace.bareRepoPath);

    expect(context).toMatchObject({
      executionPath: canonicalBareRoot,
      invocationPath: canonicalBareRoot,
      repositoryType: "bare",
      workspaceRoot: canonicalBareRoot,
    });
  });

  test("keeps non-bare invocation behavior", async () => {
    workspace = await createBareCreateWorkspace();

    const context = await resolveCreateInvocationContext(workspace.worktreePath);

    expect(context.repositoryType).toBe("non-bare");
    expect(context.workspaceRoot).toBe(workspace.worktreePath);
    expect(context.executionPath).toBe(workspace.worktreePath);
  });

  test("normalizes nested non-bare invocation to workspace root", async () => {
    workspace = await createBareCreateWorkspace();
    const nestedPath = join(workspace.worktreePath, "nested", "path", "inside");
    await mkdir(nestedPath, { recursive: true });

    const context = await resolveCreateInvocationContext(nestedPath);

    expect(context.repositoryType).toBe("non-bare");
    expect(context.invocationPath).toBe(nestedPath);
    expect(context.workspaceRoot).toBe(workspace.worktreePath);
    expect(context.executionPath).toBe(workspace.worktreePath);
  });

  test("prefers the invoking linked worktree for tracked ignore reconciliation", async () => {
    workspace = await createBareCreateWorkspace({ includeConfig: false });
    await mkdir(join(workspace.bareRepoPath, ".arashi"), { recursive: true });
    await runtime.write(
      join(workspace.bareRepoPath, ".arashi", "config.json"),
      JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }),
    );
    const invokingWorktreePath = join(workspace.rootPath, "z-invoking-worktree");
    const addWorktree = runtime.spawnSync(
      ["git", "worktree", "add", "-b", "invoking-branch", invokingWorktreePath, "main"],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(addWorktree.exitCode).toBe(0);

    const context = await resolveCreateInvocationContext(invokingWorktreePath);
    const managedIgnoreWorkspaceRoot = await resolveManagedIgnoreWorkspaceRoot(context, true);

    expect(context.repositoryType).toBe("bare");
    expect(context.executionPath).toBe(context.workspaceRoot);
    expect(resolve(managedIgnoreWorkspaceRoot)).toBe(resolve(await realpath(invokingWorktreePath)));
  });

  test("prefers the enclosing linked worktree over a nested child repository", async () => {
    workspace = await createBareCreateWorkspace({ includeConfig: false });
    await mkdir(join(workspace.bareRepoPath, ".arashi"), { recursive: true });
    await runtime.write(
      join(workspace.bareRepoPath, ".arashi", "config.json"),
      JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" }),
    );
    const trackedScope = runtime.spawnSync(
      ["git", "config", "--local", "arashi.ignoreScope", "tracked"],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(trackedScope.exitCode).toBe(0);
    const childPath = join(workspace.worktreePath, "repos", "child");
    await mkdir(childPath, { recursive: true });
    const initializeChild = runtime.spawnSync(["git", "init", "-b", "main"], {
      cwd: childPath,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(initializeChild.exitCode).toBe(0);

    const context = await resolveCreateInvocationContext(childPath);
    const managedIgnoreWorkspaceRoot = await resolveManagedIgnoreWorkspaceRoot(context, true);

    expect(context.repositoryType).toBe("bare");
    expect(resolve(managedIgnoreWorkspaceRoot)).toBe(
      resolve(await realpath(workspace.worktreePath)),
    );
  });
});
