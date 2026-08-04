import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { executeCreate } from "../../src/commands/create.ts";
import { SwitchCommandError, SwitchCommandErrorCode } from "../../src/types/switch.ts";
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

async function runCapture(cwd: string, command: string[]): Promise<{ stdout: string }> {
  const child = spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return { stdout };
}

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    env: {
      ...process.env,
      CMUX_SURFACE_ID: "",
      CMUX_WORKSPACE_ID: "",
      HERDR_ENV: "",
      KITTY_PID: "",
      KITTY_WINDOW_ID: "",
      TERM: "",
      TERM_PROGRAM: "",
      TMUX: "",
      WEZTERM_EXECUTABLE: "",
      WEZTERM_PANE: "",
      WT_SESSION: "",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
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
  test.each([true, false])(
    "propagates a successful tab through the real %s create executor without persisting disposition",
    async (configured) => {
      const root = configured
        ? await createConfiguredRepository("auto")
        : await createStandaloneRepository();
      const configPath = join(root, ".arashi", "config.json");
      const configBefore = configured ? await readFile(configPath, "utf8") : null;
      const branch = configured ? "feature/configured-real-tab" : "feature/standalone-real-tab";
      const calls: { command: string[]; cwd: string }[] = [];
      process.chdir(root);

      const exitCode = await executeCreate(
        branch,
        { tab: true },
        {
          env: { TERM_PROGRAM: "WezTerm", WEZTERM_PANE: "pane-17" },
          platform: "linux",
          runProcess: async (command, options) => {
            calls.push({ command, cwd: options.cwd });
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      );
      const canonicalRoot = await realpath(root);
      const expectedWorktree = configured
        ? join(
            canonicalRoot,
            ".arashi",
            "worktrees",
            `${basename(canonicalRoot)}-feature`,
            "configured-real-tab",
          )
        : join(canonicalRoot, ".worktrees", "feature", "standalone-real-tab");

      expect(exitCode).toBe(0);
      expect(calls).toEqual([
        {
          command: ["wezterm", "cli", "spawn", "--pane-id", "pane-17", "--cwd", expectedWorktree],
          cwd: expectedWorktree,
        },
      ]);
      await expect(access(expectedWorktree)).resolves.toBeUndefined();
      if (configured) {
        expect(await readFile(configPath, "utf8")).toBe(configBefore);
        expect(await readFile(configPath, "utf8")).not.toContain("disposition");
      } else {
        await expect(access(join(root, ".arashi"))).rejects.toThrow();
      }
    },
    20_000,
  );

  test("real CLI --tab fails before configured or standalone mutation and never persists disposition", async () => {
    const configured = await createConfiguredRepository("auto");
    const configuredConfigPath = join(configured, ".arashi", "config.json");
    const configBefore = await readFile(configuredConfigPath, "utf8");
    const configuredResult = await runCli(configured, [
      "create",
      "feature/configured-tab",
      "--tab",
    ]);
    expect(configuredResult.exitCode).not.toBe(0);
    expect(`${configuredResult.stdout}\n${configuredResult.stderr}`).toContain(
      "does not expose a stable tab target",
    );
    expect(await readFile(configuredConfigPath, "utf8")).toBe(configBefore);
    expect(
      (await runCapture(configured, ["git", "branch", "--list", "feature/configured-tab"])).stdout,
    ).toBe("");

    const standalone = await createStandaloneRepository();
    const standaloneResult = await runCli(standalone, [
      "create",
      "feature/standalone-tab",
      "--tab",
    ]);
    expect(standaloneResult.exitCode).not.toBe(0);
    expect(`${standaloneResult.stdout}\n${standaloneResult.stderr}`).toContain(
      "does not expose a stable tab target",
    );
    await expect(access(join(standalone, ".arashi"))).rejects.toThrow();
    expect(
      (await runCapture(standalone, ["git", "branch", "--list", "feature/standalone-tab"])).stdout,
    ).toBe("");
  }, 20_000);

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
          env: launch === "sesh" ? { TMUX: "/tmp/tmux/default" } : {},
          launchSwitchTarget: async (candidate, options) => {
            calls.push({ candidate, options });
            return {
              command: [],
              disposition: options.disposition,
              mode: launch === "auto" ? "kitty" : launch,
            };
          },
          runProcess: async () => ({ exitCode: 0, stderr: "", stdout: "/usr/bin/sesh\n" }),
        },
      );

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.candidate).toMatchObject({
        branchName: `feature/${launch}`,
        repoName: basename(root),
      });
      expect(calls[0]?.options).toEqual({
        disposition: "window",
        ...(launch === "herdr" ? { herdr: true } : {}),
        sesh: launch === "sesh",
      });
      const worktreePath = calls[0]?.candidate.worktreePath;
      expect(worktreePath).toBeDefined();
      await access(await realpath(worktreePath!));
    },
    20_000,
  );

  test("preserves created worktrees when automatic managed Kitty launch fails", async () => {
    const root = await createConfiguredRepository("auto");
    process.chdir(root);
    const branchName = "feature/kitty-launch-failure";

    await expect(
      executeCreate(
        branchName,
        {},
        {
          launchSwitchTarget: async () => {
            throw new SwitchCommandError(
              "Managed Kitty remote-control-inspection failed: permission denied",
              SwitchCommandErrorCode.LAUNCH_FAILED,
              { phase: "remote-control-inspection" },
            );
          },
        },
      ),
    ).rejects.toMatchObject({
      code: SwitchCommandErrorCode.LAUNCH_FAILED,
      context: { phase: "remote-control-inspection" },
    });

    await expect(
      access(
        join(root, ".arashi", "worktrees", `${basename(root)}-feature`, "kitty-launch-failure"),
      ),
    ).resolves.toBeUndefined();
  }, 20_000);

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
          return { command: [], disposition: "window", mode: "sesh" };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(launchCalls).toBe(0);
    await access(join(root, ".arashi", "worktrees", `${basename(root)}-feature`, "no-launch"));
  }, 20_000);
});
