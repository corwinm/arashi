// External-binary oracle and release journey. Node only; no TS dependency in native-only mode.
// Node tests/rust/parity.mjs BINARY REPORT [--native-only|--characterize]
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
const candidate = resolve(process.argv[2] ?? "target/release/arashi");
const reportPath = resolve(process.argv[3] ?? "target/native-parity.json");
const nativeOnly = process.argv.includes("--native-only");
const characterize = process.argv.includes("--characterize");
const source =
  process.env.ARASHI_TS_SOURCE ?? fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "arashi-native-parity-")));
const home = join(root, "home");
mkdirSync(home);
const env = {
  ...process.env,
  CI: "true",
  FORCE_COLOR: "0",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_KEY_1: "user.name",
  GIT_CONFIG_KEY_2: "user.email",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_VALUE_1: "Parity Test",
  GIT_CONFIG_VALUE_2: "parity@example.invalid",
  GIT_TERMINAL_PROMPT: "0",
  HOME: home,
  NO_COLOR: "1",
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
};
delete env.ARASHI_DIRECTIVE_FILE;
delete env.ARASHI_SHELL;
const results = [];
function exec(exe, args, cwd) {
  const p = spawnSync(exe, args, { cwd, encoding: "utf8", env, timeout: 60_000 });
  return {
    error: p.error?.message,
    status: p.status,
    stderr: p.stderr ?? "",
    stdout: p.stdout ?? "",
  };
}
function git(cwd, ...args) {
  const p = exec("git", args, cwd);
  assert.equal(p.status, 0, `${args.join(" ")}: ${p.stderr}`);
  return p.stdout;
}
function repo(cwd) {
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-b", "main");
  writeFileSync(join(cwd, "tracked.txt"), "fixture\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "-m", "fixture");
  return cwd;
}
function cli(isSource, args, cwd) {
  return exec(isSource ? process.execPath : candidate, isSource ? [source, ...args] : args, cwd);
}
// Only nondeterministic elapsed times are normalized. Paths, OIDs, semantic fields, array order,
// Exit status, and file bytes remain exact. Both implementations use the same scratch paths.
function normalized(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalized(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        ["duration", "durationMs", "elapsedMs", "totalDuration"].includes(k) ? 0 : normalized(v),
      ]),
    );
  }
  return value;
}
function compare(name, args, { actual, baseline, nativeEffects, sourceEffects }) {
  let detail = null;
  try {
    assert.equal(actual.error, undefined);
    assert.notEqual(actual.status, null);
    if (baseline) {
      assert.equal(actual.status, baseline.status, "exit status");
      assert.equal(actual.stderr, baseline.stderr, "complete stderr");
      if (args.includes("--json")) {
        assert.deepEqual(
          normalized(JSON.parse(actual.stdout)),
          normalized(JSON.parse(baseline.stdout)),
          "complete JSON envelope",
        );
      } else {
        assert.equal(actual.stdout, baseline.stdout, "complete stdout");
      }
      if (sourceEffects) {
        assert.deepEqual(nativeEffects, sourceEffects, "Git and filesystem effects");
      }
    } else {
      assert.equal(actual.status, 0, actual.stdout + actual.stderr);
    }
  } catch (error) {
    detail = error.message;
  }
  results.push({
    actual,
    args,
    baseline,
    detail,
    equal: detail === null,
    name,
    nativeEffects,
    sourceEffects,
  });
  console.log(`${detail ? "DIFF" : "PASS"} ${name}`);
  return actual;
}
function query(name, args, cwd) {
  const baseline = nativeOnly ? null : cli(true, args, cwd);
  const actual = cli(false, args, cwd);
  return compare(name, args, { actual, baseline });
}
function files(path) {
  const out = {};
  function visit(p, prefix) {
    if (!existsSync(p)) {
      return;
    }
    for (const e of readdirSync(p, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (e.name === ".git" && e.isDirectory()) {
        continue;
      }
      const child = join(p, e.name);
      const name = `${prefix}${e.name}`;
      if (e.isDirectory()) {
        out[`${name}/`] = "directory";
        visit(child, `${name}/`);
      } else {
        out[name] = readFileSync(child).toString("base64");
      }
    }
  }
  visit(path, "");
  return out;
}
function effects(cwd) {
  return {
    files: files(cwd),
    repositories: ["", "repos/zulu", "repos/alpha"].map((p) => {
      const path = join(cwd, p);
      return {
        config: git(path, "config", "--local", "--list"),
        path,
        refs: git(path, "show-ref", "--heads"),
        status: git(path, "status", "--porcelain"),
        worktrees: git(path, "worktree", "list", "--porcelain"),
      };
    }),
  };
}
function resetWorktrees(cwd, branch) {
  for (const p of ["repos/zulu", "repos/alpha", ""]) {
    const path = join(cwd, p);
    const records = git(path, "worktree", "list", "--porcelain").split("\n\n");
    for (const record of records) {
      if (record.split("\n").includes(`branch refs/heads/${branch}`)) {
        const target = record.split("\n")[0].slice("worktree ".length);
        assert.notEqual(target, path);
        git(path, "worktree", "remove", "--force", target);
      }
    }
    if (git(path, "branch", "--list", branch).trim()) {
      git(path, "branch", "-D", branch);
    }
  }
  // Only fixture-owned empty containers; Git has already removed every registered worktree.
  rmSync(join(cwd, ".arashi/worktrees"), { force: true, recursive: true });
}
try {
  const ordinary = repo(join(root, "ordinary"));
  query("ordinary list", ["list"], ordinary);
  query("ordinary list JSON", ["list", "--json"], ordinary);
  if (!nativeOnly) {
    query("ordinary status error", ["status", "--json"], ordinary);
  }
  const configured = repo(join(root, "configured"));
  repo(join(configured, "repos/zulu"));
  repo(join(configured, "repos/alpha"));
  const initArgs = ["init", "--json"];
  query("configured init dry-run", [...initArgs, "--dry-run"], configured);
  const excludePath = join(configured, ".git/info/exclude");
  const exclude = readFileSync(excludePath);
  let baseline = null,
    sourceEffects = null;
  if (!nativeOnly) {
    baseline = cli(true, initArgs, configured);
    sourceEffects = {
      exclude: readFileSync(excludePath).toString("base64"),
      files: files(configured),
    };
    rmSync(join(configured, ".arashi"), { recursive: true });
    writeFileSync(excludePath, exclude);
  }
  const initialized = cli(false, initArgs, configured);
  compare("configured init discovery", initArgs, {
    actual: initialized,
    baseline,
    nativeEffects: {
      exclude: readFileSync(excludePath).toString("base64"),
      files: files(configured),
    },
    sourceEffects,
  });
  assert.equal(initialized.status, 0, initialized.stdout);
  git(configured, "add", ".arashi");
  git(configured, "commit", "-m", "Arashi configuration");
  for (const [label, cwd] of [
    ["configured", configured],
    ["configured child", join(configured, "repos/zulu")],
  ]) {
    query(`${label} list`, ["list", "--json"], cwd);
    query(`${label} status`, ["status", "--json"], cwd);
  }
  if (!nativeOnly) {
    query("unknown repository selection", ["status", "--only", "absent", "--json"], configured);
    query("invalid option diagnostics", ["list", "--not-an-option"], ordinary);
  }
  const createArgs = [
    "create",
    "feature/demo",
    "--no-hooks",
    "--no-launch",
    "--no-switch",
    "--json",
  ];
  query("configured create dry-run", [...createArgs, "--dry-run"], configured);
  baseline = null;
  sourceEffects = null;
  if (!nativeOnly) {
    baseline = cli(true, createArgs, configured);
    sourceEffects = effects(configured);
    resetWorktrees(configured, "feature/demo");
  }
  const created = cli(false, createArgs, configured);
  compare("configured create parent and two children", createArgs, {
    actual: created,
    baseline,
    nativeEffects: effects(configured),
    sourceEffects,
  });
  assert.equal(created.status, 0, created.stdout);
  for (const p of ["", "repos/zulu", "repos/alpha"]) {
    assert.ok(existsSync(join(configured, ".arashi/worktrees/feature/demo", p, "tracked.txt")));
  }
  query("configured remove dry-run", ["remove", "feature/demo", "--dry-run", "--json"], configured);
  const removeArgs = ["remove", "feature/demo", "--force", "--json"];
  baseline = null;
  sourceEffects = null;
  if (!nativeOnly) {
    baseline = cli(true, removeArgs, configured);
    sourceEffects = effects(configured);
    const recreated = cli(false, createArgs, configured);
    assert.equal(recreated.status, 0, recreated.stdout);
  }
  const removed = cli(false, removeArgs, configured);
  compare("configured remove parent and two children", removeArgs, {
    actual: removed,
    baseline,
    nativeEffects: effects(configured),
    sourceEffects,
  });
  assert.equal(removed.status, 0, removed.stdout);
  for (const p of ["", "repos/zulu", "repos/alpha"]) {
    assert.equal(
      git(join(configured, p), "worktree", "list", "--porcelain").match(/^worktree /gm).length,
      1,
    );
  }
  if (characterize && !nativeOnly) {
    const outside = join(root, "outside");
    mkdirSync(outside);
    for (const [label, cwd] of [
      ["ordinary", ordinary],
      ["configured", configured],
      ["configured child", join(configured, "repos/zulu")],
      ["outside", outside],
    ]) {
      query(`${label} doctor (remaining scope)`, ["doctor", "--json"], cwd);
    }
  }
} catch (error) {
  results.push({ detail: error.stack, equal: false, name: "harness failure" });
  console.error(error);
} finally {
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      { candidate, characterize, nativeOnly, results, root, source: nativeOnly ? null : source },
      null,
      2,
    )}\n`,
  );
  rmSync(root, { force: true, recursive: true });
}
console.log(`Report: ${reportPath}`);
if (results.some((r) => !r.equal)) {
  process.exitCode = 1;
}
