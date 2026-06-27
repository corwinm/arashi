import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "arashi-json-cli-"));
  tempDirs.push(path);
  return path;
};

const runArashi = async (cwd: string, args: string[]): Promise<CommandResult> => {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
};

const parseSingleJsonDocument = (stdout: string): Record<string, unknown> => {
  expect(stdout.trim()).toBe(stdout.slice(0, -1));
  expect(stdout.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(stdout);
  expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(stdout);
  return parsed as Record<string, unknown>;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("CLI JSON output contract", () => {
  test("status --json returns exactly one failure envelope outside a workspace", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["status", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "status",
      error: { code: "NOT_IN_WORKSPACE" },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("list --json returns the shared envelope on command-level failure", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["list", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "list",
      error: { code: "NOT_IN_REPOSITORY" },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("shell init --json rejects shell-code output with a structured unsupported-mode error", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["shell", "init", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "shell",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "init" },
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
    expect(result.stdout).not.toContain("function ");
  });

  test("switch --json rejects launch/shell-control modes with a structured unsupported-mode error", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["switch", "--json"]);

    expect(result.exitCode).not.toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "switch",
      error: {
        code: "JSON_UNSUPPORTED_FOR_MODE",
        details: { mode: "launch" },
      },
      ok: false,
      schemaVersion: 1,
      warnings: [],
    });
  });

  test("automation commands expose JSON envelopes or structured unsupported-mode errors", async () => {
    const cwd = await makeTempDir();

    const cases = [
      { args: ["clone", "--json"], code: "JSON_UNSUPPORTED_FOR_MODE", command: "clone" },
      {
        args: ["create", "feature-json", "--json"],
        code: "JSON_UNSUPPORTED_FOR_MODE",
        command: "create",
      },
      { args: ["init", "--dry-run", "--json"], code: "JSON_UNSUPPORTED_FOR_MODE", command: "init" },
      { args: ["pull", "--json"], code: "UNKNOWN_ERROR", command: "pull" },
      { args: ["setup", "--json"], code: "UNKNOWN_ERROR", command: "setup" },
      { args: ["sync", "--json"], code: "UNKNOWN_ERROR", command: "sync" },
      { args: ["update", "--json", "--yes"], code: "JSON_UNSUPPORTED_FOR_MODE", command: "update" },
    ];

    for (const testCase of cases) {
      const result = await runArashi(cwd, testCase.args);
      expect(result.exitCode).not.toBe(0);
      const parsed = parseSingleJsonDocument(result.stdout);
      expect(parsed).toMatchObject({
        command: testCase.command,
        error: { code: testCase.code },
        ok: false,
        schemaVersion: 1,
        warnings: [],
      });
    }
  });

  test("install --json returns a structured success envelope", async () => {
    const cwd = await makeTempDir();

    const result = await runArashi(cwd, ["install", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = parseSingleJsonDocument(result.stdout);
    expect(parsed).toMatchObject({
      command: "install",
      data: {
        releasesUrl: "https://github.com/corwinm/arashi/releases",
      },
      ok: true,
      schemaVersion: 1,
      warnings: [],
    });
  });
});
