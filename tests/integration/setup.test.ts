import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "bun";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WorkspaceOptions {
  hooksTimeoutMs?: number;
  mainSetup?: string;
  repoASetup?: string;
  repoBSetup?: string;
}

async function runCommand(cwd: string, args: string[]): Promise<CommandResult> {
  const proc = spawn(args, { cwd, stderr: "pipe", stdout: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr, stdout };
}

async function writeSetupScript(repoPath: string, content: string): Promise<void> {
  const scriptPath = join(repoPath, "setup.sh");
  await writeFile(scriptPath, content);
  await chmod(scriptPath, 0o755);
}

async function createWorkspace(
  baseDir: string,
  options: WorkspaceOptions = {},
): Promise<{ workspaceRoot: string; repoAPath: string; repoBPath: string }> {
  const workspaceRoot = join(baseDir, "workspace");
  const reposDir = join(workspaceRoot, "repos");
  const repoAPath = join(reposDir, "repo-a");
  const repoBPath = join(reposDir, "repo-b");
  await mkdir(repoAPath, { recursive: true });
  await mkdir(repoBPath, { recursive: true });
  await mkdir(join(workspaceRoot, ".arashi"), { recursive: true });

  const config: {
    version: string;
    reposDir: string;
    hooks?: { timeout: number };
    repos: Record<
      string,
      { path: string; defaultBranch: string; isBare: boolean; worktrees: never[] }
    >;
  } = {
    repos: {
      "repo-a": {
        path: "./repos/repo-a",
        defaultBranch: "main",
        isBare: false,
        worktrees: [],
      },
      "repo-b": {
        path: "./repos/repo-b",
        defaultBranch: "main",
        isBare: false,
        worktrees: [],
      },
    },
    reposDir: "./repos",
    version: "1.0.0",
  };

  if (options.hooksTimeoutMs !== undefined) {
    config.hooks = { timeout: options.hooksTimeoutMs };
  }

  await writeFile(join(workspaceRoot, ".arashi", "config.json"), JSON.stringify(config, null, 2));

  if (options.mainSetup) {
    await writeSetupScript(workspaceRoot, options.mainSetup);
  }
  if (options.repoASetup) {
    await writeSetupScript(repoAPath, options.repoASetup);
  }
  if (options.repoBSetup) {
    await writeSetupScript(repoBPath, options.repoBSetup);
  }

  return { repoAPath, repoBPath, workspaceRoot };
}

async function runSetup(workspaceRoot: string, args: string[] = []): Promise<CommandResult> {
  const arashiRoot = join(import.meta.dir, "..", "..");
  const entrypoint = join(arashiRoot, "src", "index.ts");
  return runCommand(workspaceRoot, ["bun", entrypoint, "setup", ...args]);
}

describe("setup command", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-setup-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("runs main repository setup before sub-repositories", async () => {
    const { workspaceRoot } = await createWorkspace(testDir, {
      mainSetup: "#!/bin/sh\necho main >> ./setup-order.log\n",
      repoASetup: "#!/bin/sh\necho repo-a >> ../../setup-order.log\n",
      repoBSetup: "#!/bin/sh\necho repo-b >> ../../setup-order.log\n",
    });

    const result = await runSetup(workspaceRoot);
    const order = await Bun.file(join(workspaceRoot, "setup-order.log")).text();

    expect(result.exitCode).toBe(0);
    expect(order.trim().split("\n")).toEqual(["main", "repo-a", "repo-b"]);
  });

  test("skips repositories without setup scripts", async () => {
    const { workspaceRoot } = await createWorkspace(testDir, {
      mainSetup: "#!/bin/sh\nexit 0\n",
      repoASetup: "#!/bin/sh\nexit 0\n",
    });

    const result = await runSetup(workspaceRoot);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("repo-b: skipped");
    expect(result.stdout).toContain("overall: success");
  });

  test("executes only selected repositories with --only", async () => {
    const { workspaceRoot } = await createWorkspace(testDir, {
      mainSetup: "#!/bin/sh\necho main\n",
      repoASetup: "#!/bin/sh\necho repo-a\n",
      repoBSetup: "#!/bin/sh\necho repo-b\n",
    });

    const result = await runSetup(workspaceRoot, ["--only", "repo-a"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("repo-a: success");
    expect(result.stdout).toContain("workspace: skipped");
    expect(result.stdout).toContain("repo-b: skipped");
    expect(result.stdout).toContain("excluded: 2");
  });

  test("fails validation for unknown --only repositories", async () => {
    const { workspaceRoot } = await createWorkspace(testDir, {
      mainSetup: "#!/bin/sh\nexit 0\n",
    });

    const result = await runSetup(workspaceRoot, ["--only", "does-not-exist"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr + result.stdout).toContain("Unknown repositories in --only filter");
  });

  test("shows verbose output and elapsed time details", async () => {
    const { workspaceRoot } = await createWorkspace(testDir, {
      repoASetup: "#!/bin/sh\necho setup-output\n",
    });

    const result = await runSetup(workspaceRoot, ["--only", "repo-a", "--verbose"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("setup-output");
    expect(result.stdout).toMatch(/repo-a: success \(\d+\.\d{2}s\)/);
  });

  test("classifies failures and timeouts in summary", async () => {
    const { workspaceRoot } = await createWorkspace(testDir, {
      hooksTimeoutMs: 25,
      repoASetup: "#!/bin/sh\nexit 5\n",
      repoBSetup: "#!/bin/sh\nsleep 1\n",
    });

    const result = await runSetup(workspaceRoot, ["--only", "repo-a", "--only", "repo-b"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("repo-a: failed");
    expect(result.stdout).toContain("repo-b: timed-out");
    expect(result.stdout).toContain("overall: failure");
  });
});
