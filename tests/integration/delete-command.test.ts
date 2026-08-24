import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { captureRuntimeDeletionIdentities } from "../../src/commands/delete.ts";
import { inspectGitWorktreeTopology } from "../../src/lib/delete-topology.ts";
import {
  createDeleteResumeReceipt,
  type DeleteResumeReceipt,
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

const run = (cwd: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...gitEnv, ...envOverrides },
    encoding: "utf8",
    timeout: 15_000,
  });

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
    expect(result.stdout).not.toContain("SECRET_HOOK");
  });

  test("deletes exact active repository hooks and their concrete templates only", () => {
    const { workspace } = fixture();
    const hooks = join(workspace, ".arashi", "hooks");
    const inactive = join(hooks, "pre-create.api.bash");
    const example = join(hooks, "pre-create.api.sh.example");
    const generic = join(hooks, "pre-create.<repo>.sh.example");
    writeFileSync(inactive, "inactive\n");
    writeFileSync(example, "example\n");
    writeFileSync(generic, "generic\n");

    const result = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(hooks, "pre-create.api.sh"))).toBe(false);
    expect(existsSync(inactive)).toBe(true);
    expect(existsSync(example)).toBe(false);
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

  test("a terminal durable receipt resumes after the config entry and clone are gone", async () => {
    const { configPath, workspace } = fixture();
    const dryRun = run(workspace, ["delete", "api", "--dry-run", "--json"]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const dryData = JSON.parse(dryRun.stdout).data;
    const plan = dryData.plan;
    const workspaceRoot = dryData.workspace.workspaceRoot as string;
    const topology = await inspectGitWorktreeTopology(join(workspaceRoot, "repos", "api"));
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
      version: 1,
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

    const deleted = run(workspace, ["delete", "api", "--force", "--json"]);
    expect(deleted.status, deleted.stderr).toBe(0);
    const after = readFileSync(configPath);
    expect(after).toEqual(expectedAfter);
    const receipt: DeleteResumeReceipt = {
      ...initialReceipt,
      completedItemIds: plan.items.map(({ id }: { id: string }) => id),
      completedPhases: [
        "provenance",
        "worktrees",
        "metadata",
        "canonical-clone",
        "workspace-hooks",
        "configuration",
      ],
      remainingPhases: ["verification"],
    };
    await createDeleteResumeReceipt(receiptPath, receipt);

    const resumed = run(workspace, ["delete", "api", "--force", "--json"]);

    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    expect(JSON.parse(resumed.stdout).data.repositoryKey).toBe("api");
    expect(existsSync(receiptPath)).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8")).repos.api).toBeUndefined();
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
