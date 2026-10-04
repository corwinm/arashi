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
const option = (value: string | boolean, id = "effort") => ({ id, value });
const select = (id = "effort", extra: object = {}) => ({
  id,
  label: "Option",
  type: "select",
  currentValue: "minimal",
  options: [
    { id: "minimal", label: "Minimal", isDefault: true },
    { id: "deep", label: "Deep" },
  ],
  ...extra,
});
const selectWithoutCurrent = (id = "effort", extra: object = {}) => {
  const { currentValue: _unused, ...descriptor } = select(id, extra);
  return descriptor;
};
const model = (slug = "model-a", extra: object = {}): JsonObject => ({
  slug,
  name: slug,
  isCustom: false,
  isDefault: true,
  aliases: ["alias-a"],
  capabilities: {
    optionDescriptors: [
      select(),
      { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
    ],
  },
  ...extra,
});
const provider = (instanceId = "instance-a", extra: object = {}): JsonObject => ({
  instanceId,
  driver: "fixture-driver",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "CANARY-email" },
  checkedAt: date,
  models: [model()],
  extension: { token: "CANARY-extension" },
  ...extra,
});
const catalog = (providers = [provider()], settings: object = {}) => ({ providers, settings });
const saved = (
  instanceId = "instance-a",
  name = "model-a",
  options = [option("deep"), option(true, "fastMode")],
) => ({ instanceId, model: name, options });
const withDescriptors = (descriptors: unknown) =>
  provider("instance-a", {
    models: [model("model-a", { capabilities: { optionDescriptors: descriptors } })],
  });
