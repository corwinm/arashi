import { afterEach, describe, expect, test } from "vitest";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import { spawn } from "../helpers/node-runtime.ts";

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

    const first = await arashi(root, ["create", "feat/one", "--json"], home);
    expect(first.exitCode, first.stderr).toBe(0);
    const firstPath = join(await realpath(root), ".personal-trees", `${basename(root)}-feat-one`);
    expect(JSON.parse(first.stdout).data.worktreePath).toBe(firstPath);

    const second = await arashi(firstPath, ["create", "feat/two", "--json"], home);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).data.worktreePath).toBe(
      join(await realpath(root), ".personal-trees", `${basename(root)}-feat-two`),
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

    const created = await arashi(root, ["create", "feat/configured", "--json"], home);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).data.repositories[0].worktreePath).toBe(
      join(await realpath(root), ".user-trees", "feat-configured"),
    );
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain(
      "/.user-trees/",
    );
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
      (JSON.parse(listed.stdout).data.worktrees as { path: string }[]).map(({ path }) => path),
    ).toContain(legacyPath);

    const removed = await arashi(root, ["remove", "legacy", "--force", "--json"], home);
    expect(removed.exitCode, removed.stderr).toBe(0);
    await expect(access(legacyPath)).rejects.toThrow();
  });

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
