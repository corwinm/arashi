import { access, appendFile, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  collectT3ReadinessPreview,
  collectT3AuthenticatedReadFoundation,
} from "../../src/lib/t3-readiness.ts";
import { resolveT3ReadinessContext } from "../../src/lib/t3-readiness-context.ts";
import { nativeChildEnvironment } from "../../src/lib/t3-native.ts";
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";

const date = "2026-01-01T00:00:00.000Z";
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "CANARY-cookie",
};
const project = (root: string, extra: object = {}) => ({
  id: "CANARY-project",
  title: "CANARY-title",
  workspaceRoot: root,
  repositoryIdentity: null,
  defaultModelSelection: {
    instanceId: "CANARY-instance",
    model: "CANARY-model",
    options: [{ id: "effort", value: "high" }],
  },
  scripts: [],
  createdAt: date,
  updatedAt: date,
  ...extra,
});

async function exercise(
  kind: string,
  change: object = {},
  expected = "verified",
  failure?: string,
) {
  const f = await createReadinessFixture();
  const saved = process.env;
  const evidence = saved.D1_PROJECT_EVIDENCE;
  process.env = { ...f.env, T3CODE_HOME: f.baseDir, ARASHI_DIRECTIVE_FILE: "CANARY-directive" };
  try {
    let checkout = f.repo;
    if (kind === "linked") {
      checkout = join(f.root, "registered linked");
      await promisify(execFile)("git", ["worktree", "add", "-b", "linked", checkout], {
        cwd: f.repo,
        env: f.env,
      });
    }
    const alias = join(f.root, "alias");
    await symlink(checkout, alias);
    const context = await resolveT3ReadinessContext({
      cwd: f.root,
      path: kind === "linked" ? alias : checkout,
      explicitSettings: { cli: f.cli, baseDir: f.baseDir },
    });
    if (kind === "global") context.checkout = null;
    const cwd = context.checkout ?? f.root;
    const childEnv = nativeChildEnvironment({ T3CODE_HOME: f.baseDir });
    for (const argv of [
      f.versionArgv,
      f.issueArgv.map((a) => (a === "Arashi handoff" ? "Arashi readiness" : a)),
      [f.cli, "auth", "session", "revoke", "fixture-session-1", "--base-dir", f.baseDir],
      [f.cli, "auth", "session", "list", "--base-dir", f.baseDir, "--json"],
    ])
      f.allowProcess(argv, cwd, childEnv);
    f.allowHttp("GET", "/.well-known/t3/environment");
    f.allowHttp("GET", "/api/auth/session");
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    if (context.checkout) f.allowHttp("GET", "/api/orchestration/shell");
    f.allowWs("server.getConfig");
    f.allowWs("Pong");
    const descriptor = {
      environmentId: "environment-1",
      serverVersion: "0.0.43",
      orchestrationProtocolVersion: 1,
      platform: { os: process.platform, arch: process.arch },
      capabilities: { repositoryIdentity: true, connectionProbe: true },
    };
    let projects: object[] = [project(checkout, change)];
    if (kind === "alias" || kind === "linked") projects = [project(alias, change)];
    if (kind === "separator") projects = [project(checkout + "/./", change)];
    if (kind === "casing") {
      const alternate = checkout.replace("checkout", "CHECKOUT");
      projects = [project(alternate, change)];
      expected = await realpath(alternate).then(
        () => "verified",
        () => "deferred",
      );
    }
    if (kind === "absent") projects = [];
    if (kind === "wrong-root") projects = [project(f.root)];
    if (kind === "unrelated-missing")
      projects.unshift(project(join(f.root, "absent"), { id: "other" }));
    if (kind === "ambiguous") projects.push(project(alias, { id: "other" }));
    if (kind === "duplicate-id") projects.push(project(f.root));
    if (kind === "identity-alias")
      projects = [
        project(checkout, {
          repositoryIdentity: {
            canonicalKey: "CANARY-key",
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: "CANARY-remote" },
            rootPath: alias,
          },
        }),
      ];
    if (kind === "cleanup-unknown") {
      const cli = await readFile(f.cli, "utf8");
      await writeFile(
        f.cli,
        cli.replace(
          "console.log(JSON.stringify(load('sessions.json').map(s=>({sessionId:s.sessionId}))))",
          "console.log('{}')",
        ),
      );
    }
    if (kind === "cleanup-failed") {
      const cli = await readFile(f.cli, "utf8");
      await writeFile(
        f.cli,
        cli.replace("console.log('{}');", "console.log('{}');process.exit(1);"),
      );
    }
    await f.configureReadFoundation({
      descriptor,
      session: {
        authenticated: true,
        auth,
        sessionMethod: "bearer-access-token",
        scopes: ["orchestration:read"],
      },
      catalog: { environment: descriptor, auth, providers: [], settings: {} },
      shell: {
        snapshotSequence: 0,
        projects,
        threads: [
          { id: "thread", projectId: "CANARY-project", messages: [{ body: "CANARY-thread-body" }] },
        ],
        updatedAt: date,
      },
    });
    await f.installMarkers();
    const before = await f.snapshot(checkout);
    const p = await collectT3ReadinessPreview({ cwd: f.root, context });
    expect(p.readiness).toBe("preview_passed");
    // Do not let a mutable caller redirect project matching after preview.
    context.checkout = f.root;
    const r = await collectT3AuthenticatedReadFoundation(p, { authenticated: true });
    await f.waitForSocketsClosed();
    expect(await f.snapshot(checkout)).toEqual(before);
    expect(await f.activeSessions()).toEqual([]);
    expect(r.cleanup).toEqual({
      status:
        kind === "cleanup-failed" ? "failed" : kind === "cleanup-unknown" ? "unknown" : "verified",
      revoke: kind === "cleanup-failed" ? "failed" : "succeeded",
    });
    const effects = await f.effects();
    expect(effects.filter((e) => e.kind === "denied")).toEqual([]);
    expect(
      effects
        .filter((e) => e.kind === "process")
        .map((e) => (e.argv![1] === "--version" ? "version" : e.argv![3])),
    ).toEqual(["version", "version", "issue", "revoke", "list"]);
    expect(effects.filter((e) => e.kind === "http").map((e) => e.path)).toEqual([
      "/.well-known/t3/environment",
      "/.well-known/t3/environment",
      "/api/auth/session",
      "/api/auth/websocket-ticket",
      ...(kind === "global" ? [] : ["/api/orchestration/shell"]),
    ]);
    expect(effects.filter((e) => e.kind === "ws").map((e) => e.tag)).toEqual([
      "server.getConfig",
      "Pong",
    ]);
    for (const marker of Object.values(f.markers)) await expect(access(marker)).rejects.toThrow();
    expect(JSON.stringify(r)).not.toMatch(/CANARY|environment-1|fixture-session|127\.0\.0\.1/);
    if (evidence)
      await appendFile(
        join(evidence, "effects.jsonl"),
        JSON.stringify({
          case: expect.getState().currentTestName,
          immutable: true,
          remainingSessions: 0,
          runtime: process.execPath,
          operations: effects.map((e) => ({
            kind: e.kind,
            operation: e.argv ? (e.argv[1] === "--version" ? "version" : e.argv[3]) : undefined,
            cwdBound: e.cwd ? e.cwd === cwd : undefined,
            directiveAbsent: e.envKeys ? !e.envKeys.includes("ARASHI_DIRECTIVE_FILE") : undefined,
            path: e.kind === "http" ? e.path : undefined,
            tag: e.tag,
            action: e.action,
          })),
        }) + "\n",
      );
    if (failure) {
      expect(r.use.status).toBe("failed");
      expect(r.failure?.code).toBe(failure);
    } else {
      expect(r.use).toMatchObject({
        status: "succeeded",
        value: { project: expected, effectiveSelection: "deferred" },
      });
    }
  } finally {
    process.env = saved;
    await f.dispose();
  }
}

