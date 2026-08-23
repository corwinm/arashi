import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { executeInit } from "../../src/commands/init.ts";
import { loadConfig, saveConfig } from "../../src/lib/config.ts";
import { exec as gitExec } from "../../src/lib/git.ts";
import { runtime } from "../helpers/node-runtime.ts";

const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");
const roots: string[] = [];

type BareTopology = "linked" | "committed" | "unborn";

interface BareFixture {
  bareRoot: string;
  linkedRoot?: string;
  nestedRoot: string;
  root: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitExec(args, cwd);
  return result.stdout.trim();
}

async function createBareFixture(topology: BareTopology = "committed"): Promise<BareFixture> {
  const root = await mkdtemp(join(tmpdir(), "arashi-bare-init-"));
  roots.push(root);
  let bareRoot = join(root, "workspace.git");
  await git(root, ["init", "--bare", bareRoot]);
  bareRoot = await git(bareRoot, ["rev-parse", "--absolute-git-dir"]);

  let linkedRoot: string | undefined;
  if (topology !== "unborn") {
    const seedRoot = join(root, "seed");
    await mkdir(seedRoot);
    await git(seedRoot, ["init", "-b", "main"]);
    await git(seedRoot, ["config", "user.name", "Arashi Test"]);
    await git(seedRoot, ["config", "user.email", "test@example.com"]);
    await writeFile(join(seedRoot, "README.md"), "fixture\n");
    await git(seedRoot, ["add", "README.md"]);
    await git(seedRoot, ["commit", "-m", "fixture"]);
    await git(seedRoot, ["remote", "add", "origin", bareRoot]);
    await git(seedRoot, ["push", "origin", "main"]);
    await git(bareRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    if (topology === "linked") {
      linkedRoot = join(root, "linked");
      await git(bareRoot, ["worktree", "add", linkedRoot, "main"]);
    }
  }

  return { bareRoot, linkedRoot, nestedRoot: join(bareRoot, "objects"), root };
}

async function createNonBareRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arashi-nonbare-init-"));
  roots.push(root);
  await git(root, ["init"]);
  return root;
}

