import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import * as readiness from "../../src/lib/t3-readiness.ts";
import { nativeChildEnvironment } from "../../src/lib/t3-native.ts";
import { resolveT3ReadinessContext } from "../../src/lib/t3-readiness-context.ts";
import { T3HandoffError } from "../../src/lib/t3-error.ts";
import { createReadinessFixture } from "./t3-readiness-fixture.ts";
const baseline = process.env.D1_OUTPUT_BASELINE_ADAPTER === "1";
export const canaries = [
  "CANARY-runtime",
  "CANARY-auth",
  "CANARY-email",
  "CANARY-config",
  "CANARY-shell",
  "CANARY-ticket",
  "CANARY-stderr",
  "CANARY-error",
];
const date = "2026-01-01T00:00:00.000Z";
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: canaries[1],
};
export const names = [
  "selection",
  "cli",
  "runtime",
  "compatibility",
  "authentication",
  "catalog",
  "project",
  "effectiveSelection",
];
export type Scenario =
  | "preview"
  | "global"
  | "checkout"
  | "selection-text"
  | "missing-project"
  | "unknown-provider"
  | "read-failed"
  | "cleanup-failed"
  | "cleanup-unknown"
  | "typed-error"
  | "child-stderr"
  | "untyped-error"
  | "issue-stderr"
  | "read-cleanup-failed"
  | "read-cleanup-unknown";
