import { afterEach, describe, expect, test } from "vitest";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import { spawn } from "../helpers/node-runtime.ts";
import {
  bootstrapZeroConfig,
  ZeroConfigBootstrapError,
} from "../../src/lib/zero-config-bootstrap.ts";
import { vi } from "vitest";

const roots: string[] = [];

async function run(cwd: string, args: string[], env?: Record<string, string>) {
  const child = spawn(args, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
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

const arashi = (cwd: string, args: string[], home: string) =>
  run(cwd, [process.execPath, join(import.meta.dirname, "../../src/index.ts"), ...args], {
    HOME: home,
    NO_COLOR: "1",
  });

async function repository(label: string) {
  const container = await mkdtemp(join(tmpdir(), `arashi-user-${label}-`));
  roots.push(container);
  const root = join(container, "repo");
  const home = join(container, "home");
  await mkdir(root);
  await mkdir(home);
  await run(root, ["git", "init", "-b", "main"]);
  await run(root, ["git", "config", "user.email", "test@example.com"]);
  await run(root, ["git", "config", "user.name", "Test User"]);
  await writeFile(join(root, "README.md"), "test\n");
  await run(root, ["git", "add", "."]);
  await run(root, ["git", "commit", "-m", "initial"]);
  return { home, root };
}

async function writeUserConfig(home: string, value: Record<string, unknown>) {
  await mkdir(join(home, ".arashi"), { recursive: true });
  await writeFile(
    join(home, ".arashi", "config.json"),
    JSON.stringify({ version: "1.0.0", ...value }, null, 2),
  );
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("user configuration integration", () => {
  test("standalone bootstrap, linked invocation, naming, and ignore handling share the main root", async () => {
    const { home, root } = await repository("standalone");
    await writeUserConfig(home, {
      worktreeNaming: { branchSlashes: "flatten", style: "repo-branch" },
      worktreesDir: ".personal-trees",
    });

    const initialized = await arashi(root, ["init", "--zero-config", "--json"], home);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout).data.worktreesDirectory.path).toBe(
      join(await realpath(root), ".personal-trees"),
    );
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain(
      ".personal-trees/",
    );
    const doctor = await arashi(root, ["doctor", "--json"], home);
    const findings =
      JSON.parse(doctor.stdout).data?.findings ??
      JSON.parse(doctor.stdout).error?.details?.findings;
    expect(findings).toBeDefined();
    expect(findings.map((finding: { code: string }) => finding.code)).not.toContain(
      "STANDALONE_WORKTREES_NOT_IGNORED",
    );

    const first = await arashi(root, ["create", "feat/one", "--json"], home);
    expect(first.exitCode, first.stderr).toBe(0);
    const firstPath = join(await realpath(root), ".personal-trees", `${basename(root)}-feat-one`);
    expect(JSON.parse(first.stdout).data.worktreePath).toBe(firstPath);

    const second = await arashi(firstPath, ["create", "feat/two", "--json"], home);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).data.worktreePath).toBe(
      join(await realpath(root), ".personal-trees", `${basename(root)}-feat-two`),
    );
    const mainBranch = (await run(root, ["git", "branch", "--show-current"])).stdout.trim();
    for (const args of [
      ["status", "--local", "--json"],
      ["handoff", "--json"],
      ["move", "--from", mainBranch, "--to", "feat/one", "--json"],
    ]) {
      if (args[0] === "move") await writeFile(join(root, "README.md"), "pending move\n");
      const result = await arashi(root, args, home);
      expect(result.exitCode, `${args.join(" ")}: ${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).data.worktreesBase).toBe(
        join(await realpath(root), ".personal-trees"),
      );
    }
  });

  test.each(
    process.platform === "win32"
      ? [".trees[1]", "#trees", "!trees"]
      : [".trees[1]", ".trees*literal", ".trees?literal", "#trees", "!trees"],
  )("standalone bootstrap ignores a literal personal directory (%s)", async (worktreesDir) => {
    const { home, root } = await repository("literal-ignore");
    await writeUserConfig(home, { worktreesDir });
    const initialized = await arashi(root, ["init", "--zero-config", "--json"], home);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const created = await arashi(root, ["create", "literal-branch", "--json"], home);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(
      (
        await run(root, [
          "git",
          "check-ignore",
          "--no-index",
          "-q",
          "--",
          join(root, worktreesDir, "literal-branch"),
        ])
      ).exitCode,
    ).toBe(0);
  });

  test("workspace-owned relative bases stay anchored at the active linked workspace", async () => {
    const { home, root } = await repository("linked-workspace-base");
    await writeUserConfig(home, { worktreesDir: ".personal-trees" });
    await mkdir(join(root, ".arashi"));
    await writeFile(
      join(root, ".arashi", "config.json"),
      JSON.stringify({
        version: "1.0.0",
        reposDir: "repos",
        worktreesDir: ".project-trees",
        repos: {},
      }),
    );
    await run(root, ["git", "add", ".arashi/config.json"]);
    await run(root, ["git", "commit", "-m", "workspace config"]);
    const created = await arashi(root, ["create", "linked-workspace", "--json"], home);
    expect(created.exitCode, created.stdout + created.stderr).toBe(0);
    const linked = JSON.parse(created.stdout).data.repositories[0].worktreePath;
    const expectedBase = join(linked, ".project-trees");
    const inspection = await arashi(linked, ["config", "effective", "--json"], home);
    expect(JSON.parse(inspection.stdout).data.settings.worktreesDir).toEqual({
      source: "workspace",
      value: expectedBase,
    });
    for (const args of [
      ["status", "--local", "--json"],
      ["handoff", "--json"],
      ["prune", "--dry-run", "--json"],
    ]) {
      const result = await arashi(linked, args, home);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data.worktreesBase).toBe(expectedBase);
    }
    const nested = await arashi(linked, ["create", "linked-next", "--json"], home);
    expect(nested.exitCode, nested.stdout + nested.stderr).toBe(0);
    expect(JSON.parse(nested.stdout).data.repositories[0].worktreePath).toBe(
      join(expectedBase, "linked-next"),
    );
  });

  test("effective inspection reports files and supports CLI provenance", async () => {
    const { home, root } = await repository("inspect");
    await writeUserConfig(home, {
      defaults: { create: { launch: "sesh", switch: true }, switch: { mode: "cd" } },
    });
    const result = await arashi(
      root,
      ["config", "effective", "--no-create-switch", "--create-launch", "none", "--json"],
      home,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({
      files: { user: join(home, ".arashi", "config.json"), workspace: null },
      mode: "standalone",
      settings: {
        "defaults.create.launch": { source: "cli", value: "none" },
        "defaults.create.switch": { source: "cli", value: false },
        "defaults.switch.mode": { source: "user", value: "cd" },
        worktreesDir: { source: "built-in" },
        "defaults.editors.vscode.create.switch": { source: "built-in", value: false },
        "defaults.editors.vscode.create.launch": { source: "built-in", value: "none" },
        "defaults.editors.cursor.create.switch": { source: "built-in", value: false },
        "defaults.editors.cursor.create.launch": { source: "built-in", value: "none" },
        "defaults.editors.kiro.create.switch": { source: "built-in", value: false },
        "defaults.editors.kiro.create.launch": { source: "built-in", value: "none" },
      },
    });
    await expect(access(join(root, ".arashi", "config.json"))).rejects.toThrow();
  });

  test("configured create uses a user fallback while workspace fields remain authoritative", async () => {
    const { home, root } = await repository("configured");
    await writeUserConfig(home, {
      defaults: { create: { launch: "none", switch: true } },
      worktreeNaming: { branchSlashes: "flatten" },
      worktreesDir: ".user-trees",
    });
    const initialized = await arashi(root, ["init", "--no-discover", "--json"], home);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const workspacePath = join(root, ".arashi", "config.json");
    const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
    delete workspace.worktreesDir;
    workspace.defaults = { create: { launch: "none", switch: false } };
    await writeFile(workspacePath, JSON.stringify(workspace, null, 2));

    const inspection = await arashi(root, ["config", "effective", "--json"], home);
    expect(inspection.exitCode, inspection.stderr).toBe(0);
    expect(JSON.parse(inspection.stdout).data.settings).toMatchObject({
      "defaults.create.switch": { source: "workspace", value: false },
      "worktreeNaming.branchSlashes": { source: "user", value: "flatten" },
      worktreesDir: { source: "user", value: join(await realpath(root), ".user-trees") },
    });
    for (const args of [
      ["status", "--local", "--json"],
      ["handoff", "--json"],
      ["prune", "--dry-run", "--json"],
    ]) {
      const result = await arashi(root, args, home);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data.worktreesBase).toBe(
        join(await realpath(root), ".user-trees"),
      );
    }

    const created = await arashi(root, ["create", "feat/configured", "--json"], home);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).data.repositories[0].worktreePath).toBe(
      join(await realpath(root), ".user-trees", "feat-configured"),
    );
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain(
      "/.user-trees/",
    );
    const doctor = await arashi(root, ["doctor", "--json"], home);
    const doctorEnvelope = JSON.parse(doctor.stdout);
    const doctorData = doctorEnvelope.data ?? doctorEnvelope.error?.details;
    expect(doctorData.worktreesBase).toBe(join(await realpath(root), ".user-trees"));
    expect(
      doctorData.findings.filter((finding: { code: string }) =>
        finding.code.startsWith("MANAGED_IGNORE_"),
      ),
    ).toEqual([]);
    const persisted = JSON.parse(await readFile(workspacePath, "utf8"));
    expect(persisted.worktreesDir).toBeUndefined();
    expect(persisted.worktreeNaming).toBeUndefined();
  });

  test("keeps existing standalone worktrees discoverable after the preferred directory changes", async () => {
    const { home, root } = await repository("existing");
    expect((await arashi(root, ["init", "--zero-config", "--json"], home)).exitCode).toBe(0);
    const created = await arashi(root, ["create", "legacy", "--json"], home);
    expect(created.exitCode, created.stderr).toBe(0);
    const legacyPath = JSON.parse(created.stdout).data.worktreePath as string;

    await writeUserConfig(home, { worktreesDir: ".personal-trees" });
    const listed = await arashi(legacyPath, ["list", "--json"], home);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(
      await Promise.all(
        (JSON.parse(listed.stdout).data.worktrees as { path: string }[]).map(({ path }) =>
          realpath(path),
        ),
      ),
    ).toContain(await realpath(legacyPath));

    const removed = await arashi(root, ["remove", "legacy", "--force", "--json"], home);
    expect(removed.exitCode, removed.stderr).toBe(0);
    await expect(access(legacyPath)).rejects.toThrow();
  });

  test("legacy migration preserves the omitted workspace directory across repeated invocations", async () => {
    const { home, root } = await repository("migration");
    await writeUserConfig(home, { worktreesDir: ".personal-trees" });
    await mkdir(join(root, ".arashi"));
    const configPath = join(root, ".arashi", "config.json");
    await writeFile(configPath, JSON.stringify({ version: "1", reposDir: "repos", repos: {} }));
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = await arashi(root, ["config", "effective", "--json"], home);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).data.settings.worktreesDir).toEqual({
        source: "user",
        value: join(await realpath(root), ".personal-trees"),
      });
    }
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ version: "1.0.0" });
    expect(JSON.parse(await readFile(configPath, "utf8")).worktreesDir).toBeUndefined();
  });

  test("doctor skips ignore checks for an external personal root", async () => {
    const { home, root } = await repository("external-doctor");
    await writeUserConfig(home, { worktreesDir: join(home, "shared") });
    const before = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    expect((await arashi(root, ["init", "--zero-config", "--json"], home)).exitCode).toBe(0);
    const result = await arashi(root, ["doctor", "--json"], home);
    const envelope = JSON.parse(result.stdout);
    const findings = envelope.data?.findings ?? envelope.error?.details?.findings;
    expect(findings).toBeDefined();
    expect(findings.map((finding: { code: string }) => finding.code)).not.toContain(
      "STANDALONE_WORKTREES_NOT_IGNORED",
    );
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toBe(before);
  });

  test("configured doctor treats an external personal root as non-applicable", async () => {
    const { home, root } = await repository("configured-external-doctor");
    await writeUserConfig(home, { worktreesDir: join(home, "shared") });
    await mkdir(join(root, ".arashi"));
    await writeFile(
      join(root, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0", reposDir: "repos", repos: {} }),
    );
    await run(root, ["git", "config", "--local", "arashi.ignoreScope", "local"]);
    await writeFile(join(root, ".git", "info", "exclude"), "/repos/\n");
    const result = await arashi(root, ["doctor", "--json"], home);
    const envelope = JSON.parse(result.stdout);
    const data = envelope.data ?? envelope.error?.details;
    expect(
      data.findings.filter((finding: { code: string }) =>
        finding.code.startsWith("MANAGED_IGNORE_"),
      ),
    ).toEqual([]);
  });

  test("standalone refuses a worktree base equal to the main checkout before mutation", async () => {
    const { home, root } = await repository("root-base");
    await writeUserConfig(home, { worktreesDir: "." });
    const exclude = join(root, ".git", "info", "exclude");
    const before = await readFile(exclude, "utf8");
    for (const args of [
      ["init", "--zero-config", "--json"],
      ["create", "unsafe-branch", "--json"],
    ]) {
      const result = await arashi(root, args, home);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "must not resolve to the primary repository root",
      );
    }
    expect(await readFile(exclude, "utf8")).toBe(before);
    await expect(access(join(root, "unsafe-branch"))).rejects.toThrow();
    expect((await run(root, ["git", "branch", "--list", "unsafe-branch"])).stdout).toBe("");
  });

  test("configured create refuses a personal base equal to the main checkout", async () => {
    const { home, root } = await repository("configured-root-base");
    await mkdir(join(root, ".arashi"));
    await writeFile(
      join(root, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0", reposDir: "repos", repos: {} }),
    );
    await writeUserConfig(home, { worktreesDir: "." });
    const result = await arashi(root, ["create", "unsafe-branch", "--json"], home);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "must not resolve to the primary repository root",
    );
    await expect(access(join(root, "unsafe-branch"))).rejects.toThrow();
    expect((await run(root, ["git", "branch", "--list", "unsafe-branch"])).stdout).toBe("");
  });

  test("repository mutations preserve omitted workspace settings and personal ignore coverage", async () => {
    const { home, root } = await repository("mutation");
    const child = await repository("mutation-child");
    await mkdir(join(root, ".arashi"));
    const configPath = join(root, ".arashi", "config.json");
    await writeFile(configPath, JSON.stringify({ version: "1.0.0", reposDir: "repos", repos: {} }));
    await writeUserConfig(home, { worktreesDir: ".personal-trees" });
    expect((await arashi(root, ["create", "personal-before-add", "--json"], home)).exitCode).toBe(
      0,
    );
    const added = await arashi(root, ["add", child.root, "--name", "child", "--json"], home);
    expect(added.exitCode, added.stdout + added.stderr).toBe(0);
    expect(JSON.parse(await readFile(configPath, "utf8")).worktreesDir).toBeUndefined();
    // Exercise clone materialization, not its already-present no-op path.
    await rm(join(root, "repos", "child"), { recursive: true, force: true });
    for (const args of [
      ["clone", "--all", "--json"],
      ["pull", "--only", "child", "--json"],
      ["init", "--ignore-scope", "local", "--json"],
    ]) {
      const result = await arashi(root, args, home);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(await readFile(configPath, "utf8")).worktreesDir).toBeUndefined();
      const effective = await arashi(root, ["config", "effective", "--json"], home);
      expect(JSON.parse(effective.stdout).data.settings.worktreesDir.source).toBe("user");
      expect(
        (
          await run(root, [
            "git",
            "check-ignore",
            "--no-index",
            "-q",
            "--",
            ".personal-trees/probe",
          ])
        ).exitCode,
      ).toBe(0);
    }
  });

  test("pull from a linked workspace preserves personal ignore coverage in the primary checkout", async () => {
    const { home, root } = await repository("linked-pull-ignore");
    const child = await repository("linked-pull-child");
    await mkdir(join(root, ".arashi"));
    await writeFile(
      join(root, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0", reposDir: "repos", repos: {} }),
    );
    await writeUserConfig(home, { worktreesDir: ".personal-trees" });
    const added = await arashi(root, ["add", child.root, "--name", "child", "--json"], home);
    expect(added.exitCode, added.stdout + added.stderr).toBe(0);
    await run(root, ["git", "add", ".arashi/config.json"]);
    await run(root, ["git", "commit", "-m", "workspace config"]);
    const created = await arashi(root, ["create", "linked-pull", "--json"], home);
    expect(created.exitCode, created.stdout + created.stderr).toBe(0);
    const linked = JSON.parse(created.stdout).data.repositories[0].worktreePath;
    expect((await run(child.root, ["git", "branch", "linked-pull"])).exitCode).toBe(0);
    const pulled = await arashi(linked, ["pull", "--only", "child", "--json"], home);
    expect(pulled.exitCode, pulled.stdout + pulled.stderr).toBe(0);
    expect(
      (await run(root, ["git", "check-ignore", "--no-index", "-q", "--", ".personal-trees/probe"]))
        .exitCode,
    ).toBe(0);
  });

  test("delete preview reports the effective personal root", async () => {
    const { home, root } = await repository("delete-report");
    const child = await repository("delete-report-child");
    await mkdir(join(root, ".arashi"));
    await writeFile(
      join(root, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0", reposDir: "repos", repos: {} }),
    );
    await writeUserConfig(home, { worktreesDir: ".personal-trees" });
    expect(
      (await arashi(root, ["add", child.root, "--name", "child", "--json"], home)).exitCode,
    ).toBe(0);
    const preview = await arashi(root, ["delete", "child", "--dry-run", "--json"], home);
    expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).data.workspace.worktreesBase).toBe(
      join(await realpath(root), ".personal-trees"),
    );
  });

  test.each([false, true])(
    "bootstrap removes only created ancestors on verification failure (existing parent: %s)",
    async (existingParent) => {
      const { home, root } = await repository("rollback");
      await writeUserConfig(home, { worktreesDir: ".personal/trees" });
      vi.stubEnv("HOME", home);
      const parent = join(root, ".personal");
      if (existingParent) await mkdir(parent);
      const exclude = join(root, ".git", "info", "exclude");
      const before = await readFile(exclude, "utf8");
      let failure: ZeroConfigBootstrapError | undefined;
      try {
        await bootstrapZeroConfig(root, {
          dependencies: { effectiveIgnore: async () => ({ ignored: false }) },
        });
      } catch (error) {
        failure = error as ZeroConfigBootstrapError;
      }
      expect(failure).toBeInstanceOf(ZeroConfigBootstrapError);
      expect(failure?.details).toMatchObject({
        restored: { localExclude: true, worktreesDirectory: true },
        finalState: { localExcludeChanged: false, worktreesDirectoryChanged: false },
        restorationWarnings: [],
      });
      await expect(access(join(parent, "trees"))).rejects.toThrow();
      if (existingParent) await expect(access(parent)).resolves.toBeUndefined();
      else await expect(access(parent)).rejects.toThrow();
      expect(await readFile(exclude, "utf8")).toBe(before);
    },
  );

  test("invalid user configuration fails without silently changing workspace mode", async () => {
    const { home, root } = await repository("invalid");
    await mkdir(join(home, ".arashi"));
    await writeFile(join(home, ".arashi", "config.json"), "{");
    const result = await arashi(root, ["config", "effective"], home);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(join(home, ".arashi", "config.json"));
    expect(result.stderr).toContain("Failed to parse configuration file");
  });
});
