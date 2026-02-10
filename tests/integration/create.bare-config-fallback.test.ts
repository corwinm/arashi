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

describe("create config fallback in bare repository", () => {
  test("loads config from tracked repository content", async () => {
    workspace = await createBareCreateWorkspace();

    const proc = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "create", "feature-config-fallback", "--no-hooks", "--no-progress"],
      {
        cwd: workspace.bareRepoPath,
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain(
      "Loaded workspace configuration from repository content",
    );
  });
});
