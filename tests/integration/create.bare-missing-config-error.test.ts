import { runtime } from "#test-runtime";
import { afterEach, describe, expect, test } from "vitest";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { join } from "path";
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

describe("create missing config guidance from bare root", () => {
  test("returns actionable init guidance", async () => {
    workspace = await createBareCreateWorkspace({ includeConfig: false });

    const proc = runtime.spawn(
      [
        process.execPath,

        CLI_ENTRY,
        "create",
        "feature-no-config",
      ],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain('Run "arashi init"');
  });
});
