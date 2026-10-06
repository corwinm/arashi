import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeChildEnvironment } from "../../src/lib/t3-native.ts";
import { resolveT3ReadinessContext } from "../../src/lib/t3-readiness-context.ts";
import { createReadinessFixture, type ReadinessSnapshot } from "./t3-readiness-fixture.ts";

type SelectionFixtureScenario = {
  settings?: object;
  source?: "cli" | "workspace" | "user";
  project?: object | null;
  global?: boolean;
  cleanup?: "failed" | "unknown";
};

/** Shared owned setup only; collectors, provenance and effect assertions stay in the suites. */
export async function withSelectionReadFixture(
  scenario: SelectionFixtureScenario,
  catalog: { providers: object[]; settings: object },
  unrelatedSelection: object,
  inspect: (fixture: {
    f: Awaited<ReturnType<typeof createReadinessFixture>>;
    context: Awaited<ReturnType<typeof resolveT3ReadinessContext>>;
    before: ReadinessSnapshot;
    savedEnv: NodeJS.ProcessEnv;
  }) => Promise<void>,
) {
  const f = await createReadinessFixture();
  const savedEnv = process.env;
  process.env = { ...f.env, T3CODE_HOME: f.baseDir, ARASHI_DIRECTIVE_FILE: "CANARY-directive" };
  try {
    if (scenario.source === "workspace" || scenario.source === "user") {
      const owner = scenario.source === "user" ? f.home : f.repo;
      await mkdir(join(owner, ".arashi"), { recursive: true });
      await writeFile(
        join(owner, ".arashi/config.json"),
        JSON.stringify({
          version: "1.0.0",
          ...(owner === f.repo ? { reposDir: "./repos", repos: {} } : {}),
          defaults: { t3: scenario.settings },
        }),
      );
    }
    const context = await resolveT3ReadinessContext({
      cwd: f.repo,
      explicitSettings: {
        cli: f.cli,
        baseDir: f.baseDir,
        ...(!scenario.source || scenario.source === "cli" ? scenario.settings : {}),
      },
    });
    if (scenario.global) context.checkout = null;
    const cwd = context.checkout ?? f.root;
    const env = nativeChildEnvironment({ T3CODE_HOME: f.baseDir });
    for (const argv of [
      f.versionArgv,
      f.issueArgv.map((a) => (a === "Arashi handoff" ? "Arashi readiness" : a)),
      [f.cli, "auth", "session", "revoke", "fixture-session-1", "--base-dir", f.baseDir],
      [f.cli, "auth", "session", "list", "--base-dir", f.baseDir, "--json"],
    ])
      f.allowProcess(argv, cwd, env);
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
    const auth = {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "CANARY-cookie",
    };
    const project = {
      id: "CANARY-project-id",
      workspaceRoot: f.repo,
      defaultModelSelection: null,
      ...scenario.project,
      extension: "CANARY-project-extension",
    };
    await f.configureReadFoundation({
      descriptor,
      session: {
        authenticated: true,
        auth,
        sessionMethod: "bearer-access-token",
        scopes: ["orchestration:read"],
      },
      catalog: {
        environment: descriptor,
        auth,
        ...catalog,
        extension: "CANARY-catalog",
      },
      shell: {
        snapshotSequence: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          ...(scenario.project === null ? [] : [project]),
          {
            ...project,
            id: "CANARY-unrelated",
            workspaceRoot: f.root,
            defaultModelSelection: unrelatedSelection,
          },
        ],
        threads: [],
      },
    });
    if (scenario.cleanup) {
      const cli = await readFile(f.cli, "utf8");
      await writeFile(
        f.cli,
        scenario.cleanup === "failed"
          ? cli.replace("console.log('{}');", "console.log('{}');process.exit(1);")
          : cli.replace(
              "console.log(JSON.stringify(load('sessions.json').map(s=>({sessionId:s.sessionId}))))",
              "console.log('{}')",
            ),
      );
    }
    await f.installMarkers();
    const before = await f.snapshot();
    await inspect({ f, context, before, savedEnv });
  } finally {
    process.env = savedEnv;
    await f.dispose();
  }
}
