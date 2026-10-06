import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as readiness from "../../src/lib/t3-readiness.ts";
import { resolveT3Selection, type JsonObject } from "../../src/lib/t3-native.ts";
import { withSelectionReadFixture } from "../helpers/t3-readiness-selection-fixture.ts";

const date = "2026-01-01T00:00:00.000Z";
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
  await withSelectionReadFixture(
    scenario,
    catalog(scenario.providers, scenario.server),
    saved("missing"),
    async ({ f, context, before, savedEnv }) => {
      const evidence = savedEnv.D1_SELECTION_EVIDENCE;
      for (const leaf of ["provider", "model", "effort"] as const)
        if (context.settings[leaf]) expect(context.sources[leaf]).toBe(scenario.source ?? "cli");
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
        expect(() =>
          resolve(read.use.status === "succeeded" ? read.use.value : undefined!),
        ).toThrow(expect.objectContaining({ code: scenario.fail }));
      else {
        result = resolve(read.use.value);
        expect(result).toMatchObject({ effectiveSelection: "resolved", ...scenario.expected });
        expect(JSON.stringify(result)).not.toMatch(
          /CANARY|environment-1|fixture-session|127\.0\.0\.1/,
        );
        expect(() => resolve({ ...value })).toThrow();
      }
    },
  );
});