async function createPlainDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arashi-bootstrap-init-"));
  roots.push(root);
  return root;
}

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = runtime.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function localPreference(root: string): Promise<string | null> {
  try {
    return (
      await gitExec(["config", "--local", "--get", "arashi.ignoreScope"], root)
    ).stdout.trim();
  } catch {
    return null;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("repository-aware init resolution and defaults", () => {
  test.each(["committed", "unborn"] as const)(
    "canonicalizes nested %s bare invocation and persists the parent default",
    async (topology) => {
      const fixture = await createBareFixture(topology);

      const result = await executeInit(
        { noDiscover: true, quiet: true },
        { cwd: fixture.nestedRoot },
      );

      expect(result).toMatchObject({
        success: true,
        workspaceRoot: fixture.bareRoot,
        worktreesDir: "..",
      });
      expect((await loadConfig(fixture.bareRoot)).worktreesDir).toBe("..");
      expect(existsSync(join(fixture.nestedRoot, ".arashi"))).toBe(false);
    },
  );

  test("retains the non-bare omitted default", async () => {
    const root = await createNonBareRepo();

    const result = await executeInit({ noDiscover: true, quiet: true }, { cwd: root });

    expect(result).toMatchObject({ success: true, worktreesDir: ".arashi/worktrees" });
    expect((await loadConfig(root)).worktreesDir).toBe(".arashi/worktrees");
  });

  test.each([
    ["bare", "./custom-worktrees/", "custom-worktrees"],
    ["non-bare", "./custom-worktrees/", "custom-worktrees"],
  ] as const)(
    "normalizes an explicit override in a %s repository",
    async (type, input, expected) => {
      const root =
        type === "bare" ? (await createBareFixture()).bareRoot : await createNonBareRepo();

      const result = await executeInit(
        { noDiscover: true, quiet: true, worktreesDir: input },
        { cwd: root },
      );

      expect(result).toMatchObject({ success: true, worktreesDir: expected });
      expect((await loadConfig(root)).worktreesDir).toBe(expected);
    },
  );

  test.each([
    ["current directory", "."],
    ["child directory", "child"],
  ] as const)("preserves non-bare %s bootstrap in apply and dry-run", async (_label, target) => {
    const applyParent = await createPlainDirectory();
    const applyRoot = target === "." ? applyParent : join(applyParent, target);
    const apply = await executeInit(
      { noDiscover: true, quiet: true },
      {
        cwd: applyParent,
        promptConfirm: async () => ({ status: "ok", value: true }),
        promptInput: async () => ({ status: "ok", value: target }),
        stdinIsTTY: true,
      },
    );
    expect(apply).toMatchObject({
      success: true,
      workspaceRoot: applyRoot,
      worktreesDir: ".arashi/worktrees",
    });
    expect((await loadConfig(applyRoot)).worktreesDir).toBe(".arashi/worktrees");

    const previewParent = await createPlainDirectory();
    const previewRoot = target === "." ? previewParent : join(previewParent, target);
    const gitCalls: string[][] = [];
    const preview = await executeInit(
      { dryRun: true, noDiscover: true, quiet: true },
      {
        cwd: previewParent,
        gitExec: async (args, cwd) => {
          gitCalls.push(args);
          return await gitExec(args, cwd);
        },
        promptConfirm: async () => ({ status: "ok", value: true }),
        promptInput: async () => ({ status: "ok", value: target }),
        stdinIsTTY: true,
      },
    );
    expect(preview).toMatchObject({
      success: true,
      workspaceRoot: previewRoot,
      worktreesDir: ".arashi/worktrees",
    });
    expect(existsSync(previewRoot)).toBe(target === ".");
    expect(existsSync(join(previewRoot, ".git"))).toBe(false);
    expect(gitCalls).not.toContainEqual(["rev-parse", "--is-bare-repository"]);
  });

  test("fails a classified existing repository without guessing or mutation", async () => {
    const root = await createNonBareRepo();
    const calls: string[][] = [];

    const result = await executeInit(
      { noDiscover: true, quiet: true },
      {
        cwd: root,
        gitExec: async (args, cwd) => {
          calls.push(args);
          if (args.includes("--is-bare-repository")) {
            throw new Error("classification unavailable");
          }
          return await gitExec(args, cwd);
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      resolutionFailure: { code: "INIT_REPOSITORY_CLASSIFICATION_FAILED" },
    });
    expect(existsSync(join(root, ".arashi"))).toBe(false);
    expect(calls.some((args) => args[0] === "check-ignore")).toBe(false);
  });

  test.each([
    ["command failure", "throw"],
    ["empty output", ""],
    ["relative output", "relative.git"],
  ] as const)(
    "fails when absolute bare-directory canonicalization has %s",
    async (_label, output) => {
      const fixture = await createBareFixture("unborn");

      const result = await executeInit(
        { noDiscover: true, quiet: true },
        {
          cwd: fixture.nestedRoot,
          gitExec: async (args, cwd) => {
            if (args.includes("--absolute-git-dir")) {
              if (output === "throw") throw new Error("canonicalization unavailable");
              return { exitCode: 0, stderr: "", stdout: output };
            }
            return await gitExec(args, cwd);
          },
        },
      );

      expect(result).toMatchObject({
        resolutionFailure: { code: "INIT_REPOSITORY_CLASSIFICATION_FAILED" },
        success: false,
        workspaceRoot: fixture.nestedRoot,
      });
      expect(existsSync(join(fixture.bareRoot, ".arashi"))).toBe(false);
    },
  );
});

describe("existing config, force, and preference authority", () => {
  test("linked-worktree preference-only re-init reconciles the configured bare root", async () => {
    const fixture = await createBareFixture("linked");
    const initial = await runCli(fixture.bareRoot, ["init", "--no-discover", "--json"]);
    expect(initial.exitCode, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    const result = await runCli(fixture.linkedRoot!, ["init", "--ignore-scope", "none", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "init",
      data: {
        preferenceOnly: true,
        workspaceRoot: fixture.bareRoot,
        worktreesDir: "..",
      },
      ok: true,
    });
    expect(await localPreference(fixture.bareRoot)).toBe("none");
    expect(existsSync(join(fixture.linkedRoot!, ".arashi"))).toBe(false);
  });

  test("nested coordinated child preference-only re-init reconciles the configured bare root", async () => {
    const fixture = await createBareFixture("linked");
    const initial = await runCli(fixture.bareRoot, ["init", "--no-discover", "--json"]);
    expect(initial.exitCode, `${initial.stdout}\n${initial.stderr}`).toBe(0);

    const childRoot = join(fixture.linkedRoot!, "repos", "child");
    await mkdir(childRoot, { recursive: true });
    await git(childRoot, ["init"]);

    const result = await runCli(childRoot, ["init", "--ignore-scope", "none", "--json"]);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "init",
      data: {
        preferenceOnly: true,
        workspaceRoot: fixture.bareRoot,
        worktreesDir: "..",
      },
      ok: true,
    });
    expect(await localPreference(fixture.bareRoot)).toBe("none");
    expect(existsSync(join(childRoot, ".arashi"))).toBe(false);
  });

  test("ordinary existing config is preserved without repository-aware recalculation", async () => {
    const fixture = await createBareFixture();
    await saveConfig(fixture.bareRoot, {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreesDir: "legacy-location",
    });
    const before = await readFile(join(fixture.bareRoot, ".arashi", "config.json"), "utf8");

    const result = await executeInit(
      { noDiscover: true, quiet: true },
      { cwd: fixture.nestedRoot },
    );

    expect(result).toMatchObject({ success: false, workspaceRoot: fixture.bareRoot });
    expect(await readFile(join(fixture.bareRoot, ".arashi", "config.json"), "utf8")).toBe(before);
  });

  test.each([
    ["configured", "legacy-location"],
    ["legacy omission", ".arashi/worktrees"],
  ] as const)("preference-only init reports %s config authority", async (_label, expected) => {
    const fixture = await createBareFixture();
    const config = {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      ...(expected === "legacy-location" ? { worktreesDir: expected } : {}),
    };
    await mkdir(join(fixture.bareRoot, ".arashi"), { recursive: true });
    await writeFile(join(fixture.bareRoot, ".arashi", "config.json"), JSON.stringify(config));
    const before = await readFile(join(fixture.bareRoot, ".arashi", "config.json"), "utf8");

    const result = await executeInit(
      { ignoreScope: "none", quiet: true },
      { cwd: fixture.nestedRoot },
    );

    expect(result).toMatchObject({
      preferenceOnly: true,
      success: true,
      workspaceRoot: fixture.bareRoot,
      worktreesDir: expected,
    });
    expect(await readFile(join(fixture.bareRoot, ".arashi", "config.json"), "utf8")).toBe(before);
  });

  test.each([
    [undefined, ".."],
    ["./forced-location/", "forced-location"],
  ] as const)("forced bare init persists %s", async (input, expected) => {
    const fixture = await createBareFixture();
    await saveConfig(fixture.bareRoot, {
      repos: {},
      reposDir: "./repos",
      version: "1.0.0",
      worktreesDir: "old-location",
    });

    const result = await executeInit(
      { force: true, noDiscover: true, quiet: true, worktreesDir: input },
      { cwd: fixture.bareRoot },
    );

    expect(result).toMatchObject({ success: true, worktreesDir: expected });
    expect((await loadConfig(fixture.bareRoot)).worktreesDir).toBe(expected);
  });
});

describe("bare non-worktree managed-path policy", () => {
  test.each([
    ["linked", "local"],
    ["linked", "tracked"],
    ["linked", "none"],
    ["committed", "local"],
    ["committed", "tracked"],
    ["committed", "none"],
    ["unborn", "local"],
    ["unborn", "tracked"],
    ["unborn", "none"],
  ] as const)(
    "reports %s bare topology with %s scope without ignore/worktree mutation",
    async (topology, scope) => {
      const fixture = await createBareFixture(topology);
      const excludePath = join(fixture.bareRoot, "info", "exclude");
      const excludeBefore = await readFile(excludePath, "utf8");
      const worktreesBefore = await git(fixture.bareRoot, ["worktree", "list", "--porcelain"]);

      const result = await executeInit(
        { ignoreScope: scope, noDiscover: true, quiet: true },
        { cwd: fixture.nestedRoot },
      );

      expect(result).toMatchObject({
        managedIgnore: {
          scope,
          paths: [
            { input: "./repos", safety: "non-applicable", status: "non-applicable" },
            { input: "..", safety: "unsafe", safetyReason: "parent-traversal", status: "unsafe" },
          ],
        },
        success: true,
        worktreesDir: "..",
      });
      expect(await readFile(excludePath, "utf8")).toBe(excludeBefore);
      expect(existsSync(join(fixture.bareRoot, ".gitignore"))).toBe(false);
      expect(await git(fixture.bareRoot, ["worktree", "list", "--porcelain"])).toBe(
        worktreesBefore,
      );
      if (fixture.linkedRoot) {
        expect(existsSync(join(fixture.linkedRoot, ".gitignore"))).toBe(false);
      }
    },
  );

  test.each(["local", "tracked", "none"] as const)(
    "human and JSON dry-run report bare %s classification without mutation",
    async (scope) => {
      const humanFixture = await createBareFixture("unborn");
      const humanExclude = await readFile(join(humanFixture.bareRoot, "info", "exclude"), "utf8");
      const human = await runCli(humanFixture.nestedRoot, [
        "init",
        "--dry-run",
        "--no-discover",
        "--ignore-scope",
        scope,
      ]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('"worktreesDir": ".."');
      expect(human.stdout).toContain("non-applicable");
      expect(existsSync(join(humanFixture.bareRoot, ".arashi"))).toBe(false);
      expect(await readFile(join(humanFixture.bareRoot, "info", "exclude"), "utf8")).toBe(
        humanExclude,
      );
      expect(await localPreference(humanFixture.bareRoot)).toBeNull();

      const jsonFixture = await createBareFixture("unborn");
      const jsonExclude = await readFile(join(jsonFixture.bareRoot, "info", "exclude"), "utf8");
      const json = await runCli(jsonFixture.nestedRoot, [
        "init",
        "--dry-run",
        "--json",
        "--no-discover",
        "--ignore-scope",
        scope,
      ]);
      const envelope = JSON.parse(json.stdout) as { data: Record<string, unknown>; ok: boolean };
      expect(json.exitCode).toBe(0);
      expect(json.stderr).toBe("");
      expect(envelope).toMatchObject({
        data: {
          managedIgnore: {
            paths: [
              { safety: "non-applicable", status: "non-applicable" },
              { safety: "unsafe", status: "unsafe" },
            ],
            scope,
          },
          workspaceRoot: jsonFixture.bareRoot,
          worktreesDir: "..",
        },
        ok: true,
      });
      expect(existsSync(join(jsonFixture.bareRoot, ".arashi"))).toBe(false);
      expect(await readFile(join(jsonFixture.bareRoot, "info", "exclude"), "utf8")).toBe(
        jsonExclude,
      );
      expect(await localPreference(jsonFixture.bareRoot)).toBeNull();
    },
  );
});

describe("init output and persisted create placement", () => {
  test("human success and JSON success report the authoritative worktree location", async () => {
    const humanFixture = await createBareFixture("unborn");
    const human = await runCli(humanFixture.bareRoot, ["init", "--no-discover"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("Worktrees directory: ..");

    const jsonFixture = await createBareFixture("unborn");
    const json = await runCli(jsonFixture.bareRoot, ["init", "--json", "--no-discover"]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toMatchObject({
      data: { workspaceRoot: jsonFixture.bareRoot, worktreesDir: ".." },
      ok: true,
    });
  });

  test("nested bare init persists sibling placement for feature/example create", async () => {
    const fixture = await createBareFixture("committed");
    const init = await runCli(fixture.nestedRoot, ["init", "--no-discover", "--json"]);
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({
      data: { workspaceRoot: fixture.bareRoot, worktreesDir: ".." },
      ok: true,
    });

    const create = await runCli(fixture.bareRoot, [
      "create",
      "feature/example",
      "--no-hooks",
      "--no-progress",
    ]);
    expect(create.exitCode, `${create.stdout}\n${create.stderr}`).toBe(0);
    const expected = join(
      dirname(fixture.bareRoot),
      `${basename(fixture.bareRoot)}-feature`,
      "example",
    );
    expect(existsSync(expected)).toBe(true);
    expect(existsSync(join(fixture.bareRoot, "feature", "example"))).toBe(false);
    const expectedGitPath = await git(expected, ["rev-parse", "--show-toplevel"]);
    expect(await git(fixture.bareRoot, ["worktree", "list", "--porcelain"])).toContain(
      expectedGitPath,
    );

    const status = await runCli(expected, ["status", "--json"]);
    expect(status.exitCode, `${status.stdout}\n${status.stderr}`).toBe(0);
    const statusEnvelope = JSON.parse(status.stdout) as {
      command: string;
      data: { workspaceRoot: string };
      ok: boolean;
    };
    expect(statusEnvelope).toMatchObject({ command: "status", ok: true });
    expect(resolve(statusEnvelope.data.workspaceRoot)).toBe(resolve(fixture.bareRoot));

    const followUp = await runCli(expected, [
      "create",
      "feature/from-linked",
      "--no-hooks",
      "--no-progress",
    ]);
    expect(followUp.exitCode, `${followUp.stdout}\n${followUp.stderr}`).toBe(0);
    expect(
      existsSync(
        join(dirname(fixture.bareRoot), `${basename(fixture.bareRoot)}-feature`, "from-linked"),
      ),
    ).toBe(true);
  });

  test("bare init persists and create uses an explicit worktree base", async () => {
    const fixture = await createBareFixture("committed");
    const explicitBase = join(fixture.root, "explicit-base");
    const init = await runCli(fixture.bareRoot, [
      "init",
      "--no-discover",
      "--worktrees-dir",
      "../explicit-base",
      "--json",
    ]);
    expect(init.exitCode, init.stderr).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({
      data: { worktreesDir: "../explicit-base" },
      ok: true,
    });

    const create = await runCli(fixture.bareRoot, [
      "create",
      "feature/explicit",
      "--no-hooks",
      "--no-progress",
    ]);
    expect(create.exitCode, `${create.stdout}\n${create.stderr}`).toBe(0);
    expect(
      existsSync(join(explicitBase, `${basename(fixture.bareRoot)}-feature`, "explicit")),
    ).toBe(true);
  });

  test.each([
    ["non-bare omitted default", "non-bare", undefined, ".arashi/worktrees"],
    ["bare explicit override", "bare", "./json-custom/", "json-custom"],
    ["non-bare explicit override", "non-bare", "./json-custom/", "json-custom"],
  ] as const)("CLI JSON reports %s without human output", async (_label, type, input, expected) => {
    const root =
      type === "bare" ? (await createBareFixture("unborn")).bareRoot : await createNonBareRepo();
    const args = ["init", "--json", "--no-discover"];
    if (input !== undefined) args.push("--worktrees-dir", input);

    const result = await runCli(root, args);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "init",
      data: { worktreesDir: expected },
      ok: true,
    });
  });

  test.each([
    ["configured authority", "configured-base"],
    ["legacy authority", undefined],
  ] as const)("CLI JSON preference-only init reports %s", async (_label, configuredValue) => {
    const fixture = await createBareFixture("unborn");
    await mkdir(join(fixture.bareRoot, ".arashi"), { recursive: true });
    await writeFile(
      join(fixture.bareRoot, ".arashi", "config.json"),
      JSON.stringify({
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        ...(configuredValue ? { worktreesDir: configuredValue } : {}),
      }),
    );

    const result = await runCli(fixture.nestedRoot, ["init", "--json", "--ignore-scope", "none"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "init",
      data: {
        preferenceOnly: true,
        worktreesDir: configuredValue ?? ".arashi/worktrees",
      },
      ok: true,
    });
  });

  test("real bare init can add a repository without worktree-only ignore inspection", async () => {
    const fixture = await createBareFixture("unborn");
    const source = await createBareFixture("committed");
    const init = await runCli(fixture.bareRoot, ["init", "--no-discover", "--json"]);
    expect(init.exitCode, init.stderr).toBe(0);

    const add = await runCli(fixture.bareRoot, [
      "add",
      pathToFileURL(source.bareRoot).href,
      "--name",
      "child",
      "--force",
      "--json",
    ]);

    expect(add.exitCode, `${add.stdout}\n${add.stderr}`).toBe(0);
    expect(JSON.parse(add.stdout)).toMatchObject({
      command: "add",
      data: {
        managedIgnore: {
          paths: [
            { input: "./repos", status: "non-applicable" },
            { input: "..", status: "unsafe" },
          ],
        },
      },
      ok: true,
    });
    expect(existsSync(join(fixture.bareRoot, "repos", "child", ".git", "HEAD"))).toBe(true);
  });

  test("real bare init can report status without worktree-only root inspection", async () => {
    const fixture = await createBareFixture("committed");
    const init = await runCli(fixture.bareRoot, ["init", "--no-discover", "--json"]);
    expect(init.exitCode, init.stderr).toBe(0);

    const status = await runCli(fixture.bareRoot, ["status", "--json"]);
    expect(status.exitCode, `${status.stdout}\n${status.stderr}`).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ command: "status", ok: true });
    expect(status.stdout).not.toContain("Main Repository");
    expect(status.stderr).not.toContain("must be run in a work tree");
  });

  test("bare invalid stored scope preserves the managed-ignore JSON error contract", async () => {
    const fixture = await createBareFixture("committed");
    await git(fixture.bareRoot, ["config", "--local", "arashi.ignoreScope", "invalid"]);

    const result = await runCli(fixture.bareRoot, ["init", "--no-discover", "--json"]);
    expect(result.exitCode).toBe(99);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "init",
      error: { code: "MANAGED_IGNORE_RECONCILIATION_FAILED" },
      ok: false,
    });
  });
});

