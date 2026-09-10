import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  captureRuntimeDeletionIdentities,
  discoverDeleteHookPaths,
} from "../../src/commands/delete.ts";
import { inspectGitWorktreeTopology } from "../../src/lib/delete-topology.ts";
import {
  createDeleteResumeReceipt,
  type DeleteResumeReceipt,
  type DeleteTerminalResidue,
} from "../../src/lib/delete-transaction.ts";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
const roots: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "delete@example.test",
  GIT_AUTHOR_NAME: "Delete Test",
  GIT_COMMITTER_EMAIL: "delete@example.test",
  GIT_COMMITTER_NAME: "Delete Test",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgSign",
  GIT_CONFIG_VALUE_0: "false",
  NO_COLOR: "1",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "arashi-delete-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const seed = join(root, "seed");
  const remote = join(root, "api.git");
  mkdirSync(workspace);
  mkdirSync(seed);
  git(workspace, "init", "--initial-branch=main");
  writeFileSync(join(workspace, "README.md"), "workspace\n");
  git(workspace, "add", "README.md");
  git(workspace, "commit", "-m", "workspace");
  git(seed, "init", "--initial-branch=main");
  writeFileSync(join(seed, "README.md"), "api\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-m", "api");
  git(root, "init", "--bare", remote);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  mkdirSync(join(workspace, "repos"));
  git(workspace, "clone", remote, join(workspace, "repos", "api"));
  mkdirSync(join(workspace, ".arashi", "hooks"), { recursive: true });
  const configPath = join(workspace, ".arashi", "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        version: "1.0.0",
        reposDir: "repos",
        worktreesDir: ".arashi/worktrees",
        repos: {
          zeta: { path: "repos/zeta", gitUrl: "https://example.invalid/zeta.git" },
          api: { path: "repos/api", gitUrl: remote, groups: ["backend"] },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(workspace, ".arashi", "hooks", "pre-create.api.sh"), "SECRET_HOOK\n");
  writeFileSync(join(workspace, ".arashi", "hooks", "pre-create.sh"), "shared\n");
  return { configPath, remote, workspace };
};

const bareParentFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "arashi-delete-bare-parent-"));
  roots.push(root);
  const parentSource = join(root, "parent-source");
  const parentCommon = join(root, "parent.git");
  const executionRoot = join(root, "parent-linked");
  const childSeed = join(root, "child-seed");
  const childRemote = join(root, "child.git");
  mkdirSync(parentSource);
  git(parentSource, "init", "--initial-branch=main");
  writeFileSync(join(parentSource, "README.md"), "parent\n");
  git(parentSource, "add", "README.md");
  git(parentSource, "commit", "-m", "parent");
  git(root, "clone", "--bare", parentSource, parentCommon);
  git(parentCommon, "worktree", "add", executionRoot, "main");

  mkdirSync(childSeed);
  git(childSeed, "init", "--initial-branch=main");
  writeFileSync(join(childSeed, "README.md"), "child\n");
  git(childSeed, "add", "README.md");
  git(childSeed, "commit", "-m", "child");
  git(root, "init", "--bare", childRemote);
  git(childSeed, "remote", "add", "origin", childRemote);
  git(childSeed, "push", "-u", "origin", "main");
  git(childRemote, "symbolic-ref", "HEAD", "refs/heads/main");
  mkdirSync(join(executionRoot, "repos"));
  git(executionRoot, "clone", childRemote, join(executionRoot, "repos", "api"));

  const configPath = join(parentCommon, ".arashi", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        version: "1.0.0",
        reposDir: "repos",
        worktreesDir: ".arashi/worktrees",
        repos: { api: { path: "repos/api", gitUrl: childRemote } },
      },
      null,
      2,
    )}\n`,
  );
  return { childRemote, configPath, executionRoot, parentCommon, root };
};

const run = (cwd: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...gitEnv, ...envOverrides },
    encoding: "utf8",
    timeout: 15_000,
  });

const waitForPath = async (path: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const killProcessGroup = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.pid === undefined) throw new Error("Delete child has no process identifier");
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  process.kill(-child.pid, "SIGKILL");
  await exited;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("spawned configured repository delete", () => {
  test("omitted JSON target returns one selection-required document", () => {
    const { workspace } = fixture();
    const result = run(workspace, ["delete", "--json", "--force"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      command: "delete",
      schemaVersion: 1,
      error: {
        code: "DELETE_SELECTION_REQUIRED",
        details: { command: "delete", reason: "repository-required" },
        message: expect.any(String),
      },
      warnings: [],
    });
  });

  test("an existing malformed receipt fails closed before live repository planning", () => {
    const { workspace } = fixture();
    const receipts = join(workspace, ".git", ".arashi-delete-receipts");
    mkdirSync(receipts, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update("api", "utf8").digest("hex");
    writeFileSync(join(receipts, `${name}.json`), '{"version":1,"surprise":true}\n', {
      mode: 0o600,
    });

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    const error = JSON.parse(result.stdout).error;
    expect(error.code).toBe("DELETE_RECEIPT_INVALID");
    expect(Object.keys(error.details)).toEqual([
      "workspace",
      "repositoryKey",
      "dryRun",
      "force",
      "confirmation",
      "plan",
      "result",
    ]);
    expect(error.details).toMatchObject({ repositoryKey: "api", plan: null, result: null });
    expect(existsSync(join(workspace, "repos", "api"))).toBe(true);
  });

  test("finds the parent workspace receipt when invoked from the configured child", () => {
    const { workspace } = fixture();
    const receipts = join(workspace, ".git", ".arashi-delete-receipts");
    mkdirSync(receipts, { recursive: true, mode: 0o700 });
    const name = createHash("sha256").update("api", "utf8").digest("hex");
    writeFileSync(join(receipts, `${name}.json`), '{"version":1,"surprise":true}\n', {
      mode: 0o600,
    });

    const result = run(join(workspace, "repos", "api"), ["delete", "api", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_RECEIPT_INVALID");
  });

  test("JSON dry-run is deterministic, closed, and mutation-free", () => {
    const { configPath, workspace } = fixture();
    const before = readFileSync(configPath);
    const first = run(workspace, ["delete", "api", "--dry-run", "--json"]);
    const second = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const data = JSON.parse(first.stdout).data;
    const secondData = JSON.parse(second.stdout).data;
    expect(Object.keys(data)).toEqual([
      "workspace",
      "repositoryKey",
      "dryRun",
      "force",
      "confirmation",
      "plan",
      "result",
    ]);
    expect(Object.keys(data.workspace)).toEqual([
      "mode",
      "repositoriesBase",
      "workspaceRoot",
      "worktreesBase",
    ]);
    expect(data).toMatchObject({
      repositoryKey: "api",
      dryRun: true,
      force: false,
      confirmation: "not-required",
      result: null,
    });
    expect(secondData.plan).toEqual(data.plan);
    expect(first.stdout).not.toContain("SECRET_HOOK");
    expect(readFileSync(configPath)).toEqual(before);
    expect(existsSync(join(workspace, "repos", "api"))).toBe(true);
    expect(existsSync(join(workspace, ".git", ".arashi-add.transaction.lock"))).toBe(false);
  });

  test("removes a live worktree without pruning separately planned stale metadata early", () => {
    const { workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "live", "repos", "api");
    const stale = join(workspace, ".arashi", "worktrees", "stale", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    mkdirSync(dirname(stale), { recursive: true });
    git(clone, "worktree", "add", linked, "-b", "live");
    git(clone, "worktree", "add", stale, "-b", "stale");
    rmSync(stale, { recursive: true });

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(clone)).toBe(false);
  });

  test("does not delegate prepared checkout deletion to pathname-based git worktree remove", () => {
    const { workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "retry", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    git(clone, "worktree", "add", linked, "-b", "retry");
    writeFileSync(join(linked, "caller"), "authorized loss\n");
    const wrapperDirectory = join(dirname(workspace), "git-wrapper");
    mkdirSync(wrapperDirectory);
    const wrapper = join(wrapperDirectory, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *" worktree remove "*) echo injected-worktree-remove-failure >&2; exit 1;; esac\nexec ${JSON.stringify(execFileSync("which", ["git"], { encoding: "utf8" }).trim())} "$@"\n`,
      { mode: 0o755 },
    );

    const result = run(workspace, ["delete", "api", "--force", "--json"], {
      PATH: `${wrapperDirectory}:${process.env.PATH}`,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(clone)).toBe(false);
  });

  test("resumes after process loss exactly after linked quarantine and before prepare", async () => {
    const { workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "repair-gap", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    git(clone, "worktree", "add", linked, "-b", "repair-gap");
    writeFileSync(join(linked, "caller"), "authorized loss\n");
    const ready = join(dirname(workspace), "repair-pause-ready");
    const resume = join(dirname(workspace), "repair-pause-resume");
    const child = spawn(process.execPath, [cli, "delete", "api", "--force", "--json"], {
      cwd: workspace,
      detached: true,
      env: {
        ...gitEnv,
        ARASHI_DELETE_TEST_PAUSE: "linked-after-quarantine",
        ARASHI_DELETE_TEST_READY: ready,
        ARASHI_DELETE_TEST_RESUME: resume,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });
    await waitForPath(ready);
    const receiptPath = join(
      workspace,
      ".git",
      ".arashi-delete-receipts",
      `${createHash("sha256").update("api", "utf8").digest("hex")}.json`,
    );
    const interruptedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const quarantine = interruptedReceipt.runtime.worktreeQuarantines[0].quarantinePath as string;
    expect(interruptedReceipt.runtime.destructionPreparedItemIds).toEqual([]);
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(quarantine)).toBe(true);
    const registered = git(clone, "worktree", "list", "--porcelain");
    expect(registered).toContain("branch refs/heads/repair-gap");
    expect(registered).toContain("prunable gitdir file points to non-existent location");
    expect(registered).not.toContain(`worktree ${quarantine}`);
    await killProcessGroup(child);

    const resumed = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(existsSync(quarantine)).toBe(true);
    expect(existsSync(clone)).toBe(false);
  });

  test("resumes two linked worktrees after the first completion receipt is durable", async () => {
    const { workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linkedA = join(workspace, ".arashi", "worktrees", "partial-a", "repos", "api");
    const linkedB = join(workspace, ".arashi", "worktrees", "partial-b", "repos", "api");
    mkdirSync(dirname(linkedA), { recursive: true });
    mkdirSync(dirname(linkedB), { recursive: true });
    git(clone, "worktree", "add", linkedA, "-b", "partial-a");
    git(clone, "worktree", "add", linkedB, "-b", "partial-b");
    const canonicalLinkedA = realpathSync(linkedA);
    const canonicalLinkedB = realpathSync(linkedB);
    writeFileSync(join(linkedA, "caller"), "authorized loss a\n");
    writeFileSync(join(linkedB, "caller"), "authorized loss b\n");
    const ready = join(dirname(workspace), "linked-after-completion-ready");
    const resume = join(dirname(workspace), "linked-after-completion-resume");
    const child = spawn(process.execPath, [cli, "delete", "api", "--force", "--json"], {
      cwd: workspace,
      detached: true,
      env: {
        ...gitEnv,
        ARASHI_DELETE_TEST_PAUSE: "linked-after-completion",
        ARASHI_DELETE_TEST_READY: ready,
        ARASHI_DELETE_TEST_RESUME: resume,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });
    await waitForPath(ready);
    const receiptPath = join(
      workspace,
      ".git",
      ".arashi-delete-receipts",
      `${createHash("sha256").update("api", "utf8").digest("hex")}.json`,
    );
    const interruptedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const linkedItems = interruptedReceipt.identities.filter(
      ({ kind }: { kind: string }) => kind === "linked-worktree",
    );
    expect(linkedItems.map(({ path }: { path: string }) => path)).toEqual([
      canonicalLinkedA,
      canonicalLinkedB,
    ]);
    expect(interruptedReceipt.completedItemIds).toContain(linkedItems[0].id);
    expect(interruptedReceipt.completedItemIds).not.toContain(linkedItems[1].id);
    const quarantineA = interruptedReceipt.runtime.worktreeQuarantines.find(
      ({ path }: { path: string }) => path === canonicalLinkedA,
    ).quarantinePath as string;
    expect(existsSync(linkedA)).toBe(false);
    expect(existsSync(quarantineA)).toBe(true);
    expect(existsSync(linkedB)).toBe(true);
    const registered = git(clone, "worktree", "list", "--porcelain");
    expect(registered).toContain(`worktree ${canonicalLinkedA}`);
    expect(registered).toContain("prunable gitdir file points to non-existent location");
    expect(registered).toContain(`worktree ${canonicalLinkedB}`);
    await killProcessGroup(child);

    const resumed = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(existsSync(linkedA)).toBe(false);
    expect(existsSync(quarantineA)).toBe(true);
    expect(existsSync(linkedB)).toBe(false);
    expect(existsSync(clone)).toBe(false);
  });

  test.runIf(process.platform !== "win32")(
    "never delegates Git repair across a recreated administration identity",
    () => {
      const { workspace } = fixture();
      const clone = join(workspace, "repos", "api");
      const linked = join(workspace, ".arashi", "worktrees", "admin-swap", "repos", "api");
      mkdirSync(dirname(linked), { recursive: true });
      git(clone, "worktree", "add", linked, "-b", "admin-swap");
      writeFileSync(join(linked, "caller"), "authorized loss\n");
      const admin = readFileSync(join(linked, ".git"), "utf8").trim().slice("gitdir: ".length);
      const wrapperDirectory = join(dirname(workspace), "admin-swap-bin");
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const swapped = join(dirname(workspace), "admin-swapped");
      const mutated = join(dirname(workspace), "foreign-admin-mutated");
      mkdirSync(wrapperDirectory);
      writeFileSync(
        join(wrapperDirectory, "git"),
        `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = repair ] && [ ! -e ${JSON.stringify(swapped)} ]; then\n  mv ${JSON.stringify(admin)} ${JSON.stringify(`${admin}.accepted`)}\n  cp -R ${JSON.stringify(`${admin}.accepted`)} ${JSON.stringify(admin)}\n  : > ${JSON.stringify(swapped)}\n  before=$(cat ${JSON.stringify(join(admin, "gitdir"))})\n  ${JSON.stringify(realGit)} "$@"\n  status=$?\n  after=$(cat ${JSON.stringify(join(admin, "gitdir"))})\n  [ "$before" = "$after" ] || : > ${JSON.stringify(mutated)}\n  exit "$status"\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
        { mode: 0o755 },
      );

      const result = run(workspace, ["delete", "api", "--force", "--json"], {
        PATH: `${wrapperDirectory}:${process.env.PATH}`,
      });

      expect(existsSync(mutated), `${result.stdout}\n${result.stderr}`).toBe(false);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );

  test("resumes prepared retiring linked quarantine through command phase validation", async () => {
    const { workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "retiring-gap", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    git(clone, "worktree", "add", linked, "-b", "retiring-gap");
    writeFileSync(join(linked, "caller"), "authorized loss\n");
    const ready = join(dirname(workspace), "linked-after-prepare-ready");
    const resume = join(dirname(workspace), "linked-after-prepare-resume");
    const child = spawn(process.execPath, [cli, "delete", "api", "--force", "--json"], {
      cwd: workspace,
      detached: true,
      env: {
        ...gitEnv,
        ARASHI_DELETE_TEST_PAUSE: "linked-after-prepare",
        ARASHI_DELETE_TEST_READY: ready,
        ARASHI_DELETE_TEST_RESUME: resume,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });
    await waitForPath(ready);
    const receiptPath = join(
      workspace,
      ".git",
      ".arashi-delete-receipts",
      `${createHash("sha256").update("api", "utf8").digest("hex")}.json`,
    );
    const interruptedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const quarantine = interruptedReceipt.runtime.worktreeQuarantines[0].quarantinePath as string;
    const retiring = `${quarantine}.retiring`;
    expect(interruptedReceipt.runtime.destructionPreparedItemIds).toHaveLength(1);
    renameSync(quarantine, retiring);
    await killProcessGroup(child);
    expect(existsSync(quarantine)).toBe(false);
    expect(existsSync(retiring)).toBe(true);

    const resumed = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(existsSync(retiring)).toBe(true);
    expect(existsSync(clone)).toBe(false);
  });

  test("resumes linked deletion after canonical clone completion before receipt retirement", async () => {
    const { configPath, workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "late-retry", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    git(clone, "worktree", "add", linked, "-b", "late-retry");
    writeFileSync(join(linked, "caller"), "authorized loss\n");
    const admin = readFileSync(join(linked, ".git"), "utf8").trim().slice("gitdir: ".length);
    const ready = join(dirname(workspace), "clone-phase-completed-ready");
    const resume = join(dirname(workspace), "clone-phase-completed-resume");
    const child = spawn(process.execPath, [cli, "delete", "api", "--force", "--json"], {
      cwd: workspace,
      detached: true,
      env: {
        ...gitEnv,
        ARASHI_DELETE_TEST_PAUSE: "clone-phase-completed",
        ARASHI_DELETE_TEST_READY: ready,
        ARASHI_DELETE_TEST_RESUME: resume,
        NODE_ENV: "test",
      },
      stdio: "ignore",
    });
    await waitForPath(ready);
    const receiptPath = join(
      workspace,
      ".git",
      ".arashi-delete-receipts",
      `${createHash("sha256").update("api", "utf8").digest("hex")}.json`,
    );
    const interruptedReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const cloneItemIds = interruptedReceipt.identities
      .filter(({ kind }: { kind: string }) => kind === "canonical-clone" || kind === "local-ref")
      .map(({ id }: { id: string }) => id);
    const linkedItemId = interruptedReceipt.identities.find(
      ({ kind }: { kind: string }) => kind === "linked-worktree",
    ).id;
    expect(interruptedReceipt.completedItemIds).toEqual(
      expect.arrayContaining([linkedItemId, ...cloneItemIds]),
    );
    expect(interruptedReceipt.completedPhases).toContain("canonical-clone");
    expect(JSON.parse(readFileSync(configPath, "utf8")).repos.api).toBeDefined();
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(clone)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    await killProcessGroup(child);

    const resumed = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).repos.api).toBeUndefined();
    expect(existsSync(receiptPath)).toBe(false);
  });

  test("deletes from the persisted legacy repository map selected by normalization", () => {
    const { configPath, workspace } = fixture();
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    persisted.discovered_repos = persisted.repos;
    delete persisted.repos;
    writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status, result.stdout).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).discovered_repos.api).toBeUndefined();
    expect(existsSync(join(workspace, "repos", "api"))).toBe(false);
  });

  test("fails closed when another configured key aliases the selected topology", () => {
    const { configPath, workspace } = fixture();
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    persisted.repos.alias = { ...persisted.repos.api };
    writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "DELETE_TOPOLOGY_INVALID",
      details: { repositoryKey: "api" },
    });
  });

  test("fails closed when another configured key references a linked worktree", () => {
    const { configPath, workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "topic", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    git(clone, "worktree", "add", linked, "-b", "topic");
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    persisted.repos.linkedAlias = { ...persisted.repos.api, path: linked };
    writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_TOPOLOGY_INVALID");
  });

  test("fails closed when another configured path is nested inside the selected deletion root", () => {
    const { configPath, workspace } = fixture();
    const nested = join(workspace, "repos", "api", "nested-configured");
    mkdirSync(nested);
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    persisted.repos.nested = { gitUrl: persisted.repos.api.gitUrl, path: nested };
    writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_TOPOLOGY_INVALID");
    expect(existsSync(join(workspace, "repos", "api"))).toBe(true);
  });

  test("uses local origin identity for a legacy entry without gitUrl", () => {
    const { configPath, workspace } = fixture();
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    delete persisted.repos.api.gitUrl;
    writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status, result.stdout).toBe(0);
  });

  test("repairs a missing gitUrl from the selected clone under a bare-backed parent", () => {
    const { configPath, executionRoot } = bareParentFixture();
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    delete persisted.repos.api.gitUrl;
    writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const result = run(executionRoot, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test("fails closed when the canonical clone uses an external Git common directory", () => {
    const { remote, workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const external = join(workspace, ".arashi", "external-api.git");
    rmSync(clone, { recursive: true, force: true });
    git(workspace, "clone", "--separate-git-dir", external, remote, clone);

    const result = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_TOPOLOGY_INVALID");
  });

  test("rejects a canonical clone that contains the parent workspace", () => {
    const { configPath, remote, workspace } = fixture();
    const root = dirname(workspace);
    git(root, "init", "--initial-branch=main");
    git(root, "remote", "add", "origin", remote);
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    persisted.repos.api.path = "..";
    writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--dry-run", "--json", "--force"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_TOPOLOGY_INVALID");
  });

  test("rejects a deletion root containing the active bare-backed parent worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "arashi-delete-execution-containment-"));
    roots.push(root);
    const childSeed = join(root, "child-seed");
    const childRemote = join(root, "child.git");
    const selectedRoot = join(root, "selected");
    mkdirSync(childSeed);
    git(childSeed, "init", "--initial-branch=main");
    writeFileSync(join(childSeed, "README.md"), "child\n");
    git(childSeed, "add", "README.md");
    git(childSeed, "commit", "-m", "child");
    git(root, "init", "--bare", childRemote);
    git(childSeed, "remote", "add", "origin", childRemote);
    git(childSeed, "push", "-u", "origin", "main");
    git(root, "clone", childRemote, selectedRoot);

    const parentSource = join(root, "parent-source");
    const parentCommon = join(root, "parent.git");
    const executionRoot = join(selectedRoot, "active-parent");
    mkdirSync(parentSource);
    git(parentSource, "init", "--initial-branch=main");
    writeFileSync(join(parentSource, "README.md"), "parent\n");
    git(parentSource, "add", "README.md");
    git(parentSource, "commit", "-m", "parent");
    git(root, "clone", "--bare", parentSource, parentCommon);
    git(parentCommon, "worktree", "add", executionRoot, "main");
    const configPath = join(parentCommon, ".arashi", "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: "1.0.0",
          reposDir: "..",
          worktreesDir: ".arashi/worktrees",
          repos: { api: { path: "..", gitUrl: childRemote } },
        },
        null,
        2,
      )}\n`,
    );

    const result = run(executionRoot, ["delete", "api", "--dry-run", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_TOPOLOGY_INVALID");
    expect(existsSync(selectedRoot)).toBe(true);
  });

  test("fails closed instead of ignoring initialized submodule Git data", () => {
    const { remote, workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    git(clone, "-c", "protocol.file.allow=always", "submodule", "add", remote, "nested");
    git(clone, "commit", "-am", "add initialized submodule");
    git(clone, "push", "origin", "HEAD:main");

    const result = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_GIT_DATA_LOSS");
  });

  test("fails closed when only a linked worktree index contains an initialized submodule", () => {
    const { remote, workspace } = fixture();
    const primary = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "submodule", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    git(primary, "worktree", "add", linked, "-b", "linked-submodule");
    git(linked, "-c", "protocol.file.allow=always", "submodule", "add", remote, "nested");
    expect(git(primary, "ls-files", "--stage")).not.toContain("160000");
    expect(git(linked, "ls-files", "--stage")).toContain("160000");

    const result = run(workspace, ["delete", "api", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_GIT_DATA_LOSS");
  });

  test("clean JSON mutation without force returns the closed delete payload as error details", () => {
    const { workspace } = fixture();
    const result = run(workspace, ["delete", "api", "--json"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout);
    expect(Object.keys(envelope)).toEqual(["command", "error", "ok", "schemaVersion", "warnings"]);
    expect(envelope.error.code).toBe("DELETE_CONFIRMATION_REQUIRED");
    expect(Object.keys(envelope.error.details)).toEqual([
      "workspace",
      "repositoryKey",
      "dryRun",
      "force",
      "confirmation",
      "plan",
      "result",
    ]);
    expect(envelope.error.details).toMatchObject({
      repositoryKey: "api",
      dryRun: false,
      force: false,
      confirmation: "required",
      result: null,
    });
  });

  test("missing exact key returns the closed seven-field delete payload", () => {
    const { workspace } = fixture();
    const result = run(workspace, ["delete", "missing", "--force", "--json"]);

    expect(result.status).toBe(1);
    const error = JSON.parse(result.stdout).error;
    expect(error.code).toBe("DELETE_REPOSITORY_NOT_FOUND");
    expect(Object.keys(error.details)).toEqual([
      "workspace",
      "repositoryKey",
      "dryRun",
      "force",
      "confirmation",
      "plan",
      "result",
    ]);
    expect(error.details).toMatchObject({
      repositoryKey: "missing",
      dryRun: false,
      force: true,
      confirmation: "not-required",
      plan: null,
      result: null,
    });
  });

  test("invalid configured bytes take precedence with DELETE_CONFIG_INVALID", () => {
    const { configPath, workspace } = fixture();
    writeFileSync(configPath, '{"repos":{"api":{"path":"repos/api","secret":"CONFIG_CANARY"}}');

    const result = run(workspace, ["delete", "missing", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const error = JSON.parse(result.stdout).error;
    expect(error.code).toBe("DELETE_CONFIG_INVALID");
    expect(Object.keys(error.details)).toEqual([
      "workspace",
      "repositoryKey",
      "dryRun",
      "force",
      "confirmation",
      "plan",
      "result",
    ]);
    expect(error.details).toEqual({
      workspace: null,
      repositoryKey: "missing",
      dryRun: false,
      force: true,
      confirmation: "not-required",
      plan: null,
      result: null,
    });
    expect(result.stdout).not.toContain("CONFIG_CANARY");
  });

  test("standalone refusal retains canonical CONFIGURED_WORKSPACE_REQUIRED details", () => {
    const root = mkdtempSync(join(tmpdir(), "arashi-delete-standalone-"));
    roots.push(root);
    git(root, "init", "--initial-branch=main");
    mkdirSync(join(root, ".worktrees"));

    const result = run(root, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "CONFIGURED_WORKSPACE_REQUIRED",
      details: { command: "delete", mode: "standalone" },
    });
    expect(Object.keys(JSON.parse(result.stdout).error.details)).toEqual(["command", "mode"]);
  });

  test("forced JSON deletion removes owned state and preserves unrelated state", () => {
    const { configPath, workspace } = fixture();
    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).data;
    expect(data.repositoryKey).toBe("api");
    expect(Object.keys(data.plan)).toEqual(["id", "items", "warnings"]);
    expect(Object.keys(data.result)).toEqual(["items", "phases", "retry", "warnings"]);
    expect(
      data.plan.items.every(
        (entry: object) =>
          Object.keys(entry).join(",") ===
          "id,kind,ownership,path,ref,oid,planned,completed,state,reasonCode,message",
      ),
    ).toBe(true);
    expect(
      data.result.phases.every(
        (phase: object) =>
          Object.keys(phase).join(",") === "name,state,itemIds,error,startedOrder,completedOrder",
      ),
    ).toBe(true);
    expect(Object.keys(data.result.retry)).toEqual(["safe", "argv", "guidance"]);
    expect(
      data.result.phases.every((phase: { state: string }) => phase.state === "completed"),
    ).toBe(true);
    expect(existsSync(join(workspace, "repos", "api"))).toBe(false);
    expect(existsSync(join(workspace, ".arashi", "hooks", "pre-create.api.sh"))).toBe(false);
    expect(existsSync(join(workspace, ".arashi", "hooks", "pre-create.sh"))).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8")).repos).toEqual({
      zeta: { path: "repos/zeta", gitUrl: "https://example.invalid/zeta.git" },
    });
    expect(existsSync(join(workspace, ".git", ".arashi-add.transaction.lock"))).toBe(false);
    const retainedWarnings = data.result.warnings.filter((warning: string) =>
      warning.startsWith("DELETE_RETAINED_CLEANUP: "),
    );
    expect(retainedWarnings).toHaveLength(3);
    for (const warning of retainedWarnings) {
      const [, destination] = warning.split(" -> ");
      expect(existsSync(destination), warning).toBe(true);
    }
    expect(retainedWarnings.some((warning: string) => warning.includes("/repos/api -> "))).toBe(
      true,
    );
    expect(
      retainedWarnings.some((warning: string) => warning.includes("/pre-create.api.sh -> ")),
    ).toBe(true);
    const retainedReceiptPath = retainedWarnings
      .find((warning: string) => warning.includes(".arashi-delete-receipts/"))!
      .split(" -> ")[1]!;
    const retainedReceipt = JSON.parse(readFileSync(retainedReceiptPath, "utf8"));
    expect(retainedReceipt.warnings).toEqual(data.plan.warnings);
    expect(retainedReceipt.terminalResidues).toHaveLength(2);
    expect(retainedReceipt.terminalResidues).toEqual(
      retainedReceipt.terminalResidues.toSorted(
        (left: DeleteTerminalResidue, right: DeleteTerminalResidue) =>
          Buffer.compare(
            Buffer.from(`${left.itemId}\0${left.source}\0${left.destination}`),
            Buffer.from(`${right.itemId}\0${right.source}\0${right.destination}`),
          ),
      ),
    );
    for (const residue of retainedReceipt.terminalResidues)
      expect(existsSync(residue.destination), JSON.stringify(residue)).toBe(true);
    expect(result.stdout).not.toContain("SECRET_HOOK");
  });

  test("a completed retained generation does not block deleting a re-added repository", () => {
    const { configPath, remote, workspace } = fixture();
    const first = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const firstWarnings = JSON.parse(first.stdout).data.result.warnings as string[];
    const firstCloneResidue = firstWarnings
      .find((warning) => warning.includes("/repos/api -> "))!
      .split(" -> ")[1]!;

    git(workspace, "clone", remote, join(workspace, "repos", "api"));
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.repos.api = { path: "repos/api", gitUrl: remote, groups: ["backend"] };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const second = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    const secondWarnings = JSON.parse(second.stdout).data.result.warnings as string[];
    const secondCloneResidue = secondWarnings
      .find((warning) => warning.includes("/repos/api -> "))!
      .split(" -> ")[1]!;
    expect(secondCloneResidue).not.toBe(firstCloneResidue);
    expect(existsSync(firstCloneResidue)).toBe(true);
    expect(existsSync(secondCloneResidue)).toBe(true);
  });

  test("deletes exact active repository hooks and their concrete templates only", () => {
    const { workspace } = fixture();
    const hooks = join(workspace, ".arashi", "hooks");
    const inactive = join(hooks, "pre-create.api.bash");
    const example = join(hooks, "pre-create.api.sh.example");
    const removeHook = join(hooks, "pre-remove.api.sh");
    const removeExample = join(hooks, "post-remove.api.sh.example");
    const generic = join(hooks, "pre-create.<repo>.sh.example");
    writeFileSync(inactive, "inactive\n");
    writeFileSync(example, "example\n");
    writeFileSync(removeHook, "remove\n");
    writeFileSync(removeExample, "remove example\n");
    writeFileSync(generic, "generic\n");

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(hooks, "pre-create.api.sh"))).toBe(false);
    expect(existsSync(inactive)).toBe(true);
    expect(existsSync(example)).toBe(false);
    expect(existsSync(removeHook)).toBe(false);
    expect(existsSync(removeExample)).toBe(false);
    expect(existsSync(generic)).toBe(true);
  });

  test("rejects repository inline and native file hook ambiguity", () => {
    const { configPath, workspace } = fixture();
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    parsed.repos.api.hooks = { "pre-create": "echo inline" };
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: "DELETE_HOOK_AMBIGUOUS" });
    expect(existsSync(join(workspace, "repos", "api"))).toBe(true);
  });

  test("rejects repository inline and compatible child-local remove hook ambiguity", () => {
    const { configPath, workspace } = fixture();
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    parsed.repos.api.hooks = { "pre-remove": "echo inline" };
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    const configBefore = readFileSync(configPath);
    const childLocalHook = join(workspace, "repos", "api", ".arashi", "hooks", "pre-remove.sh");
    mkdirSync(dirname(childLocalHook), { recursive: true });
    writeFileSync(childLocalHook, "echo compatible\n");

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: "DELETE_HOOK_AMBIGUOUS" });
    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(existsSync(join(workspace, "repos", "api"))).toBe(true);
    expect(readFileSync(childLocalHook, "utf8")).toBe("echo compatible\n");
  });

  test("rejects canonical and compatible remove hooks before mutation", () => {
    const { configPath, workspace } = fixture();
    const configBefore = readFileSync(configPath);
    const canonicalHook = join(workspace, ".arashi", "hooks", "post-remove.api.sh");
    const compatibleHook = join(workspace, "repos", "api", ".arashi", "hooks", "post-remove.sh");
    writeFileSync(canonicalHook, "echo canonical\n");
    mkdirSync(dirname(compatibleHook), { recursive: true });
    writeFileSync(compatibleHook, "echo compatible\n");

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: "DELETE_HOOK_AMBIGUOUS" });
    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(existsSync(join(workspace, "repos", "api"))).toBe(true);
    expect(readFileSync(canonicalHook, "utf8")).toBe("echo canonical\n");
    expect(readFileSync(compatibleHook, "utf8")).toBe("echo compatible\n");
  });

  test("rejects all simulated-Windows canonical and compatible remove hook extensions", async () => {
    const { configPath, workspace } = fixture();
    const configBefore = readFileSync(configPath);
    const clone = join(workspace, "repos", "api");
    const canonicalDirectory = join(workspace, ".arashi", "hooks");
    const compatibleDirectory = join(clone, ".arashi", "hooks");
    mkdirSync(compatibleDirectory, { recursive: true });
    const candidates = [
      ...["ps1", "cmd", "bat"].map((extension) =>
        join(canonicalDirectory, `pre-remove.api.${extension}`),
      ),
      ...["ps1", "cmd", "bat"].map((extension) =>
        join(compatibleDirectory, `pre-remove.${extension}`),
      ),
    ];
    for (const candidate of candidates) writeFileSync(candidate, `echo ${candidate}\n`);

    await expect(
      discoverDeleteHookPaths(workspace, "api", undefined, clone, "win32"),
    ).rejects.toMatchObject({ code: "DELETE_HOOK_AMBIGUOUS" });

    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(existsSync(clone)).toBe(true);
    for (const candidate of candidates) expect(existsSync(candidate)).toBe(true);
  });

  test("plans global repository hooks as preserved-global-hook", () => {
    const { workspace } = fixture();
    const home = join(dirname(workspace), "home");
    const globalHook = join(home, ".arashi", "hooks", "api", "pre-create.sh");
    mkdirSync(dirname(globalHook), { recursive: true });
    writeFileSync(globalHook, "global\n");

    const result = run(workspace, ["delete", "api", "--force", "--json"], { HOME: home });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).data.plan.items).toContainEqual(
      expect.objectContaining({
        kind: "preserved-global-hook",
        ownership: "preserve",
        path: globalHook,
        state: "preserved",
      }),
    );
    expect(JSON.parse(result.stdout).data.result.items).toContainEqual(
      expect.objectContaining({
        kind: "preserved-global-hook",
        completed: false,
        state: "preserved",
      }),
    );
    expect(existsSync(globalHook)).toBe(true);
  });

  test("revalidates compatible remove hook ambiguity from a resume receipt before mutation", async () => {
    const { configPath, workspace } = fixture();
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    parsed.repos.api.hooks = { "pre-remove": "echo inline" };
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    const before = readFileSync(configPath);
    const dryRun = run(workspace, ["delete", "api", "--dry-run", "--json"]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const dryData = JSON.parse(dryRun.stdout).data;
    const plan = dryData.plan;
    const workspaceRoot = dryData.workspace.workspaceRoot as string;
    const canonicalConfigPath = join(workspaceRoot, ".arashi", "config.json");
    const topology = await inspectGitWorktreeTopology(join(workspaceRoot, "repos", "api"));
    const hookPaths = [join(workspaceRoot, ".arashi", "hooks", "pre-create.api.sh")];
    const identities = await captureRuntimeDeletionIdentities(topology, hookPaths);
    const nextConfig = JSON.parse(before.toString("utf8"));
    const originalEntry = nextConfig.repos.api;
    delete nextConfig.repos.api;
    const expectedAfter = Buffer.from(`${JSON.stringify(nextConfig, null, 2)}\n`);
    const receiptPath = plan.items.find(({ kind }: { kind: string }) => kind === "resume-receipt")
      .path as string;
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await createDeleteResumeReceipt(receiptPath, {
      version: 2,
      planId: plan.id,
      parentIdentity: hash({ commonDirectory: realpathSync(join(workspace, ".git")) }),
      repositoryKey: "api",
      configDigest: createHash("sha256").update(before).digest("hex"),
      originalEntryDigest: hash(originalEntry),
      identities: plan.items.map(({ id, kind, path, ref, oid }: Record<string, string | null>) => ({
        id: id!,
        kind: kind!,
        path,
        ref,
        oid,
      })),
      completedItemIds: [],
      completedPhases: [],
      remainingPhases: [
        "provenance",
        "worktrees",
        "metadata",
        "canonical-clone",
        "workspace-hooks",
        "configuration",
        "verification",
      ],
      retryArgv: ["aw", "delete", "api", "--force", "--json"],
      warnings: plan.warnings,
      runtime: {
        workspaceRoot,
        configPath: canonicalConfigPath,
        clonePath: topology.canonicalClonePath,
        hookPaths,
        expectedConfigBase64: before.toString("base64"),
        nextConfigBase64: expectedAfter.toString("base64"),
        topology,
        identities,
      },
    });
    const compatibleHook = join(topology.configuredActivePath, ".arashi", "hooks", "pre-remove.sh");
    mkdirSync(dirname(compatibleHook), { recursive: true });
    writeFileSync(compatibleHook, "echo compatible\n");

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: "DELETE_HOOK_AMBIGUOUS" });
    expect(readFileSync(configPath)).toEqual(before);
    expect(existsSync(topology.canonicalClonePath)).toBe(true);
    expect(readFileSync(compatibleHook, "utf8")).toBe("echo compatible\n");
  });

  test("preserves a recreated worktree while adopting its exact unprepared quarantine on retry", async () => {
    const { configPath, workspace } = fixture();
    const clone = join(workspace, "repos", "api");
    const linked = join(workspace, ".arashi", "worktrees", "gap", "repos", "api");
    mkdirSync(dirname(linked), { recursive: true });
    git(clone, "worktree", "add", linked, "-b", "gap");
    const dryRun = run(workspace, ["delete", "api", "--dry-run", "--json"]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const dryData = JSON.parse(dryRun.stdout).data;
    const plan = dryData.plan;
    const workspaceRoot = dryData.workspace.workspaceRoot as string;
    const topology = await inspectGitWorktreeTopology(join(workspaceRoot, "repos", "api"));
    const canonicalLinked = topology.linkedWorktrees[0]!.path;
    const hookPaths = [join(workspaceRoot, ".arashi", "hooks", "pre-create.api.sh")];
    const identities = await captureRuntimeDeletionIdentities(topology, hookPaths);
    const before = readFileSync(configPath);
    const parsedBefore = JSON.parse(before.toString("utf8"));
    const originalEntry = parsedBefore.repos.api;
    delete parsedBefore.repos.api;
    const expectedAfter = Buffer.from(`${JSON.stringify(parsedBefore, null, 2)}\n`);
    const receiptPath = plan.items.find(({ kind }: { kind: string }) => kind === "resume-receipt")
      .path as string;
    const parentCommon = realpathSync(join(workspace, ".git"));
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const initialReceipt: DeleteResumeReceipt = {
      version: 2,
      planId: plan.id,
      parentIdentity: hash({ commonDirectory: parentCommon }),
      repositoryKey: "api",
      configDigest: createHash("sha256").update(before).digest("hex"),
      originalEntryDigest: hash(originalEntry),
      identities: plan.items.map(({ id, kind, path, ref, oid }: Record<string, string | null>) => ({
        id: id!,
        kind: kind!,
        path,
        ref,
        oid,
      })),
      completedItemIds: [
        plan.items.find(({ kind }: { kind: string }) => kind === "resume-receipt").id,
      ],
      completedPhases: ["provenance"],
      remainingPhases: [
        "worktrees",
        "metadata",
        "canonical-clone",
        "workspace-hooks",
        "configuration",
        "verification",
      ],
      retryArgv: ["aw", "delete", "api", "--force", "--json"],
      warnings: plan.warnings,
      runtime: {
        workspaceRoot,
        configPath: join(workspaceRoot, ".arashi", "config.json"),
        clonePath: topology.canonicalClonePath,
        hookPaths,
        expectedConfigBase64: before.toString("base64"),
        nextConfigBase64: expectedAfter.toString("base64"),
        topology,
        identities,
      },
    };
    await createDeleteResumeReceipt(receiptPath, initialReceipt);
    const suffix = createHash("sha256")
      .update(`arashi-delete-quarantine-v1\0${plan.id}`)
      .digest("hex");
    const quarantine = join(
      dirname(canonicalLinked),
      `.arashi-delete-worktree-${createHash("sha256").update(canonicalLinked, "utf8").digest("hex")}-${suffix}`,
    );
    renameSync(canonicalLinked, quarantine);
    mkdirSync(canonicalLinked);
    writeFileSync(join(canonicalLinked, "REPLACEMENT"), "replacement\n");

    const deleted = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(deleted.status, `${deleted.stdout}\n${deleted.stderr}`).toBe(1);
    expect(JSON.parse(deleted.stdout).error).toMatchObject({ code: "DELETE_CONCURRENT_CHANGE" });
    expect(readFileSync(join(canonicalLinked, "REPLACEMENT"), "utf8")).toBe("replacement\n");
    expect(existsSync(quarantine)).toBe(true);
    expect(readFileSync(configPath)).toEqual(before);
    expect(existsSync(topology.canonicalClonePath)).toBe(true);
    expect(existsSync(receiptPath)).toBe(true);
    rmSync(canonicalLinked, { recursive: true });
    const resumed = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(existsSync(quarantine)).toBe(true);
  });

  test("forced deletion treats a configured linked path as active, not as the canonical clone", () => {
    const { configPath, workspace } = fixture();
    const physicalWorkspace = realpathSync(workspace);
    const primary = join(physicalWorkspace, "repos", "api");
    const configuredActive = join(
      physicalWorkspace,
      ".arashi",
      "worktrees",
      "topic",
      "repos",
      "api",
    );
    mkdirSync(dirname(configuredActive), { recursive: true });
    git(primary, "worktree", "add", configuredActive, "-b", "topic");
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    parsed.repos.api.path = configuredActive;
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(configuredActive)).toBe(false);
    expect(existsSync(primary)).toBe(false);
  });

  test("refuses a configured clone reached through a symbolic-link target", () => {
    const { configPath, workspace } = fixture();
    const configuredPath = join(workspace, "repos", "api");
    const actualPath = join(dirname(workspace), "external-api");
    rmSync(configuredPath, { recursive: true });
    mkdirSync(actualPath);
    writeFileSync(join(actualPath, "KEEP"), "keep\n");
    symlinkSync(actualPath, configuredPath, "dir");
    const before = readFileSync(configPath);

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_PATH_UNSAFE");
    const details = JSON.parse(result.stdout).error.details;
    expect(Object.keys(details)).toEqual([
      "workspace",
      "repositoryKey",
      "dryRun",
      "force",
      "confirmation",
      "plan",
      "result",
    ]);
    expect(details).toMatchObject({ repositoryKey: "api", plan: null, result: null });
    expect(readFileSync(configPath)).toEqual(before);
    expect(readFileSync(join(actualPath, "KEEP"), "utf8")).toBe("keep\n");
  });

  test("refuses Git data loss before confirmation", () => {
    const { configPath, workspace } = fixture();
    writeFileSync(join(workspace, "repos", "api", "UNTRACKED_SECRET"), "do not delete\n");
    const before = readFileSync(configPath);

    const result = run(workspace, ["delete", "api", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_GIT_DATA_LOSS");
    expect(readFileSync(configPath)).toEqual(before);
    expect(existsSync(join(workspace, "repos", "api", "UNTRACKED_SECRET"))).toBe(true);
  });

  test("refuses a clone whose fetch URL does not match configuration", () => {
    const { configPath, workspace } = fixture();
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    parsed.repos.api.gitUrl = join(dirname(workspace), "different.git");
    writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    const before = readFileSync(configPath);

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error.code).toBe("DELETE_TOPOLOGY_INVALID");
    expect(readFileSync(configPath)).toEqual(before);
    expect(existsSync(join(workspace, "repos", "api"))).toBe(true);
  });

  test("accepts multiple origin fetch URLs when at least one has matching identity", () => {
    const { workspace } = fixture();
    const primary = join(workspace, "repos", "api");
    git(primary, "config", "--add", "remote.origin.url", "ssh://git@example.test/other.git");

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(primary)).toBe(false);
  });
});
