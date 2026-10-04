import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { readT3Config, t3Http } from "../../src/lib/t3-native.ts";
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { runLifecycleHook } from "../../src/lib/hooks.ts";

const fixtures: Awaited<ReturnType<typeof createReadinessFixture>>[] = [];
async function fixture() {
  const value = await createReadinessFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()));
});

describe("D1 effect-ledger fixture foundation (not readiness acceptance)", () => {
  test("registers approved public descriptor and authenticated shell routes without admitting task snapshots", async () => {
    const f = await fixture();
    f.allowHttp("GET", "/.well-known/t3/environment");
    f.allowHttp("GET", "/api/orchestration/shell");
    expect(
      await t3Http(f.origin, undefined, f.dependencies)("/.well-known/t3/environment"),
    ).toMatchObject({ environmentId: "environment-1", orchestrationProtocolVersion: 1 });
    const token = await f.issueOwnedSession();
    expect(await t3Http(f.origin, token, f.dependencies)("/api/orchestration/shell")).toEqual({
      projects: [],
      snapshotSequence: 0,
      threads: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() => f.allowHttp("GET", "/api/orchestration/snapshot")).toThrow("unknown route");
    expect((await fetch(`${f.origin}/api/orchestration/snapshot`)).status).toBe(403);
    await f.revokeOwnedSession();
    expect((await f.effects()).filter((e) => e.kind === "http").map((e) => e.path)).toEqual([
      "/.well-known/t3/environment",
      "/api/orchestration/shell",
    ]);
  });
  test("denies unlisted HTTP paths and methods, even through the real server", async () => {
    const f = await fixture();
    f.allowHttp("GET", "/.well-known/t3/environment");
    expect(
      (await f.dependencies.fetch!(`${f.origin}/.well-known/t3/environment`, { redirect: "error" }))
        .status,
    ).toBe(200);
    await expect(
      f.dependencies.fetch!(`${f.origin}/forbidden`, { redirect: "error" }),
    ).rejects.toThrow("denied");
    await expect(
      f.dependencies.fetch!(`${f.origin}/.well-known/t3/environment`, {
        method: "POST",
        redirect: "error",
      }),
    ).rejects.toThrow("denied");
    expect((await fetch(`${f.origin}/forbidden`)).status).toBe(403);
    expect((await fetch(`${f.origin}/.well-known/t3/environment`, { method: "POST" })).status).toBe(
      403,
    );
    expect((await f.effects()).filter((e) => e.kind === "denied")).toHaveLength(4);
  });

  test("requires strict redirect policy and never follows a redirect", async () => {
    const f = await fixture();
    f.allowHttp("GET", "/redirect");
    await expect(f.dependencies.fetch!(`${f.origin}/redirect`)).rejects.toThrow("denied");
    await expect(
      f.dependencies.fetch!(`${f.origin}/redirect`, { redirect: "error" }),
    ).rejects.toThrow();
    expect((await f.effects()).filter((e) => e.kind === "http").map((e) => e.path)).toEqual([
      "/redirect",
    ]);
  });

  test("denies unlisted WebSocket tags at the actual transport boundary", async () => {
    const f = await fixture();
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    f.allowWs("server.getConfig");
    const token = await f.issueOwnedSession();
    const ticket = await t3Http(f.origin, token, f.dependencies)("/api/auth/websocket-ticket", {});
    await f.sendWs(String(ticket.ticket), {
      _tag: "Request",
      headers: [],
      id: "1",
      payload: {},
      tag: "thread.turn.start",
    });
    const effects = await f.effects();
    expect(effects.some((e) => e.kind === "denied" && e.boundary === "ws")).toBe(true);
    expect(effects.filter((e) => e.kind === "ws")).toEqual([]);
  });

  test("runs real HTTP, catalog WebSocket and fake executable with owned session cleanup", async () => {
    const f = await fixture();
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    f.allowWs("server.getConfig");
    const token = await f.issueOwnedSession();
    const config = await readT3Config(f.origin, token, t3Http(f.origin, token, f.dependencies));
    expect(config.providers).toBeInstanceOf(Array);
    await f.waitForSocketsClosed();
    await f.revokeOwnedSession();
    const events = await f.effects();
    expect(events.filter((e) => e.kind === "socket").map((e) => e.action)).toEqual([
      "open",
      "close",
    ]);
    expect(events.filter((e) => e.kind === "session").map((e) => e.action)).toEqual([
      "issue",
      "revoke",
    ]);
    expect(events.filter((e) => e.kind === "process")).toHaveLength(2);
    expect(await f.activeSessions()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  test("denies unauthorized issuance, unknown processes, CWD/env drift and unknown runtime reads", async () => {
    const f = await fixture();
    await expect(
      f.dependencies.runProcess!(f.issueArgv, { cwd: f.repo, env: f.env }),
    ).rejects.toThrow("denied");
    // Bypassing the injected runner must not bypass issuance policy.
    await expect(
      promisify(execFile)(f.cli, f.issueArgv.slice(1), { cwd: f.repo, env: f.env, timeout: 2000 }),
    ).rejects.toThrow();
    expect(await f.activeSessions()).toEqual([]);
    await expect(
      f.dependencies.runProcess!(["unlisted"], { cwd: f.repo, env: f.env }),
    ).rejects.toThrow("denied");
    f.allowProcess(f.versionArgv);
    expect(
      (
        await promisify(execFile)(f.cli, ["--version"], { cwd: f.repo, env: f.env, timeout: 2000 })
      ).stdout.trim(),
    ).toBe("t3 v0.0.43");
    expect((await f.effects()).filter((e) => e.kind === "process")).toHaveLength(1);
    await expect(
      f.dependencies.runProcess!(f.versionArgv, { cwd: f.root, env: f.env }),
    ).rejects.toThrow("denied");
    await expect(
      f.dependencies.runProcess!(f.versionArgv, {
        cwd: f.repo,
        env: { ...f.env, EXTRA: "private" },
      }),
    ).rejects.toThrow("denied");
    expect(
      (await f.dependencies.runProcess!(f.versionArgv, { cwd: f.repo, env: f.env })).stdout.trim(),
    ).toBe("t3 v0.0.43");
    await expect(f.dependencies.readRuntime!(join(f.root, "unknown"))).rejects.toThrow("denied");
    f.allowRead(f.runtimePath);
    expect(JSON.parse(await f.dependencies.readRuntime!(f.runtimePath)).origin).toBe(f.origin);
    const processEvent = (await f.effects()).find((e) => e.kind === "process")!;
    expect(processEvent.argv).toEqual(f.versionArgv);
    expect(processEvent.cwd).toBe(f.repo);
    expect(processEvent.envKeys).toEqual(Object.keys(f.env).toSorted());
  });

  test("captures immutable bytes, modes, refs and worktree registrations without status", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    expect(await f.snapshot()).toEqual(before);
    await writeFile(join(f.repo, "README.md"), "changed\n");
    await chmod(join(f.repo, "README.md"), 0o600);
    expect(await f.snapshot()).not.toEqual(before);
    expect(before.files.find((entry) => entry.path.endsWith("README.md"))?.bytes.toString()).toBe(
      "fixture\n",
    );
    expect(before.worktrees).toContain(f.repo);
    expect(before.refs).toContain("refs/heads/main");
  });

  test.each(["clean", "process", "fetch", "hook"] as const)(
    "calibrates the real %s marker separately and preserves receipt/empty-lock/orphan-temp",
    async (kind) => {
      const f = await fixture();
      // Git status can refresh other index paths even with a pathspec. Apply
      // Only the calibrated filter in this independent copy; default fixtures
      // Retain both markers for future no-status assertions.
      await f.installMarkers(kind === "clean" || kind === "process" ? kind : undefined);
      const before = await f.snapshotReceipts();
      for (const marker of Object.values(f.markers)) {
        await expect(access(marker)).rejects.toThrow();
      }
      if (kind === "hook") {
        expect((await runLifecycleHook("pre-create", f.repo, {}))?.success).toBe(true);
      } else {
        await f.calibrate(kind);
      }
      // Git may re-run a clean filter while comparing stat/index content.
      // Calibration requires positive execution, not an invented call count.
      const markerEffects = (await readFile(f.markers[kind], "utf8")).trim().split("\n");
      expect(markerEffects.length).toBeGreaterThan(0);
      expect(markerEffects.every((effect) => effect === kind)).toBe(true);
      for (const [name, path] of Object.entries(f.markers)) {
        if (name !== kind) {
          await expect(access(path)).rejects.toThrow();
        }
      }
      expect(await f.snapshotReceipts()).toEqual(before);
      expect(before.files.map((entry) => entry.path.split("/").at(-1)).toSorted()).toEqual([
        "fixture.json",
        "fixture.json.lock",
        "fixture.json.orphan.tmp",
      ]);
      expect(before.files.find((entry) => entry.path.endsWith(".lock"))?.bytes.length).toBe(0);
    },
  );

  test("denies unknown route/read registration and unauthorized tickets/bodies", async () => {
    const f = await fixture();
    expect(() => f.allowHttp("POST", "/api/orchestration/dispatch")).toThrow("unknown route");
    expect(() => f.allowRead(join(f.home, "private.json"))).toThrow("unknown read");
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    expect(
      (await fetch(`${f.origin}/api/auth/websocket-ticket`, { body: "{}", method: "POST" })).status,
    ).toBe(403);
    const token = await f.issueOwnedSession();
    expect(
      (
        await f.dependencies.fetch!(`${f.origin}/api/auth/websocket-ticket`, {
          body: '{"task":"private"}',
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
          redirect: "error",
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${f.origin}/ws?orchestrationProtocol=1&wsTicket=unowned`)).status).toBe(
      403,
    );
    const evidence = JSON.stringify(await f.effects());
    expect(evidence).not.toContain(token);
    expect(evidence).not.toContain("private");
    expect((await f.effects()).filter((e) => e.kind === "denied").map((e) => e.boundary)).toEqual([
      "auth",
      "body",
      "socket",
    ]);
  });

  test("disposes only owned directories and closes the server idempotently", async () => {
    const f = await fixture();
    await f.dispose();
    await f.dispose();
    await expect(access(f.root)).rejects.toThrow();
    await expect(fetch(f.origin)).rejects.toThrow();
  });
});

// Additional independent RED for native-child profile binding and operation bounds.
describe("D1 preview child and bounded operations", () => {
  test("selects T3CODE_HOME and omits directive in the real default version child", async () => {
    const { vi } = await import("vitest");
    const { collectT3ReadinessPreview } = await import("../../src/lib/t3-readiness.ts");
    const { nativeChildEnvironment } = await import("../../src/lib/t3-native.ts");
    const { resolveT3ReadinessContext } = await import("../../src/lib/t3-readiness-context.ts");
    const f = await fixture();
    const context = await resolveT3ReadinessContext({
      cwd: f.repo,
      explicitSettings: { cli: f.cli, baseDir: f.baseDir },
    });
    const cli = await readFile(f.cli, "utf8");
    await writeFile(
      f.cli,
      cli.replace(
        "if (argv[0] === '--version')",
        `if(process.env.T3CODE_HOME !== ${JSON.stringify(f.baseDir)} || process.env.ARASHI_DIRECTIVE_FILE) process.exit(1);\nif (argv[0] === '--version')`,
      ),
    );
    vi.stubEnv("FIXTURE_CONTROL", f.env.FIXTURE_CONTROL!);
    vi.stubEnv("HOME", f.home);
    vi.stubEnv("T3CODE_HOME", "CANARY-wrong-profile");
    vi.stubEnv("ARASHI_DIRECTIVE_FILE", "CANARY-directive");
    try {
      f.allowProcess(f.versionArgv, f.repo, nativeChildEnvironment({ T3CODE_HOME: f.baseDir }));
      f.allowRead(f.runtimePath);
      f.allowHttp("GET", "/.well-known/t3/environment");
      const r = await collectT3ReadinessPreview(
        { cwd: f.repo, context },
        { readRuntime: f.dependencies.readRuntime, fetch: f.dependencies.fetch },
      );
      expect(r.readiness).toBe("preview_passed");
      expect((await f.effects()).find((e) => e.kind === "process")?.envKeys).not.toContain(
        "ARASHI_DIRECTIVE_FILE",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test.each(["version", "runtime", "HTTP", "body"])(
    "bounds hung %s at 15s with virtual time",
    async (kind) => {
      const { vi } = await import("vitest");
      const { collectT3ReadinessPreview } = await import("../../src/lib/t3-readiness.ts");
      const { resolveT3ReadinessContext } = await import("../../src/lib/t3-readiness-context.ts");
      const f = await fixture();
      const context = await resolveT3ReadinessContext({
        cwd: f.repo,
        explicitSettings: { cli: f.cli, baseDir: f.baseDir },
      });
      const raw = await readFile(f.runtimePath, "utf8");
      let cancelled = false;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const never = () => {
        started();
        return new Promise<never>(() => {});
      };
      vi.useFakeTimers();
      try {
        const pending = collectT3ReadinessPreview(
          { cwd: f.repo, context },
          {
            runProcess:
              kind === "version"
                ? never
                : async () => ({ exitCode: 0, stdout: "0.0.43", stderr: "" }),
            readRuntime: kind === "runtime" ? never : async () => raw,
            fetch:
              kind === "HTTP"
                ? never
                : async () =>
                    kind === "body"
                      ? new Response(
                          new ReadableStream({
                            start() {
                              started();
                            },
                            cancel() {
                              cancelled = true;
                            },
                          }),
                        )
                      : Response.json(descriptor()),
          },
        );
        await ready;
        await vi.advanceTimersByTimeAsync(15001);
        const r = await pending;
        expect(r.exitCode).toBe(1);
        expect(
          stage(r, kind === "version" ? "cli" : kind === "runtime" ? "runtime" : "compatibility")
            .code,
        ).toBe("T3_UNREACHABLE");
        if (kind === "body") expect(cancelled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  test.each(["runtime oversize", "stdout oversize", "stderr oversize"])(
    "rejects %s",
    async (kind) => {
      const f = await fixture();
      const large = "x".repeat(1024 * 1024 + 1);
      const r = await preview(
        f,
        kind === "runtime oversize"
          ? { readRuntime: async () => large }
          : {
              runProcess: async () => ({
                exitCode: 0,
                stdout: kind === "stdout oversize" ? large : "0.0.43",
                stderr: kind === "stderr oversize" ? large : "",
              }),
            },
      );
      expect(r.exitCode).toBe(1);
      expect(stage(r, kind === "runtime oversize" ? "runtime" : "cli").code).toBe(
        kind === "runtime oversize" ? "T3_DISCOVERY_INVALID" : "T3_RESPONSE_INVALID",
      );
    },
  );
});

describe("D1 preview read resource boundaries", () => {
  test("cancels a rejected public response body without reading it", async () => {
    const f = await fixture();
    let cancelled = false;
    const r = await preview(f, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        ),
    });
    expect(r.exitCode).toBe(1);
    expect(cancelled).toBe(true);
  });
  test("reads the real runtime with a byte limit without an injected reader", async () => {
    const { collectT3ReadinessPreview } = await import("../../src/lib/t3-readiness.ts");
    const { resolveT3ReadinessContext } = await import("../../src/lib/t3-readiness-context.ts");
    const f = await fixture();
    const context = await resolveT3ReadinessContext({
      cwd: f.repo,
      explicitSettings: { cli: f.cli, baseDir: f.baseDir },
    });
    await writeFile(f.runtimePath, " ".repeat(1024 * 1024 + 1));
    const r = await collectT3ReadinessPreview(
      { cwd: f.repo, context },
      { runProcess: async () => ({ exitCode: 0, stdout: "0.0.43", stderr: "" }) },
    );
    expect(stage(r, "runtime").code).toBe("T3_DISCOVERY_INVALID");
  });
  test("does not open a FIFO runtime as a blocking byte stream", async () => {
    const { collectT3ReadinessPreview } = await import("../../src/lib/t3-readiness.ts");
    const { resolveT3ReadinessContext } = await import("../../src/lib/t3-readiness-context.ts");
    const { rm } = await import("node:fs/promises");
    const f = await fixture();
    const context = await resolveT3ReadinessContext({
      cwd: f.repo,
      explicitSettings: { cli: f.cli, baseDir: f.baseDir },
    });
    await rm(f.runtimePath);
    await promisify(execFile)("mkfifo", [f.runtimePath]);
    // A test watchdog opens the FIFO only after demonstrating the defect; this
    // releases the baseline filesystem request so RED cannot strand the worker.
    const watchdog = setTimeout(() => {
      void writeFile(f.runtimePath, "{}");
    }, 1000);
    const start = performance.now();
    try {
      const r = await collectT3ReadinessPreview(
        { cwd: f.repo, context },
        { runProcess: async () => ({ exitCode: 0, stdout: "0.0.43", stderr: "" }) },
      );
      expect(performance.now() - start).toBeLessThan(500);
      expect(stage(r, "runtime").code).toBe("T3_DISCOVERY_INVALID");
    } finally {
      clearTimeout(watchdog);
    }
  });
  test("global context defers effective selection and has no project lookup", async () => {
    const { collectT3ReadinessPreview } = await import("../../src/lib/t3-readiness.ts");
    const f = await fixture();
    const raw = await readFile(f.runtimePath, "utf8");
    const r = await collectT3ReadinessPreview(
      { cwd: f.root, explicitSettings: { cli: f.cli, baseDir: f.baseDir } },
      {
        runProcess: async () => ({ exitCode: 0, stdout: "0.0.43", stderr: "" }),
        readRuntime: async () => raw,
        fetch: async () => Response.json(descriptor()),
      },
    );
    expect(r.readiness).toBe("preview_passed");
    expect(stage(r, "project").state).toBe("not_applicable");
    expect(stage(r, "effectiveSelection").state).toBe("deferred");
  });
  test("invalid selection fails before any native effect and excludes caught path data", async () => {
    const { collectT3ReadinessPreview } = await import("../../src/lib/t3-readiness.ts");
    const f = await fixture();
    const r = await collectT3ReadinessPreview(
      {
        cwd: f.repo,
        path: join(f.root, "CANARY-missing"),
        explicitSettings: { cli: f.cli, baseDir: f.baseDir },
      },
      f.dependencies,
    );
    expect(stage(r, "selection").state).toBe("failed");
    expect(r.exitCode).toBe(1);
    expect(await f.effects()).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  test.each(["0.0.42", "0.0.43-beta", "bad", "00.0.43", "9007199254740992.0.0", ["0.0.43"], null])(
    "independently rejects server version %s",
    async (serverVersion) => {
      const f = await fixture();
      const r = await preview(f, {
        fetch: async () => Response.json(descriptor({ serverVersion })),
      });
      expect(stage(r, "cli").state).toBe("verified");
      expect(stage(r, "compatibility").code).toBe("T3_VERSION_UNSUPPORTED");
    },
  );
});

async function preview(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const { nativeChildEnvironment, preflightT3Native } = await import("../../src/lib/t3-native.ts");
  const { resolveT3ReadinessContext } = await import("../../src/lib/t3-readiness-context.ts");
  const context = await resolveT3ReadinessContext({
    cwd: f.repo,
    explicitSettings: { cli: f.cli, baseDir: f.baseDir },
  });
  f.allowProcess(
    f.versionArgv,
    f.repo,
    nativeChildEnvironment({ ...f.env, T3CODE_HOME: f.baseDir }),
  );
  f.allowRead(f.runtimePath);
  f.allowHttp("GET", "/.well-known/t3/environment");
  const dependencies = {
    ...f.dependencies,
    runProcess: (argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
      f.dependencies.runProcess(argv, {
        ...options,
        env: nativeChildEnvironment({
          ...f.env,
          T3CODE_HOME: options.env.T3CODE_HOME ?? f.baseDir,
        }),
      }),
    ...overrides,
  };
  // Explicit historical adapter, never enabled in GREEN. Missing-module RED is separate.
  if (process.env.D1_BASELINE_PREVIEW === "1") {
    try {
      return await preflightT3Native(f.repo, dependencies, context.settings, true);
    } catch {
      return {};
    }
  }
  const modulePath = "../../src/lib/t3-readiness.ts";
  return (await import(modulePath)).collectT3ReadinessPreview(
    { cwd: f.repo, context },
    dependencies,
  );
}
const stage = (r: { stages: { name: string; state: string; code: string }[] }, name: string) =>
  r.stages.find((s) => s.name === name)!;
const descriptor = (extra: Record<string, unknown> = {}) => ({
  environmentId: "environment-1",
  serverVersion: "0.0.43",
  orchestrationProtocolVersion: 1,
  platform: { os: process.platform },
  ...extra,
});
describe("D1 bounded preview A06–A09", () => {
  test("A06 preview effect allowlist and immutable state with explicit deferral", async () => {
    const f = await fixture();
    await f.installMarkers();
    const before = await f.snapshot();
    const r = await preview(f);
    expect(r).toMatchObject({
      readiness: "preview_passed",
      exitCode: 0,
      cleanup: { state: "not_attempted" },
    });
    expect(r.stages.map((s: { name: string; state: string }) => [s.name, s.state])).toEqual([
      ["selection", "verified"],
      ["cli", "verified"],
      ["runtime", "verified"],
      ["compatibility", "verified"],
      ["authentication", "deferred"],
      ["catalog", "deferred"],
      ["project", "deferred"],
      ["effectiveSelection", "deferred"],
    ]);
    expect(await f.snapshot()).toEqual(before);
    if (process.env.D1_PREVIEW_EVIDENCE) {
      await writeFile(
        join(process.env.D1_PREVIEW_EVIDENCE, "preview-effects.json"),
        JSON.stringify({ immutableSnapshotEqual: true, events: await f.effects() }),
      );
    }
    expect(await f.activeSessions()).toEqual([]);
    expect((await f.effects()).map((e) => e.kind)).toEqual(["process", "read", "http"]);
    for (const marker of Object.values(f.markers)) await expect(access(marker)).rejects.toThrow();
  });
  test.each([
    ["JSON", "{"],
    ["version", { version: 2 }],
    ["PID zero", { pid: 0 }],
    ["PID unsafe", { pid: 9007199254740992 }],
    ["PID string", { pid: "12" }],
    ["port zero", { port: 0 }],
    ["port large", { port: 65536 }],
    ["port string", { port: "80" }],
    ["origin type", { origin: {} }],
    ["remote", { origin: "http://remote.invalid:1234" }],
    ["credentials", { origin: "http://user:CANARY@127.0.0.1:1234" }],
    ["path", { origin: "http://127.0.0.1:1234/CANARY" }],
    ["query", { origin: "http://127.0.0.1:1234/?CANARY" }],
    ["hash", { origin: "http://127.0.0.1:1234/#CANARY" }],
    ["https", { origin: "https://127.0.0.1:1234" }],
    ["mismatch", { port: 1234 }],
  ])("A07/A09 runtime %s rejects before HTTP", async (_name, change) => {
    const f = await fixture();
    const raw = JSON.parse(await readFile(f.runtimePath, "utf8"));
    await writeFile(
      f.runtimePath,
      typeof change === "string" ? change : JSON.stringify({ ...raw, ...change }),
    );
    const r = await preview(f);
    expect(r.exitCode).toBe(1);
    expect(stage(r, "runtime")).toMatchObject({ state: "failed", code: "T3_DISCOVERY_INVALID" });
    expect((await f.effects()).some((e) => e.kind === "http")).toBe(false);
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  test.each(["base", "runtime", "CLI"])("A07 missing %s", async (kind) => {
    const f = await fixture();
    const { rm } = await import("node:fs/promises");
    await rm(kind === "base" ? f.baseDir : kind === "runtime" ? f.runtimePath : f.cli, {
      recursive: true,
    });
    const r = await preview(f);
    expect(r.exitCode).toBe(1);
    expect(stage(r, kind === "CLI" ? "cli" : "runtime").code).toBe(
      kind === "CLI" ? "T3_CLI_NOT_FOUND" : "T3_ENVIRONMENT_MISSING",
    );
  });
  test.each(["ESRCH", "EPERM"])("A07 PID %s", async (code) => {
    const f = await fixture();
    let count = 0;
    const r = await preview(f, {
      probePid: () => {
        count++;
        throw Object.assign(new Error("CANARY"), { code });
      },
    });
    expect(count).toBe(1);
    expect(r.readiness).toBe(code === "EPERM" ? "preview_passed" : "blocked");
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  test.each(["127.0.0.1", "localhost", "[::1]"])("A07 loopback %s", async (host) => {
    const f = await fixture();
    const raw = JSON.parse(await readFile(f.runtimePath, "utf8"));
    raw.origin = `http://${host}:${raw.port}`;
    await writeFile(f.runtimePath, JSON.stringify(raw));
    const r = await preview(f, {
      fetch: async (input: URL, init: RequestInit) => {
        expect(new URL(String(input)).hostname).toBe(host);
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        return Response.json(descriptor());
      },
    });
    expect(r.readiness).toBe("preview_passed");
  });
  test.each([
    "0.0.43",
    "0.0.45",
    "1.2.3",
    "0.0.42",
    "0.0.45-beta",
    "bad",
    "00.0.43",
    "9007199254740992.0.0",
  ])("A08 version %s", async (version) => {
    const f = await fixture();
    const r = await preview(f, {
      runProcess: async () => ({ exitCode: 0, stdout: `t3 v${version}`, stderr: "CANARY" }),
      fetch: async () => Response.json(descriptor({ serverVersion: version })),
    });
    expect(r.readiness).toBe(
      ["0.0.43", "0.0.45", "1.2.3"].includes(version) ? "preview_passed" : "blocked",
    );
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  test.each([
    ["mismatch", { serverVersion: "0.0.45" }, "T3_VERSION_MISMATCH"],
    ["protocol2", { orchestrationProtocolVersion: 2 }, "T3_PROTOCOL_UNSUPPORTED"],
    ["missing protocol", { orchestrationProtocolVersion: undefined }, "T3_PROTOCOL_UNSUPPORTED"],
    ["id", { environmentId: "CANARY/invalid" }, "T3_ENVIRONMENT_INVALID"],
    ["platform", { platform: { os: "other" } }, "T3_ENVIRONMENT_INVALID"],
    ["empty id", { environmentId: "" }, "T3_ENVIRONMENT_INVALID"],
  ])("A08/A09 descriptor %s", async (_name, extra, code) => {
    const f = await fixture();
    const r = await preview(f, { fetch: async () => Response.json(descriptor(extra)) });
    expect(stage(r, "compatibility")).toMatchObject({ state: "failed", code });
    expect(r.exitCode).toBe(1);
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  test.each([401, 403, 500, 302])("A09 HTTP %s", async (status) => {
    const f = await fixture();
    const r = await preview(f, {
      fetch: async (_input: URL, init: RequestInit) => {
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        return new Response("CANARY", {
          status,
          headers: { location: "http://private.invalid/CANARY" },
        });
      },
    });
    expect(r.exitCode).toBe(1);
    expect(stage(r, "authentication").state).toBe("deferred");
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
  test.each(["invalid", "empty", "oversize", "throw"])("A09 response %s", async (kind) => {
    const f = await fixture();
    const r = await preview(f, {
      fetch: async () => {
        if (kind === "throw") throw new Error("CANARY");
        return new Response(
          kind === "oversize" ? " ".repeat(1024 * 1024 + 1) : kind === "empty" ? "{}" : "CANARY",
        );
      },
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
});