test.each(["exact", "alias", "separator", "linked", "unrelated-missing"])(
  "A17 unique selected physical project: %s",
  (kind) => exercise(kind),
);
test("A17 casing follows actual host filesystem, not naive lowercase", async () => {
  // The fixture's macOS volume is case insensitive; native POSIX case-sensitive
  // behavior remains filesystem-owned rather than manufactured string folding.
  await exercise("casing");
});
test.each(["absent", "wrong-root"])(
  "A17 %s defers without project creation or checkout readiness",
  (kind) => exercise(kind, {}, "deferred"),
);
test("A17 global project remains not applicable without shell read", () =>
  exercise("global", {}, "not_applicable"));
test("A17 two aliases block instead of choosing first", () =>
  exercise("ambiguous", {}, "", "T3_RESPONSE_INVALID"));
test("A17 duplicate project ID blocks", () =>
  exercise("duplicate-id", {}, "", "T3_RESPONSE_INVALID"));
test.each([
  ["relative root", { workspaceRoot: "relative" }],
  ["array ID", { id: ["CANARY-project"] }],
  ["identity array", { repositoryIdentity: [] }],
  ["identity missing locator", { repositoryIdentity: { canonicalKey: "key" } }],
  [
    "identity root mismatch",
    {
      repositoryIdentity: {
        canonicalKey: "key",
        locator: { source: "git-remote", remoteName: "origin", remoteUrl: "CANARY-remote" },
        rootPath: "/",
      },
    },
  ],
  ["missing default", { defaultModelSelection: undefined }],
  ["array selection", { defaultModelSelection: [] }],
  ["array instance", { defaultModelSelection: { instanceId: ["id"], model: "model" } }],
  ["array model", { defaultModelSelection: { instanceId: "id", model: ["model"] } }],
  [
    "nested option",
    {
      defaultModelSelection: {
        instanceId: "id",
        model: "model",
        options: [{ id: "effort", value: {} }],
      },
    },
  ],
  ["array env mode", { defaultThreadEnvMode: ["local"] }],
] as const)("A17 malformed selected evidence: %s", (_name, change) =>
  exercise("exact", change, "", "T3_RESPONSE_INVALID"),
);
test.each(["cleanup-failed", "cleanup-unknown"])(
  "A17 matched project survives independently %s cleanup",
  (kind) => exercise(kind),
);
test("A17 supported repositoryIdentity root alias matches physically", () =>
  exercise("identity-alias"));
test.each([null, { instanceId: "instance", model: "model" }])(
  "A17 valid structural defaults %s stay private",
  (defaultModelSelection) =>
    exercise("exact", { defaultModelSelection, defaultThreadEnvMode: "worktree" }),
);
