import { describe, expect, test, vi } from "vitest";
import * as workspaceContext from "../../src/lib/workspace-context.ts";
import * as ordinaryDoctor from "../../src/lib/doctor.ts";
import * as status from "../../src/commands/status.ts";
import * as remove from "../../src/core/remove.ts";
import { executeDoctor } from "../../src/commands/doctor.ts";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";

const entry = join(import.meta.dirname, "../../src/index.ts");
const doctor = join(import.meta.dirname, "../../src/commands/doctor.ts");
const onlyFlags = [
  "t3Authenticated",
  "path",
  "t3Cli",
  "t3BaseDir",
  "t3Provider",
  "t3Model",
  "t3Effort",
];
const cliFlags = [
  "--t3-authenticated",
  "--path",
  "--t3-cli",
  "--t3-base-dir",
  "--t3-provider",
  "--t3-model",
  "--t3-effort",
];
const run = (cwd: string, env: NodeJS.ProcessEnv, args: string[]) =>
  new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    execFile(
      args[0] === entry && process.env.D1_COMMAND_EXECUTABLE
        ? process.env.D1_COMMAND_EXECUTABLE
        : "bun",
      args[0] === entry && process.env.D1_COMMAND_EXECUTABLE ? args.slice(1) : args,
      {
        cwd,
        env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
        maxBuffer: 1024 * 1024,
        timeout: 20000,
      },
      (error, stdout, stderr) =>
        resolve({
          exitCode: error ? Number((error as { code?: number }).code) || 1 : 0,
          stderr,
          stdout,
        }),
    );
  });
const direct = (options: Record<string, unknown>) => [
  "-e",
  `import {executeDoctor} from ${JSON.stringify(doctor)}; process.exitCode = await executeDoctor(${JSON.stringify(options)});`,
];
const data = (stdout: string) => {
  const envelope = JSON.parse(stdout);
  expect(envelope.command).toBe("doctor");
  expect(envelope.schemaVersion).toBe(1);
  return envelope.ok ? envelope.data : envelope.error.details;
};

