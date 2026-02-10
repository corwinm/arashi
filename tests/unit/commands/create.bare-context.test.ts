import { afterEach, describe, expect, test } from "bun:test";
import { resolveCreateInvocationContext } from "../../../src/commands/create.ts";
import {
  createBareCreateWorkspace,
  type BareCreateWorkspace,
} from "../../helpers/create-bare-create-workspace.ts";

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
});
