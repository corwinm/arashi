import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as readiness from "../../src/lib/t3-readiness.ts";
import {
  resolveT3Selection,
  nativeChildEnvironment,
  type JsonObject,
} from "../../src/lib/t3-native.ts";
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
// Historical RED adapter is explicit and opt-in: unchanged native API ignores
// the proposed strict boundary; unchanged foundation has deferred selection.
const strict = (config: JsonObject, settings = {}) =>
  resolveT3Selection(config, settings, undefined, { readiness: true });

test.each([
  ["disabled status", { status: "disabled" }],
  ["disabled flag", { enabled: false }],
  ["uninstalled", { installed: false }],
  ["error", { status: "error" }],
  ["unavailable", { availability: "unavailable", installed: false, enabled: false }],
  ["unauthenticated", { auth: { status: "unauthenticated" } }],
])(
  "A18 explicit rejected instance cannot fall through to same-named driver: %s",
  (_name, extra) => {
    expect(() =>
      strict(
        catalog([provider("instance-a", extra), provider("other", { driver: "instance-a" })]),
        { provider: "instance-a" },
      ),
    ).toThrow();
  },
);

test.each([
  ["array instance", { instanceId: ["instance-a"] }],
  ["array driver", { driver: ["fixture-driver"] }],
  ["array enabled", { enabled: [true] }],
  ["array installed", { installed: [true] }],
  ["array status", { status: ["ready"] }],
  ["unknown status", { status: "future-state" }],
  ["array availability", { availability: ["available"] }],
  ["array auth", { auth: [] }],
  ["array auth status", { auth: { status: ["authenticated"] } }],
  ["array checkedAt", { checkedAt: [date] }],
  ["array version", { version: [] }],
  ["array models", { models: {} }],
  ["array model slug", { models: [{ ...provider().models[0], slug: ["model-a"] }] }],
  ["array isDefault", { models: [{ ...provider().models[0], isDefault: [true] }] }],
  ["array aliases", { models: [{ ...provider().models[0], aliases: [["alias"]] }] }],
  [
    "array currentValue",
    {
      models: [
        {
          ...provider().models[0],
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select",
                currentValue: ["minimal"],
                options: [{ id: "minimal" }],
              },
            ],
          },
        },
      ],
    },
  ],
] as const)("A18 strict relevant catalog scalar: %s", (_name, extra) => {
  expect(() =>
    strict(catalog([provider("instance-a", extra)]), {
      provider: "fixture-driver",
      model: "model-a",
    }),
  ).toThrow();
});

test.each(["warning", "ready"])("A18 %s/auth unknown are not freshness hard errors", (status) => {
  expect(
    strict(catalog([provider("instance-a", { status, auth: { status: "unknown" } })])),
  ).toMatchObject({ instanceId: "instance-a" });
});
test("A18 duplicate instance identities reject even with explicit routing", () => {
  expect(() => strict(catalog([provider(), provider()]), { provider: "instance-a" })).toThrow();
});

