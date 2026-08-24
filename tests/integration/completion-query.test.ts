import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
          main: { path: "." },
          "repo one": { path: "repos/repo one", groups: [" docs team "] },
          [sensitiveRepository]: { path: "repos/odd", groups: ["DOCS TEAM"] },
        },
      }),
    );
    const only = runQuery(root, ["arashi", "create", "topic", "--only", "repo"]);
    expect(only.status).toBe(0);
    expect(only.stderr.length).toBe(0);
    expect(records(only.stdout)).toEqual(
      expect.arrayContaining([{ value: "repo one", description: expect.any(String) }]),
    );
    const comma = runQuery(root, ["arashi", "create", "topic", "--only", "other,repo"]);
    expect(records(comma.stdout).map((entry) => entry.value)).toContain("other,repo one");
    const spacedComma = runQuery(root, ["arashi", "create", "topic", "--only", "other, repo"]);
    expect(records(spacedComma.stdout).map((entry) => entry.value)).toContain("other,repo one");
    const group = runQuery(root, ["arashi", "create", "topic", "--group", "docs"]);
    expect(records(group.stdout).map((entry) => entry.value)).toEqual(["docs team"]);
    const workspaceRepository = runQuery(root, ["arashi", "create", "topic", "--only", ""]);
    expect(records(workspaceRepository.stdout).map((entry) => entry.value)).toContain(
      basename(root),
    );
    expect(records(workspaceRepository.stdout).map((entry) => entry.value)).toContain(
      sensitiveRepository,
    );
    for (const command of ["status", "sync"]) {
      const selectors = records(runQuery(root, ["arashi", command, "--only", ""]).stdout).map(
        ({ value }) => value,
      );
      expect(selectors).toContain("repo one");
      expect(selectors).toContain("main");
      expect(selectors).not.toContain(basename(root));
    }
    const ignoreScopes = records(
      runQuery(root, ["arashi", "init", "--ignore-scope", ""]).stdout,
    ).map(({ value }) => value);
    expect(ignoreScopes).toEqual(["local", "none", "tracked"]);
  });

  test.each(["discoveredRepos", "discovered_repos"])(
    "normalizes configured repositories from the legacy %s key",
    (repositoryKey) => {
      const root = mkdtempSync(join(tmpdir(), "arashi-completion-legacy-config-"));
      temporaryDirectories.push(root);
      mkdirSync(join(root, ".arashi"));
      writeFileSync(
        join(root, ".arashi", "config.json"),
        JSON.stringify({
          [repositoryKey]: { legacy: { groups: ["legacy-group"], path: "repos/legacy" } },
          version: "1.0.0",
        }),
      );

      expect(
        records(runQuery(root, ["arashi", "create", "topic", "--only", "leg"]).stdout).map(
          ({ value }) => value,
        ),
      ).toContain("legacy");
      expect(
        records(runQuery(root, ["arashi", "create", "topic", "--group", "leg"]).stdout).map(
          ({ value }) => value,
        ),
      ).toContain("legacy-group");
    },
  );

  test.skipIf(process.platform === "win32")(
    "canonicalizes primary paths and excludes prunable worktrees from remove completion",
    () => {
      const root = mkdtempSync(join(tmpdir(), "arashi-completion-remove-filter-"));
      temporaryDirectories.push(root);
      const workspace = join(root, "workspace");
      const realChild = join(root, "real-child");
      const configuredChild = join(workspace, "repos", "child");
      const linkedChild = join(root, "linked-child");
      const prunableChild = join(root, "prunable-child");
      const gitEnvironment = {
        ...process.env,
        GIT_AUTHOR_EMAIL: "completion@example.test",
        GIT_AUTHOR_NAME: "Completion Test",
        GIT_COMMITTER_EMAIL: "completion@example.test",
        GIT_COMMITTER_NAME: "Completion Test",
      };
      const git = (cwd: string, arguments_: string[]) => {
        const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", env: gitEnvironment });
        expect(result.status, result.stderr).toBe(0);
      };
      const initialize = (repository: string) => {
        mkdirSync(repository, { recursive: true });
        git(repository, ["init", "--initial-branch=main"]);
        writeFileSync(join(repository, "README.md"), "fixture\n");
        git(repository, ["add", "README.md"]);
        git(repository, ["commit", "-m", "fixture"]);
      };

      initialize(workspace);
      initialize(realChild);
      mkdirSync(join(workspace, "repos"), { recursive: true });
      symlinkSync(realChild, configuredChild);
      mkdirSync(join(workspace, ".arashi"));
      writeFileSync(
        join(workspace, ".arashi", "config.json"),
        JSON.stringify({ repos: { child: { path: "repos/child" } }, version: "1.0.0" }),
      );
      git(realChild, ["worktree", "add", "-b", "linked", linkedChild]);
      git(realChild, ["worktree", "add", "-b", "prunable", prunableChild]);
      const canonicalPrunableChild = realpathSync(prunableChild);
      rmSync(prunableChild, { recursive: true });

      const removable = records(runQuery(workspace, ["arashi", "remove", "--path", ""]).stdout).map(
        ({ value }) => value,
      );
      expect(removable).toContain(realpathSync(linkedChild));
      expect(removable).not.toContain(realpathSync(realChild));
      expect(removable).not.toContain(canonicalPrunableChild);
    },
  );

  test("discovers configured common-root workspaces from linked worktrees", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "arashi-completion-common-root-"));
    temporaryDirectories.push(root);
    const bare = join(root, "workspace.git");
    const seed = join(root, "seed");
    const linked = join(root, "linked");
    const primaryRepository = join(bare, "repos", "app");
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
    mkdirSync(primaryRepository, { recursive: true });
    git(["init", "--initial-branch=main"], primaryRepository);
    writeFileSync(join(primaryRepository, "README.md"), "child fixture\n");
    git(["add", "README.md"], primaryRepository);
    git(["commit", "-m", "child fixture"], primaryRepository);
    mkdirSync(join(linked, "repos"), { recursive: true });
    git(["worktree", "add", "-b", "linked-child", repository], primaryRepository);

    const repositories = records(
      runQuery(linked, ["arashi", "create", "topic", "--only", "a"]).stdout,
    ).map(({ value }) => value);
    expect(repositories).toContain("app");

    const worktrees = records(
      runQuery(linked, ["arashi", "move", "topic", "--from", ""]).stdout,
    ).map(({ value }) => value);
    expect(worktrees).toContain(realpathSync(repository));

    const removable = records(runQuery(linked, ["arashi", "remove", "--path", ""]).stdout).map(
      ({ value }) => value,
    );
    expect(removable).toContain(realpathSync(linked));
    expect(removable).toContain(realpathSync(repository));
  });

  test.skipIf(process.platform === "win32")(
    "recovers configured non-bare workspaces from external linked worktrees",
    () => {
      const root = mkdtempSync(join(tmpdir(), "arashi-completion-external-linked-"));
      temporaryDirectories.push(root);
      const main = join(root, "main");
      const linked = join(root, "external ");
      mkdirSync(main);
      const git = (arguments_: string[], cwd = main) => {
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
      git(["init", "--initial-branch=main"]);
      writeFileSync(join(main, "README.md"), "fixture\n");
      git(["add", "README.md"]);
      git(["commit", "-m", "fixture"]);
      mkdirSync(join(main, ".arashi"));
      writeFileSync(
        join(main, ".arashi", "config.json"),
        JSON.stringify({ repos: { app: { path: "repos/app" } }, version: "1.0.0" }),
      );
      git(["worktree", "add", "-b", "external", linked]);
      const app = join(linked, "repos", "app");
      mkdirSync(app, { recursive: true });
      git(["init"], app);

      const repositories = records(
        runQuery(linked, ["arashi", "create", "topic", "--only", "a"]).stdout,
      ).map(({ value }) => value);
      expect(repositories).toContain("app");

      const worktrees = records(runQuery(linked, ["arashi", "move", "--from", ""]).stdout).map(
        ({ value }) => value,
      );
      expect(worktrees).toContain(realpathSync(linked));
    },
  );

  test.skipIf(process.platform === "win32")(
    "preserves NUL-delimited worktree paths and follows command repository scope",
    () => {
      const root = mkdtempSync(join(tmpdir(), "arashi-completion-scope-"));
      temporaryDirectories.push(root);
      const workspace = join(root, "workspace");
      const child = join(workspace, "repos", "child");
      const bare = join(workspace, "repos", "bare.git");
      const parentWorktree = join(root, "parent, line\nbreak");
      const childWorktree = join(root, "child-worktree");
      const gitEnvironment = {
        ...process.env,
        GIT_AUTHOR_EMAIL: "completion@example.test",
        GIT_AUTHOR_NAME: "Completion Test",
        GIT_COMMITTER_EMAIL: "completion@example.test",
        GIT_COMMITTER_NAME: "Completion Test",
      };
      const git = (cwd: string, arguments_: string[]) => {
        const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", env: gitEnvironment });
        expect(result.status, result.stderr).toBe(0);
      };
      const initialize = (repository: string) => {
        mkdirSync(repository, { recursive: true });
        git(repository, ["init", "--initial-branch=main"]);
        writeFileSync(join(repository, "README.md"), "fixture\n");
        git(repository, ["add", "README.md"]);
        git(repository, ["commit", "-m", "fixture"]);
      };

      initialize(workspace);
      initialize(child);
      mkdirSync(bare);
      git(bare, ["init", "--bare"]);
      mkdirSync(join(workspace, ".arashi"));
      writeFileSync(
        join(workspace, ".arashi", "config.json"),
        JSON.stringify({
          repos: { bare: { path: "repos/bare.git" }, child: { path: "repos/child" } },
          version: "1.0.0",
        }),
      );
      git(workspace, ["worktree", "add", "-b", "parent,feature", parentWorktree]);
      git(child, ["worktree", "add", "-b", "child-feature", childWorktree]);
      const canonicalParentWorktree = realpathSync(parentWorktree);
      const canonicalChildWorktree = realpathSync(childWorktree);

      const values = (words: string[]) =>
        records(runQuery(workspace, words).stdout).map(({ value }) => value);
      const parent = values(["arashi", "switch", ""]);
      expect(parent).toContain(canonicalParentWorktree);
      expect(parent).not.toContain(canonicalChildWorktree);
      const children = values(["arashi", "switch", "--repos", ""]);
      expect(children).toContain(canonicalChildWorktree);
      expect(children).not.toContain(canonicalParentWorktree);
      const all = values(["arashi", "switch", "--all", ""]);
      expect(all).toEqual(
        expect.arrayContaining([canonicalParentWorktree, canonicalChildWorktree]),
      );
      expect(all).not.toContain(realpathSync(bare));
      expect(all).not.toContain(basename(bare));

      const removablePaths = values(["arashi", "remove", "--path", ""]);
      expect(removablePaths).toEqual(
        expect.arrayContaining([canonicalParentWorktree, canonicalChildWorktree]),
      );
      expect(removablePaths).not.toContain(realpathSync(workspace));
      expect(removablePaths).not.toContain(realpathSync(child));

      const moveReferences = values(["arashi", "move", "--from", ""]);
      expect(moveReferences).toEqual(
        expect.arrayContaining([
          "parent,feature",
          "child-feature",
          basename(canonicalParentWorktree),
          canonicalParentWorktree,
          canonicalChildWorktree,
        ]),
      );
      expect(moveReferences).not.toContain(basename(canonicalChildWorktree));

      const removeReferences = values(["arashi", "remove", ""]);
      expect(removeReferences).toEqual(
        expect.arrayContaining(["parent,feature", "child-feature", canonicalChildWorktree]),
      );
      expect(removeReferences).not.toContain(basename(canonicalChildWorktree));

      expect(values(["arashi", "switch", "parent,"])).toContain("parent,feature");
      expect(
        values(["arashi", "switch", "--path", `${canonicalParentWorktree.slice(0, -5)}`]),
      ).toContain(canonicalParentWorktree);
    },
  );

  test("suppresses configured selectors in standalone repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "arashi-completion-standalone-"));
    temporaryDirectories.push(root);
    const initialized = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    expect(initialized.status, initialized.stderr).toBe(0);

    expect(records(runQuery(root, ["arashi", "create", "topic", "--only", ""]).stdout)).toEqual([]);
    expect(records(runQuery(root, ["arashi", "create", "topic", "--group", ""]).stdout)).toEqual(
      [],
    );

    const environment = {
      ...process.env,
      GIT_AUTHOR_EMAIL: "completion@example.com",
      GIT_AUTHOR_NAME: "Completion Test",
      GIT_COMMITTER_EMAIL: "completion@example.com",
      GIT_COMMITTER_NAME: "Completion Test",
    };
    writeFileSync(join(root, "README.md"), "fixture\n");
    for (const arguments_ of [
      ["add", "README.md"],
      ["commit", "-m", "fixture"],
    ]) {
      const result = spawnSync("git", arguments_, {
        cwd: root,
        encoding: "utf8",
        env: environment,
      });
      expect(result.status, result.stderr).toBe(0);
    }
    const linked = join(root, "linked-worktree");
    const added = spawnSync("git", ["worktree", "add", "-b", "linked-branch", linked], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });
    expect(added.status, added.stderr).toBe(0);
    expect(
      records(runQuery(root, ["arashi", "remove", ""]).stdout).map(({ value }) => value),
    ).toEqual([]);

    mkdirSync(join(root, ".worktrees"));
    const standaloneRemove = records(runQuery(root, ["arashi", "remove", ""]).stdout).map(
      ({ value }) => value,
    );
    if (process.platform !== "win32") expect(standaloneRemove).toContain("linked-branch");
    expect(standaloneRemove).not.toContain(realpathSync(linked));
    expect(standaloneRemove).not.toContain(basename(linked));
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
    const completedInline = records(
      runQuery(cwd, ["arashi", "create", "topic", "--conflict=ABORT", ""]).stdout,
    ).map((entry) => entry.value);
    expect(completedInline).not.toContain("ABORT");
    expect(completedInline).not.toContain("REUSE_EXISTING");
  });

  test("delete completes only exact configured keys in its zero-or-one positional slot", () => {
    const root = mkdtempSync(join(tmpdir(), "arashi-completion-delete-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, ".arashi"));
    writeFileSync(
      join(root, ".arashi", "config.json"),
      JSON.stringify({
        repos: {
          alpha: { path: "repos/alpha", groups: ["backend"] },
          zeta: { path: "repos/zeta", groups: ["frontend"] },
        },
        version: "1.0.0",
      }),
    );

    expect(records(runQuery(root, ["arashi", "delete", ""]).stdout)).toEqual([
      { description: "Configured repository", value: "alpha" },
      { description: "Configured repository", value: "zeta" },
    ]);
    expect(records(runQuery(root, ["arashi", "delete", "a"]).stdout)).toEqual([
      { description: "Configured repository", value: "alpha" },
    ]);
    expect(records(runQuery(root, ["arashi", "delete", "alpha", ""]).stdout)).toEqual([]);
    const values = records(runQuery(root, ["arashi", "delete", ""]).stdout).map(
      ({ value }) => value,
    );
    expect(values).not.toEqual(expect.arrayContaining(["backend", "frontend", "repos/alpha"]));
  });

  test("keeps repeatable handoff options available after an occurrence", () => {
    const values = records(
      runQuery(process.cwd(), ["arashi", "handoff", "--risk", "first", "--"]).stdout,
    ).map(({ value }) => value);
    expect(values).toContain("--risk");
    expect(values).toContain("--link");
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
