import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";

const CLI_ENTRY = join(import.meta.dir, "../../src/index.ts");

let workspacePath = "";

async function runGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
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
  await Bun.write(
    join(workspacePath, ".arashi", "config.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        reposDir: "./repos",
        worktreesDir,
        repos: {},
      },
      null,
      2,
    ),
  );
}

async function runCreate(branch: string): Promise<void> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, "create", branch, "--no-hooks", "--no-progress"], {
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`create failed (exit=${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

describe("create command worktree location resolution", () => {
  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "arashi-worktree-location-"));

    await runGit(["init", "-b", "main"], workspacePath);
    await runGit(["config", "user.name", "Test User"], workspacePath);
    await runGit(["config", "user.email", "test@example.com"], workspacePath);

    await writeFile(join(workspacePath, "README.md"), "# workspace\n");
    await runGit(["add", "README.md"], workspacePath);
    await runGit(["commit", "-m", "Initial"], workspacePath);
  });

  afterEach(async () => {
    if (workspacePath.length > 0) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  test("resolves ../, ., ./, .arashi/worktrees, and trailing slash variants", async () => {
    const repoName = basename(workspacePath);

    await writeWorkspaceConfig("../");
    await runCreate("feature-parent");
    const parentPath = resolve(workspacePath, "..", `${repoName}-feature-parent`);
    expect(await Bun.file(join(parentPath, "README.md")).exists()).toBe(true);

    await writeWorkspaceConfig(".");
    await runCreate("feature-dot");
    const dotPath = resolve(workspacePath, `${repoName}-feature-dot`);
    expect(await Bun.file(join(dotPath, "README.md")).exists()).toBe(true);

    await writeWorkspaceConfig("./");
    await runCreate("feature-dot-slash");
    const dotSlashPath = resolve(workspacePath, `${repoName}-feature-dot-slash`);
    expect(await Bun.file(join(dotSlashPath, "README.md")).exists()).toBe(true);
    expect(dirname(dotPath)).toBe(dirname(dotSlashPath));

    await writeWorkspaceConfig(".arashi/worktrees");
    await runCreate("feature-managed");
    const managedPath = resolve(
      workspacePath,
      ".arashi",
      "worktrees",
      `${repoName}-feature-managed`,
    );
    expect(await Bun.file(join(managedPath, "README.md")).exists()).toBe(true);

    await writeWorkspaceConfig(".arashi/worktrees/");
    await runCreate("feature-managed-slash");
    const managedSlashPath = resolve(
      workspacePath,
      ".arashi",
      "worktrees",
      `${repoName}-feature-managed-slash`,
    );
    expect(await Bun.file(join(managedSlashPath, "README.md")).exists()).toBe(true);
    expect(dirname(managedPath)).toBe(dirname(managedSlashPath));
  });
});
