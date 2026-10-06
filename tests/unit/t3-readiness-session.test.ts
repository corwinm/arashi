import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as native from "../../src/lib/t3-native.ts";
import { T3HandoffError } from "../../src/lib/t3-error.ts";
import { nativeEnvironment } from "../helpers/t3-native.ts";

import * as readiness from "../../src/lib/t3-readiness.ts";
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// Opt-in historical adapter exercises the REAL legacy issue/use/revoke path.
// It cannot recover the successful return value that legacy cleanup discards.
async function owned(
  ...args: Parameters<typeof native.withT3Session>
): Promise<native.T3OwnedSessionResult<unknown>> {
  if (process.env.ARASHI_SESSION_LEGACY_RED === "1") {
    try {
      return {
        use: { status: "succeeded", value: await native.withT3Session(...args) },
        cleanup: { status: "unknown", revoke: "succeeded" },
      };
    } catch {
      return {
        use: { status: "not_attempted" },
        cleanup: { status: "unknown", revoke: "not_attempted" },
      };
    }
  }
  return native.withOwnedT3Session(...args);
}
const body = (fields: object = {}) =>
  JSON.stringify({
    sessionId: "owned-session",
    token: "FIXTURE_SECRET",
    method: "bearer-access-token",
    scopes: ["orchestration:read"],
    expiresAt: "2026-10-04T12:00:00Z",
    ...fields,
  });