export async function withOutcome(
  scenario: Scenario,
  inspect: (result: readiness.T3ReadinessOutcome) => void | Promise<void>,
) {
  const f = await createReadinessFixture();
  const env = process.env;
  process.env = { ...f.env, T3CODE_HOME: f.baseDir };
  try {
    const context = await resolveT3ReadinessContext({
      cwd: f.repo,
      explicitSettings: { cli: f.cli, baseDir: f.baseDir },
    });
    if (scenario === "global") context.checkout = null;
    const cwd = context.checkout ?? f.root;
    for (const argv of [
      f.versionArgv,
      f.issueArgv.map((a) => (a === "Arashi handoff" ? "Arashi readiness" : a)),
      [f.cli, "auth", "session", "revoke", "fixture-session-1", "--base-dir", f.baseDir],
      [f.cli, "auth", "session", "list", "--base-dir", f.baseDir, "--json"],
    ])
      f.allowProcess(argv, cwd, nativeChildEnvironment({ T3CODE_HOME: f.baseDir }));
    for (const path of [
      "/.well-known/t3/environment",
      "/api/auth/session",
      "/api/orchestration/shell",
    ])
      f.allowHttp("GET", path);
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    f.allowWs("server.getConfig");
    f.allowWs("Pong");
    const descriptor = {
      environmentId: "environment-1",
      serverVersion: "0.0.43",
      orchestrationProtocolVersion: 1,
      platform: { os: process.platform, arch: process.arch },
      capabilities: { repositoryIdentity: true, connectionProbe: true },
      extension: canaries[0],
    };
    const runtime = JSON.parse(await readFile(f.runtimePath, "utf8"));
    await writeFile(
      f.runtimePath,
      JSON.stringify({
        ...runtime,
        auth: { token: canaries[0] },
        privateProfileLabel: canaries[0],
        receipt: { prompt: canaries[4], digest: canaries[4] },
      }),
    );
    const executable = await readFile(f.cli, "utf8");
    await writeFile(
      f.cli,
      executable
        .replace("ticket:crypto.randomUUID()", `ticket:'${canaries[5]}'`)
        .replace("token:crypto.randomUUID()", `token:'${canaries[1]}-token'`),
    );
    await f.configureReadFoundation({
      descriptor,
      session: {
        authenticated: true,
        auth,
        sessionMethod: "bearer-access-token",
        scopes: ["orchestration:read"],
        extension: canaries[1],
      },
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
            auth: {
              status: scenario === "unknown-provider" ? "unknown" : "authenticated",
              email: canaries[2],
            },
            checkedAt: date,
            models: [
              {
                slug: scenario === "selection-text" ? "model @variant +2026" : "model-a",
                name: canaries[3],
                isCustom: false,
                isDefault: true,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: scenario === "selection-text" ? "enabled flag" : "enabled",
                      label: canaries[3],
                      type: "boolean",
                      currentValue: false,
                    },
                  ],
                },
              },
            ],
          },
        ],
        settings: {},
        extension: canaries[3],
      },
      shell: {
        snapshotSequence: 0,
        updatedAt: date,
        projects:
          scenario === "missing-project"
            ? []
            : [
                {
                  id: "project-a",
                  workspaceRoot: f.repo,
                  defaultModelSelection: null,
                  extension: canaries[4],
                },
              ],
        threads: [
          {
            id: "thread-a",
            projectId: "project-a",
            title: canaries[4],
            messages: [{ prompt: canaries[4], digest: canaries[4] }],
            receipt: canaries[4],
          },
        ],
        extension: canaries[4],
      },
      ...(scenario.startsWith("read-") ? { shellStatus: 500 } : {}),
    });
    if (
      [
        "cleanup-failed",
        "cleanup-unknown",
        "child-stderr",
        "issue-stderr",
        "read-cleanup-failed",
        "read-cleanup-unknown",
      ].includes(scenario)
    ) {
      const cli = await readFile(f.cli, "utf8");
      await writeFile(
        f.cli,
        scenario.endsWith("cleanup-failed")
          ? cli.replace(
              "console.log('{}');",
              `console.error('${canaries[6]}');console.log('{}');process.exit(1);`,
            )
          : scenario.endsWith("cleanup-unknown")
            ? cli.replace(
                "console.log(JSON.stringify(load('sessions.json').map(s=>({sessionId:s.sessionId}))));",
                `{console.error('${canaries[6]}');console.log('{}')}`,
              )
            : scenario === "issue-stderr"
              ? cli.replace(
                  "console.log(JSON.stringify(session));",
                  `console.error('${canaries[6]}');console.log(JSON.stringify({...session,token:null}));`,
                )
              : cli.replace(
                  "console.log('t3 v0.0.43');",
                  `{console.error('${canaries[6]}');process.exit(1);}`,
                ),
      );
    }
    await f.installMarkers();
    const before = await f.snapshot();
    const dependencies = {
      checkTime: () => Date.parse(date),
      ...(scenario.endsWith("typed-error")
        ? {
            readRuntime: async () => {
              if (scenario === "untyped-error") throw new Error(canaries[7]);
              throw new T3HandoffError("T3_DISCOVERY_INVALID", canaries[7]!, {
                token: canaries[7],
              });
            },
          }
        : {}),
    };
    let result;
    if (baseline) {
      const preview = await readiness.collectT3ReadinessPreview(
        { cwd: f.root, context },
        dependencies,
      );
      const read =
        scenario !== "preview" && preview.exitCode === 0
          ? await readiness.collectT3AuthenticatedReadFoundation(
              preview,
              { authenticated: true },
              dependencies,
            )
          : undefined;
      const selected =
        read?.use.status === "succeeded"
          ? readiness.resolveT3ReadinessEffectiveSelection(read.use.value)
          : undefined;
      const provider = selected ? readiness.classifyT3ReadinessProviderState(selected) : undefined;
      result = {
        checkMode: scenario === "preview" ? "preview" : "authenticated",
        readiness: provider?.readiness ?? preview.readiness,
        stages: preview.stages,
        cleanup: { state: read?.cleanup.status ?? "not_attempted" },
        selection: selected
          ? {
              ...selected.selection,
              provisional: selected.provisional,
              sources: selected.sources,
              optionSources: selected.optionSources,
            }
          : undefined,
        provider: provider?.provider,
      } as unknown as readiness.T3ReadinessOutcome;
    } else
      result = await readiness.collectT3ReadinessOutcome(
        { cwd: f.root, context, authenticated: scenario !== "preview" },
        dependencies,
      );
    await inspect(result);
    await f.waitForSocketsClosed();
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual(await f.activeSessions(), []);
    const effects = await f.effects();
    assert.deepEqual(
      effects.filter((e) => e.kind === "denied"),
      [],
    );
    const processActions = effects
      .filter((e) => e.kind === "process")
      .map((e) => (e.argv![1] === "--version" ? "version" : e.argv![3]));
    const preAuth = ["typed-error", "untyped-error", "child-stderr"].includes(scenario);
    assert.deepEqual(
      processActions,
      scenario === "preview" || preAuth
        ? ["version"]
        : ["version", "version", "issue", "revoke", "list"],
    );
    if (env.D1_OUTPUT_EFFECTS_EVIDENCE)
      await appendFile(
        env.D1_OUTPUT_EFFECTS_EVIDENCE,
        JSON.stringify({
          scenario,
          appRuntime: process.execPath,
          immutable: true,
          remainingSessions: 0,
          operations: effects.map(({ sessionId: _privateId, ...effect }) => ({
            ...effect,
            argv: effect.argv?.map((arg) =>
              arg === "fixture-session-1" ? "<owned-session>" : arg,
            ),
          })),
        }) + "\n",
      );
  } finally {
    process.env = env;
    await f.dispose();
  }
}
