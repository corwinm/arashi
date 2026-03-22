import { afterEach, describe, expect, test } from "bun:test";
import { ConfigNotFoundError, loadConfigWithFallback } from "../../src/lib/config.ts";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import type { BareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";

let workspace: BareCreateWorkspace | null = null;

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("config resolution in bare contexts", () => {
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

  test("throws clear error when config does not exist", async () => {
    workspace = await createBareCreateWorkspace({ includeConfig: false });

    await expect(
      loadConfigWithFallback(workspace.bareRepoPath, {
        bareRepoPath: workspace.bareRepoPath,
      }),
    ).rejects.toBeInstanceOf(ConfigNotFoundError);
  });
});
