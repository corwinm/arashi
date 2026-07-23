import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { executeCreate } from "../../src/commands/create.ts";
import { spawn } from "../helpers/node-runtime.ts";

const roots: string[] = [];
const originalCwd = process.cwd();
const CLI_ENTRY = join(import.meta.dirname, "../../src/index.ts");

async function run(cwd: string, command: string[]): Promise<void> {
  const process = spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`);
  }
}

async function createConfiguredRepository(launch: "auto" | "sesh" | "herdr"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arashi create $safe's "));
  roots.push(root);
  await run(root, ["git", "init", "-b", "main"]);
  await run(root, ["git", "config", "user.email", "test@example.com"]);
  await run(root, ["git", "config", "user.name", "Test User"]);
  await mkdir(join(root, ".arashi"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".arashi/worktrees/\n");
  await writeFile(join(root, "README.md"), "create launch integration fixture\n");
  await writeFile(
    join(root, ".arashi", "config.json"),
    JSON.stringify(
      {
        defaults: { create: { launch, switch: false } },
        repos: {},
        reposDir: "./repos",
        version: "1.0.0",
        worktreesDir: "./.arashi/worktrees",
      },
      null,
      2,
    ),
  );
  await run(root, ["git", "add", "."]);
  await run(root, ["git", "commit", "-m", "initial fixture"]);
  return root;
}

async function createStandaloneRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arashi standalone create $safe's "));
  roots.push(root);
  await run(root, ["git", "init", "-b", "main"]);
  await run(root, ["git", "config", "user.email", "test@example.com"]);
  await run(root, ["git", "config", "user.name", "Test User"]);
  await mkdir(join(root, ".worktrees"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".worktrees/\n");
  await writeFile(join(root, "README.md"), "standalone create launch fixture\n");
  await run(root, ["git", "add", "."]);
  await run(root, ["git", "commit", "-m", "initial fixture"]);
  return root;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("configured create launch in a real workspace", () => {
  test.each(["auto", "sesh", "herdr"] as const)(
    "creates the primary worktree and routes configured %s through the shared launcher",
    async (launch) => {
      const root = await createConfiguredRepository(launch);
      process.chdir(root);
      const calls: {
        candidate: { branchName: string; repoName: string; worktreePath: string };
        options: { herdr?: boolean; sesh?: boolean };
      }[] = [];

      const exitCode = await executeCreate(
        `feature/${launch}`,
        {},
        {
          launchSwitchTarget: async (candidate, options) => {
            calls.push({ candidate, options });
            return {
              command: [],
              mode: launch === "auto" ? "fallback" : launch,
            };
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.candidate).toMatchObject({
        branchName: `feature/${launch}`,
        repoName: basename(root),
      });
      expect(calls[0]?.options).toEqual({
        ...(launch === "herdr" ? { herdr: true } : {}),
        sesh: launch === "sesh",
      });
      const worktreePath = calls[0]?.candidate.worktreePath;
      expect(worktreePath).toBeDefined();
      await access(await realpath(worktreePath!));
    },
    20_000,
  );

  test.each([
    ["--launch", "--no-launch"],
    ["--no-launch", "--launch"],
  ])(
    "gives --launch precedence over --no-launch for real CLI argv order %s %s",
    async (...flags) => {
      const root = await createConfiguredRepository("sesh");
      const child = spawn(
        [process.execPath, CLI_ENTRY, "create", "feature/argv-precedence", "--json", ...flags],
        {
          cwd: root,
          env: { ...process.env, NO_COLOR: "1" },
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);

      expect(exitCode).not.toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        error: { code: "JSON_UNSUPPORTED_FOR_MODE" },
        ok: false,
      });
      await expect(
        access(join(root, ".arashi", "worktrees", `${basename(root)}-feature`, "argv-precedence")),
      ).rejects.toThrow();
    },
  );

  test("rejects standalone direct-executor JSON launch before dry-run or mutation", async () => {
    const root = await createStandaloneRepository();
    process.chdir(root);
    const originalWrite = process.stdout.write;
    let stdout = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;

    let exitCode: number;
    try {
      exitCode = await executeCreate("feature/standalone-json", {
        dryRun: true,
        json: true,
        launch: true,
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(exitCode!).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "create",
      error: { code: "JSON_UNSUPPORTED_FOR_MODE" },
      ok: false,
    });
    await expect(access(join(root, ".worktrees", "feature", "standalone-json"))).rejects.toThrow();
  });

  test("reports explicit launcher conflict before JSON launch restriction", async () => {
    const root = await createConfiguredRepository("sesh");
    const child = spawn(
      [
        process.execPath,
        CLI_ENTRY,
        "create",
        "feature/json-conflict",
        "--json",
        "--sesh",
        "--herdr",
      ],
      {
        cwd: root,
        env: { ...process.env, NO_COLOR: "1" },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      command: "create",
      error: { code: "CONFLICTING_LAUNCH_OPTIONS" },
      ok: false,
    });
    await expect(
      access(join(root, ".arashi", "worktrees", `${basename(root)}-feature`, "json-conflict")),
    ).rejects.toThrow();
  });

  test("lets --no-launch override configured launch without suppressing independent switch", async () => {
    const root = await createConfiguredRepository("sesh");
    process.chdir(root);
    let launchCalls = 0;

    const exitCode = await executeCreate(
      "feature/no-launch",
      { launch: false, switch: true },
      {
        launchSwitchTarget: async () => {
          launchCalls += 1;
          return { command: [], mode: "sesh" };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(launchCalls).toBe(0);
    await access(join(root, ".arashi", "worktrees", `${basename(root)}-feature`, "no-launch"));
  }, 20_000);
});
