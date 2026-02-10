import { afterEach, describe, expect, test } from "bun:test";
import {
  createBareCreateWorkspace,
  type BareCreateWorkspace,
} from "../helpers/create-bare-create-workspace.ts";
import { join } from "path";

let workspace: BareCreateWorkspace | null = null;
const CLI_ENTRY = join(import.meta.dir, "../../src/index.ts");

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

    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "create", "feature-no-config"], {
      cwd: workspace.bareRepoPath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain('Run "arashi init"');
  });
});
