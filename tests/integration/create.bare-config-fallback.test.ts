import { afterEach, describe, expect, test } from "bun:test";
import { createBareCreateWorkspace } from "../helpers/create-bare-create-workspace.ts";
import { join } from "path";
type BareCreateWorkspace = Awaited<ReturnType<typeof createBareCreateWorkspace>>;

let workspace: BareCreateWorkspace | null = null;
const CLI_ENTRY = join(import.meta.dir, "../../src/index.ts");

afterEach(async () => {
  if (!workspace) {
    return;
  }

  await workspace.cleanup();
  workspace = null;
});

describe("create config fallback in bare repository", () => {
  test("loads config from tracked repository content", async () => {
    workspace = await createBareCreateWorkspace();

    const proc = Bun.spawn(
      ["bun", CLI_ENTRY, "create", "feature-config-fallback", "--no-hooks", "--no-progress"],
      {
        cwd: workspace.bareRepoPath,
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`create failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    expect(exitCode).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain(
      "Loaded workspace configuration from repository content",
    );
  });
});
