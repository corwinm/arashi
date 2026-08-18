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

  test("uses Git to discover an effective tracked ignore rule from a CRLF checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-crlf-"));
    testRoots.push(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test User"]);
    await git(root, ["config", "core.autocrlf", "true"]);
    await writeFile(join(root, ".gitignore"), "repos/\n");
    await git(root, ["add", ".gitignore"]);
    await git(root, ["commit", "-m", "Track ignore rules"]);
    await rm(join(root, ".gitignore"));
    await git(root, ["checkout", "--", ".gitignore"]);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("repos/\r\n");

    const inspection = await inspectManagedIgnore({
      reposDir: "repos",
      workspaceRoot: root,
      worktreesDir: ".arashi/worktrees",
    });

    expect(inspection.paths[0]).toMatchObject({
      source: { path: ".gitignore", pattern: "repos/", type: "tracked" },
      status: "already-ignored",
    });
  });

  test("recovers malformed successful primary output through one direct Git query", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-recovery-"));
    testRoots.push(root);
    await git(root, ["init"]);
    const requests: { args: string[]; stdin?: string }[] = [];

    const inspection = await inspectManagedIgnore(
      { reposDir: "repos", workspaceRoot: root, worktreesDir: "." },
      async ({ args, stdin }) => {
        requests.push({ args, stdin });
        return requests.length === 1
          ? { exitCode: 0, stderr: "", stdout: "malformed-primary" }
          : { exitCode: 0, stderr: "", stdout: ".gitignore:7:repos/\trepos/\n" };
      },
    );

    expect(inspection.paths[0]).toMatchObject({
      source: { path: ".gitignore", pattern: "repos/", type: "tracked" },
      status: "already-ignored",
    });
    expect(requests).toEqual([
      {
        args: ["check-ignore", "-z", "-v", "--no-index", "--stdin"],
        stdin: "repos/\0",
      },
      {
        args: ["check-ignore", "-v", "--no-index", "--", "repos/"],
        stdin: undefined,
      },
    ]);
  });

  test.each([
    [
      "quoted Unicode requested path",
      String.raw`.gitignore:7:répos/` + "\t" + String.raw`"r\303\251pos/"` + "\n",
      "répos",
      { path: ".gitignore", pattern: "répos/", type: "tracked" },
    ],
    [
      "quoted requested path containing a quote",
      String.raw`.gitignore:8:quote"dir/` + "\t" + String.raw`"quote\"dir/"` + "\n",
      'quote"dir',
      { path: ".gitignore", pattern: 'quote"dir/', type: "tracked" },
    ],
    [
      "quoted local exclude source",
      String.raw`".git/info/excl\165de":9:repos/` + "\trepos/\n",
      "repos",
      { path: ".git/info/exclude", pattern: "repos/", type: "local" },
    ],
  ])("decodes Git C-style quoting for %s", async (_case, fallbackStdout, reposDir, source) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-quoted-recovery-"));
    testRoots.push(root);
    await git(root, ["init"]);
    let calls = 0;

    const inspection = await inspectManagedIgnore(
      { reposDir, workspaceRoot: root, worktreesDir: "." },
      async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stderr: "", stdout: "malformed-primary" }
          : { exitCode: 0, stderr: "", stdout: fallbackStdout };
      },
    );

    expect(inspection.paths[0]).toMatchObject({ source, status: "already-ignored" });
    expect(calls).toBe(2);
  });

  test.each([
    ["short octal escape", String.raw`.gitignore:7:?/` + "\t" + String.raw`"\77/"` + "\n", "?"],
    [
      "out-of-range octal escape",
      String.raw`.gitignore:7:?/` + "\t" + String.raw`"\477/"` + "\n",
      "?",
    ],
    [
      "unescaped interior quote",
      String.raw`.gitignore:7:a"b/` + "\t" + String.raw`"a"b/"` + "\n",
      'a"b',
    ],
  ])("fails closed for fallback output with %s", async (_case, fallbackStdout, reposDir) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-invalid-quote-"));
    testRoots.push(root);
    await git(root, ["init"]);
    let calls = 0;

    const inspection = inspectManagedIgnore(
      { reposDir, workspaceRoot: root, worktreesDir: "." },
      async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stderr: "", stdout: "malformed-primary" }
          : { exitCode: 0, stderr: "", stdout: fallbackStdout };
      },
    );

    await expect(inspection).rejects.toThrowError(/invalid Git path quoting/);
    expect(calls).toBe(2);
  });

  test.each([
    ["malformed", ".gitignore:not-a-line:repos/\trepos/\n", "malformed"],
    ["path-mismatched", ".gitignore:7:repos/\tother/\n", "path mismatch"],
    ["delimiter-ambiguous", "first:1:middle:2:last\trepos/\n", "ambiguous"],
  ])("fails closed when fallback output is %s", async (_case, fallbackStdout, outcome) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-recovery-"));
    testRoots.push(root);
    await git(root, ["init"]);
    let calls = 0;

    const inspection = inspectManagedIgnore(
      { reposDir: "repos", workspaceRoot: root, worktreesDir: "." },
      async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stderr: "", stdout: "secret-binary\0payload" }
          : { exitCode: 0, stderr: "", stdout: fallbackStdout };
      },
    );

    await expect(inspection).rejects.toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("primary payload was malformed"),
      }),
    );
    await expect(inspection).rejects.toThrowError(
      expect.objectContaining({ message: expect.stringContaining(outcome) }),
    );
    await expect(inspection).rejects.not.toThrowError(/secret-binary/);
    expect(calls).toBe(2);
  });

  test.each([
    ["no match", { exitCode: 1, stderr: "", stdout: "" }, "reported no match"],
    ["fatal exit", { exitCode: 128, stderr: "secret stderr", stdout: "" }, "exit code 128"],
    [
      "spawn failure",
      { exitCode: -1, spawnError: new Error("secret spawn error"), stderr: "", stdout: "" },
      "failed to spawn",
    ],
  ])("reports the fallback %s outcome without raw output", async (_case, fallback, outcome) => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-recovery-outcome-"));
    testRoots.push(root);
    await git(root, ["init"]);
    let calls = 0;

    const inspection = inspectManagedIgnore(
      { reposDir: "repos", workspaceRoot: root, worktreesDir: "." },
      async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stderr: "", stdout: "secret-primary-output" }
          : fallback;
      },
    );

    await expect(inspection).rejects.toThrowError(
      expect.objectContaining({ message: expect.stringContaining(outcome) }),
    );
    await expect(inspection).rejects.not.toThrowError(
      /secret-primary-output|secret stderr|secret spawn/,
    );
    expect(calls).toBe(2);
  });

  test("does not recover when the primary query reports no match", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-no-match-"));
    testRoots.push(root);
    await git(root, ["init"]);
    let calls = 0;

    const inspection = await inspectManagedIgnore(
      { reposDir: "repos", workspaceRoot: root, worktreesDir: "." },
      async () => {
        calls += 1;
        return { exitCode: 1, stderr: "", stdout: "" };
      },
    );

    expect(inspection.paths[0]).toMatchObject({ status: "unignored" });
    expect(inspection.paths[0]?.source).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("does not recover when the primary query fails to spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-primary-spawn-"));
    testRoots.push(root);
    await git(root, ["init"]);
    let calls = 0;

    const inspection = inspectManagedIgnore(
      { reposDir: "repos", workspaceRoot: root, worktreesDir: "." },
      async () => {
        calls += 1;
        return {
          exitCode: -1,
          spawnError: new Error("primary spawn failed"),
          stderr: "",
          stdout: "",
        };
      },
    );

    await expect(inspection).rejects.toThrowError(/primary spawn failed/);
    expect(calls).toBe(1);
  });

  test("does not recover when the primary query fails fatally", async () => {
    const root = await mkdtemp(join(tmpdir(), "arashi-managed-ignore-fatal-"));
    testRoots.push(root);
    await git(root, ["init"]);
    let calls = 0;

    const inspection = inspectManagedIgnore(
      { reposDir: "repos", workspaceRoot: root, worktreesDir: "." },
      async () => {
        calls += 1;
        return { exitCode: 128, stderr: "fatal: inspection failed", stdout: "" };
      },
    );

    await expect(inspection).rejects.toThrowError(/fatal: inspection failed/);
    expect(calls).toBe(1);
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
