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

describe("create conflict guidance from bare root", () => {
  test("reports conflict with actionable next step", async () => {
    workspace = await createBareCreateWorkspace();
    const branch = "feature-conflict";

    const firstRun = Bun.spawn(
      ["bun", CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"],
      {
        cwd: workspace.bareRepoPath,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const firstExit = await firstRun.exited;
    expect(firstExit).toBe(0);

    const secondRun = Bun.spawn(
      ["bun", CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress", "--conflict", "ABORT"],
      {
        cwd: workspace.bareRepoPath,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(secondRun.stdout).text();
    const stderr = await new Response(secondRun.stderr).text();
    const exitCode = await secondRun.exited;

    expect(exitCode).toBe(2);
    expect(`${stdout}\n${stderr}`).toContain("retry with --conflict REUSE_EXISTING");
  });
});
