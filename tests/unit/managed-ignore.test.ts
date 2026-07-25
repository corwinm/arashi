import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "../helpers/node-runtime.ts";
import {
  classifyManagedPaths,
  inspectManagedIgnore,
  inspectRepositoryManagedIgnore,
  reconcileManagedIgnore,
  reconcileRepositoryManagedIgnore,
  restoreManagedIgnore,
} from "../../src/lib/managed-ignore.ts";

const testRoots: string[] = [];

const git = async (cwd: string, args: string[]): Promise<string> => {
  const process = spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
  return stdout.trim();
};

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("managed ignore path classification", () => {
  test("normalizes and deduplicates safe repository-relative directories", () => {
    expect(classifyManagedPaths(["./repos", "repos/", "repos\\", ".arashi\\worktrees\\"])).toEqual([
      { input: "./repos", rule: "/repos/", safety: "safe" },
      { input: ".arashi\\worktrees\\", rule: "/.arashi/worktrees/", safety: "safe" },
    ]);
  });

  test("escapes Git pattern metacharacters in configured directory names", () => {
    expect(classifyManagedPaths(["!cache", "#generated", "[ab]", "star*", "maybe?"])).toEqual([
      { input: "!cache", rule: "/\\!cache/", safety: "safe" },
      { input: "#generated", rule: "/\\#generated/", safety: "safe" },
      { input: "[ab]", rule: "/\\[ab\\]/", safety: "safe" },
      { input: "star*", rule: "/star\\*/", safety: "safe" },
      { input: "maybe?", rule: "/maybe\\?/", safety: "safe" },
    ]);
  });

  test("reports unsafe root, absolute, and parent-traversal paths", () => {
    expect(
      classifyManagedPaths([".", "./", "../repos", "/tmp/repos", String.raw`C:\repos`]),
    ).toEqual([
      { input: ".", reason: "repository-root", safety: "unsafe" },
      { input: "./", reason: "repository-root", safety: "unsafe" },
      { input: "../repos", reason: "parent-traversal", safety: "unsafe" },
      { input: "/tmp/repos", reason: "absolute", safety: "unsafe" },
      { input: String.raw`C:\repos`, reason: "absolute", safety: "unsafe" },
    ]);
  });

  test("rejects control characters that could inject managed ignore rules", () => {
    expect(classifyManagedPaths(["safe\n*", "safe\0path"])).toEqual([
      { input: "safe\n*", reason: "control-character", safety: "unsafe" },
      { input: "safe\0path", reason: "control-character", safety: "unsafe" },
    ]);
  });

  test("uses Git to discover an effective tracked ignore rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    await writeFile(join(root, ".gitignore"), "repos/\n");

    const inspection = await inspectManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(inspection.paths[0]).toMatchObject({
      rule: "/repos/",
      source: { pattern: "repos/", type: "tracked" },
      status: "already-ignored",
    });
  });

  test("parses delimiter-safe effective source data", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const globalPath = join(root, "global:ignore");
    await writeFile(globalPath, "managed:repos/\n");
    await git(root, ["config", "--local", "core.excludesFile", globalPath]);

    const inspection = await inspectManagedIgnore({
      reposDir: "managed:repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(inspection.paths[0]).toMatchObject({
      source: { path: globalPath, pattern: "managed:repos/", type: "global" },
      status: "already-ignored",
    });
  });

  test("does not create an empty tracked ignore file when effective rules already exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const globalPath = join(root, "global-ignore");
    await writeFile(globalPath, "repos/\n.arashi/worktrees/\n");
    await git(root, ["config", "--local", "core.excludesFile", globalPath]);

    const result = await reconcileManagedIgnore({
      reposDir: "repos",
      requestedScope: "tracked",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(result.fileChanges.tracked).toBe(false);
    await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("propagates fatal Git ignore inspection failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const invalidExcludePath = process.platform === "win32" ? join(root, "invalid:exclude") : root;
    if (process.platform === "win32") {
      await writeFile(invalidExcludePath, "repos/\n");
    }
    await git(root, ["config", "--local", "core.excludesFile", invalidExcludePath]);

    await expect(
      reconcileManagedIgnore({
        reposDir: "repos",
        workspaceRoot: root,
        worktreesDir: ".arashi/worktrees",
      }),
    ).rejects.toMatchObject({
      code: "MANAGED_IGNORE_RECONCILIATION_FAILED",
      details: { attempted: false, changed: false, phase: "inspection", restored: false },
    });
  });

  test.each([
    ["inspection", inspectRepositoryManagedIgnore],
    ["reconciliation", reconcileRepositoryManagedIgnore],
  ])("wraps repository classification failures during %s", async (_operation, run) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-invalid-repository-"));
    testRoots.push(root);

    await expect(
      run({
        reposDir: "repos",
        workspaceRoot: root,
        worktreesDir: ".arashi/worktrees",
      }),
    ).rejects.toMatchObject({
      code: "MANAGED_IGNORE_RECONCILIATION_FAILED",
      details: { attempted: false, changed: false, phase: "inspection", restored: false },
    });
  });

  test("resolves explicit scope before clone-local preference and defaults to local", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    await git(root, ["config", "--local", "arashi.ignoreScope", "tracked"]);

    const stored = await inspectManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });
    const explicit = await inspectManagedIgnore({
      reposDir: "repos",
      requestedScope: "none",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(stored).toMatchObject({ scope: "tracked", storedPreference: "tracked" });
    expect(explicit).toMatchObject({ scope: "none", storedPreference: "tracked" });
  });

  test("preserves team-owned tracked rules when no clone-local scope was selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const tracked =
      "# BEGIN Arashi managed ignore rules\n/repos/\n/.arashi/worktrees/\n# END Arashi managed ignore rules\n";
    await writeFile(join(root, ".gitignore"), tracked);

    const result = await reconcileManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(result.changed).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(tracked);
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).not.toContain(
      "BEGIN Arashi",
    );
  });

  test("migrates Arashi-owned rules when switching from local to tracked scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);

    await reconcileManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });
    const result = await reconcileManagedIgnore({
      reposDir: "repos",
      requestedScope: "tracked",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain("/repos/");
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).not.toContain(
      "BEGIN Arashi",
    );
    expect(result.fileChanges).toMatchObject({ local: true, preference: true, tracked: true });
  });

  test("propagates failures while clearing the clone-local scope preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    await git(root, ["config", "--local", "arashi.ignoreScope", "tracked"]);
    await writeFile(join(root, ".git", "config.lock"), "locked");

    await expect(
      reconcileManagedIgnore({
        reposDir: "repos",
        requestedScope: "local",
        workspaceRoot: root,
        worktreesDir: ".arashi/worktrees",
      }),
    ).rejects.toMatchObject({ code: "MANAGED_IGNORE_RECONCILIATION_FAILED" });
  });

  test("rejects a local exclude target that is a symbolic link", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const outside = join(root, "outside-local-exclude");
    await writeFile(outside, "outside\n");
    await rm(join(root, ".git", "info", "exclude"));
    await symlink(outside, join(root, ".git", "info", "exclude"));

    await expect(
      reconcileManagedIgnore({
        reposDir: "repos",
        requestedScope: "local",
        workspaceRoot: root,
        worktreesDir: ".arashi/worktrees",
      }),
    ).rejects.toMatchObject({ code: "MANAGED_IGNORE_RECONCILIATION_FAILED" });
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  test("allows local reconciliation when only the tracked ignore target is a symbolic link", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const outside = join(root, "outside-tracked-ignore");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, ".gitignore"));

    const result = await reconcileManagedIgnore({
      reposDir: "repos",
      requestedScope: "local",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(result.targetType).toBe("local");
    expect(result.fileChanges.local).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  test("rejects a tracked ignore target that is a symbolic link", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const outside = join(root, "outside-ignore");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, ".gitignore"));

    await expect(
      reconcileManagedIgnore({
        reposDir: "repos",
        requestedScope: "tracked",
        workspaceRoot: root,
        worktreesDir: ".arashi/worktrees",
      }),
    ).rejects.toMatchObject({ code: "MANAGED_IGNORE_RECONCILIATION_FAILED" });
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  test("restores preference state when applying the target file fails", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    await git(root, ["config", "--local", "arashi.ignoreScope", "none"]);
    await chmod(root, 0o555);

    try {
      await expect(
        reconcileManagedIgnore({
          reposDir: "repos",
          requestedScope: "tracked",
          workspaceRoot: root,
          worktreesDir: ".arashi/worktrees",
        }),
      ).rejects.toMatchObject({
        code: "MANAGED_IGNORE_RECONCILIATION_FAILED",
        details: { attempted: true, changed: false, phase: "apply", restored: true },
      });
    } finally {
      await chmod(root, 0o755);
    }

    expect(await git(root, ["config", "--local", "--get", "arashi.ignoreScope"])).toBe("none");
    await expect(readFile(join(root, ".gitignore"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("applies a local owned block and restores the exact prior state", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const excludePath = join(root, ".git", "info", "exclude");
    const original = await readFile(excludePath, "utf8");

    const result = await reconcileManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(await readFile(excludePath, "utf8")).toContain(
      "# BEGIN Arashi managed ignore rules\n/repos/\n/.arashi/worktrees/\n# END Arashi managed ignore rules",
    );
    expect(result).toMatchObject({ attempted: true, changed: true, restored: false });

    await restoreManagedIgnore(result);
    expect(await readFile(excludePath, "utf8")).toBe(original);
    expect(result).toMatchObject({ attempted: true, changed: false, restored: true });
  });

  test("discovers local and global sources and resolves linked-worktree common excludes", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test User"]);
    await writeFile(join(root, "README.md"), "root\n");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "initial"]);
    const excludePath = join(root, ".git", "info", "exclude");
    await writeFile(excludePath, "repos/\n");
    const globalPath = join(root, "test-global-ignore");
    await writeFile(globalPath, ".arashi/worktrees/\n");
    await git(root, ["config", "--local", "core.excludesFile", globalPath]);
    const linked = join(root, "linked");
    await git(root, ["worktree", "add", linked, "-b", "linked"]);

    const inspection = await inspectManagedIgnore({
      reposDir: "repos",
      workspaceRoot: linked,
      worktreesDir: ".arashi/worktrees",
    });

    expect(normalize(inspection.localExcludePath)).toBe(normalize(await realpath(excludePath)));
    expect(inspection.paths.map((path) => path.source?.type)).toEqual(["local", "global"]);
  });

  test("removes only stale owned entries and remains idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const excludePath = join(root, ".git", "info", "exclude");
    await writeFile(
      excludePath,
      "user-rule/\n# BEGIN Arashi managed ignore rules\n/old-repos/\n/repos/\n# END Arashi managed ignore rules\n",
    );

    await reconcileManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });
    const firstContent = await readFile(excludePath, "utf8");
    const second = await reconcileManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(firstContent).toContain("user-rule/");
    expect(firstContent).not.toContain("old-repos/");
    expect(firstContent.match(/BEGIN Arashi/g)).toHaveLength(1);
    expect(second.changed).toBe(false);
  });

  test("none scope persists preference, warns, and freezes stale owned content", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const excludePath = join(root, ".git", "info", "exclude");
    const content =
      "# BEGIN Arashi managed ignore rules\nold-repos/\n# END Arashi managed ignore rules\n";
    await writeFile(excludePath, content);

    const result = await reconcileManagedIgnore({
      reposDir: "repos",
      requestedScope: "none",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(result.staleRules).toEqual([{ path: excludePath, rule: "old-repos/", target: "local" }]);
    expect(result.warnings).toHaveLength(3);
    expect(await readFile(excludePath, "utf8")).toBe(content);
    expect(await git(root, ["config", "--local", "--get", "arashi.ignoreScope"])).toBe("none");
  });
});
