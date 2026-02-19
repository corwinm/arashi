import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "bun";

describe("add command duplicate guidance", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-add-duplicate-"));
    await mkdir(join(testDir, ".arashi"), { recursive: true });

    const config = {
      version: "1.0.0",
      repos_dir: "./repos",
      auto_setup: true,
      discovered_repos: {
        "arashi-docs": {
          path: "./repos/arashi-docs",
          git_url: "git@github.com:corwinm/arashi-docs.git",
        },
      },
    };

    await writeFile(join(testDir, ".arashi", "config.json"), JSON.stringify(config, null, 2));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("suggests clone instead of remove for duplicate repository", async () => {
    const entrypoint = join(import.meta.dir, "..", "..", "src", "index.ts");
    const proc = spawn(["bun", entrypoint, "add", "git@github.com:corwinm/arashi-docs.git"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(2);
    expect(output).toContain("arashi clone");
    expect(output).not.toContain("arashi remove");
    expect(output).not.toContain("Use a different name");
  });
});
