import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "bun";

describe("add command duplicate guidance", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-add-duplicate-"));
    await mkdir(join(testDir, ".arashi"), { recursive: true });

    const config = {
      repos: {
        "arashi-docs": {
          path: "./repos/arashi-docs",
          gitUrl: "git@github.com:corwinm/arashi-docs.git",
        },
      },
      reposDir: "./repos",
      version: "1.0.0",
    };

    await writeFile(join(testDir, ".arashi", "config.json"), JSON.stringify(config, null, 2));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("suggests clone instead of remove for duplicate repository", async () => {
    const entrypoint = join(import.meta.dir, "..", "..", "src", "index.ts");
    const proc = spawn(["bun", entrypoint, "add", "git@github.com:corwinm/arashi-docs.git"], {
      cwd: testDir,
      stderr: "pipe",
      stdout: "pipe",
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
