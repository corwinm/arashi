import { runtime } from "../../helpers/node-runtime.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "fs/promises";
import {
  detectDefaultBranch,
  detectSetupScript,
  discoverRepositories,
} from "../../../src/core/repository.js";
import { join } from "path";
import { tmpdir } from "os";

describe("detectSetupScript", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-setup-detect-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  test("detects setup.sh when present in repository root", async () => {
    const repoPath = join(testDir, "setup-repo");
    await mkdir(repoPath, { recursive: true });
    const setupPath = join(repoPath, "setup.sh");
    await runtime.write(setupPath, "#!/bin/bash\necho 'Setup script'");

    const result = await detectSetupScript(repoPath);

    expect(result.hasSetupScript).toBe(true);
    expect(result.setupScriptPath).toBe(setupPath);
  });

  test("returns false when no setup script exists", async () => {
    const repoPath = join(testDir, "no-setup-repo");
    await mkdir(repoPath, { recursive: true });

    const result = await detectSetupScript(repoPath);

    expect(result.hasSetupScript).toBe(false);
    expect(result.setupScriptPath).toBeUndefined();
  });

  test("detects multiple script patterns", async () => {
    const repo1Path = join(testDir, "bash-setup-repo");
    await mkdir(repo1Path, { recursive: true });
    const bashSetupPath = join(repo1Path, "setup.bash");
    await runtime.write(bashSetupPath, "#!/bin/bash\necho 'Bash setup'");

    const result1 = await detectSetupScript(repo1Path);
    expect(result1.hasSetupScript).toBe(true);
    expect(result1.setupScriptPath).toBe(bashSetupPath);

    const repo2Path = join(testDir, "arashi-setup-repo");
    await mkdir(join(repo2Path, ".arashi"), { recursive: true });
    const arashiSetupPath = join(repo2Path, ".arashi", "setup.sh");
    await runtime.write(arashiSetupPath, "#!/bin/bash\necho 'Arashi setup'");

    const result2 = await detectSetupScript(repo2Path);
    expect(result2.hasSetupScript).toBe(true);
    expect(result2.setupScriptPath).toBe(arashiSetupPath);
  });

  test("supports custom patterns from options", async () => {
    const repoPath = join(testDir, "custom-setup-repo");
    await mkdir(repoPath, { recursive: true });
    const customPath = join(repoPath, "install.sh");
    await runtime.write(customPath, "#!/bin/bash\necho 'Custom install'");

    const result = await detectSetupScript(repoPath, ["install.sh", "bootstrap.sh"]);

    expect(result.hasSetupScript).toBe(true);
    expect(result.setupScriptPath).toBe(customPath);
  });
});

describe("repository discovery regressions", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "arashi-repository-"));
  });

  afterEach(async () => {
    await rm(testDir, { force: true, recursive: true });
  });

  const git = async (cwd: string, ...args: string[]) => {
    const child = runtime.spawn(["git", ...args], { cwd });
    expect(await child.exited).toBe(0);
  };

  test("detects an origin default branch from a linked worktree", async () => {
    const mainRepo = join(testDir, "main-repo");
    const linkedWorktree = join(testDir, "linked-worktree");
    await mkdir(mainRepo);
    await git(mainRepo, "init", "-b", "release");
    await git(mainRepo, "config", "user.email", "test@example.com");
    await git(mainRepo, "config", "user.name", "Test User");
    await runtime.write(join(mainRepo, "README.md"), "test\n");
    await git(mainRepo, "add", "README.md");
    await git(mainRepo, "commit", "-m", "initial");
    await git(mainRepo, "branch", "feature");
    await git(mainRepo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
    await git(mainRepo, "worktree", "add", linkedWorktree, "feature");

    expect(await detectDefaultBranch(linkedWorktree)).toBe("release");
  });

  test("returns repositories in deterministic path order after parallel discovery", async () => {
    for (const name of ["zeta", "alpha", "middle"]) {
      await mkdir(join(testDir, name, ".git"), { recursive: true });
    }
    for (const name of ["zeta-broken", "alpha-broken"]) {
      await symlink(join(testDir, "missing"), join(testDir, name));
    }

    const result = await discoverRepositories(testDir, { followSymlinks: true, maxDepth: 1 });

    expect(result.repositories.map(({ name }) => name)).toEqual(["alpha", "middle", "zeta"]);
    expect(result.errors.map(({ path }) => path)).toEqual([
      join(testDir, "alpha-broken"),
      join(testDir, "zeta-broken"),
    ]);
  });
});