type Scenario = {
  settings?: object;
  source?: "cli" | "workspace" | "user";
  project?: object | null;
  server?: object;
  providers?: ReturnType<typeof provider>[];
  global?: boolean;
  fail?: string;
  cleanup?: "failed" | "unknown";
  expected?: object;
};
const cases: [string, Scenario][] = [
  ...(["cli", "workspace", "user"] as const).map((source): [string, Scenario] => [
    source + " leaves",
    {
      source,
      settings: { provider: "instance-b", model: "model-b", effort: "minimal" },
      providers: [provider(), provider("instance-b")],
      server: { defaultModelSelection: saved() },
      project: { defaultModelSelection: saved() },
      expected: {
        selection: { instanceId: "instance-b", model: "model-b", options: [option("minimal")] },
        sources: { provider: source, model: source, effort: source },
      },
    },
  ]),
  [
    "exact project before server",
    {
      project: { defaultModelSelection: saved("instance-b", "model-b") },
      providers: [provider(), provider("instance-b")],
      server: { defaultModelSelection: saved() },
      expected: {
        sources: { provider: "project", model: "project", effort: "project" },
        selection: saved("instance-b", "model-b"),
      },
    },
  ],
  [
    "server inherited not relabeled project",
    {
      project: { defaultModelSelection: null },
      server: { defaultModelSelection: saved() },
      expected: {
        sources: { provider: "server", model: "server", effort: "server" },
        selection: saved(),
      },
    },
  ],
  [
    "catalog defaults",
    {
      expected: {
        sources: { provider: "catalog", model: "catalog", effort: "catalog" },
        selection: saved("instance-a", "model-a", "minimal"),
      },
    },
  ],
  [
    "mixed leaves",
    {
      source: "workspace",
      settings: { effort: "minimal" },
      project: { defaultModelSelection: saved() },
      expected: { sources: { provider: "project", model: "project", effort: "workspace" } },
    },
  ],
  [
    "missing project provisional server",
    {
      project: null,
      server: { defaultModelSelection: saved() },
      expected: {
        project: "deferred",
        effectiveSelection: "resolved",
        provisional: true,
        sources: { provider: "server", model: "server", effort: "server" },
      },
    },
  ],
  [
    "missing project ignores unrelated defaults",
    {
      project: null,
      expected: { selection: saved("instance-a", "model-a", "minimal"), provisional: true },
    },
  ],
  [
    "global not applicable",
    { global: true, expected: { project: "not_applicable", provisional: false } },
  ],
  [
    "unique driver routing",
    {
      settings: { provider: "fixture-driver" },
      expected: {
        selection: saved("instance-a", "model-a", "minimal"),
        sources: { provider: "cli" },
      },
    },
  ],
  [
    "driver ambiguity",
    {
      settings: { provider: "fixture-driver" },
      providers: [provider(), provider("instance-b")],
      fail: "T3_PROVIDER_AMBIGUOUS",
    },
  ],
  [
    "missing explicit provider",
    { settings: { provider: "missing" }, fail: "T3_PROVIDER_AMBIGUOUS" },
  ],
  [
    "missing saved provider",
    { server: { defaultModelSelection: saved("missing") }, fail: "T3_PROVIDER_AMBIGUOUS" },
  ],
  [
    "disabled explicit",
    {
      settings: { provider: "instance-a" },
      providers: [provider("instance-a", { status: "disabled" })],
      fail: "T3_PROVIDER_AMBIGUOUS",
    },
  ],
  [
    "error explicit",
    {
      settings: { provider: "instance-a" },
      providers: [provider("instance-a", { status: "error" })],
      fail: "T3_PROVIDER_AMBIGUOUS",
    },
  ],
  [
    "unavailable explicit",
    {
      settings: { provider: "instance-a" },
      providers: [
        provider("instance-a", { enabled: false, installed: false, availability: "unavailable" }),
      ],
      fail: "T3_PROVIDER_AMBIGUOUS",
    },
  ],
  [
    "unauthenticated explicit",
    {
      settings: { provider: "instance-a" },
      providers: [provider("instance-a", { auth: { status: "unauthenticated" } })],
      fail: "T3_PROVIDER_AMBIGUOUS",
    },
  ],
  ["unsupported explicit model", { settings: { model: "missing" }, fail: "T3_MODEL_UNAVAILABLE" }],
  [
    "unsupported explicit effort",
    { settings: { effort: "missing" }, fail: "T3_EFFORT_UNSUPPORTED" },
  ],
  [
    "malformed server instance",
    {
      server: { defaultModelSelection: { ...saved(), instanceId: ["instance-a"] } },
      fail: "T3_CATALOG_INVALID",
    },
  ],
  [
    "malformed server option",
    {
      server: { defaultModelSelection: { ...saved(), options: [{ id: "effort", value: {} }] } },
      fail: "T3_CATALOG_INVALID",
    },
  ],
  [
    "cleanup failed preserves selection",
    { cleanup: "failed", expected: { effectiveSelection: "resolved" } },
  ],
  [
    "cleanup unknown preserves selection",
    { cleanup: "unknown", expected: { effectiveSelection: "resolved" } },
  ],
];

test.each(cases)("A18 default Bun owned selection: %s", async (_name, scenario) => {
  const f = await createReadinessFixture();
  const savedEnv = process.env;
  const evidence = savedEnv.D1_SELECTION_EVIDENCE;
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
    const read = await readiness.collectT3AuthenticatedReadFoundation(preview, {
      authenticated: true,
    });
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
          run: savedEnv.D1_SELECTION_RUN,
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
    const resolve =
      process.env.D1_SELECTION_BASELINE_ADAPTER === "1"
        ? (value: readiness.T3AuthenticatedReadFoundation) => value
        : readiness.resolveT3ReadinessEffectiveSelection;
    let result: unknown;
    if (scenario.fail)
      expect(() => resolve(read.use.status === "succeeded" ? read.use.value : undefined!)).toThrow(
        expect.objectContaining({ code: scenario.fail }),
      );
    else {
      result = resolve(read.use.value);
      expect(result).toMatchObject({ effectiveSelection: "resolved", ...scenario.expected });
      expect(JSON.stringify(result)).not.toMatch(
        /CANARY|environment-1|fixture-session|127\.0\.0\.1/,
      );
      expect(() => resolve({ ...value })).toThrow();
    }
  } finally {
    process.env = savedEnv;
    await f.dispose();
  }
});
