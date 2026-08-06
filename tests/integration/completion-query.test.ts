import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "../../src/index.ts");
const runQuery = (cwd: string, words: string[]) =>
  spawnSync(
    process.execPath,
    [cliPath, "completion", "__query", String(words.length - 1), "--", ...words],
    { cwd, encoding: null, env: { ...process.env, NO_COLOR: "1" }, timeout: 1000 },
  );
const records = (stdout: Buffer) => {
  const fields = stdout.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  return Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => ({
    description: fields[index * 2 + 1],
    value: fields[index * 2],
  }));
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe("lossless bounded dynamic completion query", () => {
  test("returns alternating NUL records and preserves shell-sensitive configured values", () => {
    const sensitiveRepository = "quote'glob*\\tab\tline\nrepo";
    const root = mkdtempSync(join(tmpdir(), "arashi-completion-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, ".arashi"));
    writeFileSync(
      join(root, ".arashi", "config.json"),
      JSON.stringify({
        version: "1.0.0",
        reposDir: "repos",
        repos: {
          "repo one": { path: "repos/repo one", groups: ["docs team"] },
          [sensitiveRepository]: { path: "repos/odd" },
        },
      }),
    );
    const only = runQuery(root, ["arashi", "create", "topic", "--only", "repo"]);
    expect(only.status).toBe(0);
    expect(only.stderr.length).toBe(0);
    expect(records(only.stdout)).toEqual(
      expect.arrayContaining([{ value: "repo one", description: expect.any(String) }]),
    );
    const group = runQuery(root, ["arashi", "create", "topic", "--group", "docs"]);
    expect(records(group.stdout).map((entry) => entry.value)).toContain("docs team");
    const comma = runQuery(root, ["arashi", "create", "topic", "--only", "other,repo"]);
    expect(records(comma.stdout).map((entry) => entry.value)).toContain("other,repo one");
    const workspaceRepository = runQuery(root, ["arashi", "create", "topic", "--only", ""]);
    expect(records(workspaceRepository.stdout).map((entry) => entry.value)).toContain(
      basename(root),
    );
    expect(records(workspaceRepository.stdout).map((entry) => entry.value)).toContain(
      sensitiveRepository,
    );
  });

  test("discovers configured common-root workspaces from linked worktrees", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "arashi-completion-common-root-"));
    temporaryDirectories.push(root);
    const bare = join(root, "workspace.git");
    const seed = join(root, "seed");
    const linked = join(root, "linked");
    const repository = join(linked, "repos", "app");
    const git = (arguments_: string[], cwd = root) => {
      const result = spawnSync("git", arguments_, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: "completion@example.test",
          GIT_AUTHOR_NAME: "Completion Test",
          GIT_COMMITTER_EMAIL: "completion@example.test",
          GIT_COMMITTER_NAME: "Completion Test",
        },
      });
      expect(result.status, result.stderr).toBe(0);
    };

    git(["init", "--bare", bare]);
    git(["init", "--initial-branch=main", seed]);
    writeFileSync(join(seed, "README.md"), "fixture\n");
    git(["add", "README.md"], seed);
    git(["commit", "-m", "fixture"], seed);
    git(["remote", "add", "origin", bare], seed);
    git(["push", "origin", "main"], seed);
    git(["--git-dir", bare, "worktree", "add", linked, "main"]);
    mkdirSync(join(bare, ".arashi"));
    writeFileSync(
      join(bare, ".arashi", "config.json"),
      JSON.stringify({
        repos: { app: { groups: ["docs"], path: "repos/app" } },
        reposDir: "repos",
        version: "1.0.0",
      }),
    );
    mkdirSync(repository, { recursive: true });
    git(["init"], repository);

    const repositories = records(
      runQuery(linked, ["arashi", "create", "topic", "--only", "a"]).stdout,
    ).map(({ value }) => value);
    expect(repositories).toContain("app");

    const worktrees = records(
      runQuery(linked, ["arashi", "move", "topic", "--from", ""]).stdout,
    ).map(({ value }) => value);
    expect(worktrees).toContain(realpathSync(repository));
  });

  test("returns exact finite choices only for their owning slots", () => {
    const cwd = process.cwd();
    expect(
      records(runQuery(cwd, ["arashi", "completion", "b"]).stdout).map((entry) => entry.value),
    ).toEqual(["bash"]);
    expect(
      records(runQuery(cwd, ["arashi", "create", "topic", "--conflict", "R"]).stdout).map(
        (entry) => entry.value,
      ),
    ).toEqual(["REUSE_EXISTING"]);
    expect(records(runQuery(cwd, ["arashi", "status", "R"]).stdout)).toEqual([]);
  });

  test("suppresses options that conflict with an already selected option", () => {
    const cwd = process.cwd();
    const values = records(runQuery(cwd, ["arashi", "create", "topic", "--tmux", ""]).stdout).map(
      (entry) => entry.value,
    );

    expect(values).not.toContain("--herdr");
    expect(values).not.toContain("--sesh");
    expect(values).not.toContain("--tmux");
    expect(values).toContain("--dry-run");
  });

  test("does not leak Arashi options after a variadic child command begins", () => {
    const result = runQuery(process.cwd(), ["arashi", "exec", "printf", ""]);
    expect(result.status).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(records(result.stdout)).toEqual([]);
  });

  test("fails silently and quickly outside or with broken workspace metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "arashi-completion-empty-"));
    temporaryDirectories.push(root);
    const started = performance.now();
    const outside = runQuery(root, ["arashi", "create", "topic", "--only", "r"]);
    expect(outside.status).toBe(0);
    expect(outside.stdout.length).toBe(0);
    expect(outside.stderr.length).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
    mkdirSync(join(root, ".arashi"));
    writeFileSync(join(root, ".arashi", "config.json"), "{");
    const broken = runQuery(root, ["arashi", "create", "topic", "--only", "r"]);
    expect(broken.status).toBe(0);
    expect(broken.stdout.length).toBe(0);
    expect(broken.stderr.length).toBe(0);

    const configPath = join(root, ".arashi", "config.json");
    writeFileSync(configPath, " ".repeat(2 * 1024 * 1024));
    const oversized = runQuery(root, ["arashi", "create", "topic", "--only", "r"]);
    expect(oversized.status).toBe(0);
    expect(oversized.stdout.length).toBe(0);
    expect(oversized.stderr.length).toBe(0);

    if (process.platform !== "win32") {
      rmSync(configPath);
      expect(spawnSync("mkfifo", [configPath]).status).toBe(0);
      const fifo = runQuery(root, ["arashi", "create", "topic", "--only", "r"]);
      expect(fifo.status).toBe(0);
      expect(fifo.stdout.length).toBe(0);
      expect(fifo.stderr.length).toBe(0);
    }
  });
});