// Pinned official cliAuthFormat.ts formatSessionList: array, no `current` field.
const active = (fields: object = {}) => ({
  sessionId: "unrelated-session",
  method: "bearer-access-token",
  scopes: ["orchestration:read"],
  subject: "PRIVATE_SUBJECT",
  client: { deviceType: "bot", label: "PRIVATE_LABEL" },
  connected: false,
  issuedAt: "2026-10-04T11:00:00.000Z",
  expiresAt: "2026-10-04T12:00:00.000Z",
  lastConnectedAt: null,
  ...fields,
});
function runner(
  stdout: string,
  exitCode = 0,
  revoke: number | Error = 0,
  list: string | Error = "[]",
  listExit = 0,
  listStderr = "PRIVATE_STDERR",
) {
  const commands: string[][] = [];
  const runProcess: NonNullable<native.T3NativeDependencies["runProcess"]> = async (command) => {
    commands.push([...command]);
    if (command.includes("issue")) return { stdout, exitCode, stderr: "PRIVATE_STDERR" };
    if (command.includes("list")) {
      if (list instanceof Error) throw list;
      return { stdout: list, exitCode: listExit, stderr: listStderr };
    }
    if (revoke instanceof Error) throw revoke;
    return { stdout: "", stderr: "PRIVATE_STDERR", exitCode: revoke };
  };
  return { commands, runProcess };
}
describe("owned session foundation", () => {
  test.each([
    ["exact absent", "[]", "verified"],
    [
      "unrelated sessions",
      JSON.stringify([
        active(),
        active({ sessionId: "another-session", method: "browser-session-cookie" }),
      ]),
      "verified",
    ],
    ["exit zero still active", JSON.stringify([active({ sessionId: "owned-session" })]), "failed"],
    [
      "target plus unrelated",
      JSON.stringify([active(), active({ sessionId: "owned-session" })]),
      "failed",
    ],
  ])("A15 %s", async (_name, list, status) => {
    const fixture = runner(body(), 0, 0, list);
    const result = await owned(nativeEnvironment(), ".", fixture, async () => "observed");
    expect(result.use).toEqual({ status: "succeeded", value: "observed" });
    expect(result.cleanup).toEqual({ status, revoke: "succeeded" });
    expect(fixture.commands.map((command) => command[3])).toEqual(["issue", "revoke", "list"]);
    expect(fixture.commands[2]).toEqual([
      "t3",
      "auth",
      "session",
      "list",
      "--base-dir",
      "/t3",
      "--json",
    ]);
    expect(fixture.commands.filter((command) => command.includes("revoke"))).toHaveLength(1);
    expect(fixture.commands.flat()).not.toContain("FIXTURE_SECRET");
    expect(fixture.commands.flat()).not.toContain("unrelated-session");
    expect(JSON.stringify(result)).not.toMatch(
      /FIXTURE_SECRET|PRIVATE_|owned-session|unrelated-session|another-session/,
    );
  });
  const invalidEntries: [string, unknown][] = [
    ["null entry", null],
    ["array entry", []],
    ["scalar entry", 1],
    ["missing ID", active({ sessionId: undefined })],
    ["object ID", active({ sessionId: {} })],
    ["array ID", active({ sessionId: ["unrelated-session"] })],
    ["unsafe ID", active({ sessionId: "--all" })],
    ["empty ID", active({ sessionId: "" })],
    ["number ID", active({ sessionId: 1 })],
    ["array method", active({ method: ["bearer-access-token"] })],
    ["unknown method", active({ method: "invalid" })],
    ["missing method", active({ method: undefined })],
    ["scalar scopes", active({ scopes: "orchestration:read" })],
    ["object scope", active({ scopes: [{}] })],
    ["unknown scope", active({ scopes: ["invalid"] })],
    ["missing scopes", active({ scopes: undefined })],
    ["array subject", active({ subject: ["private"] })],
    ["empty subject", active({ subject: "" })],
    ["array client", active({ client: [] })],
    ["missing client", active({ client: undefined })],
    ["bad device", active({ client: { deviceType: [] } })],
    ["bad label", active({ client: { deviceType: "bot", label: {} } })],
    ...["ipAddress", "userAgent", "os", "browser"].map((field): [string, unknown] => [
      "bad client " + field,
      active({ client: { deviceType: "bot", [field]: [] } }),
    ]),
    ["array connected", active({ connected: [false] })],
    ["missing connected", active({ connected: undefined })],
    ["array issuedAt", active({ issuedAt: [] })],
    ["invalid issuedAt", active({ issuedAt: "not-date" })],
    ["missing issuedAt", active({ issuedAt: undefined })],
    ["object expiresAt", active({ expiresAt: {} })],
    ["invalid expiresAt", active({ expiresAt: "2026-02-30T12:00:00.000Z" })],
    ["array lastConnectedAt", active({ lastConnectedAt: [] })],
    ["missing lastConnectedAt", active({ lastConnectedAt: undefined })],
  ];
  test.each([
    ["object envelope", '{"sessions":[]}'],
    ["null", "null"],
    ["boolean", "true"],
    ["number", "1"],
    ["string", '"[]"'],
    ["malformed JSON", "["],
    ["duplicate IDs", JSON.stringify([active(), active()])],
    ["oversize ASCII", "[]" + " ".repeat(1024 * 1024)],
    ["oversize UTF8", JSON.stringify([active({ subject: "é".repeat(600_000) })])],
    ...invalidEntries.map(([name, entry]) => [
      name,
      JSON.stringify([active({ sessionId: "valid-first" }), entry]),
    ]),
    ["target before invalid entry", JSON.stringify([active({ sessionId: "owned-session" }), null])],
  ])("A15 invalid list %s", async (_name, list) => {
    const fixture = runner(body(), 0, 0, list);
    const result = await owned(nativeEnvironment(), ".", fixture, async () => true);
    expect(result.use).toEqual({ status: "succeeded", value: true });
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "succeeded" });
    expect(fixture.commands.map((command) => command[3])).toEqual(["issue", "revoke", "list"]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|owned-session|unrelated-session/);
  });
  test.each([
    ["nonzero", "[]", 1, "private"],
    ["timeout", new Error("timeout PRIVATE_STDERR"), 0, ""],
    ["spawn throw", new Error("spawn PRIVATE_STDERR"), 0, ""],
    ["stderr oversized", "[]", 0, "x".repeat(1024 * 1024 + 1)],
  ])("A15 list %s", async (_name, list, exitCode, stderr) => {
    const fixture = runner(body(), 0, 0, list, exitCode, stderr);
    const result = await owned(nativeEnvironment(), ".", fixture, async () => {
      throw new T3HandoffError("T3_RESPONSE_INVALID", "private");
    });
    expect(result.use.status).toBe("failed");
    expect(result.failure?.code).toBe("T3_RESPONSE_INVALID");
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "succeeded" });
    expect(fixture.commands).toHaveLength(3);
  });
  test.each([1, new Error("PRIVATE_STDERR")])(
    "A15 failed revoke remains failed despite absence %s",
    async (revoke) => {
      const fixture = runner(body(), 0, revoke, "[]");
      const result = await owned(nativeEnvironment(), ".", fixture, async () => true);
      expect(result.cleanup).toEqual({ status: "failed", revoke: "failed" });
      expect(fixture.commands.map((command) => command[3])).toEqual(["issue", "revoke", "list"]);
    },
  );
  test("A15 legacy success performs no verification, even if list would fail", async () => {
    const fixture = runner(body(), 0, 0, new Error("must not list"));
    await expect(
      native.withT3Session(nativeEnvironment(), ".", fixture, async () => undefined),
    ).resolves.toBeUndefined();
    expect(fixture.commands.map((command) => command[3])).toEqual(["issue", "revoke"]);
    const error = new Error("raw issue failure");
    await expect(
      native.withT3Session(
        nativeEnvironment(),
        ".",
        {
          runProcess: async () => {
            throw error;
          },
        },
        async () => true,
      ),
    ).rejects.toBe(error);
  });

  test("preserves successful use independently when revoke fails", async () => {
    const fixture = runner(body(), 0, 1);
    const result = await owned(nativeEnvironment(), ".", fixture, async () => "observed");
    expect(result.use).toEqual({ status: "succeeded", value: "observed" });
    expect(result.cleanup).toEqual({ status: "failed", revoke: "failed" });
  });
  test("cleans exact attributable ID with invalid token without using it", async () => {
    const fixture = runner(body({ token: {} }));
    let uses = 0;
    await owned(nativeEnvironment(), ".", fixture, async () => {
      uses++;
    });
    expect(uses).toBe(0);
    expect(fixture.commands.find((command) => command.includes("revoke"))).toEqual([
      "t3",
      "auth",
      "session",
      "revoke",
      "owned-session",
      "--base-dir",
      "/t3",
    ]);
  });
  test("exports the separate structured primitive", () => {
    expect(native.withOwnedT3Session).toBeTypeOf("function");
  });
  test.each([
    ["nonzero with ID", body(), 1, true],
    ["empty token", body({ token: "" }), 0, true],
    ["object token", body({ token: {} }), 0, true],
    ["array token", body({ token: ["secret"] }), 0, true],
    ["malformed JSON", "{", 0, false],
    ["missing ID", body({ sessionId: undefined }), 0, false],
    ["object ID", body({ sessionId: {} }), 0, false],
    ["array ID", body({ sessionId: ["owned-session"] }), 0, false],
    ["unsafe ID", body({ sessionId: "--all" }), 0, false],
    ["empty object", "{}", 0, false],
  ])("A13 %s", async (_name, stdout, exitCode, cleanup) => {
    const fixture = runner(stdout as string, exitCode as number);
    let uses = 0;
    const result = await owned(nativeEnvironment(), ".", fixture, async () => {
      uses++;
    });
    expect(uses).toBe(0);
    expect(result.use.status).toBe("not_attempted");
    expect(result.failure).toMatchObject({ code: "T3_AUTH_FAILED" });
    expect(result.cleanup).toEqual({
      status: cleanup ? "verified" : "unknown",
      revoke: cleanup ? "succeeded" : "not_attempted",
    });
    expect(fixture.commands.filter((command) => command.includes("revoke"))).toHaveLength(
      cleanup ? 1 : 0,
    );
    expect(fixture.commands.filter((command) => command.includes("list"))).toHaveLength(
      cleanup ? 1 : 0,
    );
    expect(JSON.stringify(result)).not.toMatch(/FIXTURE_SECRET|PRIVATE_STDERR|owned-session/);
  });
  test.each(["spawn failure", "timeout"])(
    "A13 issue %s sanitizes failure and cannot guess cleanup",
    async (reason) => {
      const commands: string[][] = [];
      const result = await owned(
        nativeEnvironment(),
        ".",
        {
          runProcess: async (command) => {
            commands.push([...command]);
            throw new Error(`${reason} PRIVATE_STDERR`);
          },
        },
        async () => {
          throw new Error("must not use");
        },
      );
      expect(commands).toHaveLength(1);
      expect(result.failure).toMatchObject({ code: "T3_AUTH_FAILED" });
      expect(result.cleanup).toEqual({ status: "unknown", revoke: "not_attempted" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_STDERR");
    },
  );
  test.each([0, 1, new Error("PRIVATE_STDERR")])(
    "retains read failure with revoke %s",
    async (revoke) => {
      const fixture = runner(body(), 0, revoke);
      const result = await owned(nativeEnvironment(), ".", fixture, async () => {
        throw new T3HandoffError("T3_RESPONSE_INVALID", "T3 returned an incompatible response.");
      });
      expect(result.use.status).toBe("failed");
      expect(result.failure).toMatchObject({ code: "T3_RESPONSE_INVALID" });
      expect(result.cleanup).toEqual({
        status: revoke === 0 ? "verified" : "failed",
        revoke: revoke === 0 ? "succeeded" : "failed",
      });
    },
  );
  test("undefined successful value is not a failed use", async () => {
    const result = await owned(nativeEnvironment(), ".", runner(body()), async () => undefined);
    expect(result.use).toEqual({ status: "succeeded", value: undefined });
    expect(result.cleanup).toEqual({ status: "verified", revoke: "succeeded" });
  });
  test("legacy wrapper preserves label, malformed issuance effects and cleanup error precedence", async () => {
    const invalid = runner(body({ token: {} }));
    await expect(
      native.withT3Session(nativeEnvironment(), ".", invalid, async () => 1),
    ).rejects.toMatchObject({ code: "T3_AUTH_FAILED" });
    expect(invalid.commands).toHaveLength(1);
    expect(invalid.commands[0]).toContain("Arashi handoff");
    const valid = runner(body(), 0, 1);
    await expect(
      native.withT3Session(nativeEnvironment(), ".", valid, async () => {
        throw new T3HandoffError("T3_RESPONSE_INVALID", "safe");
      }),
    ).rejects.toMatchObject({
      code: "T3_RESPONSE_INVALID",
      details: { sessionCleanupFailed: true },
    });
  });
  test("screens typed callback failure fields while legacy retains original error", async () => {
    const error = new T3HandoffError("T3_RESPONSE_INVALID", "FIXTURE_SECRET", {
      raw: "PRIVATE_STDERR",
    });
    const result = await owned(nativeEnvironment(), ".", runner(body()), async () => {
      throw error;
    });
    expect(result.failure?.code).toBe("T3_RESPONSE_INVALID");
    expect(result.failure?.message).not.toContain("FIXTURE_SECRET");
    expect(JSON.stringify(result)).not.toMatch(/FIXTURE_SECRET|PRIVATE_STDERR/);
    await expect(
      native.withT3Session(nativeEnvironment(), ".", runner(body()), async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
  test("falsey callback rejection is still structured failure", async () => {
    const result = await owned(nativeEnvironment(), ".", runner(body()), async () => {
      throw undefined;
    });
    expect(result.use.status).toBe("failed");
    expect(result.failure?.code).toBe("T3_HANDOFF_FAILED");
  });
  test("real owned executable and loopback read enforce direct argv/profile/exact revoke", async () => {
    const root = await mkdtemp(join(tmpdir(), "owned-session-"));
    roots.push(root);
    const cli = join(root, "fake-t3.cjs");
    const ledger = join(root, "ledger.jsonl");
    await writeFile(
      cli,
      `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv.slice(2); const base = ${JSON.stringify(root)}; if (process.env.T3CODE_HOME !== base || process.env.ARASHI_DIRECTIVE_FILE || process.cwd() !== base) process.exit(9); const issue = ['auth','session','issue','--base-dir',base,'--ttl','5m','--label','Arashi readiness','--json']; const revoke = ['auth','session','revoke','owned-session','--base-dir',base]; const list = ['auth','session','list','--base-dir',base,'--json']; if (JSON.stringify(a)!==JSON.stringify(issue) && JSON.stringify(a)!==JSON.stringify(revoke) && JSON.stringify(a)!==JSON.stringify(list)) process.exit(8); fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ operation:a[2], cwdBound:true, profileBound:true })+'\\n'); if (a[2]==='issue') console.log(${JSON.stringify(body())}); if (a[2]==='list') console.log(${JSON.stringify(JSON.stringify([active()]))});\n`,
    );
    await chmod(cli, 0o700);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    for (const args of [
      ["auth", "session", "list", "--base-dir", root, "--json", "FIXTURE_SECRET"],
      ["auth", "session", "revoke", "unrelated-session", "--base-dir", root],
    ]) {
      await expect(
        promisify(execFile)(cli, args, {
          cwd: root,
          env: native.nativeChildEnvironment({ T3CODE_HOME: root }),
        }),
      ).rejects.toMatchObject({ code: 8 });
    }
    const { createServer } = await import("node:http");
    let reads = 0;
    const server = createServer((request, response) => {
      if (
        request.url !== "/fixture-read" ||
        request.method !== "GET" ||
        request.headers.authorization !== "Bearer FIXTURE_SECRET"
      ) {
        response.writeHead(403).end();
        return;
      }
      reads++;
      response.setHeader("content-type", "application/json");
      response.end('{"observed":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture address");
      const result = await owned(
        { baseDir: root, cli, origin: `http://127.0.0.1:${address.port}` },
        root,
        {},
        async (request) => (await request("/fixture-read")).observed,
      );
      expect(result.use).toEqual({ status: "succeeded", value: true });
      expect(result.cleanup).toEqual({ status: "verified", revoke: "succeeded" });
      expect(reads).toBe(1);
      expect(
        (await readFile(ledger, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).operation),
      ).toEqual(["issue", "revoke", "list"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

// Opt-in unchanged owned acquisition/read path: behavioral RED, not missing API RED.
const readFoundation = async (
  preview: readiness.T3ReadinessPreview,
  authenticated: boolean,
  f: Awaited<ReturnType<typeof createReadinessFixture>>,
) => {
  if (process.env.ARASHI_READ_LEGACY_RED === "1")
    return native.withOwnedT3Session(
      { baseDir: f.baseDir, cli: f.cli, origin: f.origin },
      preview.stages.find((s) => s.name === "project")?.state === "not_applicable"
        ? f.root
        : f.repo,
      {},
      async (request, token) => {
        await native.readT3Config(f.origin, token, request);
        await request("/api/auth/session");
        return {
          authentication: "verified",
          catalog: "read",
          project: "deferred",
          effectiveSelection: "deferred",
          authority: "administrative",
        };
      },
    );
  return readiness.collectT3AuthenticatedReadFoundation(preview, { authenticated });
};
const authDescriptor = () => ({
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "fixture-cookie",
});
const readShape = () => {
  const descriptor = {
    environmentId: "environment-1",
    serverVersion: "0.0.43",
    orchestrationProtocolVersion: 1,
    platform: { os: process.platform, arch: process.arch },
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  };
  return {
    descriptor,
    session: {
      authenticated: true,
      auth: authDescriptor(),
      scopes: [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "access:read",
        "access:write",
        "relay:write",
      ],
      sessionMethod: "bearer-access-token",
      expiresAt: "2026-10-04T12:00:00.000Z",
    },
    catalog: { environment: descriptor, auth: authDescriptor(), providers: [], settings: {} },
    shell: {
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
};
async function readCase(
  checkout: boolean,
  run: (
    f: Awaited<ReturnType<typeof createReadinessFixture>>,
    p: readiness.T3ReadinessPreview,
    shape: ReturnType<typeof readShape>,
  ) => Promise<void>,
) {
  const f = await createReadinessFixture();
  const saved = process.env;
  process.env = {
    ...f.env,
    T3CODE_HOME: f.baseDir,
    ARASHI_DIRECTIVE_FILE: "PRIVATE_DIRECTIVE",
    ...(saved.ARASHI_READ_LEGACY_RED
      ? { ARASHI_READ_LEGACY_RED: saved.ARASHI_READ_LEGACY_RED }
      : {}),
  };
  try {
    const childEnv = native.nativeChildEnvironment({ T3CODE_HOME: f.baseDir });
    const cwd = checkout ? f.repo : f.root;
    f.allowProcess(f.versionArgv, cwd, childEnv);
    f.allowProcess(
      f.issueArgv.map((a) => (a === "Arashi handoff" ? "Arashi readiness" : a)),
      cwd,
      childEnv,
    );
    f.allowProcess(
      [f.cli, "auth", "session", "revoke", "fixture-session-1", "--base-dir", f.baseDir],
      cwd,
      childEnv,
    );
    f.allowProcess(
      [f.cli, "auth", "session", "list", "--base-dir", f.baseDir, "--json"],
      cwd,
      childEnv,
    );
    f.allowHttp("GET", "/.well-known/t3/environment");
    f.allowHttp("GET", "/api/auth/session");
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    if (checkout) f.allowHttp("GET", "/api/orchestration/shell");
    f.allowWs("server.getConfig");
    f.allowWs("Pong");
    const shape = readShape();
    await f.configureReadFoundation(shape);
    const context = {
      checkout: checkout ? f.repo : null,
      settings: { baseDir: f.baseDir, cli: f.cli },
      workspaceRoot: null,
      workspace: null,
      roots: null,
      sources: {},
    };
    const p = await readiness.collectT3ReadinessPreview({ cwd: f.root, context });
    expect(p.readiness).toBe("preview_passed");
    // Caller mutation after preview is deliberately not acquisition authority.
    context.settings.cli = "PRIVATE_alternative";
    context.settings.baseDir = f.root;
    context.checkout = f.root;
    p.facts.environmentId = "PRIVATE_public";
    await run(f, p, shape);
    await f.waitForSocketsClosed();
    expect(await f.activeSessions()).toEqual([]);
    const effects = await f.effects();
    expect(effects.filter((e) => e.kind === "denied")).toEqual([]);
    if (saved.D1_AUTH_READ_EVIDENCE) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        join(saved.D1_AUTH_READ_EVIDENCE, "screened-ledgers.jsonl"),
        JSON.stringify({
          case: expect.getState().currentTestName,
          runtime: { node: process.versions.node, executable: process.execPath },
          checkout,
          events: effects.map((e) => ({
            kind: e.kind,
            operation: e.argv ? (e.argv[1] === "--version" ? "version" : e.argv[3]) : undefined,
            method: e.method,
            path: e.kind === "http" ? e.path : undefined,
            body: e.body,
            tag: e.tag,
            action: e.action,
            directiveAbsent: e.envKeys ? !e.envKeys.includes("ARASHI_DIRECTIVE_FILE") : undefined,
            cwdBound: e.cwd ? e.cwd === cwd : undefined,
          })),
          remainingSessions: 0,
        }) + "\n",
      );
    }
  } finally {
    process.env = saved;
    await f.dispose();
  }
}
describe("Task4.4 authenticated read foundation", () => {
  test("separate API setup", () => {
    expect(readiness.collectT3AuthenticatedReadFoundation).toBeTypeOf("function");
  });
  test.each([false, true])("A11 actual task-free acquisition checkout=%s", async (checkout) =>
    readCase(checkout, async (f, p) => {
      const r = await readFoundation(p, true, f);
      expect(r.use).toEqual({
        status: "succeeded",
        value: {
          authentication: "verified",
          catalog: "read",
          project: checkout ? "deferred" : "not_applicable",
          effectiveSelection: "deferred",
          authority: "administrative",
        },
      });
      expect(r.cleanup).toEqual({ status: "verified", revoke: "succeeded" });
      const e = await f.effects();
      expect(e.filter((x) => x.kind === "http").map((x) => [x.method, x.path, x.body])).toEqual([
        ["GET", "/.well-known/t3/environment", "absent"],
        ["GET", "/.well-known/t3/environment", "absent"],
        ["GET", "/api/auth/session", "absent"],
        ["POST", "/api/auth/websocket-ticket", "empty-object"],
        ...(checkout ? [["GET", "/api/orchestration/shell", "absent"]] : []),
      ]);
      expect(
        e
          .filter((x) => x.kind === "process")
          .map((x) => (x.argv![1] === "--version" ? "version" : x.argv![3])),
      ).toEqual(["version", "version", "issue", "revoke", "list"]);
      expect(e.findIndex((x) => x.kind === "socket" && x.action === "close")).toBeLessThan(
        e.findIndex((x) => x.kind === "session" && x.action === "revoke"),
      );
      expect(e.filter((x) => x.kind === "ws").map((x) => x.tag)).toEqual([
        "server.getConfig",
        "Pong",
      ]);
      expect(JSON.stringify(r)).not.toMatch(/environment-1|fixture-cookie|127\.0\.0\.1|PRIVATE/);
    }),
  );
  test.each(["CLI", "server", "environment", "consent", "copy"])(
    "A10 issuance gate %s",
    async (kind) =>
      readCase(true, async (f, p, shape) => {
        if (kind === "CLI")
          await writeFile(
            f.cli,
            (await readFile(f.cli, "utf8")).replace("t3 v0.0.43", "t3 v0.0.45"),
          );
        if (kind === "server")
          await f.configureReadFoundation({
            ...shape,
            descriptor: { ...shape.descriptor, serverVersion: "0.0.45" },
          });
        if (kind === "environment")
          await f.configureReadFoundation({
            ...shape,
            descriptor: { ...shape.descriptor, environmentId: "other-environment" },
          });
        await expect(
          readFoundation(kind === "copy" ? structuredClone(p) : p, kind !== "consent", f),
        ).rejects.toMatchObject({
          code:
            kind === "consent"
              ? "T3_AUTHENTICATED_REQUIRED"
              : kind === "copy"
                ? "T3_PREVIEW_REQUIRED"
                : "T3_IDENTITY_CHANGED",
        });
        expect((await f.effects()).filter((e) => e.kind === "session")).toEqual([]);
      }),
  );
  test.each([
    ["unauthenticated", { authenticated: false }],
    ["array authenticated", { authenticated: [true] }],
    ["missing scopes", { scopes: undefined }],
    ["missing read", { scopes: ["orchestration:operate"] }],
    ["scalar scopes", { scopes: "orchestration:read" }],
    ["scope object", { scopes: [{}] }],
    ["unknown scope", { scopes: ["orchestration:read", "invented"] }],
    ["method mismatch", { sessionMethod: "browser-session-cookie" }],
    ["array method", { sessionMethod: ["bearer-access-token"] }],
    ["missing auth", { auth: undefined }],
    ["auth shape", { auth: [] }],
    ["invalid expiry", { expiresAt: {} }],
  ])("A12 session %s blocks before catalog", async (_name, change) =>
    readCase(true, async (f, p, shape) => {
      await f.configureReadFoundation({ ...shape, session: { ...shape.session, ...change } });
      const r = await readFoundation(p, true, f);
      expect(r.use.status).toBe("failed");
      expect(r.failure?.code).toBe("T3_AUTH_FAILED");
      expect(r.cleanup.status).toBe("verified");
      expect((await f.effects()).filter((e) => e.kind === "http").map((e) => e.path)).toEqual([
        "/.well-known/t3/environment",
        "/.well-known/t3/environment",
        "/api/auth/session",
      ]);
    }),
  );
  test.each(["read-only scope", "optional expiry absent"])("A12 supported %s", async (kind) =>
    readCase(true, async (f, p, shape) => {
      const session: Record<string, unknown> = { ...shape.session };
      if (kind === "read-only scope") session.scopes = ["orchestration:read"];
      else delete session.expiresAt;
      await f.configureReadFoundation({ ...shape, session });
      expect((await readFoundation(p, true, f)).use.status).toBe("succeeded");
    }),
  );
  test.each(["bad policy", "bad bootstrap", "bad session methods", "bad cookie", "missing method"])(
    "A12 descriptor identity %s",
    async (kind) =>
      readCase(true, async (f, p, shape) => {
        const session: Record<string, unknown> = {
          ...shape.session,
          auth: {
            ...shape.session.auth,
            ...(kind === "bad policy"
              ? { policy: [] }
              : kind === "bad bootstrap"
                ? { bootstrapMethods: [{}] }
                : kind === "bad session methods"
                  ? { sessionMethods: "bearer-access-token" }
                  : kind === "bad cookie"
                    ? { sessionCookieName: [] }
                    : {}),
          },
        };
        if (kind === "missing method") delete session.sessionMethod;
        await f.configureReadFoundation({ ...shape, session });
        const r = await readFoundation(p, true, f);
        expect(r.use.status).toBe("failed");
        expect(r.failure?.code).toBe("T3_AUTH_FAILED");
        expect(r.cleanup.status).toBe("verified");
        expect((await f.effects()).filter((e) => e.kind === "ws")).toEqual([]);
      }),
  );
  test.each(["revoke failure", "list unknown"])(
    "A15 authenticated success independent of %s",
    async (kind) =>
      readCase(true, async (f, p) => {
        f.allowRead(f.runtimePath);
        const r = await readiness.collectT3AuthenticatedReadFoundation(
          p,
          { authenticated: true },
          {
            ...f.dependencies,
            runProcess: async (argv, options) => {
              const out = await f.dependencies.runProcess(argv, options);
              if (kind === "revoke failure" && argv[3] === "revoke") return { ...out, exitCode: 1 };
              if (kind === "list unknown" && argv[3] === "list") return { ...out, stdout: "{" };
              return out;
            },
          },
        );
        expect(r.use.status).toBe("succeeded");
        expect(r.cleanup.status).toBe(kind === "revoke failure" ? "failed" : "unknown");
      }),
  );
  test.each(["ticket", "config malformed", "shell project identity", "shell thread identity"])(
    "A14 additional bounded read %s",
    async (kind) =>
      readCase(true, async (f, p, shape) => {
        await f.configureReadFoundation({
          ...shape,
          ...(kind === "ticket"
            ? { ticket: [] }
            : kind === "config malformed"
              ? { catalog: [] }
              : kind === "shell project identity"
                ? { shell: { ...shape.shell, projects: [{ id: [], workspaceRoot: "private" }] } }
                : { shell: { ...shape.shell, threads: [{ id: "thread-1", projectId: [] }] } }),
        });
        const r = await readFoundation(p, true, f);
        expect(r.use.status).toBe("failed");
        expect(r.cleanup.status).toBe("verified");
      }),
  );
  test.each(["config identity", "shell failure", "shell schema", "close", "oversize", "wrong-id"])(
    "A14 bounded read %s enters exact cleanup",
    async (kind) =>
      readCase(true, async (f, p, shape) => {
        await f.configureReadFoundation({
          ...shape,
          ...(kind === "config identity"
            ? {
                catalog: {
                  ...shape.catalog,
                  environment: { ...shape.descriptor, environmentId: "other-environment" },
                },
              }
            : kind === "shell failure"
              ? { shellStatus: 500 }
              : kind === "shell schema"
                ? { shell: { ...shape.shell, projects: {} } }
                : { ws: kind }),
        });
        const r = await readFoundation(p, true, f);
        expect(r.use.status).toBe("failed");
        expect(r.cleanup.status).toBe("verified");
        expect(
          (await f.effects())
            .filter((e) => e.kind === "process")
            .map((e) => e.argv![3])
            .slice(-3),
        ).toEqual(["issue", "revoke", "list"]);
        expect(JSON.stringify(r)).not.toMatch(/other-environment|127\.0\.0\.1/);
      }),
  );
});
