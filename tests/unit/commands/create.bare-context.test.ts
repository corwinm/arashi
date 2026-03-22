import { afterEach, describe, expect, test } from "bun:test";
import { createBareCreateWorkspace } from "../../helpers/create-bare-create-workspace.ts";
import { join } from "path";
import { mkdir } from "fs/promises";
import { resolveCreateInvocationContext } from "../../../src/commands/create.ts";
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

    expect(context.repositoryType).toBe("bare");
    expect(context.workspaceRoot).toBe(workspace.bareRepoPath);
    expect(context.executionPath).toBe(workspace.bareRepoPath);
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
});
