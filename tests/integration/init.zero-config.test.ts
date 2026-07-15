import { afterEach, describe, expect, test } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "../helpers/node-runtime.ts";
import {
  ZeroConfigBootstrapError,
  bootstrapZeroConfig,
} from "../../src/lib/zero-config-bootstrap.ts";

const roots: string[] = [];

async function run(cwd: string, args: string[]) {
  const child = spawn(args, { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arashi-zero-init-"));
  roots.push(root);
  expect((await run(root, ["git", "init"])).exitCode).toBe(0);
  return root;
}

async function arashi(root: string, args: string[]) {
  return await run(root, [
    process.execPath,
    join(import.meta.dirname, "../../src/index.ts"),
    ...args,
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("init --zero-config", () => {
  test("creates only the convention and literal repository-local exclude rule", async () => {
    const root = await repository();
    const result = await arashi(root, ["init", "--zero-config"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("standalone");
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toContain(
      "\n.worktrees/\n",
    );
    await expect(access(join(root, ".worktrees"))).resolves.toBeUndefined();
    await expect(access(join(root, ".arashi"))).rejects.toThrow();
    await expect(access(join(root, ".gitignore"))).rejects.toThrow();
  });

  test("dry-run JSON is isolated and leaves both actions unapplied", async () => {
    const root = await repository();
    const before = await readFile(join(root, ".git", "info", "exclude"));
    const result = await arashi(root, [
      "init",
      "--zero-config",
      "--dry-run",
      "--json",
      "--verbose",
    ]);
    const envelope = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(envelope).toMatchObject({
      data: {
        dryRun: true,
        finalState: { localExcludeChanged: false, worktreesDirectoryChanged: false },
        attempted: { localExclude: false, worktreesDirectory: false },
        mode: "standalone",
        worktreesDirectory: { changed: false, planned: true },
        localExclude: { changed: false, planned: true, rule: ".worktrees/" },
      },
      ok: true,
    });
    expect(await readFile(join(root, ".git", "info", "exclude"))).toEqual(before);
    await expect(access(join(root, ".worktrees"))).rejects.toThrow();
  });

  test("reports structured rollback evidence after injected verification failure", async () => {
    const root = await repository();
    const exclude = join(root, ".git", "info", "exclude");
    const before = await readFile(exclude);

    let bootstrapError: ZeroConfigBootstrapError | undefined;
    try {
      await bootstrapZeroConfig(root, {
        dependencies: {
          effectiveIgnore: async () => ({ ignored: false }),
        },
      });
    } catch (error) {
      bootstrapError = error as ZeroConfigBootstrapError;
    }

    expect(bootstrapError).toBeInstanceOf(ZeroConfigBootstrapError);
    expect(bootstrapError?.details).toMatchObject({
      attempted: { localExclude: true, worktreesDirectory: true },
      finalState: { localExcludeChanged: false, worktreesDirectoryChanged: false },
      originalFailure: expect.stringContaining("higher-precedence"),
      restorationWarnings: [],
      restored: { localExclude: true, worktreesDirectory: true },
    });
    expect(await readFile(exclude)).toEqual(before);
    await expect(access(join(root, ".worktrees"))).rejects.toThrow();
  });

  test("reports unchanged state after an injected directory creation failure", async () => {
    const root = await repository();
    let bootstrapError: ZeroConfigBootstrapError | undefined;

    try {
      await bootstrapZeroConfig(root, {
        dependencies: {
          mkdir: async (path, options) => {
            if (String(path).endsWith(".worktrees")) {
              throw new Error("injected directory failure");
            }
            await mkdir(path, options);
            return undefined;
          },
        },
      });
    } catch (error) {
      bootstrapError = error as ZeroConfigBootstrapError;
    }

    expect(bootstrapError?.details).toMatchObject({
      attempted: { localExclude: false, worktreesDirectory: true },
      finalState: { localExcludeChanged: false, worktreesDirectoryChanged: false },
      originalFailure: expect.stringContaining("injected directory failure"),
    });
    await expect(access(join(root, ".worktrees"))).rejects.toThrow();
  });

  test("restores the directory after an injected exclude write failure", async () => {
    const root = await repository();
    const exclude = join(root, ".git", "info", "exclude");
    const before = await readFile(exclude);
    let bootstrapError: ZeroConfigBootstrapError | undefined;

    try {
      await bootstrapZeroConfig(root, {
        dependencies: {
          writeFile: async () => {
            throw new Error("injected exclude write failure");
          },
        },
      });
    } catch (error) {
      bootstrapError = error as ZeroConfigBootstrapError;
    }

    expect(bootstrapError?.details).toMatchObject({
      attempted: { localExclude: true, worktreesDirectory: true },
      finalState: { localExcludeChanged: false, worktreesDirectoryChanged: false },
      originalFailure: expect.stringContaining("injected exclude write failure"),
      restored: { localExclude: false, worktreesDirectory: true },
    });
    expect(await readFile(exclude)).toEqual(before);
    await expect(access(join(root, ".worktrees"))).rejects.toThrow();
  });

  test("keeps original failure and reports an injected restoration failure separately", async () => {
    const root = await repository();
    const exclude = join(root, ".git", "info", "exclude");
    const before = await readFile(exclude);
    let writes = 0;

    let bootstrapError: ZeroConfigBootstrapError | undefined;
    try {
      await bootstrapZeroConfig(root, {
        dependencies: {
          effectiveIgnore: async () => ({ ignored: false }),
          writeFile: async (path, contents) => {
            writes += 1;
            if (writes === 2) {
              throw new Error("injected restoration failure");
            }
            await writeFile(path, contents);
          },
        },
      });
    } catch (error) {
      bootstrapError = error as ZeroConfigBootstrapError;
    }

    expect(bootstrapError?.details).toMatchObject({
      finalState: { localExcludeChanged: true, worktreesDirectoryChanged: false },
      originalFailure: expect.stringContaining("higher-precedence"),
      restorationWarnings: [expect.stringContaining("injected restoration failure")],
      restored: { localExclude: false, worktreesDirectory: true },
    });
    expect(await readFile(exclude)).not.toEqual(before);
  });

  test("preserves no-final-newline content and is idempotent", async () => {
    const root = await repository();
    const exclude = join(root, ".git", "info", "exclude");
    await writeFile(exclude, "existing");

    expect((await arashi(root, ["init", "--zero-config"])).exitCode).toBe(0);
    const once = await readFile(exclude, "utf8");
    expect(once).toBe("existing\n.worktrees/\n");
    const repeated = await arashi(root, ["init", "--zero-config", "--json"]);
    expect(JSON.parse(repeated.stdout).data).toMatchObject({ changed: false, mode: "standalone" });
    expect(await readFile(exclude, "utf8")).toBe(once);
  });

  test("honors an existing tracked effective rule without changing local exclude", async () => {
    const root = await repository();
    const exclude = join(root, ".git", "info", "exclude");
    const before = await readFile(exclude);
    await writeFile(join(root, ".gitignore"), ".worktrees/\n");

    const result = await arashi(root, ["init", "--zero-config", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.localExclude).toMatchObject({
      changed: false,
      planned: false,
    });
    expect(await readFile(exclude)).toEqual(before);
  });

  test("preserves CRLF local exclude formatting", async () => {
    const root = await repository();
    const exclude = join(root, ".git", "info", "exclude");
    await writeFile(exclude, "first\r\nsecond");

    expect((await arashi(root, ["init", "--zero-config"])).exitCode).toBe(0);

    expect(await readFile(exclude, "utf8")).toBe("first\r\nsecond\r\n.worktrees/\r\n");
  });

  test("refuses a symlinked local exclude and rolls back the new directory", async () => {
    const root = await repository();
    const exclude = join(root, ".git", "info", "exclude");
    const target = join(root, "outside-exclude");
    await writeFile(target, "unchanged\n");
    await unlink(exclude);
    await symlink(target, exclude);

    const result = await arashi(root, ["init", "--zero-config"]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("symlinked");
    expect(await readFile(target, "utf8")).toBe("unchanged\n");
    await expect(access(join(root, ".worktrees"))).rejects.toThrow();
  });

  test.each([
    "--repos-dir=x",
    "--worktrees-dir=x",
    "--ignore-scope=none",
    "--force",
    "--no-discover",
  ])("rejects incompatible option %s before mutation", async (option) => {
    const root = await repository();
    const result = await arashi(root, ["init", "--zero-config", option]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("incompatible");
    await expect(access(join(root, ".worktrees"))).rejects.toThrow();
  });

  test("rejects existing configured state before mutation", async () => {
    const root = await repository();
    await mkdir(join(root, ".arashi"));
    await writeFile(join(root, ".arashi", "config.json"), "{");
    const result = await arashi(root, ["init", "--zero-config"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("configured");
    await expect(access(join(root, ".worktrees"))).rejects.toThrow();
  });
});
