import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as readiness from "../../src/lib/t3-readiness.ts";
import { nativeChildEnvironment } from "../../src/lib/t3-native.ts";
import { resolveT3ReadinessContext } from "../../src/lib/t3-readiness-context.ts";
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";

const date = "2026-01-01T00:00:00.000Z";
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "CANARY-cookie",
};
const option = (value: string) => ({ id: "effort", value });
const saved = (instanceId = "instance-a", model = "model-a", effort = "deep") => ({
  instanceId,
  model,
  options: [option(effort)],
});
const provider = (instanceId = "instance-a", extra: object = {}) => ({
  instanceId,
  driver: "fixture-driver",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "CANARY-email" },
  checkedAt: date,
  models: ["model-a", "model-b"].map((slug, i) => ({
    slug,
    name: slug,
    isCustom: false,
    isDefault: i === 0,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          currentValue: "minimal",
          options: [
            { id: "minimal", label: "Minimal", isDefault: true },
            { id: "deep", label: "Deep" },
          ],
        },
      ],
    },
  })),
  extension: { token: "CANARY-extension" },
  ...extra,
});
const catalog = (providers = [provider()], settings: object = {}) => ({ providers, settings });
type Scenario = {
  settings?: object;
  source?: "cli" | "workspace" | "user";
  project?: object | null;
  server?: object;
  providers?: ReturnType<typeof provider>[];
  global?: boolean;
  cleanup?: "failed" | "unknown";
  expected?: object;
  advance?: boolean;
  clock?: number;
};
const checkTime = Date.parse(date);
const at = (offset: number) => new Date(checkTime + offset).toISOString();
const verified = {
  provider: { state: "verified", freshness: "fresh" },
  readiness: "checkout_verified",
};
const uncertain = { provider: { state: "unknown", severity: "warning" }, readiness: "unknown" };
const cases: [string, Scenario][] = [
  ...[0, -299999, -300000, 1, 29999, 30000].map((offset): [string, Scenario] => [
    `fresh boundary ${offset}ms`,
    { providers: [provider("instance-a", { checkedAt: at(offset) })], expected: verified },
  ]),
  ...[-300001, -600000].map((offset): [string, Scenario] => [
    `stale boundary ${offset}ms`,
    {
      providers: [provider("instance-a", { checkedAt: at(offset) })],
      expected: {
        ...uncertain,
        provider: { state: "unknown", severity: "warning", freshness: "stale" },
      },
    },
  ]),
  ...[30001, 60000].map((offset): [string, Scenario] => [
    `future boundary ${offset}ms`,
    {
      providers: [provider("instance-a", { checkedAt: at(offset) })],
      expected: {
        ...uncertain,
        provider: { state: "unknown", severity: "warning", freshness: "unknown", checkedAt: null },
      },
    },
  ]),
  ...[
    "invalid",
    "2026-02-30T00:00:00.000Z",
    "0",
    "2026-01-01",
    "2026-01-01T00:00:00.000Z CANARY",
  ].map((checkedAt): [string, Scenario] => [
    `invalid timestamp ${checkedAt}`,
    {
      providers: [provider("instance-a", { checkedAt })],
      expected: {
        ...uncertain,
        provider: { state: "unknown", severity: "warning", freshness: "unknown", checkedAt: null },
      },
    },
  ]),
  ...["ready", "warning"].flatMap((status) =>
    ["authenticated", "unknown"].map((authStatus): [string, Scenario] => [
      `status ${status} auth ${authStatus}`,
      {
        providers: [
          provider("instance-a", { status, auth: { status: authStatus, email: "CANARY-email" } }),
        ],
        expected: status === "ready" && authStatus === "authenticated" ? verified : uncertain,
      },
    ]),
  ),
  [
    "global fresh",
    { global: true, expected: { provider: { state: "verified" }, readiness: "global_verified" } },
  ],
  [
    "global warning",
    {
      global: true,
      providers: [provider("instance-a", { status: "warning" })],
      expected: uncertain,
    },
  ],
  [
    "missing project fresh",
    { project: null, expected: { provider: { state: "verified" }, readiness: "unknown" } },
  ],
  ["cleanup failed independent", { cleanup: "failed", expected: verified }],
  ["cleanup unknown independent", { cleanup: "unknown", expected: verified }],
  ["recorded clock stable after collection", { advance: true, expected: verified }],
  [
    "nonfinite clock cannot verify",
    {
      clock: NaN,
      expected: {
        ...uncertain,
        provider: { state: "unknown", freshness: "unknown", checkedAt: null },
      },
    },
  ],
  [
    "independent recorded check stale",
    {
      clock: checkTime + 300001,
      expected: { ...uncertain, provider: { state: "unknown", freshness: "stale" } },
    },
  ],
  ["independent recorded check boundary", { clock: checkTime + 300000, expected: verified }],
  [
    "exact selected not first catalog provider",
    {
      settings: { provider: "instance-b" },
      providers: [
        provider("instance-a", { status: "warning", checkedAt: "invalid" }),
        provider("instance-b"),
      ],
      expected: verified,
    },
  ],
];
test.each(cases)("A20 default Bun owned provider state: %s", async (_name, scenario) => {
  const f = await createReadinessFixture();
  const savedEnv = process.env;
  const evidence = savedEnv.D1_PROVIDER_STATE_EVIDENCE;
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
    for (const leaf of ["provider", "model", "effort"] as const)
      if (context.settings[leaf]) expect(context.sources[leaf]).toBe(scenario.source ?? "cli");
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
        ...catalog(scenario.providers, scenario.server),
        extension: "CANARY-catalog",
      },
      shell: {
        snapshotSequence: 0,
        updatedAt: date,
        projects: [
          ...(scenario.project === null ? [] : [project]),
          {
            ...project,
            id: "CANARY-unrelated",
            workspaceRoot: f.root,
            defaultModelSelection: saved("missing"),
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
    const preview = await readiness.collectT3ReadinessPreview({ cwd: f.root, context });
    expect(preview.readiness).toBe("preview_passed");
    // Pin all leaves and provenance. Neither mutable context nor public facts authorize changes.
    context.settings.provider = "missing";
    context.sources.provider = "user";
    context.checkout = f.root;
    let wallClock = scenario.clock ?? checkTime;
    let clockCalls = 0;
    const read = await readiness.collectT3AuthenticatedReadFoundation(
      preview,
      {
        authenticated: true,
      },
      {
        checkTime: () => {
          clockCalls++;
          return wallClock;
        },
      },
    );
    expect(read.use.status).toBe("succeeded");
    if (read.use.status !== "succeeded") throw new Error("read prerequisite failed");
    await f.waitForSocketsClosed();
    expect(await f.snapshot()).toEqual(before);
    expect(await f.activeSessions()).toEqual([]);
    expect(read.cleanup.status).toBe(scenario.cleanup ?? "verified");
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
      ...(scenario.global ? [] : ["/api/orchestration/shell"]),
    ]);
    expect(effects.filter((e) => e.kind === "ws").map((e) => e.tag)).toEqual([
      "server.getConfig",
      "Pong",
    ]);
    for (const marker of Object.values(f.markers)) await expect(access(marker)).rejects.toThrow();
    if (evidence)
      await appendFile(
        join(evidence, "effects.jsonl"),
        JSON.stringify({
          run: savedEnv.D1_PROVIDER_STATE_RUN,
          case: expect.getState().currentTestName,
          immutable: true,
          remainingSessions: 0,
          runtime: process.execPath,
          operations: effects.map(({ sessionId: _privateId, ...e }) => ({
            ...e,
            argv: e.argv?.map((v) => (v === "fixture-session-1" ? "<owned-session>" : v)),
          })),
        }) + "\n",
      );
    const value = read.use.value;
    const selected = readiness.resolveT3ReadinessEffectiveSelection(value);
    const classify =
      savedEnv.D1_PROVIDER_STATE_BASELINE_ADAPTER === "1"
        ? // Explicit new-contract RED: accepted production only has resolved selection.
          (_selected: readiness.T3EffectiveSelectionFoundation): unknown => ({
            readiness: "unknown",
            provider: { state: "deferred" },
          })
        : readiness.classifyT3ReadinessProviderState;
    if (scenario.advance) wallClock += 600000;
    // Mutable public selection is NOT classification authority.
    selected.selection.instanceId = "missing";
    selected.project = "not_applicable";
    selected.provisional = true;
    const result = classify(selected);
    expect(result).toMatchObject(scenario.expected!);
    expect(result).toMatchObject({
      provider: {
        status:
          scenario.providers?.find(
            (p) => p.instanceId === (scenario.settings ? "instance-b" : "instance-a"),
          )?.status ?? "ready",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /CANARY|environment-1|fixture-session|127\.0\.0\.1|instance-|model-/,
    );
    if (savedEnv.D1_PROVIDER_STATE_BASELINE_ADAPTER !== "1") {
      expect(clockCalls).toBe(1);
      expect(classify(selected)).toEqual(result);
      expect(() => classify({ ...selected })).toThrow();
      expect(() =>
        classify(value as unknown as readiness.T3EffectiveSelectionFoundation),
      ).toThrow();
      expect(() =>
        classify(preview as unknown as readiness.T3EffectiveSelectionFoundation),
      ).toThrow();
    }
    expect(await f.effects()).toEqual(effects);
    expect(await f.snapshot()).toEqual(before);
    if (evidence)
      await appendFile(
        join(evidence, "classification.jsonl"),
        JSON.stringify({
          run: savedEnv.D1_PROVIDER_STATE_RUN,
          case: expect.getState().currentTestName,
          pure: true,
          immutable: true,
          clockCalls,
          result,
        }) + "\n",
      );
  } finally {
    process.env = savedEnv;
    await f.dispose();
  }
});
