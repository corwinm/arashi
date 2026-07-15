import { afterEach, describe, expect, test } from "vitest";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "../helpers/node-runtime.ts";
import { ConfigParseError, resolveWorkspaceContext } from "../../src/lib/workspace-context.ts";
import {
  ConfigError,
  ConfigValidationError,
  UnsupportedConfigVersionError,
} from "../../src/lib/config.ts";

const roots: string[] = [];

async function run(cwd: string, args: string[]): Promise<string> {
  const process = spawn(args, { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  expect(exitCode).toBe(0);
  return stdout.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arashi-context-"));
  roots.push(root);
  await run(root, ["git", "init"]);
  await run(root, ["git", "config", "user.email", "test@example.com"]);
  await run(root, ["git", "config", "user.name", "Test User"]);
  await writeFile(join(root, "README.md"), "test\n");
  await run(root, ["git", "add", "README.md"]);
  await run(root, ["git", "commit", "-m", "initial"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("resolveWorkspaceContext", () => {
  test("resolves a standalone main repository and nested invocation without persistence", async () => {
    const root = await repository();
    await mkdir(join(root, ".worktrees"));
    await mkdir(join(root, "src", "nested"), { recursive: true });
    const canonicalRoot = await realpath(root);

    const context = await resolveWorkspaceContext(join(root, "src", "nested"));

    expect(context).toMatchObject({
      config: { repos: {}, reposDir: "./repos", version: "1.0.0", worktreesDir: ".worktrees" },
      mainRoot: canonicalRoot,
      mode: "standalone",
      repository: { name: root.split("/").at(-1), path: canonicalRoot },
      workspaceRoot: canonicalRoot,
    });
    await expect(access(join(root, ".arashi", "config.json"))).rejects.toThrow();
  });

  test("resolves the main root when invoked from an external linked worktree", async () => {
    const root = await repository();
    const linked = `${root}-linked`;
    roots.push(linked);
    await mkdir(join(root, ".worktrees"));
    await run(root, ["git", "worktree", "add", "-b", "linked", linked]);

    const context = await resolveWorkspaceContext(linked);

    expect(context.mode).toBe("standalone");
    if (context.mode === "standalone") expect(context.mainRoot).toBe(await realpath(root));
  });

  test("configured discovery wins and malformed configuration is not hidden", async () => {
    const root = await repository();
    await mkdir(join(root, ".worktrees"));
    await mkdir(join(root, ".arashi"));
    await writeFile(join(root, ".arashi", "config.json"), "{");

    await expect(resolveWorkspaceContext(root)).rejects.toBeInstanceOf(ConfigParseError);
  });

  test.each([
    [
      "schema-invalid",
      JSON.stringify({ version: "1.0.0", reposDir: 42, repos: {} }),
      ConfigValidationError,
    ],
    [
      "unsupported",
      JSON.stringify({ version: "2.0.0", reposDir: "./repos", repos: {} }),
      UnsupportedConfigVersionError,
    ],
  ])("preserves %s config failures beside the convention", async (_name, contents, ErrorType) => {
    const root = await repository();
    await mkdir(join(root, ".worktrees"));
    await mkdir(join(root, ".arashi"));
    await writeFile(join(root, ".arashi", "config.json"), contents);

    await expect(resolveWorkspaceContext(root)).rejects.toBeInstanceOf(ErrorType);
  });

  test("preserves unreadable config failures beside the convention", async () => {
    const root = await repository();
    await mkdir(join(root, ".worktrees"));
    await mkdir(join(root, ".arashi"));
    const config = join(root, ".arashi", "config.json");
    await writeFile(config, JSON.stringify({ version: "1.0.0", reposDir: "./repos", repos: {} }));
    await chmod(config, 0o000);
    try {
      await expect(resolveWorkspaceContext(root)).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await chmod(config, 0o600);
    }
  });

  test("does not hide invalid configuration at a linked-worktree invocation root", async () => {
    const root = await repository();
    const linked = `${root}-linked-config`;
    roots.push(linked);
    await mkdir(join(root, ".worktrees"));
    await run(root, ["git", "worktree", "add", "-b", "linked-config", linked]);
    await mkdir(join(linked, ".arashi"));
    await writeFile(join(linked, ".arashi", "config.json"), "{");

    await expect(resolveWorkspaceContext(linked)).rejects.toBeInstanceOf(ConfigParseError);
  });

  test("resolves an enclosing configured workspace before a nested standalone convention", async () => {
    const parent = await repository();
    await mkdir(join(parent, ".arashi"));
    await writeFile(
      join(parent, ".arashi", "config.json"),
      JSON.stringify({ version: "1.0.0", reposDir: "./repos", repos: {} }),
    );
    const child = join(parent, "nested", "child");
    await mkdir(child, { recursive: true });
    await run(child, ["git", "init"]);
    await mkdir(join(child, ".worktrees"));

    await expect(resolveWorkspaceContext(child)).resolves.toMatchObject({
      mode: "configured",
      workspaceRoot: parent,
    });
  });

  test("resolves an external linked worktree of a managed child to its configured parent", async () => {
    const parent = await repository();
    const child = join(parent, "repos", "child");
    await mkdir(child, { recursive: true });
    await run(child, ["git", "init"]);
    await run(child, ["git", "config", "user.email", "test@example.com"]);
    await run(child, ["git", "config", "user.name", "Test User"]);
    await writeFile(join(child, "README.md"), "child\n");
    await run(child, ["git", "add", "."]);
    await run(child, ["git", "commit", "-m", "initial"]);
    await mkdir(join(child, ".worktrees"));
    await mkdir(join(parent, ".arashi"));
    await writeFile(
      join(parent, ".arashi", "config.json"),
      JSON.stringify({
        version: "1.0.0",
        reposDir: "./repos",
        repos: { child: { path: "./repos/child" } },
      }),
    );
    const linked = `${parent}-external-child`;
    roots.push(linked);
    await run(child, ["git", "worktree", "add", "-b", "external", linked]);

    await expect(resolveWorkspaceContext(linked)).resolves.toMatchObject({
      mode: "configured",
      workspaceRoot: await realpath(parent),
    });
  });

  test("returns unavailable without the convention and outside Git", async () => {
    const root = await repository();
    const plain = await mkdtemp(join(tmpdir(), "arashi-context-plain-"));
    roots.push(plain);

    await expect(resolveWorkspaceContext(root)).resolves.toMatchObject({ mode: "unavailable" });
    await expect(resolveWorkspaceContext(plain)).resolves.toMatchObject({ mode: "unavailable" });
  });

  test("resolves a repository created with a separate Git directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "arashi-context-separate-"));
    roots.push(parent);
    const root = join(parent, "worktree");
    const gitDirectory = join(parent, "metadata.git");
    await mkdir(root);
    await run(root, ["git", "init", `--separate-git-dir=${gitDirectory}`]);
    await mkdir(join(root, ".worktrees"));

    await expect(resolveWorkspaceContext(root)).resolves.toMatchObject({
      mainRoot: await realpath(root),
      mode: "standalone",
    });
  });
});
