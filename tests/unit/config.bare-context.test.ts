import {
  ConfigNotFoundError,
  findWorkspaceRoot,
  loadConfigWithFallback,
  loadWorkspaceRepositories,
} from "../../src/lib/config.ts";
import { afterEach, describe, expect, test } from "vitest";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { mkdir, realpath, writeFile } from "fs/promises";
import { basename, join } from "path";
type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

let workspace: BareCreateWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("config resolution in bare contexts", () => {
  test("prefers bare-root configuration over checked-out tracked configuration", async () => {
    workspace = await createBareCreateWorkspace();
    await mkdir(join(workspace.bareRepoPath, ".arashi"), { recursive: true });
    await writeFile(
      join(workspace.bareRepoPath, ".arashi", "config.json"),
      JSON.stringify({
        repos: {},
        reposDir: "./bare-repos",
        version: "1.0.0",
        worktreesDir: "..",
      }),
    );

    expect(await realpath(await findWorkspaceRoot(workspace.worktreePath))).toBe(
      await realpath(workspace.bareRepoPath),
    );
  });

  test("loads local config for non-bare invocation", async () => {
    workspace = await createBareCreateWorkspace();

    const loaded = await loadConfigWithFallback(workspace.worktreePath);

    expect(loaded.source).toBe("local-file");
    expect(loaded.config.reposDir).toBe("./repos");
  });

  test("falls back to repository content for bare invocation", async () => {
    workspace = await createBareCreateWorkspace();

    const loaded = await loadConfigWithFallback(workspace.bareRepoPath, {
      bareRepoPath: workspace.bareRepoPath,
    });

    expect(loaded.source).toBe("repository-content");
    expect(loaded.config.reposDir).toBe("./repos");
  });

  test("keeps the configured repository name while using the linked execution path", async () => {
    workspace = await createBareCreateWorkspace({ includeConfig: false });
    await mkdir(join(workspace.bareRepoPath, ".arashi"), { recursive: true });
    await writeFile(
      join(workspace.bareRepoPath, ".arashi", "config.json"),
      JSON.stringify({
        repos: { child: { path: "./repos/child" } },
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir: "..",
      }),
    );

    const { repositories } = await loadWorkspaceRepositories({
      configurationRoot: workspace.bareRepoPath,
      executionRoot: workspace.worktreePath,
    });

    expect(repositories).toEqual([
      { name: basename(workspace.bareRepoPath), path: workspace.worktreePath },
      {
        gitUrl: undefined,
        groups: undefined,
        name: "child",
        path: join(workspace.worktreePath, "repos", "child"),
      },
    ]);
  });

  test("throws clear error when config does not exist", async () => {
    workspace = await createBareCreateWorkspace({ includeConfig: false });

    await expect(
      loadConfigWithFallback(workspace.bareRepoPath, {
        bareRepoPath: workspace.bareRepoPath,
      }),
    ).rejects.toBeInstanceOf(ConfigNotFoundError);
  });
});
