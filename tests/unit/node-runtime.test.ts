import { afterEach, expect, test, vi } from "vitest";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { resolveTestCommand, spawn, spawnSync } from "../helpers/node-runtime.ts";

const entry = join(import.meta.dirname, "../../src/index.ts");
afterEach(() => vi.unstubAllEnvs());

test("source execution remains the default", () => {
  vi.stubEnv("ARASHI_TEST_BINARY", undefined);
  const command = [process.execPath, entry, "list", "--json"];
  expect(resolveTestCommand(command)).toEqual(command);
});

test("substitutes only the exact CLI entry and requires an absolute binary", () => {
  vi.stubEnv("ARASHI_TEST_BINARY", process.execPath);
  for (const node of [process.execPath, "node"]) {
    expect(resolveTestCommand([node, entry, "list", "--json"])).toEqual([
      process.execPath,
      "list",
      "--json",
    ]);
  }
  expect(resolveTestCommand(["node", relative(process.cwd(), entry), "list"])).toEqual([
    process.execPath,
    "list",
  ]);
  vi.stubEnv("ARASHI_TEST_BINARY", "target/release/arashi");
  expect(() => resolveTestCommand(["node", entry, "list"])).toThrow(/absolute/);
  vi.stubEnv("ARASHI_TEST_BINARY", "");
  expect(() => resolveTestCommand(["node", entry, "list"])).toThrow(/absolute/);
});

test("relative CLI entries are resolved against the child cwd", () => {
  vi.stubEnv("ARASHI_TEST_BINARY", process.execPath);
  expect(
    resolveTestCommand(["node", "index.ts", "list"], join(import.meta.dirname, "../../src")),
  ).toEqual([process.execPath, "list"]);
  const other = ["node", "src/index.ts", "list"];
  expect(resolveTestCommand(other, tmpdir())).toEqual(other);
  const child = spawnSync(["node", "index.ts", "-e", "process.stdout.write('relative entry')"], {
    cwd: join(import.meta.dirname, "../../src"),
  });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("relative entry");
});

test("preserves non-CLI Node, Git, runtime flags, and PTY outer wrappers", () => {
  vi.stubEnv("ARASHI_TEST_BINARY", process.execPath);
  for (const command of [
    [process.execPath, "-e", "console.log('node')", entry],
    [process.execPath, "--trace-warnings", entry, "list"],
    [process.execPath, `${entry}.other`, "list"],
    [
      process.execPath,
      join(import.meta.dirname, "../helpers/pty-input.mjs"),
      tmpdir(),
      JSON.stringify([process.execPath, entry, "list"]),
    ],
    ["git", "status", "--porcelain"],
    ["other-runtime", entry, "list"],
  ])
    expect(resolveTestCommand(command)).toEqual(command);
  // The existing test-only Git commit policy is unchanged.
  expect(resolveTestCommand(["git", "commit", "-m", "fixture"])).toEqual([
    "git",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
});

const probe = `process.stdin.setEncoding('utf8'); let input = ''; process.stdin.on('data', x => input += x); process.stdin.on('end', () => { console.log(JSON.stringify({cwd: process.cwd(), value: process.env.PROBE_VALUE, args: process.argv.slice(1), input})); console.error('probe stderr'); process.exitCode = 23; });`;

test("async substitution preserves cwd, env, stdin, stdout, stderr and exit", async () => {
  // Node stands in for an external executable so the probe works on every host.
  vi.stubEnv("ARASHI_TEST_BINARY", process.execPath);
  const child = spawn([process.execPath, entry, "-e", probe, "two words"], {
    cwd: tmpdir(),
    env: { ...process.env, PROBE_VALUE: "child env" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin?.end("probe input");
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(23);
  expect(JSON.parse(stdout)).toEqual({
    cwd: spawnSync([process.execPath, "-p", "process.cwd()"], { cwd: tmpdir() })
      .stdout.toString()
      .trim(),
    value: "child env",
    args: ["two words"],
    input: "probe input",
  });
  expect(stderr).toBe("probe stderr\n");
});

test("sync substitution preserves cwd, env, streams and exit", () => {
  vi.stubEnv("ARASHI_TEST_BINARY", process.execPath);
  const result = spawnSync(
    [
      "node",
      entry,
      "-e",
      "console.log(process.env.PROBE_VALUE); console.error(process.cwd()); process.exitCode = 19",
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, PROBE_VALUE: "sync env" },
    },
  );
  expect(result.exitCode).toBe(19);
  expect(result.stdout.toString()).toBe("sync env\n");
  expect(result.stderr.toString().trim()).toBe(
    spawnSync([process.execPath, "-p", "process.cwd()"], { cwd: tmpdir() })
      .stdout.toString()
      .trim(),
  );
});
