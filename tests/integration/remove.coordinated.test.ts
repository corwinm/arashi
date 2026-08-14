import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  createNestedWorktrees,
  createRemoveWorkspace,
  createWorktree,
  markWorktreeDirty,
} from "../helpers/remove-test-workspace.ts";
import { executeRemove } from "../../src/commands/remove.ts";
import { formatRemovalSummaryHuman } from "../../src/core/remove.ts";
import { spawn } from "../helpers/node-runtime.ts";

const CLI_ENTRY = join(import.meta.dirname, "..", "..", "src", "index.ts");

describe("remove command - coordinated child-first removal", () => {
  let workspace: Awaited<ReturnType<typeof createRemoveWorkspace>>;

  beforeEach(async () => {
    workspace = await createRemoveWorkspace(["repo-a", "repo-b"]);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test.each(["branch", "path"] as const)(
    "expands a configured parent selected by %s and previews descendants child-first",
    async (selectionMode) => {
      const parentBranch = `parent-${selectionMode}`;
      const childBranches = { "repo-a": `child-a-${selectionMode}`, "repo-b": parentBranch };
      const { childPaths, parentPath } = await createNestedWorktrees(
        workspace,
        parentBranch,
        childBranches,
      );
      await git(workspace.repos[1].path, ["branch", childBranches["repo-a"]]);
      const expectedPaths = (
        await Promise.all(
          [childPaths["repo-a"], childPaths["repo-b"], parentPath].map((path) => realpath(path)),
        )
      ).map(normalizePathForComparison);
      const target = selectionMode === "path" ? await realpath(parentPath) : parentBranch;

      const result = await runRemove(target, {
        dryRun: true,
        json: true,
        path: selectionMode === "path",
      });

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout);
      const removals = envelope.data.operations.filter(
        (operation: { type: string }) => operation.type === "worktree_remove",
      );
      expect(
        removals.map((operation: { worktreePath: string }) =>
          normalizePathForComparison(operation.worktreePath),
        ),
      ).toEqual(expectedPaths);
      expect(envelope.data.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            branchName: childBranches["repo-a"],
            repository: "repo-a",
            type: "branch_delete",
          }),
        ]),
      );
      expect(envelope.data.operations).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            branchName: childBranches["repo-a"],
            repository: "repo-b",
            type: "branch_delete",
          }),
        ]),
      );
      expect(existsSync(parentPath)).toBe(true);
      expect(existsSync(childPaths["repo-a"])).toBe(true);

      const human = await runRemove(target, {
        dryRun: true,
        path: selectionMode === "path",
      });
      const humanLines = human.stdout.split("\n");
      const removalHeader = humanLines.indexOf("Planned worktree removals:");
      const branchHeader = humanLines.indexOf("Planned branch deletions:");
      const humanPaths = humanLines
        .slice(removalHeader + 1, branchHeader)
        .map((line) =>
          expectedPaths.find((path) => normalizePathForComparison(line).endsWith(path)),
        )
        .filter((path): path is string => path !== undefined);
      expect(humanPaths).toEqual(expectedPaths);
    },
  );

  test("real removal clears nested paths, registrations, and prunable metadata", async () => {
    const parentBranch = "parent-real";
    const { childPaths, parentPath } = await createNestedWorktrees(workspace, parentBranch, {
      "repo-a": "mixed-child-real",
      "repo-b": parentBranch,
    });
    const canonicalPaths = await Promise.all(
      [parentPath, ...Object.values(childPaths)].map((path) => realpath(path)),
    );

    const result = await runRemove(parentBranch, { force: true, json: true });

    expect(result.exitCode, result.stdout).toBe(0);
    for (const path of [parentPath, ...Object.values(childPaths)]) {
      expect(existsSync(path)).toBe(false);
    }
    const registrations = await Promise.all(
      [workspace.rootPath, ...workspace.repos.map((repo) => repo.path)].map(worktreeList),
    );
    for (const path of canonicalPaths) {
      expect(registrations.join("\n")).not.toContain(path);
    }
    for (const repoPath of [workspace.rootPath, ...workspace.repos.map((repo) => repo.path)]) {
      expect(await prunePreview(repoPath)).toBe("");
    }
  });

  test("includes transitive descendants while preserving unrelated discovery order", async () => {
    const { childPaths, parentPath } = await createNestedWorktrees(workspace, "parent-transitive", {
      "repo-a": "child-transitive",
    });
    const grandchildPath = join(childPaths["repo-a"], "repos", "repo-b");
    await mkdir(join(childPaths["repo-a"], "repos"), { recursive: true });
    await createWorktree(workspace.repos[1].path, "grandchild-transitive", grandchildPath);
    const unrelatedPath = join(workspace.rootPath, "worktrees", "unrelated-transitive");
    await createWorktree(workspace.repos[1].path, "unrelated-transitive", unrelatedPath);
    const expectedPaths = (
      await Promise.all(
        [grandchildPath, childPaths["repo-a"], childPaths["repo-b"], parentPath].map((path) =>
          realpath(path),
        ),
      )
    ).map(normalizePathForComparison);

    const result = await runRemove(await realpath(parentPath), {
      dryRun: true,
      json: true,
      path: true,
    });
    const removals = JSON.parse(result.stdout).data.operations.filter(
      (operation: { type: string }) => operation.type === "worktree_remove",
    );
    const paths = removals.map((operation: { worktreePath: string }) =>
      normalizePathForComparison(operation.worktreePath),
    );

    expect(paths).toEqual(expectedPaths);
    expect(paths).not.toContain(normalizePathForComparison(await realpath(unrelatedPath)));
  });

  test("does not expand descendants with --keep-worktrees", async () => {
    const { parentPath } = await createNestedWorktrees(workspace, "parent-keep", {
      "repo-a": "child-keep",
      "repo-b": "child-keep-other",
    });

    const result = await runRemove(await realpath(parentPath), {
      dryRun: true,
      json: true,
      keepWorktrees: true,
      path: true,
    });
    const envelope = JSON.parse(result.stdout);

    expect(envelope.data.operations).toEqual([
      expect.objectContaining({ branchName: "parent-keep", type: "branch_delete" }),
    ]);
  });

  test("skips intentionally missing configured repositories during strict inventory discovery", async () => {
    const { childPaths, parentPath } = await createNestedWorktrees(
      workspace,
      "parent-missing-repo",
      {
        "repo-a": "child-missing-repo",
      },
    );
    await git(workspace.repos[1].path, ["worktree", "remove", childPaths["repo-b"], "--force"]);
    expect(existsSync(childPaths["repo-b"])).toBe(false);
    const missingRepoPath = workspace.repos[1].path;
    const preservedRepoPath = `${missingRepoPath}-preserved`;
    await rename(missingRepoPath, preservedRepoPath);

    try {
      const result = await runRemove(await realpath(parentPath), {
        force: true,
        keepBranches: true,
        path: true,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await rename(preservedRepoPath, missingRepoPath);
    }

    expect(existsSync(parentPath)).toBe(false);
    expect(existsSync(childPaths["repo-a"])).toBe(false);
  });

  test("fails closed when a missing configured repository owns a nested descendant", async () => {
    const { childPaths, parentPath } = await createNestedWorktrees(
      workspace,
      "parent-missing-owner",
      {
        "repo-a": "child-missing-owner",
      },
    );
    const missingRepoPath = workspace.repos[1].path;
    const preservedRepoPath = `${missingRepoPath}-preserved`;
    await rename(missingRepoPath, preservedRepoPath);

    try {
      await expect(
        runRemove(await realpath(parentPath), { force: true, path: true }),
      ).rejects.toThrow(/repo-b.*configured descendant/i);
    } finally {
      await rename(preservedRepoPath, missingRepoPath);
    }

    expect(existsSync(parentPath)).toBe(true);
    expect(existsSync(childPaths["repo-a"])).toBe(true);
    expect(existsSync(childPaths["repo-b"])).toBe(true);
    expect(normalizePathForComparison(await worktreeList(workspace.repos[1].path))).toContain(
      normalizePathForComparison(await realpath(childPaths["repo-b"])),
    );
  });

  test("fails closed for a missing repository nested beneath an auto-included descendant", async () => {
    const { childPaths, parentPath } = await createNestedWorktrees(
      workspace,
      "parent-transitive-missing-owner",
      {
        "repo-a": "child-transitive-missing-owner",
      },
    );
    await git(workspace.repos[1].path, ["worktree", "remove", childPaths["repo-b"], "--force"]);
    const grandchildPath = join(childPaths["repo-a"], "repos", "repo-b");
    await mkdir(join(childPaths["repo-a"], "repos"), { recursive: true });
    await createWorktree(workspace.repos[1].path, "grandchild-missing-owner", grandchildPath);
    const missingRepoPath = workspace.repos[1].path;
    const preservedRepoPath = `${missingRepoPath}-preserved`;
    await rename(missingRepoPath, preservedRepoPath);

    try {
      await expect(
        runRemove(await realpath(parentPath), { force: true, path: true }),
      ).rejects.toThrow(/repo-b.*configured descendant/i);
    } finally {
      await rename(preservedRepoPath, missingRepoPath);
    }

    expect(existsSync(parentPath)).toBe(true);
    expect(existsSync(childPaths["repo-a"])).toBe(true);
    expect(existsSync(grandchildPath)).toBe(true);
    expect(normalizePathForComparison(await worktreeList(workspace.repos[1].path))).toContain(
      normalizePathForComparison(await realpath(grandchildPath)),
    );
  });

  test("fails closed before parent mutation when configured descendant inventory cannot be inspected", async () => {
    const { childPaths, parentPath } = await createNestedWorktrees(workspace, "parent-inspection", {
      "repo-a": "child-inspection",
    });
    const childGitPath = join(workspace.repos[0].path, ".git");
    const brokenGitPath = join(workspace.repos[0].path, ".git-broken");
    const originalCwd = process.cwd();
    await rename(childGitPath, brokenGitPath);
    await writeFile(childGitPath, "gitdir: missing-git-directory\n");

    try {
      process.chdir(workspace.rootPath);
      await expect(
        executeRemove(await realpath(parentPath), { force: true, path: true }),
      ).rejects.toThrow(/repo-a/);
    } finally {
      process.chdir(originalCwd);
      await rm(childGitPath);
      await rename(brokenGitPath, childGitPath);
    }

    expect(existsSync(parentPath)).toBe(true);
    expect(existsSync(childPaths["repo-a"])).toBe(true);
    expect(normalizePathForComparison(await worktreeList(workspace.rootPath))).toContain(
      normalizePathForComparison(await realpath(parentPath)),
    );
    expect(normalizePathForComparison(await worktreeList(workspace.repos[0].path))).toContain(
      normalizePathForComparison(await realpath(childPaths["repo-a"])),
    );
  });

  test("blocks a parent whose existing descendant is prunable", async () => {
    const { childPaths, parentPath } = await createNestedWorktrees(
      workspace,
      "parent-prunable-descendant",
      { "repo-a": "child-prunable-a", "repo-b": "child-prunable-b" },
    );
    const gitPointer = join(childPaths["repo-b"], ".git");
    const hiddenGitPointer = join(childPaths["repo-b"], ".git-hidden");
    await rename(gitPointer, hiddenGitPointer);

    let result;
    try {
      result = await runRemove(await realpath(parentPath), {
        force: true,
        keepBranches: true,
        path: true,
      });
    } finally {
      await rename(hiddenGitPointer, gitPointer);
    }

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("appeared after planning");
    expect(existsSync(parentPath)).toBe(true);
    expect(existsSync(childPaths["repo-a"])).toBe(true);
    expect(existsSync(childPaths["repo-b"])).toBe(true);
    expect(normalizePathForComparison(await worktreeList(workspace.repos[1].path))).toContain(
      normalizePathForComparison(await realpath(childPaths["repo-b"])),
    );
  });

  test("revalidates the authoritative plan after pre-remove hooks before mutation", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { childPaths, parentPath } = await createNestedWorktrees(
      workspace,
      "parent-hook-invalidation",
      { "repo-a": "child-hook-invalidation" },
    );
    await git(workspace.repos[1].path, ["worktree", "remove", childPaths["repo-b"], "--force"]);
    const lateDescendantPath = join(parentPath, "repos", "repo-b");
    const hooksDir = join(workspace.rootPath, ".arashi", "hooks");
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-remove.sh");
    await writeFile(
      hookPath,
      `#!/usr/bin/env bash\nset -euo pipefail\nif [[ ! -e '${lateDescendantPath}' ]]; then\n  git -C '${workspace.repos[1].path}' worktree add -b hook-created-descendant '${lateDescendantPath}' >/dev/null\nfi\n`,
    );
    await chmod(hookPath, 0o755);

    const result = await runRemove(await realpath(parentPath), {
      force: true,
      keepBranches: true,
      path: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("appeared after planning");
    expect(existsSync(parentPath)).toBe(true);
    expect(existsSync(childPaths["repo-a"])).toBe(true);
    expect(existsSync(lateDescendantPath)).toBe(true);
    expect(normalizePathForComparison(await worktreeList(workspace.repos[1].path))).toContain(
      normalizePathForComparison(await realpath(lateDescendantPath)),
    );
  });

  test("auto-included dirty descendants are confirmed and exposed to hooks", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { childPaths, parentPath } = await createNestedWorktrees(workspace, "parent-context", {
      "repo-a": "child-context",
    });
    await markWorktreeDirty(childPaths["repo-a"]);
    const canonicalChildPath = await realpath(childPaths["repo-a"]);
    const canonicalParentPath = await realpath(parentPath);
    const preTargetLog = join(workspace.rootPath, ".arashi", "pre-remove-targets.json");
    const postTargetLog = join(workspace.rootPath, ".arashi", "post-remove-targets.json");
    const hooksDir = join(workspace.rootPath, ".arashi", "hooks");
    await mkdir(hooksDir, { recursive: true });
    for (const hookName of ["pre-remove", "post-remove"]) {
      const hookPath = join(hooksDir, `${hookName}.sh`);
      await writeFile(
        hookPath,
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' "$ARASHI_REMOVE_TARGETS_JSON" > "$ARASHI_MAIN_REPO_PATH/.arashi/${hookName}-targets.json"\n`,
      );
      await chmod(hookPath, 0o755);
    }
    const prompts: string[] = [];

    const result = await runRemove(
      await realpath(parentPath),
      { keepBranches: true, path: true },
      async (message) => {
        prompts.push(message);
        return { status: "ok" as const, value: true };
      },
    );

    expect(result.exitCode).toBe(0);
    expect(prompts[0]).toContain("discard all uncommitted changes");
    for (const targetLog of [preTargetLog, postTargetLog]) {
      const targets = JSON.parse(await readFile(targetLog, "utf8"));
      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ repository: "repo-a", worktreePath: canonicalChildPath }),
          expect.objectContaining({ worktreePath: canonicalParentPath }),
        ]),
      );
    }
  });

  test.each([
    ["--force", { force: true, json: true }],
    ["--no-check-dirty", { checkDirty: false, force: true, json: true }],
  ] as const)(
    "auto-included dirty descendants preserve %s removal behavior",
    async (_label, options) => {
      const { childPaths, parentPath } = await createNestedWorktrees(
        workspace,
        `parent-${_label}`,
        {
          "repo-a": `child-${_label}`,
        },
      );
      await markWorktreeDirty(childPaths["repo-a"]);

      const result = await runRemove(await realpath(parentPath), {
        ...options,
        keepBranches: true,
        path: true,
      });

      expect(result.exitCode, result.stdout).toBe(0);
      expect(existsSync(childPaths["repo-a"])).toBe(false);
      expect(existsSync(parentPath)).toBe(false);
    },
  );

  test("real CLI emits one JSON document for an auto-included dirty descendant", async () => {
    const { childPaths, parentPath } = await createNestedWorktrees(workspace, "parent-cli-dirty", {
      "repo-a": "child-cli-dirty",
    });
    await markWorktreeDirty(childPaths["repo-a"]);

    const result = await runCli(workspace.rootPath, [
      "remove",
      await realpath(parentPath),
      "--path",
      "--force",
      "--keep-branches",
      "--json",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(result.stdout.trim()).toBe(JSON.stringify(envelope, null, 2));
    expect(existsSync(childPaths["repo-a"])).toBe(false);
    expect(existsSync(parentPath)).toBe(false);
  });

  test("a failed child blocks its ancestor while an unrelated removal and finalization continue", async () => {
    if (process.platform === "win32") {
      return;
    }
    const parentBranch = "parent-blocked";
    const { childPaths, parentPath } = await createNestedWorktrees(workspace, parentBranch, {
      "repo-a": "locked-child",
      "repo-b": "other-child",
    });
    const unrelatedPath = join(workspace.rootPath, "worktrees", "unrelated-blocked");
    await createWorktree(workspace.repos[1].path, parentBranch, unrelatedPath);
    await git(workspace.repos[0].path, ["worktree", "lock", childPaths["repo-a"]]);
    const canonicalChildPath = await realpath(childPaths["repo-a"]);
    const canonicalParentPath = await realpath(parentPath);
    const canonicalUnrelatedPath = await realpath(unrelatedPath);
    const postMarker = join(workspace.rootPath, ".arashi", "post-remove-complete");
    const hooksDir = join(workspace.rootPath, ".arashi", "hooks");
    await mkdir(hooksDir, { recursive: true });
    const postHookPath = join(hooksDir, "post-remove.sh");
    await writeFile(
      postHookPath,
      `#!/usr/bin/env bash\nset -euo pipefail\ntouch "$ARASHI_MAIN_REPO_PATH/.arashi/post-remove-complete"\n`,
    );
    await chmod(postHookPath, 0o755);

    const result = await runRemove(parentBranch, { json: true }, async () => ({
      status: "ok" as const,
      value: true,
    }));

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.details.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repository: "repo-a",
          status: "failed",
          worktreePath: canonicalChildPath,
        }),
        expect.objectContaining({ status: "failed", worktreePath: canonicalParentPath }),
        expect.objectContaining({
          repository: "repo-b",
          status: "success",
          worktreePath: canonicalUnrelatedPath,
        }),
      ]),
    );
    expect(
      envelope.error.details.operations.find(
        (operation: { worktreePath?: string }) => operation.worktreePath === canonicalParentPath,
      ).error,
    ).toContain("descendant");
    expect(envelope.error.details.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branchName: "locked-child", type: "branch_delete" }),
        expect.objectContaining({ branchName: parentBranch, type: "branch_delete" }),
      ]),
    );
    expect(envelope.error.details.hookOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hookName: "post-remove", hookStatus: "success" }),
      ]),
    );
    expect(existsSync(childPaths["repo-a"])).toBe(true);
    expect(existsSync(parentPath)).toBe(true);
    expect(existsSync(unrelatedPath)).toBe(false);
    expect(await worktreeList(workspace.repos[0].path)).toContain(canonicalChildPath);
    expect(await worktreeList(workspace.rootPath)).toContain(canonicalParentPath);
    expect(existsSync(postMarker)).toBe(true);
    const human = formatRemovalSummaryHuman(envelope.error.details, {});
    expect(human).toContain("Partial removal completed");
    expect(human).toContain(canonicalChildPath);
    expect(human).toContain(`Removal of ${canonicalParentPath} blocked`);
    expect(human).not.toContain("Successfully removed");
  });

  test("real CLI emits one JSON document for a dependency-blocked partial failure", async () => {
    if (process.platform === "win32") {
      return;
    }
    const parentBranch = "parent-cli-partial";
    const { childPaths, parentPath } = await createNestedWorktrees(workspace, parentBranch, {
      "repo-a": "locked-cli-child",
      "repo-b": parentBranch,
    });
    const unrelatedPath = join(workspace.rootPath, "worktrees", "unrelated-cli-partial");
    await createWorktree(workspace.repos[1].path, parentBranch, unrelatedPath);
    await git(workspace.repos[0].path, ["worktree", "lock", childPaths["repo-a"]]);
    const canonicalParentPath = await realpath(parentPath);

    const result = await runCli(workspace.rootPath, ["remove", parentBranch, "--force", "--json"]);

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(result.stdout.trim()).toBe(JSON.stringify(envelope, null, 2));
    expect(envelope.error.details.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", worktreePath: canonicalParentPath }),
      ]),
    );
  });

  async function runRemove(
    target: string,
    options: Parameters<typeof executeRemove>[1],
    confirm?: NonNullable<Parameters<typeof executeRemove>[2]>["confirm"],
  ): Promise<{ exitCode: number; stdout: string }> {
    const originalCwd = process.cwd();
    const originalWrite = process.stdout.write;
    const originalLog = console.log;
    let stdout = "";
    process.chdir(workspace.rootPath);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => {
      stdout += `${args.map(String).join(" ")}\n`;
    };
    try {
      const promptHandlers = confirm
        ? { confirm, multiSelect: async () => ({ status: "ok" as const, value: [] }) }
        : undefined;
      return { exitCode: await executeRemove(target, options, promptHandlers), stdout };
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
    }
  }
});

async function git(repoPath: string, args: string[]): Promise<string> {
  const proc = spawn(["git", ...args], { cwd: repoPath, stderr: "pipe", stdout: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(stderr || stdout);
  }
  return stdout;
}

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
}

const normalizePathForComparison = (value: string): string => value.replaceAll("\\", "/");

const worktreeList = (repoPath: string): Promise<string> =>
  git(repoPath, ["worktree", "list", "--porcelain"]);

const prunePreview = (repoPath: string): Promise<string> =>
  git(repoPath, ["worktree", "prune", "--dry-run", "--verbose"]);