async function fixture(global = false, scenario = "healthy") {
  const f = await createReadinessFixture();
  const cwd = global ? f.root : f.repo;
  const env = {
    ...f.env,
    ARASHI_DIRECTIVE_FILE: join(f.root, "directive"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    T3CODE_HOME: f.baseDir,
  };
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.ARASHI_DIRECTIVE_FILE;
  for (const argv of [
    f.versionArgv,
    f.issueArgv.map((a) => (a === "Arashi handoff" ? "Arashi readiness" : a)),
    [f.cli, "auth", "session", "revoke", "fixture-session-1", "--base-dir", f.baseDir],
    [f.cli, "auth", "session", "list", "--base-dir", f.baseDir, "--json"],
  ]) {
    f.allowProcess(argv, cwd, childEnv);
  }
  for (const path of [
    "/.well-known/t3/environment",
    "/api/auth/session",
    "/api/orchestration/shell",
  ]) {
    f.allowHttp("GET", path);
  }
  f.allowHttp("POST", "/api/auth/websocket-ticket");
  f.allowWs("server.getConfig");
  f.allowWs("Pong");
  const descriptor = {
    capabilities: { repositoryIdentity: true, connectionProbe: true },
    environmentId: "environment-1",
    extension: "CANARY-private",
    orchestrationProtocolVersion: 1,
    platform: { os: process.platform, arch: process.arch },
    serverVersion: "0.0.43",
  };
  const auth = {
    bootstrapMethods: ["one-time-token"],
    policy: "loopback-browser",
    sessionCookieName: "CANARY-private",
    sessionMethods: ["bearer-access-token"],
  };
  await f.configureReadFoundation({
    catalog: {
      environment: descriptor,
      auth,
      providers: [
        {
          instanceId: "instance-a",
          driver: "fixture-driver",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated", email: "CANARY-private" },
          checkedAt: new Date().toISOString(),
          models: [
            {
              slug: "model-a",
              name: "CANARY-private",
              isCustom: false,
              isDefault: true,
              capabilities: { optionDescriptors: [] },
            },
          ],
        },
      ],
      settings: {},
    },
    descriptor,
    session: {
      authenticated: true,
      auth,
      sessionMethod: "bearer-access-token",
      scopes: ["orchestration:read"],
    },
    shell: {
      snapshotSequence: 0,
      updatedAt: new Date().toISOString(),
      projects:
        scenario === "missing-project"
          ? []
          : [{ id: "project-a", workspaceRoot: f.repo, defaultModelSelection: null }],
      threads: [],
    },
    ...(scenario === "read-failed" ? { shellStatus: 500 } : {}),
  });
  if (scenario.startsWith("cleanup-")) {
    const source = await readFile(f.cli, "utf8");
    await writeFile(
      f.cli,
      scenario === "cleanup-failed"
        ? source.replace(
            "console.log('{}');",
            "console.error('CANARY-private');console.log('{}');process.exit(1);",
          )
        : source.replace(
            "console.log(JSON.stringify(load('sessions.json').map(s=>({sessionId:s.sessionId}))));",
            "{console.error('CANARY-private');console.log('{}');}",
          ),
    );
  }
  await f.installMarkers();
  return {
    args: ["doctor", "--t3", "--t3-cli", f.cli, "--t3-base-dir", f.baseDir],
    cwd,
    env,
    f,
    options: { t3: true, json: true, t3Cli: f.cli, t3BaseDir: f.baseDir },
  };
}

describe("doctor T3 command boundary A05/A06/A11/A21", () => {
  test.each(onlyFlags)("direct %s without mode rejects before discovery", async (flag) => {
    const f = await createReadinessFixture();
    try {
      const before = await f.snapshot();
      const result = await run(
        f.root,
        f.env,
        direct({ json: true, [flag]: flag === "t3Authenticated" ? true : "CANARY-private" }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("CANARY-private");
      expect(JSON.parse(result.stdout).error.code).toBe("INVALID_OPTIONS");
      expect(await f.effects()).toEqual([]);
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.dispose();
    }
  });
  test.each(cliFlags)("CLI JSON %s without mode returns a screened envelope", async (flag) => {
    const f = await createReadinessFixture();
    try {
      const before = await f.snapshot();
      const result = await run(f.repo, f.env, [
        entry,
        "doctor",
        "--json",
        flag,
        ...(flag === "--t3-authenticated" ? [] : [flag === "--path" ? f.repo : "CANARY-private"]),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        command: "doctor",
        ok: false,
        error: { code: "INVALID_OPTIONS", message: "T3-only options require --t3." },
        warnings: [],
      });
      expect(result.stdout).not.toContain("CANARY-private");
      expect(result.stdout).not.toContain(f.repo);
      expect(await f.effects()).toEqual([]);
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.dispose();
    }
  });
  test.each(cliFlags)("CLI human %s without mode remains an error", async (flag) => {
    const f = await createReadinessFixture();
    try {
      const before = await f.snapshot();
      const result = await run(f.repo, f.env, [
        entry,
        "doctor",
        flag,
        ...(flag === "--t3-authenticated" ? [] : [flag === "--path" ? f.repo : "CANARY-private"]),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("T3-only options require --t3.");
      expect(result.stderr).not.toContain("CANARY-private");
      expect(result.stderr).not.toContain(f.repo);
      expect(await f.effects()).toEqual([]);
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.dispose();
    }
  });
  test.each(
    ["ordinary", "t3", "t3-authenticated"].flatMap((mode) =>
      [
        { kind: "single", tail: ["unwanted-task"] },
        { kind: "multiple", tail: ["unwanted-task", "CANARY-private"] },
        { kind: "terminator", tail: ["--", "CANARY-private", "--unknown-private"] },
      ].map(({ kind, tail }) => ({ kind, mode, tail })),
    ),
  )("CLI $mode excess $kind rejects before diagnostics", async ({ mode, tail }) => {
    const { f, cwd, env, args } = await fixture();
    try {
      const before = await f.snapshot();
      const commandArgs =
        mode === "ordinary"
          ? ["doctor"]
          : [...args, ...(mode === "t3-authenticated" ? ["--t3-authenticated"] : [])];
      for (const json of [true, false]) {
        const result = await run(cwd, env, [
          entry,
          ...commandArgs,
          ...(json ? ["--json"] : []),
          ...tail,
        ]);
        expect(result.exitCode).toBe(1);
        if (json) {
          expect(JSON.parse(result.stdout)).toEqual({
            command: "doctor",
            error: {
              code: "INVALID_OPTIONS",
              message: "Doctor does not accept positional arguments.",
            },
            ok: false,
            schemaVersion: 1,
            warnings: [],
          });
          expect(result.stderr).toBe("");
        } else {
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe("Doctor does not accept positional arguments.\n");
        }
        expect(result.stdout + result.stderr).not.toContain("CANARY-private");
        expect(result.stdout + result.stderr).not.toContain("--unknown-private");
        expect(result.stdout + result.stderr).not.toContain(cwd);
        expect(await f.effects()).toEqual([]);
        expect(await f.snapshot()).toEqual(before);
      }
    } finally {
      await f.dispose();
    }
  });
  test.each([
    "preview",
    "global",
    "checkout",
    "missing-project",
    "read-failed",
    "cleanup-failed",
    "cleanup-unknown",
  ])("real Bun CLI %s", async (scenario) => {
    const { f, cwd, env, args } = await fixture(scenario === "global", scenario);
    try {
      const before = await f.snapshot();
      const result = await run(cwd, env, [
        entry,
        ...args,
        ...(scenario === "preview" ? [] : ["--t3-authenticated"]),
        "--json",
      ]);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("CANARY-private");
      const outcome = data(result.stdout);
      expect(outcome.mode).toBe("t3");
      expect(result.exitCode).toBe(
        ["read-failed", "cleanup-failed", "cleanup-unknown"].includes(scenario) ? 1 : 0,
      );
      expect(outcome.readiness).toBe(
        scenario === "preview"
          ? "preview_passed"
          : scenario === "global"
            ? "global_verified"
            : scenario === "missing-project"
              ? "unknown"
              : scenario === "read-failed"
                ? "blocked"
                : "checkout_verified",
      );
      expect(outcome.cleanup.state).toBe(
        scenario === "preview"
          ? "not_attempted"
          : scenario === "cleanup-failed"
            ? "failed"
            : scenario === "cleanup-unknown"
              ? "unknown"
              : "verified",
      );
      const effects = await f.effects();
      expect(effects.filter((e) => e.kind === "denied")).toEqual([]);
      expect(effects.filter((e) => e.kind === "session").map((e) => e.action)).toEqual(
        scenario === "preview" ? [] : ["issue", "revoke"],
      );
      expect(
        effects
          .filter((e) => e.kind === "process")
          .every((e) => !e.envKeys?.includes("ARASHI_DIRECTIVE_FILE")),
      ).toBe(true);
      expect(await f.snapshot()).toEqual(before);
      for (const marker of [...Object.values(f.markers), env.ARASHI_DIRECTIVE_FILE]) {
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (process.env.D1_COMMAND_EVIDENCE) {
        await appendFile(
          process.env.D1_COMMAND_EVIDENCE,
          JSON.stringify({
            scenario,
            appRuntime: "bun",
            appEntry: process.env.D1_COMMAND_EXECUTABLE ?? entry,
            cwd,
            appExitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            snapshotUnchanged: true,
            effects: effects.map(({ kind, action, path, method, tag, envKeys }) => ({
              kind,
              action,
              path,
              method,
              tag,
              envKeys,
            })),
          }) + "\n",
        );
      }
    } finally {
      await f.dispose();
    }
  });
  test("direct preview is read-only and human CLI names deferred authority", async () => {
    const { f, cwd, env, args, options } = await fixture();
    try {
      const before = await f.snapshot();
      const result = await run(cwd, env, direct(options));
      expect(result.exitCode).toBe(0);
      expect(data(result.stdout).readiness).toBe("preview_passed");
      const human = await run(cwd, env, [entry, ...args]);
      expect(human.exitCode).toBe(0);
      expect(human.stderr).toBe("");
      expect(human.stdout).toContain("not an authenticated check");
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.dispose();
    }
  });
  test("invalid explicit checkout is static blocked T3 output, no native effects", async () => {
    const { f, cwd, env, options } = await fixture();
    try {
      const result = await run(
        cwd,
        env,
        direct({ ...options, path: join(f.root, "CANARY-private") }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("CANARY-private");
      const outcome = data(result.stdout);
      expect(outcome.mode).toBe("t3");
      expect(outcome.stages[0].state).toBe("failed");
      expect(await f.effects()).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  test("direct dependence guard skips every ordinary entrypoint", async () => {
    const { f, cwd, env, options } = await fixture();
    const oldEnv = process.env;
    const oldCwd = process.cwd();
    const guards = [
      vi.spyOn(workspaceContext, "resolveWorkspaceContext"),
      vi.spyOn(ordinaryDoctor, "runDoctor"),
      vi.spyOn(status, "checkRepoStatus"),
      vi.spyOn(remove, "discoverPrunableWorktrees"),
    ];
    for (const guard of guards) {
      guard.mockImplementation(async () => {
        throw new Error("ordinary collector invoked");
      });
    }
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      process.env = env;
      process.chdir(cwd);
      const before = await f.snapshot();
      expect(await executeDoctor(options)).toBe(0);
      expect(data(String(output.mock.calls[0]?.[0])).readiness).toBe("preview_passed");
      for (const guard of guards) {
        expect(guard).not.toHaveBeenCalled();
      }
      expect(await f.snapshot()).toEqual(before);
    } finally {
      process.env = oldEnv;
      process.chdir(oldCwd);
      vi.restoreAllMocks();
      await f.dispose();
    }
  });
  test.each(["hook-ambiguity", "source-unavailable"])(
    "ordinary blocker %s does not block T3",
    async (kind) => {
      const { f, cwd, env, args } = await fixture();
      const ordinaryFixture = await fixture();
      try {
        for (const configRoot of [cwd, ordinaryFixture.cwd]) {
          await mkdir(join(configRoot, ".arashi"), { recursive: true });
          await writeFile(
            join(configRoot, ".arashi/config.json"),
            JSON.stringify({
              repos:
                kind === "source-unavailable"
                  ? { missing: { path: "./repos/missing", copy: [".env"] } }
                  : {},
              reposDir: "./repos",
              version: "1.0.0",
              ...(kind === "hook-ambiguity"
                ? { hooks: { scripts: { "pre-create": { bash: "exit 0" } } } }
                : {}),
            }),
          );
        }
        const ordinary = await run(ordinaryFixture.cwd, ordinaryFixture.env, [
          entry,
          "doctor",
          "--json",
        ]);
        expect(ordinary.exitCode).toBe(1);
        expect(
          data(ordinary.stdout).findings.map((finding: { code: string }) => finding.code),
          ordinary.stdout,
        ).toContain(
          kind === "hook-ambiguity"
            ? "HOOK_AMBIGUOUS"
            : "MATERIALIZATION_SOURCE_CHECKOUT_UNAVAILABLE",
        );
        const before = await f.snapshot();
        const result = await run(cwd, env, [entry, ...args, "--json"]);
        expect(result.exitCode).toBe(0);
        expect(data(result.stdout).readiness).toBe("preview_passed");
        expect(data(result.stdout).checkedCategories).toEqual(["t3"]);
        expect(await f.snapshot()).toEqual(before);
        expect((await f.effects()).filter((e) => e.kind === "session")).toEqual([]);
      } finally {
        await ordinaryFixture.f.dispose();
        await f.dispose();
      }
    },
  );
  test.each(["ignore", "stale"])("ordinary standalone %s findings stay separate", async (kind) => {
    const { f, cwd, env, args } = await fixture();
    const ordinaryFixture = await fixture();
    try {
      for (const selected of [{ cwd, env }, ordinaryFixture]) {
        await mkdir(join(selected.cwd, ".worktrees"), { recursive: true });
        if (kind === "stale") {
          const linked = join(selected.cwd, ".worktrees", "gone");
          await promisify(execFile)("git", ["worktree", "add", "-b", "gone", linked], {
            cwd: selected.cwd,
            env: selected.env,
          });
          await rm(linked, { force: true, recursive: true });
        }
      }
      const ordinary = await run(ordinaryFixture.cwd, ordinaryFixture.env, [
        entry,
        "doctor",
        "--json",
      ]);
      const observed = data(ordinary.stdout);
      expect(observed.mode).toBe("standalone");
      expect(observed.findings.map((finding: { code: string }) => finding.code)).toContain(
        kind === "ignore" ? "STANDALONE_WORKTREES_NOT_IGNORED" : "WORKTREE_STALE_METADATA",
      );
      const before = await f.snapshot();
      const t3 = await run(cwd, env, [entry, ...args, "--json"]);
      expect(t3.exitCode).toBe(0);
      expect(data(t3.stdout).mode).toBe("t3");
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await ordinaryFixture.f.dispose();
      await f.dispose();
    }
  });
  test("direct extra task positional rejects before diagnostics", async () => {
    const { f, cwd, env, options } = await fixture();
    try {
      const result = await run(cwd, env, [
        "-e",
        `import {executeDoctor} from ${JSON.stringify(doctor)}; process.exitCode = await executeDoctor(${JSON.stringify(options)}, "unwanted-task");`,
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("INVALID_OPTIONS");
      expect(await f.effects()).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  test.each(["healthy", "cleanup-failed", "cleanup-unknown"])(
    "direct authenticated %s and human outcome",
    async (scenario) => {
      const { f, cwd, env, options, args } = await fixture(false, scenario);
      try {
        const before = await f.snapshot();
        const result = await run(
          cwd,
          env,
          direct({
            ...options,
            t3Authenticated: true,
            t3Provider: "instance-a",
            t3Model: "model-a",
          }),
        );
        expect(result.exitCode).toBe(scenario === "healthy" ? 0 : 1);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain("CANARY-private");
        const outcome = data(result.stdout);
        expect(outcome.readiness).toBe("checkout_verified");
        expect(outcome.selection.sources.provider).toBe("cli");
        const human = await run(cwd, env, [entry, ...args, "--t3-authenticated"]);
        expect(human.exitCode).toBe(result.exitCode);
        expect(human.stderr).toBe("");
        expect(human.stdout).not.toContain("CANARY-private");
        expect(human.stdout).toContain("administrative authority");
        expect(human.stdout).toContain(`Cleanup: ${outcome.cleanup.state}`);
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.dispose();
      }
    },
  );
  test("authenticated consent is literal true at direct boundary", async () => {
    const { f, cwd, env, options } = await fixture();
    try {
      const result = await run(cwd, env, direct({ ...options, t3Authenticated: "true" }));
      expect(result.exitCode).toBe(0);
      expect(data(result.stdout).checkMode).toBe("preview");
      expect((await f.effects()).filter((e) => e.kind === "session")).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  test.skipIf(process.platform !== "darwin")(
    "TTY preview does not prompt or authenticate",
    async () => {
      const { f, cwd, env, args } = await fixture();
      try {
        const ttyChildEnv: NodeJS.ProcessEnv = { ...env, PWD: cwd };
        delete ttyChildEnv.ARASHI_DIRECTIVE_FILE;
        f.allowProcess(f.versionArgv, cwd, ttyChildEnv);
        const before = await f.snapshot();
        const { spawn: spawnPty } = await import("node-pty");
        const child = spawnPty("bun", [entry, ...args], {
          cwd,
          env: env as Record<string, string>,
          cols: 200,
          rows: 50,
          name: "xterm-256color",
        });
        let stdout = "";
        child.onData((chunk) => {
          stdout += chunk;
        });
        const exitCode = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("owned TTY probe deadline"));
          }, 20000);
          child.onExit((event) => {
            clearTimeout(timer);
            resolve(event.exitCode);
          });
        });
        expect(exitCode).toBe(0);
        expect(stdout).toContain("not an authenticated check");
        expect(stdout).toContain("preview_passed");
        expect(
          (await f.effects()).filter((e) => e.kind === "session" || e.kind === "denied"),
        ).toEqual([]);
        expect(await f.snapshot()).toEqual(before);
      } finally {
        await f.dispose();
      }
    },
  );
  test("help contains exact grammar without executing diagnostics", async () => {
    const f = await createReadinessFixture();
    try {
      const result = await run(f.root, f.env, [entry, "doctor", "--help"]);
      expect(result.exitCode).toBe(0);
      for (const flag of ["--t3", ...cliFlags]) {
        expect(result.stdout).toContain(flag);
      }
      expect(await f.effects()).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  test("malformed applicable configuration blocks both modes unchanged", async () => {
    const { f, cwd, env, args } = await fixture();
    try {
      await mkdir(join(cwd, ".arashi"), { recursive: true });
      await writeFile(join(cwd, ".arashi/config.json"), "{");
      const before = await f.snapshot();
      for (const argv of [
        [entry, "doctor", "--json"],
        [entry, ...args, "--json"],
      ]) {
        const result = await run(cwd, env, argv);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout).ok).toBe(false);
      }
      expect(await f.effects()).toEqual([]);
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.dispose();
    }
  });
});
