import { runtime } from "../helpers/node-runtime.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dirname, join, relative, resolve } from "path";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");

let testRoot = "";
let workspacePath = "";

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = runtime.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return;
  }

  const stderr = await new Response(proc.stderr).text();
  throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function writeWorkspaceConfig(worktreesDir: string): Promise<void> {
  await mkdir(join(workspacePath, ".arashi"), { recursive: true });
  await runtime.write(
    join(workspacePath, ".arashi", "config.json"),
    JSON.stringify(
      {
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir,
      },
      null,
      2,
    ),
  );
}

async function writePreCreateMarker(marker: string): Promise<void> {
  const hooksDir = join(workspacePath, ".arashi", "hooks");
  await mkdir(hooksDir, { recursive: true });
  const windows = process.platform === "win32";
  await writeFile(
    join(hooksDir, windows ? "pre-create.ps1" : "pre-create.sh"),
    windows
      ? `New-Item -ItemType File -Path '${marker}' | Out-Null\n`
      : `#!/bin/sh\ntouch '${marker}'\n`,
    { mode: 0o755 },
  );
}

async function runCreate(branch: string): Promise<void> {
  const proc = runtime.spawn(
    [
      process.execPath,

      CLI_ENTRY,
      "create",
      branch,
      "--no-hooks",
      "--no-progress",
    ],
    {
      cwd: workspacePath,
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
}

async function runCreateResult(
  branch: string,
  extraArgs: string[] = [],
): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const proc = runtime.spawn(
    [process.execPath, CLI_ENTRY, "create", branch, "--no-progress", ...extraArgs],
    { cwd: workspacePath, stderr: "pipe", stdout: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr, stdout };
}

describe("create command worktree location resolution", () => {
  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "arashi-worktree-location-"));
    workspacePath = join(testRoot, "workspace");
    await mkdir(workspacePath);

    await runGit(["init", "-b", "main"], workspacePath);
    await runGit(["config", "user.name", "Test User"], workspacePath);
    await runGit(["config", "user.email", "test@example.com"], workspacePath);

    await writeFile(join(workspacePath, "README.md"), "# workspace\n");
    await runGit(["add", "README.md"], workspacePath);
    await runGit(["commit", "-m", "Initial"], workspacePath);
  });

  afterEach(async () => {
    if (testRoot.length > 0) {
      await rm(testRoot, { force: true, recursive: true });
    }
  });

  test("resolves ../, ., ./, .arashi/worktrees, and trailing slash variants", async () => {
    await writeWorkspaceConfig("../");
    await runCreate("feature-parent");
    const parentPath = resolve(workspacePath, "..", "feature-parent");
    expect(await runtime.file(join(parentPath, "README.md")).exists()).toBe(true);

    await writeWorkspaceConfig(".");
    await runCreate("feature-dot");
    const dotPath = resolve(workspacePath, "feature-dot");
    expect(await runtime.file(join(dotPath, "README.md")).exists()).toBe(true);

    await writeWorkspaceConfig("./");
    await runCreate("feature-dot-slash");
    const dotSlashPath = resolve(workspacePath, "feature-dot-slash");
    expect(await runtime.file(join(dotSlashPath, "README.md")).exists()).toBe(true);
    expect(dirname(dotPath)).toBe(dirname(dotSlashPath));

    await writeWorkspaceConfig(".arashi/worktrees");
    await runCreate("feature-managed");
    const managedPath = resolve(workspacePath, ".arashi", "worktrees", "feature-managed");
    expect(await runtime.file(join(managedPath, "README.md")).exists()).toBe(true);

    await writeWorkspaceConfig(".arashi/worktrees/");
    await runCreate("feature-managed-slash");
    const managedSlashPath = resolve(
      workspacePath,
      ".arashi",
      "worktrees",
      "feature-managed-slash",
    );
    expect(await runtime.file(join(managedSlashPath, "README.md")).exists()).toBe(true);
    expect(dirname(managedPath)).toBe(dirname(managedSlashPath));
  }, 20_000);

  test("rejects an unregistered destination before mutation when the branch already exists", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/collision";
    await runGit(["branch", branch, "main"], workspacePath);
    const destination = resolve(workspacePath, "custom-worktrees", "feature", "collision");
    await mkdir(destination, { recursive: true });
    const marker = join(workspacePath, "pre-create-ran");
    await writePreCreateMarker(marker);
    const excludePath = join(workspacePath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");

    const result = await runCreateResult(branch);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("Worktree path already exists:");
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      join("custom-worktrees", "feature", "collision"),
    );
    expect(result.stderr).not.toContain("Unexpected error");
    expect(result.stderr).not.toContain("WorktreeDestinationCollisionError");
    expect(result.stderr).not.toContain("src/commands/create.ts");
    expect(await runtime.file(marker).exists()).toBe(false);
    expect(await readFile(excludePath, "utf8")).toBe(excludeBefore);
    const branchProbe = runtime.spawn(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: workspacePath,
      stderr: "ignore",
      stdout: "ignore",
    });
    expect(await branchProbe.exited).toBe(0);
  });

  test("rejects an unregistered destination during dry-run before mutation", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/dry-run-collision";
    const destination = resolve(
      await realpath(workspacePath),
      "custom-worktrees",
      "feature",
      "dry-run-collision",
    );
    await mkdir(destination, { recursive: true });
    const marker = join(workspacePath, "pre-create-ran");
    await writePreCreateMarker(marker);

    const result = await runCreateResult(branch, ["--dry-run", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "WORKTREE_DESTINATION_COLLISION",
        details: { conflict: { repositoryName: "workspace", worktreePath: destination } },
      },
      ok: false,
    });
    expect(await runtime.file(marker).exists()).toBe(false);
    const branchProbe = runtime.spawn(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
      cwd: workspacePath,
      stderr: "ignore",
      stdout: "ignore",
    });
    expect(await branchProbe.exited).not.toBe(0);
  });

  test.skipIf(process.platform === "win32")(
    "rejects a dangling symlink destination before mutation",
    async () => {
      await writeWorkspaceConfig("custom-worktrees");
      const branch = "feature/dangling";
      const destination = resolve(workspacePath, "custom-worktrees", "feature", "dangling");
      await mkdir(dirname(destination), { recursive: true });
      await symlink(join(testRoot, "missing-target"), destination);
      const marker = join(workspacePath, "pre-create-ran");
      await writePreCreateMarker(marker);
      const excludePath = join(workspacePath, ".git", "info", "exclude");
      const excludeBefore = await readFile(excludePath, "utf8");

      const result = await runCreateResult(branch, ["--json"]);

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
      const canonicalDestination = resolve(
        await realpath(workspacePath),
        "custom-worktrees",
        "feature",
        "dangling",
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: "WORKTREE_DESTINATION_COLLISION",
          details: {
            conflict: { repositoryName: "workspace", worktreePath: canonicalDestination },
          },
        },
        ok: false,
      });
      expect(await runtime.file(marker).exists()).toBe(false);
      expect(await readFile(excludePath, "utf8")).toBe(excludeBefore);
      const branchProbe = runtime.spawn(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
        cwd: workspacePath,
        stderr: "ignore",
        stdout: "ignore",
      });
      expect(await branchProbe.exited).not.toBe(0);
    },
  );

  test("rejects a target branch registered at another live path before mutation", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/wrong-location";
    const registeredPath = resolve(testRoot, "other-registration");
    await runGit(["worktree", "add", "-b", branch, registeredPath, "main"], workspacePath);
    const marker = join(workspacePath, "pre-create-ran");
    await writePreCreateMarker(marker);
    const excludePath = join(workspacePath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    const plannedDestination = resolve(
      await realpath(workspacePath),
      "custom-worktrees",
      "feature",
      "wrong-location",
    );

    const dryRun = await runCreateResult(branch, [
      "--dry-run",
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    ]);
    expect(dryRun.exitCode, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(1);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      error: {
        code: "WORKTREE_DESTINATION_COLLISION",
        details: { conflict: { repositoryName: "workspace" } },
      },
      ok: false,
    });

    const result = await runCreateResult(branch, ["--conflict", "REUSE_EXISTING", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      error: {
        code: string;
        details: { conflict: { repositoryName: string; worktreePath: string } };
      };
      ok: boolean;
    };
    expect(envelope).toMatchObject({
      error: {
        code: "WORKTREE_DESTINATION_COLLISION",
        details: { conflict: { repositoryName: "workspace" } },
      },
      ok: false,
    });
    const reportedPath = envelope.error.details.conflict.worktreePath;
    const reportedWorkspace = dirname(dirname(dirname(reportedPath)));
    const reportedSuffix = relative(reportedWorkspace, reportedPath);
    expect(resolve(await realpath(reportedWorkspace), reportedSuffix)).toBe(plannedDestination);
    expect(await runtime.file(marker).exists()).toBe(false);
    expect(await readFile(excludePath, "utf8")).toBe(excludeBefore);
    expect(await runtime.file(join(registeredPath, "README.md")).exists()).toBe(true);
  });

  test("rejects an exact prunable registration backed by an empty directory", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/stale-exact";
    const destination = resolve(workspacePath, "custom-worktrees", "feature", "stale-exact");
    await mkdir(dirname(destination), { recursive: true });
    await runGit(["worktree", "add", "-b", branch, destination, "main"], workspacePath);
    await rm(destination, { recursive: true });
    await mkdir(destination);
    const marker = join(workspacePath, "pre-create-ran");
    await writePreCreateMarker(marker);
    const excludePath = join(workspacePath, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");

    const result = await runCreateResult(branch, ["--conflict", "REUSE_EXISTING", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "WORKTREE_DESTINATION_COLLISION",
        details: { conflict: { repositoryName: "workspace" } },
      },
      ok: false,
    });
    expect(await runtime.file(marker).exists()).toBe(false);
    expect(await readFile(excludePath, "utf8")).toBe(excludeBefore);
    expect(await runtime.file(join(destination, "README.md")).exists()).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "rejects an exact prunable registration backed by a dangling symlink",
    async () => {
      await writeWorkspaceConfig("custom-worktrees");
      const branch = "feature/stale-symlink";
      const destination = resolve(workspacePath, "custom-worktrees", "feature", "stale-symlink");
      await mkdir(dirname(destination), { recursive: true });
      await runGit(["worktree", "add", "-b", branch, destination, "main"], workspacePath);
      await rm(destination, { recursive: true });
      await symlink(join(testRoot, "missing-stale-target"), destination);
      const marker = join(workspacePath, "pre-create-ran");
      await writePreCreateMarker(marker);
      const excludePath = join(workspacePath, ".git", "info", "exclude");
      const excludeBefore = await readFile(excludePath, "utf8");

      const result = await runCreateResult(branch, ["--conflict", "REUSE_EXISTING", "--json"]);

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: {
          code: "WORKTREE_DESTINATION_COLLISION",
          details: { conflict: { repositoryName: "workspace" } },
        },
        ok: false,
      });
      expect(await runtime.file(marker).exists()).toBe(false);
      expect(await readFile(excludePath, "utf8")).toBe(excludeBefore);
    },
  );

  test("reuses an exact live Git registration for the target branch", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/existing";
    const destination = resolve(workspacePath, "custom-worktrees", "feature", "existing");
    await mkdir(dirname(destination), { recursive: true });
    await runGit(["worktree", "add", "-b", branch, destination, "main"], workspacePath);

    const result = await runCreateResult(branch, ["--conflict", "REUSE_EXISTING", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        repositories: [
          {
            repositoryName: "workspace",
            worktreePath: expect.any(String),
          },
        ],
      },
      ok: true,
    });
    expect(await runtime.file(join(destination, "README.md")).exists()).toBe(true);
    expect(await realpath(destination)).toBe(
      await realpath(JSON.parse(result.stdout).data.repositories[0].worktreePath as string),
    );
  });

  test("reports an exact live registration as reusable during dry-run", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/dry-run-existing";
    const destination = resolve(workspacePath, "custom-worktrees", "feature", "dry-run-existing");
    await mkdir(dirname(destination), { recursive: true });
    await runGit(["worktree", "add", "-b", branch, destination, "main"], workspacePath);

    const result = await runCreateResult(branch, [
      "--dry-run",
      "--conflict",
      "REUSE_EXISTING",
      "--json",
    ]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        dryRunOutcome: {
          conflicts: [
            {
              blocking: false,
              conflictType: "branch_exists",
              repositoryName: "workspace",
            },
          ],
          plannedWorktrees: [
            {
              planStatus: "actionable",
              repositoryName: "workspace",
              worktreePath: expect.any(String),
            },
          ],
          summaryCounts: { blockingTotal: 0 },
        },
      },
      ok: true,
    });
  });

  test.skipIf(process.platform === "win32")(
    "reuses an exact live registration whose path contains a newline",
    async () => {
      await writeWorkspaceConfig("custom\nworktrees");
      const branch = "feature/newline-path";
      const destination = resolve(workspacePath, "custom\nworktrees", "feature", "newline-path");
      await mkdir(dirname(destination), { recursive: true });
      await runGit(["worktree", "add", "-b", branch, destination, "main"], workspacePath);

      const result = await runCreateResult(branch, ["--conflict", "REUSE_EXISTING", "--json"]);

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(await realpath(JSON.parse(result.stdout).data.repositories[0].worktreePath)).toBe(
        await realpath(destination),
      );
    },
  );

  test("reports the authoritative colliding destination in one JSON failure envelope", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/json-collision";
    const destination = resolve(
      await realpath(workspacePath),
      "custom-worktrees",
      "feature",
      "json-collision",
    );
    await mkdir(destination, { recursive: true });

    const result = await runCreateResult(branch, ["--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      error: { details: { conflict: { worktreePath: string } } };
    };
    expect(envelope).toMatchObject({
      command: "create",
      error: {
        code: "WORKTREE_DESTINATION_COLLISION",
        details: {
          conflict: {
            repositoryName: "workspace",
            worktreePath: expect.any(String),
          },
        },
      },
      ok: false,
    });
    expect(await realpath(envelope.error.details.conflict.worktreePath)).toBe(
      await realpath(destination),
    );
  });

  test("reports the authoritative parent destination in dry-run JSON", async () => {
    await writeWorkspaceConfig("custom-worktrees");
    const branch = "feature/json-preview";
    const destination = resolve(
      await realpath(workspacePath),
      "custom-worktrees",
      "feature",
      "json-preview",
    );

    const result = await runCreateResult(branch, ["--dry-run", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      data: { dryRunOutcome: { plannedWorktrees: { worktreePath: string }[] } };
    };
    expect(envelope).toMatchObject({
      data: {
        dryRunOutcome: {
          plannedWorktrees: [
            {
              branchName: branch,
              repositoryName: "workspace",
              worktreePath: expect.any(String),
            },
          ],
        },
      },
      ok: true,
    });
    const reportedPath = envelope.data.dryRunOutcome.plannedWorktrees[0]!.worktreePath;
    const reportedWorkspace = dirname(dirname(dirname(reportedPath)));
    const reportedSuffix = relative(reportedWorkspace, reportedPath);
    expect(resolve(await realpath(reportedWorkspace), reportedSuffix)).toBe(destination);
    expect(await runtime.file(destination).exists()).toBe(false);
  });
});
