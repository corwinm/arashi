import { afterEach, describe, expect, test } from "vitest";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import { spawn } from "../helpers/node-runtime.ts";

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
  await run(root, ["git", "init"]);
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
    const removed = await arashi(root, ["remove", "feat/example", "--json"]);
    expect(removed.exitCode).toBe(0);
    await expect(access(linked)).rejects.toThrow();
    await expect(access(join(root, ".arashi"))).rejects.toThrow();
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

  test("list preserves simple composability, table, verbose, and max-depth modes", async () => {
    const root = await repository();
    await arashi(root, ["init", "--zero-config"]);
    await arashi(root, ["create", "list-modes", "--json"]);

    const simple = await arashi(root, ["list", "--max-depth", "0"]);
    const table = await arashi(root, ["list", "--table"]);
    const verbose = await arashi(root, ["list", "--verbose", "--max-depth", "0"]);

    expect(simple.exitCode).toBe(0);
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
    expect(verbose.stdout).toContain("Workspace mode: standalone");
    expect(verbose.stdout).toContain("HEAD:");
    expect(verbose.stdout).toContain("Branch:");
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

    const result = await arashi(root, ["remove", "protected"], { HOME: home });

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
      `#!/bin/sh\nprintf '%s\\n' "$ARASHI_WORKSPACE_MODE:$ARASHI_REPO_NAME:$ARASHI_BRANCH_NAME" > '${record}'\nexit 23\n`,
    );
    await chmod(join(hookDirectory, "post-remove.sh"), 0o755);

    const result = await arashi(root, ["remove", "partial-remove", "--json"], { HOME: home });

    expect(result.exitCode).not.toBe(0);
    expect(await readFile(record, "utf8")).toContain("standalone");
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "STANDALONE_REMOVE_PARTIAL_FAILURE",
      details: {
        finalState: { branchExists: true, worktreeExists: true },
        hookFailures: expect.arrayContaining([
          expect.objectContaining({ hookName: "post-remove" }),
        ]),
        operationFailures: expect.arrayContaining([
          expect.objectContaining({ operation: "remove-worktree" }),
        ]),
      },
    });
    await expect(access(linked)).resolves.toBeUndefined();
  });
});