describe("managed-ignore rollback applicability guards", () => {
  test("pre-existing parent alone does not retain a preference change", async () => {
    const root = await createNonBareRepo();
    await writeFile(join(root, ".arashi"), "blocks initialization");

    const result = await executeInit(
      { ignoreScope: "none", noDiscover: true, quiet: true, reposDir: "..", worktreesDir: ".." },
      { cwd: root },
    );

    expect(result.success).toBe(false);
    expect(await localPreference(root)).toBeNull();
    expect(existsSync(resolve(root, ".."))).toBe(true);
  });

  test("bare non-applicable administrative paths do not retain a preference change", async () => {
    const fixture = await createBareFixture("unborn");
    await writeFile(join(fixture.bareRoot, ".arashi"), "blocks initialization");

    const result = await executeInit(
      { ignoreScope: "none", noDiscover: true, quiet: true },
      { cwd: fixture.bareRoot },
    );

    expect(result.success).toBe(false);
    expect(await localPreference(fixture.bareRoot)).toBeNull();
  });

  test("full applicable cleanup restores prior ignore state", async () => {
    const root = await createNonBareRepo();
    await writeFile(join(root, ".arashi"), "blocks initialization");
    const excludePath = join(root, ".git", "info", "exclude");
    const before = await readFile(excludePath, "utf8");

    const result = await executeInit({ noDiscover: true, quiet: true }, { cwd: root });

    expect(result.success).toBe(false);
    expect(await readFile(excludePath, "utf8")).toBe(before);
  });

  test("surviving applicable safe repos state retains coverage", async () => {
    const root = await createNonBareRepo();
    await writeFile(join(root, "repos"), "blocks directory creation");

    const result = await executeInit({ noDiscover: true, quiet: true }, { cwd: root });

    expect(result.success).toBe(false);
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain("/repos/");
  });

  test("restoration failures retain the initialization failure and final observed state", async () => {
    const root = await createNonBareRepo();
    await writeFile(join(root, ".arashi"), "blocks initialization");

    const result = await executeInit(
      { noDiscover: true, quiet: true },
      {
        cwd: root,
        restoreManagedIgnore: async () => {
          throw new Error("restore unavailable");
        },
      },
    );

    expect(result).toMatchObject({
      rollbackFailure: {
        code: "INIT_ROLLBACK_FAILED",
        details: {
          failures: [{ message: "restore unavailable" }],
          finalState: expect.arrayContaining([
            expect.objectContaining({ path: join(root, ".git", "info", "exclude") }),
          ]),
          originalFailure: expect.objectContaining({
            message: expect.stringContaining("EEXIST"),
          }),
        },
      },
      success: false,
    });
  });

  test("bare parent sentinel remains byte-for-byte unchanged after downstream failure", async () => {
    const fixture = await createBareFixture("unborn");
    const sentinelPath = join(fixture.root, "parent-sentinel.bin");
    await writeFile(sentinelPath, Buffer.from([0, 255, 1, 2, 10, 13]));
    const before = await readFile(sentinelPath);
    await writeFile(join(fixture.bareRoot, ".arashi"), "blocks initialization");

    const result = await executeInit(
      { ignoreScope: "none", noDiscover: true, quiet: true },
      { cwd: fixture.bareRoot },
    );

    expect(result.success).toBe(false);
    expect(await readFile(sentinelPath)).toEqual(before);
  });

  test("rollback preserves pre-existing Arashi, hooks, and repos directories", async () => {
    const root = await createNonBareRepo();
    const arashiDir = join(root, ".arashi");
    const hooksDir = join(arashiDir, "hooks");
    const reposDir = join(root, "repos");
    await mkdir(hooksDir, { recursive: true });
    await mkdir(reposDir, { recursive: true });
    await writeFile(join(arashiDir, "sentinel.txt"), "arashi sentinel\n");
    await writeFile(join(hooksDir, "sentinel.txt"), "hooks sentinel\n");
    await writeFile(join(reposDir, "sentinel.txt"), "repos sentinel\n");

    const result = await executeInit(
      { noDiscover: true, quiet: true },
      {
        cwd: root,
        ensureDir: async (path) => {
          if (path === reposDir) throw new Error("injected downstream directory failure");
          await mkdir(path, { recursive: true });
        },
      },
    );

    expect(result.success).toBe(false);
    expect(await readFile(join(arashiDir, "sentinel.txt"), "utf8")).toBe("arashi sentinel\n");
    expect(await readFile(join(hooksDir, "sentinel.txt"), "utf8")).toBe("hooks sentinel\n");
    expect(await readFile(join(reposDir, "sentinel.txt"), "utf8")).toBe("repos sentinel\n");
  });
});
