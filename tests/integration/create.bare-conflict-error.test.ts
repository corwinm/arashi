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

describe("create conflict guidance from bare root", () => {
  test("reports conflict with actionable next step", async () => {
    workspace = await createBareCreateWorkspace();
    const branch = "feature-conflict";

    const firstRun = runtime.spawn(
      [
        process.execPath,
        "--no-warnings",
        "--experimental-transform-types",

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
    const firstStdout = await new Response(firstRun.stdout).text();
    const firstStderr = await new Response(firstRun.stderr).text();
    const firstExit = await firstRun.exited;

    if (firstExit !== 0) {
      throw new Error(
        `first create failed (exit=${firstExit})\nstdout:\n${firstStdout}\nstderr:\n${firstStderr}`,
      );
    }
    expect(firstExit).toBe(0);

    const secondRun = runtime.spawn(
      [
        process.execPath,
        "--no-warnings",
        "--experimental-transform-types",

        CLI_ENTRY,
        "create",
        branch,
        "--no-hooks",
        "--no-progress",
        "--conflict",
        "ABORT",
      ],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const stdout = await new Response(secondRun.stdout).text();
    const stderr = await new Response(secondRun.stderr).text();
    const exitCode = await secondRun.exited;

    expect(exitCode).toBe(2);
    expect(`${stdout}\n${stderr}`).toContain("retry with --conflict REUSE_EXISTING");
  });
});
