import { afterEach, describe, expect, test } from "vitest";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import { spawn } from "../helpers/node-runtime.ts";
import { executeCreate } from "../../src/commands/create.ts";
import { executeRemove } from "../../src/commands/remove.ts";

const roots: string[] = [];
async function run(cwd: string, args: string[], env?: Record<string, string>) {
  const child = spawn(args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
async function arashi(cwd: string, args: string[], env?: Record<string, string>) {
  return run(
    cwd,
    [process.execPath, join(import.meta.dirname, "../../src/index.ts"), ...args],
    env,
  );
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "arashi-standalone-"));
  roots.push(root);
  await run(root, ["git", "init", "-b", "main"]);
  await run(root, ["git", "config", "user.email", "test@example.com"]);
  await run(root, ["git", "config", "user.name", "Test User"]);
  await writeFile(join(root, "README.md"), "test\n");
  await run(root, ["git", "add", "."]);
  await run(root, ["git", "commit", "-m", "initial"]);
  return root;
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))),
);

describe("standalone lifecycle", () => {
  test("blocks exact unignored create before branch or directory mutation", async () => {
    const root = await repository();
    await (await import("fs/promises")).mkdir(join(root, ".worktrees"));
    const canonicalRoot = await realpath(root);
    const result = await arashi(root, ["create", "feat/blocked", "--dry-run", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "STANDALONE_DESTINATION_NOT_IGNORED",
      details: {
        effectiveIgnore: { ignored: false, source: null },
        mutation: { branch: false, config: false, ignore: false, worktree: false },
        repairCommands: expect.arrayContaining([
          "arashi init --zero-config",
          expect.stringContaining("info/exclude"),
        ]),
      },
    });
    expect(JSON.parse(result.stdout).error.details.destination).toBe(
      join(canonicalRoot, ".worktrees", "feat", "blocked"),
    );
    expect((await run(root, ["git", "branch", "--list", "feat/blocked"])).stdout).toBe("");
    await expect(access(join(root, ".worktrees", "feat"))).rejects.toThrow();
  });

  test("blocks create when verbose Git ignore evidence is an effective negation", async () => {
    const root = await repository();
    await mkdir(join(root, ".worktrees"));
    await writeFile(join(root, ".gitignore"), "!/.worktrees/\n!/.worktrees/**\n");

    const result = await arashi(root, ["create", "feat/exposed", "--dry-run", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "STANDALONE_DESTINATION_NOT_IGNORED",
      details: {
        effectiveIgnore: { ignored: false },
        mutation: { branch: false, config: false, ignore: false, worktree: false },
      },
    });
    expect((await run(root, ["git", "branch", "--list", "feat/exposed"])).stdout).toBe("");
    await expect(access(join(root, ".worktrees", "feat", "exposed"))).rejects.toThrow();
  });

  test("create JSON reports the effective ignore source", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);

    const result = await arashi(root, ["create", "ignore-evidence", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      effectiveIgnore: {
        ignored: true,
        pattern: ".worktrees/",
        source: expect.stringContaining("info/exclude"),
      },
      mode: "standalone",
    });
  });

  test("create reuses a remote-only branch", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "arashi-remote-"));
    roots.push(remote);
    await run(remote, ["git", "init", "--bare"]);
    await run(root, ["git", "remote", "add", "origin", remote]);
    await run(root, ["git", "branch", "remote-only"]);
    await run(root, ["git", "push", "origin", "remote-only"]);
    await run(root, ["git", "branch", "-D", "remote-only"]);
    await arashi(root, ["init", "--zero-config"]);

    const result = await arashi(root, ["create", "remote-only", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      branchSource: "origin/remote-only",
      reusedRemoteBranch: true,
    });
    expect((await run(root, ["git", "rev-parse", "remote-only"])).stdout.trim()).toBe(
      (await run(root, ["git", "rev-parse", "origin/remote-only"])).stdout.trim(),
    );
  });

  test("post-create rollback removes only invocation-owned slash parents", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await mkdir(join(root, ".worktrees", "preserved"));
    const home = await mkdtemp(join(tmpdir(), "arashi-home-"));
    roots.push(home);
    const hooks = join(home, ".arashi", "hooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, "post-create.sh"), "#!/bin/sh\nexit 31\n");
    await chmod(join(hooks, "post-create.sh"), 0o755);

    const owned = await arashi(root, ["create", "owned/nested/failure", "--json"], {
      HOME: home,
    });
    const preserved = await arashi(root, ["create", "preserved/failure", "--json"], {
      HOME: home,
    });

    expect(owned.exitCode).not.toBe(0);
    expect(preserved.exitCode).not.toBe(0);
    expect(JSON.parse(owned.stdout).error.code).toBe("STANDALONE_HOOK_FAILED");
    await expect(access(join(root, ".worktrees", "owned"))).rejects.toThrow();
    await expect(access(join(root, ".worktrees", "preserved"))).resolves.toBeUndefined();
    expect((await run(root, ["git", "branch", "--list", "owned/nested/failure"])).stdout).toBe("");
  });

  test("bootstraps, creates slash path, lists/statuses from linked worktree, and removes", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    expect((await arashi(root, ["init", "--zero-config"])).exitCode).toBe(0);
    const created = await arashi(root, ["create", "feat/example", "--json"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).data).toMatchObject({
      mode: "standalone",
      worktreePath: join(canonicalRoot, ".worktrees", "feat", "example"),
    });
    const linked = join(root, ".worktrees", "feat", "example");
    expect(JSON.parse((await arashi(linked, ["list", "--json"])).stdout).data).toMatchObject({
      mode: "standalone",
      workspaceRoot: canonicalRoot,
    });
    expect(JSON.parse((await arashi(linked, ["status", "--json"])).stdout).data.mode).toBe(
      "standalone",
    );
    const removed = await arashi(root, ["remove", "feat/example", "--force", "--json"]);
    expect(removed.exitCode).toBe(0);
    await expect(access(linked)).rejects.toThrow();
    await expect(access(join(root, ".arashi"))).rejects.toThrow();
  });

  test("standalone remove preserves confirmation and effective keep semantics", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    for (const branch of ["declined", "keep-directory", "keep-branch"]) {
      expect((await arashi(root, ["create", branch, "--json"])).exitCode).toBe(0);
    }

    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const prompts: string[] = [];
      expect(
        await executeRemove(
          "declined",
          {},
          {
            confirm: async (message) => {
              prompts.push(message);
              return { status: "ok", value: false };
            },
            multiSelect: async () => ({ status: "ok", value: [] }),
          },
        ),
      ).toBe(0);
      expect(prompts).toEqual([expect.stringContaining("Remove 1 worktree and delete 1 branch")]);
      await expect(access(join(root, ".worktrees", "declined"))).resolves.toBeUndefined();
      expect((await run(root, ["git", "branch", "--list", "declined"])).stdout).toContain(
        "declined",
      );

      expect(await executeRemove("keep-directory", { force: true, keepWorktrees: true })).toBe(0);
      await expect(access(join(root, ".worktrees", "keep-directory"))).resolves.toBeUndefined();
      const keptDirectoryListing = (await run(root, ["git", "worktree", "list", "--porcelain"]))
        .stdout;
      expect(keptDirectoryListing).toContain(".worktrees/keep-directory");
      expect(keptDirectoryListing).toContain("detached");
      expect((await run(root, ["git", "branch", "--list", "keep-directory"])).stdout).toBe("");

      expect(await executeRemove("keep-branch", { force: true, keepBranches: true })).toBe(0);
      await expect(access(join(root, ".worktrees", "keep-branch"))).rejects.toThrow();
      expect((await run(root, ["git", "branch", "--list", "keep-branch"])).stdout.trim()).toBe(
        "keep-branch",
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("standalone explicit detached path preserves the hook target label", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    const relativeTarget = join(".worktrees", "detached-remove");
    const linked = join(root, relativeTarget);
    expect((await run(root, ["git", "worktree", "add", "--detach", linked, "HEAD"])).exitCode).toBe(
      0,
    );

    const home = await mkdtemp(join(tmpdir(), "arashi-remove-hook-home-"));
    roots.push(home);
    const hookDirectory = join(home, ".arashi", "hooks");
    const hook = join(hookDirectory, "pre-remove.sh");
    const record = join(home, "branch-name");
    await mkdir(hookDirectory, { recursive: true });
    await writeFile(hook, `#!/bin/sh\nprintf '%s' "$ARASHI_BRANCH_NAME" > "${record}"\n`);
    await chmod(hook, 0o755);

    const result = await arashi(root, ["remove", relativeTarget, "--path", "--force", "--json"], {
      HOME: home,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(record, "utf8")).toBe(relativeTarget);
    await expect(access(linked)).rejects.toThrow();
  });

  test("standalone remove without a target prompts for a worktree", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "interactive-remove", "--json"]);
    const linked = join(root, ".worktrees", "interactive-remove");
    const canonicalLinked = await realpath(linked);

    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const promptHandlers = {
        confirm: async () => ({ status: "ok" as const, value: true }),
        multiSelect: async () => ({ status: "ok" as const, value: [] }),
        select: async (message: string, choices: { name: string; value: string }[]) => {
          expect(message).toBe("Select a worktree to remove:");
          expect(choices).toEqual([
            expect.objectContaining({
              name: expect.stringContaining("interactive-remove"),
              value: canonicalLinked,
            }),
          ]);
          return { status: "ok" as const, value: canonicalLinked };
        },
      };

      expect(await executeRemove(undefined, { force: true }, promptHandlers)).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    await expect(access(linked)).rejects.toThrow();
    expect((await run(root, ["git", "branch", "--list", "interactive-remove"])).stdout).toBe("");
  });

  test("standalone remove excludes prunable worktrees from selection", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "selectable-remove", "--json"]);
    const selectable = await realpath(join(root, ".worktrees", "selectable-remove"));
    const stale = join(root, ".worktrees", "stale-remove");
    expect(
      (await run(root, ["git", "worktree", "add", "-b", "stale-remove", stale])).exitCode,
    ).toBe(0);
    await rm(stale, { force: true, recursive: true });

    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      const promptHandlers = {
        confirm: async () => ({ status: "ok" as const, value: true }),
        multiSelect: async () => ({ status: "ok" as const, value: [] }),
        select: async (_message: string, choices: { name: string; value: string }[]) => {
          expect(choices).toEqual([
            expect.objectContaining({ name: "selectable-remove", value: selectable }),
          ]);
          return { reason: "exit" as const, status: "cancelled" as const };
        },
      };

      expect(await executeRemove(undefined, { force: true }, promptHandlers)).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }

    await expect(access(selectable)).resolves.toBeUndefined();
    expect((await run(root, ["git", "branch", "--list", "stale-remove"])).stdout).toContain(
      "stale-remove",
    );
  });

  test("standalone remove directs stale-only selection to prune", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    const stale = join(root, ".worktrees", "stale-only-remove");
    expect(
      (await run(root, ["git", "worktree", "add", "-b", "stale-only-remove", stale])).exitCode,
    ).toBe(0);
    await rm(stale, { force: true, recursive: true });

    const result = await arashi(root, ["remove", "--force"]);

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("arashi prune");
    expect((await run(root, ["git", "branch", "--list", "stale-only-remove"])).stdout).toContain(
      "stale-only-remove",
    );
  });

  test("standalone remove JSON requires an explicit target", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "json-remove", "--json"]);

    const result = await arashi(root, ["remove", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "remove",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "interactive-selection" },
      },
      ok: false,
    });
    await expect(access(join(root, ".worktrees", "json-remove"))).resolves.toBeUndefined();
  });

  test("standalone remove dry-run reports a complete non-mutating plan", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "remove-preview", "--json"]);
    const linked = join(root, ".worktrees", "remove-preview");
    await writeFile(join(linked, "dirty.txt"), "dirty\n");
    const home = await mkdtemp(join(tmpdir(), "arashi-remove-preview-home-"));
    roots.push(home);
    const hooks = join(home, ".arashi", "hooks");
    await mkdir(hooks, { recursive: true });
    const marker = join(home, "hook-ran");
    for (const hookName of ["pre-remove", "post-remove"]) {
      const hook = join(hooks, `${hookName}.sh`);
      await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
      await chmod(hook, 0o755);
    }

    const result = await arashi(root, ["remove", "remove-preview", "--dry-run", "--json"], {
      HOME: home,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      blockers: [
        expect.objectContaining({
          branchName: "remove-preview",
          path: expect.stringContaining("remove-preview"),
          type: "dirty_worktree",
        }),
      ],
      dryRun: true,
      effectiveOptions: {
        checkDirty: true,
        force: false,
        keepBranches: false,
        keepWorktrees: false,
      },
      hooks: expect.arrayContaining([
        expect.objectContaining({ hookName: "pre-remove", scope: "global-shared" }),
        expect.objectContaining({ hookName: "post-remove", scope: "global-shared" }),
      ]),
      mode: "standalone",
      operations: expect.arrayContaining([
        expect.objectContaining({
          type: "worktree_remove",
          worktreePath: join(canonicalRoot, ".worktrees", "remove-preview"),
        }),
        expect.objectContaining({ branchName: "remove-preview", type: "branch_delete" }),
      ]),
      repositoriesBase: canonicalRoot,
      repositoryPath: canonicalRoot,
      summary: { totalBranches: 1, totalWorktrees: 1 },
      workspaceRoot: canonicalRoot,
      worktreesBase: join(canonicalRoot, ".worktrees"),
    });
    const keepWorktree = await arashi(
      root,
      ["remove", "remove-preview", "--dry-run", "--keep-worktrees", "--json"],
      { HOME: home },
    );
    expect(keepWorktree.exitCode).toBe(0);
    expect(JSON.parse(keepWorktree.stdout).data).toMatchObject({
      effectiveOptions: { keepBranches: false, keepWorktrees: true },
      operations: expect.arrayContaining([
        expect.objectContaining({
          branchName: "remove-preview",
          type: "worktree_detach",
          worktreePath: join(canonicalRoot, ".worktrees", "remove-preview"),
        }),
        expect.objectContaining({ branchName: "remove-preview", type: "branch_delete" }),
      ]),
      summary: { totalBranches: 1, totalWorktrees: 0 },
    });
    await expect(access(marker)).rejects.toThrow();
    await expect(access(linked)).resolves.toBeUndefined();
    expect((await run(root, ["git", "branch", "--list", "remove-preview"])).stdout).toContain(
      "remove-preview",
    );
  });

  test("standalone create applies explicit launch, sesh, switch, and opt-out overrides", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    await arashi(root, ["init", "--zero-config"]);
    const originalCwd = process.cwd();
    process.chdir(root);
    const launches: { branchName: string; sesh?: boolean }[] = [];
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
    const dependencies = {
      launchSwitchTarget: async (
        candidate: { branchName: string },
        options: { sesh?: boolean },
      ) => {
        launches.push({ branchName: candidate.branchName, sesh: options.sesh });
        return {
          command: ["test-launch"],
          mode: options.sesh ? ("sesh" as const) : ("fallback" as const),
        };
      },
    };
    try {
      expect(await executeCreate("explicit-launch", { launch: true }, dependencies)).toBe(0);
      expect(await executeCreate("explicit-sesh", { sesh: true }, dependencies)).toBe(0);
      expect(await executeCreate("explicit-switch", { switch: true }, dependencies)).toBe(0);
      expect(
        await executeCreate("explicit-opt-out", { launch: false, switch: false }, dependencies),
      ).toBe(0);
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
    }

    expect(launches).toEqual([
      { branchName: "explicit-launch", sesh: false },
      { branchName: "explicit-sesh", sesh: true },
    ]);
    expect(output.join("\n")).toContain(
      `Default switch target: ${join(canonicalRoot, ".worktrees", "explicit-switch")}`,
    );
    expect(output.join("\n")).toContain(
      "Launch skipped (resolved defaults disabled launch for this invocation).",
    );
    await expect(access(join(root, ".arashi"))).rejects.toThrow();
  });

  test("standalone Herdr launch uses the main checkout and preserves the created worktree on failure", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    await arashi(root, ["init", "--zero-config"]);
    const originalCwd = process.cwd();
    process.chdir(root);
    let captured:
      | {
          herdr?: boolean;
          source?: { path: string; status: "available" } | { status: "unavailable" };
          worktreePath: string;
        }
      | undefined;
    try {
      await expect(
        executeCreate(
          "herdr-launch-failure",
          { herdr: true },
          {
            launchSwitchTarget: async (candidate, options) => {
              captured = {
                herdr: options.herdr,
                source: candidate.herdrSource,
                worktreePath: candidate.worktreePath,
              };
              throw new Error("Herdr server unavailable after standalone creation");
            },
          },
        ),
      ).rejects.toThrow("Herdr server unavailable after standalone creation");
    } finally {
      process.chdir(originalCwd);
    }

    const worktreePath = join(canonicalRoot, ".worktrees", "herdr-launch-failure");
    expect(captured).toEqual({
      herdr: true,
      source: { path: canonicalRoot, status: "available" },
      worktreePath,
    });
    await expect(access(worktreePath)).resolves.toBeUndefined();
  });

  test.each([
    ["create", ["branch", "--only", "repo"]],
    ["create", ["branch", "--group", "group"]],
    ["create", ["branch", "--interactive"]],
    ["switch", ["--all"]],
  ])("rejects meaningless %s standalone selection", async (command, args) => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    const result = await arashi(root, [command, ...args]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("standalone");
  });

  test.each([
    ["prune", ["--dry-run", "--json"]],
    ["doctor", ["--json"]],
    ["handoff", ["--json"]],
  ])("reports standalone metadata for %s", async (command, args) => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    const result = await arashi(root, [command, ...args]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.mode).toBe("standalone");
  });

  test.each(["status", "prune", "handoff", "doctor"])(
    "%s encloses invalid config in one command-specific JSON error",
    async (command) => {
      const root = await repository();
      await mkdir(join(root, ".worktrees"));
      await mkdir(join(root, ".arashi"));
      await writeFile(join(root, ".arashi", "config.json"), "{");

      const result = await arashi(root, [command, "--json"]);

      expect(result.exitCode).not.toBe(0);
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({ command, ok: false });
      expect(envelope.error.message).toContain("parse");
      expect(envelope.error.details?.mode).not.toBe("standalone");
    },
  );

  test.each(["status", "prune", "handoff", "doctor"])(
    "%s reports configured metadata when valid config and .worktrees coexist",
    async (command) => {
      const root = await repository();
      const canonicalRoot = await realpath(root);
      await mkdir(join(root, ".worktrees"));
      await mkdir(join(root, ".arashi"));
      await writeFile(
        join(root, ".arashi", "config.json"),
        JSON.stringify({
          version: "1.0.0",
          reposDir: "./configured-repos",
          worktreesDir: "./configured-worktrees",
          repos: {},
        }),
      );

      const result = await arashi(root, [
        command,
        ...(command === "prune" ? ["--dry-run"] : []),
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).data).toMatchObject({
        mode: "configured",
        workspaceRoot: canonicalRoot,
        worktreesBase: join(canonicalRoot, "configured-worktrees"),
      });
    },
  );

  test("handoff preserves standalone status, caller context, evidence, and summaries", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "handoff-context", "--json"]);
    const linked = join(root, ".worktrees", "handoff-context");
    const canonicalLinked = await realpath(linked);
    await writeFile(join(linked, "README.md"), "dirty handoff\n");

    const result = await arashi(linked, [
      "handoff",
      "--json",
      "--link",
      "issue-212",
      "--validation",
      "pnpm test — passed",
      "--todo",
      "finish docs",
      "--risk",
      "remote drift",
      "--next-command",
      "arashi status --verbose",
    ]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data).toMatchObject({
      callerWorktree: canonicalLinked,
      context: {
        links: ["issue-212"],
        nextCommands: ["arashi status --verbose"],
        risks: ["remote drift"],
        todos: ["finish docs"],
        validations: ["pnpm test — passed"],
      },
      effectiveOptions: { format: "json" },
      mode: "standalone",
      repositoryPath: canonicalRoot,
      summary: { dirtyCount: 1, total: 2, touchedCount: 1 },
      workspace: { branch: "handoff-context", path: canonicalRoot },
      worktreesBase: join(canonicalRoot, ".worktrees"),
    });
    expect(data.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: expect.objectContaining({ localBranch: "handoff-context" }),
          path: canonicalLinked,
          state: "dirty",
        }),
      ]),
    );

    const markdown = await arashi(linked, [
      "handoff",
      "--link",
      "issue-212",
      "--validation",
      "pnpm test — passed",
      "--todo",
      "finish docs",
      "--risk",
      "remote drift",
      "--next-command",
      "arashi status --verbose",
    ]);
    expect(markdown.exitCode).toBe(0);
    expect(markdown.stdout).toContain("Workspace mode: standalone");
    expect(markdown.stdout).toContain(`Caller worktree: ${canonicalLinked}`);
    expect(markdown.stdout).toContain("handoff-context");
    expect(markdown.stdout).toContain("pnpm test — passed");
    expect(markdown.stdout).toContain("finish docs");
    expect(markdown.stdout).toContain("remote drift");
    expect(markdown.stdout).toContain("issue-212");
  });

  test("status preserves remote/default relationships, caller worktree, and verbose details", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    const remote = await mkdtemp(join(tmpdir(), "arashi-status-remote-"));
    roots.push(remote);
    await run(remote, ["git", "init", "--bare"]);
    await run(root, ["git", "remote", "add", "origin", remote]);
    await run(root, ["git", "push", "-u", "origin", "main"]);
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "status-context", "--json"]);
    const linked = join(root, ".worktrees", "status-context");
    const canonicalLinked = await realpath(linked);
    await run(linked, ["git", "push", "-u", "origin", "status-context"]);
    await writeFile(join(linked, "README.md"), "status dirty\n");

    const result = await arashi(linked, ["status", "--verbose", "--json"]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data).toMatchObject({
      callerWorktree: canonicalLinked,
      currentBranch: "status-context",
      mode: "standalone",
      repositoryPath: canonicalRoot,
      summary: { dirtyCount: 1, total: 2 },
      workspaceRoot: canonicalRoot,
      worktreesBase: join(canonicalRoot, ".worktrees"),
    });
    expect(data.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: expect.objectContaining({
            ahead: 0,
            behind: 0,
            localBranch: "status-context",
            remoteBranch: "origin/status-context",
          }),
          defaultBranch: expect.objectContaining({ branch: "main", state: "available" }),
          files: [expect.objectContaining({ path: "README.md" })],
          fullStatus: expect.stringContaining("README.md"),
          path: canonicalLinked,
        }),
      ]),
    );
  });

  test("list preserves simple composability, table, and verbose modes while rejecting standalone depth discovery", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "list-modes", "--json"]);

    const simple = await arashi(root, ["list"]);
    const table = await arashi(root, ["list", "--table"]);
    const verbose = await arashi(root, ["list", "--verbose"]);
    const depth = await arashi(root, ["list", "--max-depth", "0", "--json"]);

    expect(simple.exitCode).toBe(0);
    expect(simple.stderr).toContain("Workspace mode: standalone");
    expect(simple.stdout.trim().split("\n")).toHaveLength(2);
    expect(
      simple.stdout
        .trim()
        .split("\n")
        .every((line) => line.startsWith("/")),
    ).toBe(true);
    expect(table.stdout).toContain("BRANCH");
    expect(table.stdout).toContain("WORKTREE");
    expect(table.stdout).toContain("list-modes");
    expect(table.stderr).toContain("Workspace mode: standalone");
    expect(table.stdout).not.toContain("Workspace mode: standalone");
    expect(verbose.stdout).toContain("Workspace mode: standalone");
    expect(verbose.stdout).toContain("HEAD:");
    expect(verbose.stdout).toContain("Branch:");
    expect(depth.exitCode).not.toBe(0);
    expect(JSON.parse(depth.stdout)).toMatchObject({
      command: "list",
      error: { message: expect.stringContaining("--max-depth") },
      ok: false,
    });
  });

  test("prune reports structured stale entries, reasons, totals, and results", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    await arashi(root, ["init", "--zero-config"]);
    await run(root, [
      "git",
      "worktree",
      "add",
      "-b",
      "stale-prune",
      join(root, ".worktrees", "stale-prune"),
    ]);
    await rm(join(root, ".worktrees", "stale-prune"), { recursive: true, force: true });

    const preview = await arashi(root, ["prune", "--dry-run", "--json"]);

    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout).data).toMatchObject({
      dryRun: true,
      mode: "standalone",
      overallStatus: "success",
      repositories: [
        expect.objectContaining({
          path: canonicalRoot,
          prunable: [
            expect.objectContaining({
              branch: "stale-prune",
              path: expect.stringContaining("stale-prune"),
              pruneReason: expect.any(String),
            }),
          ],
          status: "skipped",
        }),
      ],
      totalPrunable: 1,
      totalPruned: 0,
      totalRepositories: 1,
    });

    const applied = await arashi(root, ["prune", "--json"]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout).data).toMatchObject({
      repositories: [expect.objectContaining({ prunedCount: 1, status: "pruned" })],
      totalPruned: 1,
    });
  });

  test("doctor reports full standalone repository/worktree health without synthetic repos", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await writeFile(join(root, "README.md"), "doctor dirty\n");
    await run(root, [
      "git",
      "worktree",
      "add",
      "-b",
      "doctor-stale",
      join(root, ".worktrees", "doctor-stale"),
    ]);
    await rm(join(root, ".worktrees", "doctor-stale"), { recursive: true, force: true });

    const result = await arashi(root, ["doctor", "--json"]);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data).toMatchObject({
      checkedCategories: expect.arrayContaining(["workspace", "repository", "worktree"]),
      mode: "standalone",
    });
    expect(data.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "REPOSITORY_DIRTY" }),
        expect.objectContaining({
          code: "WORKTREE_STALE_METADATA",
          details: expect.objectContaining({ path: expect.stringContaining("doctor-stale") }),
        }),
      ]),
    );
    expect(JSON.stringify(data)).not.toContain("managed-ignore:./repos");
    expect(JSON.stringify(data)).not.toContain("MANAGED_IGNORE_MISSING");
  });

  test("doctor preserves blocking exit, JSON, and human finding contracts in standalone mode", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    const realGit = (await run(root, ["which", "git"])).stdout.trim();
    const bin = join(root, "test-bin");
    const wrapper = join(bin, "git");
    await mkdir(bin);
    await writeFile(
      wrapper,
      `#!/bin/sh\nif [ "$1" = status ]; then echo 'injected status failure' >&2; exit 42; fi\nexec '${realGit}' "$@"\n`,
    );
    await chmod(wrapper, 0o755);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

    const json = await arashi(root, ["doctor", "--json"], env);
    expect(json.exitCode).not.toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      command: "doctor",
      error: {
        code: "DOCTOR_BLOCKING_FINDINGS",
        details: {
          findings: [
            expect.objectContaining({
              code: "REPOSITORY_STATUS_FAILED",
              severity: "error",
              suggestedCommands: [expect.stringContaining("git -C")],
            }),
          ],
          mode: "standalone",
        },
      },
      ok: false,
    });

    const human = await arashi(root, ["doctor"], env);
    expect(human.exitCode).not.toBe(0);
    expect(human.stdout).toContain("Workspace mode: standalone");
    expect(human.stdout).toContain("REPOSITORY_STATUS_FAILED");
    expect(human.stdout).toContain("repository:");
    expect(human.stdout).toContain("Suggested commands:");
  });

  test("move JSON and human results identify standalone mode and roots", async () => {
    const root = await repository();
    const canonicalRoot = await realpath(root);
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "move-mode", "--json"]);
    await writeFile(join(root, "README.md"), "move mode\n");
    const mainBranch = (await run(root, ["git", "branch", "--show-current"])).stdout.trim();

    const json = await arashi(root, ["move", "--from", mainBranch, "--to", "move-mode", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout).data).toMatchObject({
      mode: "standalone",
      repositoryPath: canonicalRoot,
      workspaceRoot: canonicalRoot,
      worktreesBase: join(canonicalRoot, ".worktrees"),
    });

    await run(join(root, ".worktrees", "move-mode"), ["git", "restore", "README.md"]);
    await writeFile(join(root, "README.md"), "move mode again\n");
    const human = await arashi(root, ["move", "--from", mainBranch, "--to", "move-mode"]);
    expect(human.stdout).toContain("Workspace mode: standalone");
    expect(human.stdout).toContain(canonicalRoot);
  });

  test("switch human success identifies standalone mode and exact target", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "switch-mode", "--json"]);
    const directive = join(root, "switch.directive");

    const result = await arashi(root, ["switch", "switch-mode", "--cd"], {
      ARASHI_DIRECTIVE_FILE: directive,
      ARASHI_SHELL: "zsh",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Workspace mode: standalone");
    expect(result.stdout).toContain(await realpath(root));
    expect(await readFile(directive, "utf8")).toContain(
      await realpath(join(root, ".worktrees", "switch-mode")),
    );
  });

  test.each([
    ["add", ["https://example.com/repository.git", "--json"]],
    ["clone", ["--all", "--json"]],
    ["exec", ["--json", "--", "true"]],
    ["pull", ["--json"]],
    ["push", ["--dry-run", "--json"]],
    ["setup", ["--json"]],
    ["sync", ["--json"]],
  ])("rejects configured-only %s before repository mutation", async (command, args) => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);

    const result = await arashi(root, [command, ...args]);

    expect(result.exitCode).not.toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error).toMatchObject({ code: "CONFIGURED_WORKSPACE_REQUIRED" });
    expect(envelope.error.message).toContain("arashi init");
    await expect(access(join(root, ".arashi"))).rejects.toThrow();
  });

  test("moves changes between standalone worktrees with explicit references", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "feature", "--json"]);
    await writeFile(join(root, "README.md"), "changed\n");
    const mainBranch = (await run(root, ["git", "branch", "--show-current"])).stdout.trim();

    const result = await arashi(root, ["move", "--from", mainBranch, "--to", "feature", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ movedCount: 1 });
    expect(
      await (
        await import("fs/promises")
      ).readFile(join(root, ".worktrees", "feature", "README.md"), "utf8"),
    ).toBe("changed\n");
    await expect(access(join(root, ".arashi"))).rejects.toThrow();
  });

  test("uses a standalone linked worktree as the implicit move source", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "source", "--json"]);
    const linked = join(root, ".worktrees", "source");
    await writeFile(join(linked, "README.md"), "from linked\n");
    const mainBranch = (await run(root, ["git", "branch", "--show-current"])).stdout.trim();

    const result = await arashi(linked, ["move", "--to", mainBranch, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ movedCount: 1 });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("from linked\n");
  });

  test("runs targeted then shared global create hooks and ignores local hooks", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    const home = await mkdtemp(join(tmpdir(), "arashi-home-"));
    roots.push(home);
    const hooks = join(home, ".arashi", "hooks");
    const record = join(home, "hooks.log");
    await mkdir(join(hooks, basename(root)), { recursive: true });
    await mkdir(join(root, ".arashi", "hooks"), { recursive: true });
    const scripts = [
      [join(hooks, basename(root), "pre-create.sh"), "targeted-pre"],
      [join(hooks, "pre-create.sh"), "shared-pre"],
      [join(hooks, basename(root), "post-create.sh"), "targeted-post"],
      [join(hooks, "post-create.sh"), "shared-post"],
      [join(root, ".arashi", "hooks", "pre-create.sh"), "local-should-not-run"],
    ];
    for (const [path, label] of scripts) {
      await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${label}' >> '${record}'\n`);
      await chmod(path, 0o755);
    }

    const result = await arashi(root, ["create", "hooked"], { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(await readFile(record, "utf8")).toBe(
      "targeted-pre\nshared-pre\ntargeted-post\nshared-post\n",
    );
  });

  test("a failing global pre-remove hook gates standalone removal", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "protected", "--json", "--no-hooks"]);
    const home = await mkdtemp(join(tmpdir(), "arashi-home-"));
    roots.push(home);
    const hookDirectory = join(home, ".arashi", "hooks", basename(root));
    const hook = join(hookDirectory, "pre-remove.sh");
    await mkdir(hookDirectory, { recursive: true });
    await writeFile(hook, "#!/bin/sh\nexit 42\n");
    await chmod(hook, 0o755);

    const result = await arashi(root, ["remove", "protected", "--force"], { HOME: home });

    expect(result.exitCode).not.toBe(0);
    await expect(access(join(root, ".worktrees", "protected"))).resolves.toBeUndefined();
    expect((await run(root, ["git", "branch", "--list", "protected"])).stdout).toContain(
      "protected",
    );
  });

  test("standalone remove finalizes after operation failure and aggregates hook failure", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "partial-remove", "--json", "--no-hooks"]);
    const linked = join(root, ".worktrees", "partial-remove");
    await writeFile(join(linked, "untracked.txt"), "dirty\n");
    const home = await mkdtemp(join(tmpdir(), "arashi-home-"));
    roots.push(home);
    const hookDirectory = join(home, ".arashi", "hooks", basename(root));
    const record = join(home, "post-remove.log");
    await mkdir(hookDirectory, { recursive: true });
    await writeFile(
      join(hookDirectory, "post-remove.sh"),
      `#!/bin/sh\nprintf '%s\\n' 'targeted' >> '${record}'\nexit 23\n`,
    );
    await chmod(join(hookDirectory, "post-remove.sh"), 0o755);
    await writeFile(
      join(home, ".arashi", "hooks", "post-remove.sh"),
      `#!/bin/sh\nprintf '%s\\n' 'shared' >> '${record}'\nexit 24\n`,
    );
    await chmod(join(home, ".arashi", "hooks", "post-remove.sh"), 0o755);

    const result = await arashi(root, ["remove", "partial-remove", "--force", "--json"], {
      HOME: home,
    });

    expect(result.exitCode).not.toBe(0);
    expect(await readFile(record, "utf8")).toBe("targeted\nshared\n");
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "STANDALONE_REMOVE_PARTIAL_FAILURE",
      details: {
        finalState: { branchExists: false, worktreeExists: false },
        hookFailures: expect.arrayContaining([
          expect.objectContaining({ hookName: "post-remove" }),
        ]),
        operationFailures: [],
      },
    });
    expect(JSON.parse(result.stdout).error.details.hookFailures).toHaveLength(2);
    await expect(access(linked)).rejects.toThrow();
  });
});