type Scenario = {
  settings?: object;
  source?: "cli" | "workspace" | "user";
  project?: object | null;
  server?: object;
  providers?: JsonObject[];
  global?: boolean;
  fail?: string;
  cleanup?: "failed" | "unknown";
  expected?: object;
};
const defaults = [option("minimal"), option(false, "fastMode")];
const cases: [string, Scenario][] = [
  [
    "select saved boolean rejects without coercion",
    {
      project: { defaultModelSelection: saved("instance-a", "model-a", [option(true)]) },
      fail: "T3_EFFORT_UNSUPPORTED",
    },
  ],
  [
    "boolean saved string rejects without coercion",
    {
      project: {
        defaultModelSelection: saved("instance-a", "model-a", [option("false", "fastMode")]),
      },
      fail: "T3_EFFORT_UNSUPPORTED",
    },
  ],
  [
    "explicit effort overrides saved unsupported membership",
    {
      settings: { effort: "minimal" },
      project: {
        defaultModelSelection: saved("instance-a", "model-a", [
          option("missing"),
          option(true, "fastMode"),
        ]),
      },
      expected: {
        selection: saved("instance-a", "model-a", [option("minimal"), option(true, "fastMode")]),
        optionSources: [
          { id: "effort", source: "cli" },
          { id: "fastMode", source: "project" },
        ],
      },
    },
  ],
  [
    "provider switch does not carry unsupported saved option",
    {
      settings: { provider: "instance-b" },
      providers: [provider(), provider("instance-b")],
      project: {
        defaultModelSelection: saved("instance-a", "model-a", [
          option("private-choice", "private-option"),
        ]),
      },
      expected: { selection: saved("instance-b", "model-a", defaults) },
    },
  ],
  [
    "provider switch explicit unsupported effort rejects",
    {
      settings: { provider: "instance-b", effort: "missing" },
      providers: [provider(), provider("instance-b")],
      project: { defaultModelSelection: saved() },
      fail: "T3_EFFORT_UNSUPPORTED",
    },
  ],
  [
    "model switch explicit effort preserves only authored choice",
    {
      settings: { model: "alias-b", effort: "deep" },
      providers: [
        provider("instance-a", {
          models: [model(), model("model-b", { isDefault: false, aliases: ["alias-b"] })],
        }),
      ],
      server: { defaultModelSelection: saved() },
      expected: {
        selection: saved("instance-a", "model-b", [option("deep"), option(false, "fastMode")]),
        optionSources: [
          { id: "effort", source: "cli" },
          { id: "fastMode", source: "catalog" },
        ],
      },
    },
  ],
  [
    "cleanup failure leaves model/options evidence intact",
    {
      cleanup: "failed",
      settings: { model: "alias-a" },
      expected: { selection: saved("instance-a", "model-a", defaults) },
    },
  ],
  [
    "cleanup uncertainty leaves model/options evidence intact",
    {
      cleanup: "unknown",
      settings: { model: "alias-a" },
      expected: { selection: saved("instance-a", "model-a", defaults) },
    },
  ],
  [
    "exact slug",
    {
      settings: { model: "model-a" },
      expected: { selection: saved("instance-a", "model-a", defaults) },
    },
  ],
  [
    "supported alias retains saved options",
    {
      settings: { model: "alias-a" },
      project: { defaultModelSelection: saved() },
      expected: { selection: saved(), sources: { model: "cli", effort: "project" } },
    },
  ],
  [
    "saved alias maps to canonical slug",
    {
      server: { defaultModelSelection: saved("instance-a", "alias-a") },
      expected: { selection: saved(), sources: { model: "server", effort: "server" } },
    },
  ],
  ["missing model", { settings: { model: "missing" }, fail: "T3_MODEL_UNAVAILABLE" }],
  [
    "ambiguous alias",
    {
      settings: { model: "alias-a" },
      providers: [
        provider("instance-a", { models: [model(), model("model-b", { isDefault: false })] }),
      ],
      fail: "T3_MODEL_UNAVAILABLE",
    },
  ],
  [
    "slug collides with another model alias",
    {
      settings: { model: "model-a" },
      providers: [
        provider("instance-a", {
          models: [model(), model("model-b", { isDefault: false, aliases: ["model-a"] })],
        }),
      ],
      fail: "T3_MODEL_UNAVAILABLE",
    },
  ],
  [
    "no model default",
    {
      providers: [provider("instance-a", { models: [model("model-a", { isDefault: false })] })],
      fail: "T3_MODEL_UNAVAILABLE",
    },
  ],
  [
    "multiple model defaults",
    {
      providers: [provider("instance-a", { models: [model(), model("model-b", { aliases: [] })] })],
      fail: "T3_MODEL_UNAVAILABLE",
    },
  ],
  [
    "unsupported saved option",
    {
      project: {
        defaultModelSelection: saved("instance-a", "model-a", [option("deep", "unknown")]),
      },
      fail: "T3_OPTIONS_UNSUPPORTED",
    },
  ],
  [
    "explicit unsupported effort not dropped",
    {
      settings: { effort: "missing" },
      project: { defaultModelSelection: saved() },
      fail: "T3_EFFORT_UNSUPPORTED",
    },
  ],
  [
    "reasoningEffort uses advertised membership",
    {
      settings: { effort: "deep" },
      providers: [withDescriptors([select("reasoningEffort")])],
      expected: {
        selection: saved("instance-a", "model-a", [option("deep", "reasoningEffort")]),
        optionSources: [{ id: "reasoningEffort", source: "cli" }],
      },
    },
  ],
  [
    "boolean effort does not coerce authored string",
    {
      settings: { effort: "true" },
      providers: [
        withDescriptors([{ id: "effort", label: "Effort", type: "boolean", currentValue: false }]),
      ],
      fail: "T3_EFFORT_UNSUPPORTED",
    },
  ],
  [
    "boolean saved effort accepted",
    {
      project: { defaultModelSelection: saved("instance-a", "model-a", [option(true)]) },
      providers: [
        withDescriptors([{ id: "effort", label: "Effort", type: "boolean", currentValue: false }]),
      ],
      expected: { selection: saved("instance-a", "model-a", [option(true)]) },
    },
  ],
  [
    "provider switch same model slug resets saved options",
    {
      settings: { provider: "instance-b" },
      providers: [provider(), provider("instance-b")],
      project: { defaultModelSelection: saved() },
      expected: {
        selection: saved("instance-b", "model-a", defaults),
        sources: { provider: "cli", model: "catalog", effort: "catalog" },
      },
    },
  ],
  [
    "provider switch explicit alias and effort",
    {
      settings: { provider: "instance-b", model: "alias-a", effort: "deep" },
      providers: [provider(), provider("instance-b")],
      server: { defaultModelSelection: saved() },
      expected: {
        selection: saved("instance-b", "model-a", [option("deep"), option(false, "fastMode")]),
        optionSources: [
          { id: "effort", source: "cli" },
          { id: "fastMode", source: "catalog" },
        ],
      },
    },
  ],
  [
    "model switch resets saved boolean and effort",
    {
      settings: { model: "model-b" },
      providers: [
        provider("instance-a", {
          models: [model(), model("model-b", { isDefault: false, aliases: ["alias-b"] })],
        }),
      ],
      project: { defaultModelSelection: saved() },
      expected: {
        selection: saved("instance-a", "model-b", defaults),
        sources: { model: "cli", effort: "catalog" },
      },
    },
  ],
  [
    "model switch explicit unsupported effort still rejects",
    {
      settings: { model: "model-b", effort: "deep" },
      providers: [
        provider("instance-a", {
          models: [
            model(),
            model("model-b", { isDefault: false, aliases: [], capabilities: null }),
          ],
        }),
      ],
      project: { defaultModelSelection: saved() },
      fail: "T3_EFFORT_UNSUPPORTED",
    },
  ],
  [
    "select option without default is omitted",
    {
      providers: [
        withDescriptors([
          selectWithoutCurrent("mode", { options: [{ id: "standard", label: "Standard" }] }),
        ]),
      ],
      expected: { selection: saved("instance-a", "model-a", []) },
    },
  ],
  [
    "unique choice default resolves",
    {
      providers: [withDescriptors([selectWithoutCurrent("mode")])],
      expected: { selection: saved("instance-a", "model-a", [option("minimal", "mode")]) },
    },
  ],
  [
    "duplicate descriptor identities",
    { providers: [withDescriptors([select(), select()])], fail: "T3_CATALOG_INVALID" },
  ],
  [
    "duplicate choice identities",
    {
      providers: [
        withDescriptors([
          select("effort", {
            options: [
              { id: "minimal", label: "A" },
              { id: "minimal", label: "B" },
            ],
          }),
        ]),
      ],
      fail: "T3_CATALOG_INVALID",
    },
  ],
  [
    "multiple choice defaults",
    {
      providers: [
        withDescriptors([
          selectWithoutCurrent("effort", {
            options: [
              { id: "minimal", label: "A", isDefault: true },
              { id: "deep", label: "B", isDefault: true },
            ],
          }),
        ]),
      ],
      fail: "T3_CATALOG_INVALID",
    },
  ],
  [
    "unadvertised currentValue masked by explicit effort",
    {
      settings: { effort: "deep" },
      providers: [withDescriptors([select("effort", { currentValue: "missing" })])],
      fail: "T3_CATALOG_INVALID",
    },
  ],
  [
    "duplicate saved option identities",
    {
      server: {
        defaultModelSelection: saved("instance-a", "model-a", [option("minimal"), option("deep")]),
      },
      fail: "T3_CATALOG_INVALID",
    },
  ],
  [
    "extensions ignored without leaking",
    {
      providers: [withDescriptors([{ ...select(), extension: { token: "CANARY-descriptor" } }])],
      expected: { selection: saved("instance-a", "model-a", [option("minimal")]) },
    },
  ],
];
test.each(cases)("A19 pure selection: %s", (_name, scenario) => {
  const config = catalog(scenario.providers, scenario.server);
  const project = (scenario.project ?? undefined) as JsonObject | undefined;
  const before = structuredClone({ config, project, settings: scenario.settings });
  let sources: unknown;
  const resolve = () =>
    resolveT3Selection(config, scenario.settings ?? {}, project, {
      readiness: true,
      provenance: (value) => {
        sources = value;
      },
    });
  if (scenario.fail) expect(resolve).toThrow(expect.objectContaining({ code: scenario.fail }));
  else {
    const selection = resolve();
    expect(selection).toEqual((scenario.expected as { selection: unknown }).selection);
    expect(sources).toBeDefined();
    expect(JSON.stringify({ selection, sources })).not.toContain("CANARY");
  }
  expect({ config, project, settings: scenario.settings }).toEqual(before);
});
const malformed: [string, unknown][] = [
  ["descriptor container", {}],
  ["descriptor array scalar", [null]],
  ["descriptor id array", [{ ...select(), id: ["effort"] }]],
  ["descriptor type array", [{ ...select(), type: ["select"] }]],
  ["descriptor unknown type", [{ ...select(), type: "string" }]],
  ["select choices object", [{ ...select(), options: {} }]],
  ["select choice scalar", [{ ...select(), options: [false] }]],
  ["select choice id array", [{ ...select(), options: [{ id: ["minimal"] }] }]],
  ["select default array", [{ ...select(), options: [{ id: "minimal", isDefault: [true] }] }]],
  ["select current boolean", [{ ...select(), currentValue: true }]],
  ["select current array", [{ ...select(), currentValue: ["minimal"] }]],
  ["boolean current string", [{ id: "fastMode", type: "boolean", currentValue: "false" }]],
  ["boolean current object", [{ id: "fastMode", type: "boolean", currentValue: {} }]],
];
test.each(malformed)("A19 malformed consumed descriptor: %s", (_name, descriptors) => {
  expect(() =>
    resolveT3Selection(catalog([withDescriptors(descriptors)]), {}, undefined, { readiness: true }),
  ).toThrow(expect.objectContaining({ code: "T3_CATALOG_INVALID" }));
});
test.each([null, {}, [], 1, "", " deep "])("A19 malformed saved option scalar %j", (value) => {
  expect(() =>
    resolveT3Selection(
      catalog(undefined, {
        defaultModelSelection: { ...saved(), options: [{ id: "effort", value }] },
      }),
      {},
      undefined,
      { readiness: true },
    ),
  ).toThrow(expect.objectContaining({ code: "T3_CATALOG_INVALID" }));
});
test("A19 ordinary resolver keeps duplicate option compatibility", () => {
  expect(resolveT3Selection(catalog([withDescriptors([select(), select()])]), {}).options).toEqual([
    option("minimal"),
    option("minimal"),
  ]);
  expect(
    resolveT3Selection(
      catalog(undefined, {
        defaultModelSelection: saved("instance-a", "model-a", [option("minimal"), option("deep")]),
      }),
      {},
    ).options,
  ).toEqual(defaults);
});
test.each(cases)("A19 default Bun owned model/options: %s", async (_name, scenario) => {
  const f = await createReadinessFixture();
  const savedEnv = process.env;
  const evidence = savedEnv.D1_MODEL_OPTIONS_EVIDENCE;
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
          run: savedEnv.D1_MODEL_OPTIONS_RUN,
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
    const resolve = readiness.resolveT3ReadinessEffectiveSelection;
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
    // Selection is a pure gate: no additional native effects or state changes.
    expect(await f.effects()).toEqual(effects);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    process.env = savedEnv;
    await f.dispose();
  }
});
