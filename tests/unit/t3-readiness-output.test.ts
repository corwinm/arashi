import {
  withOutcome,
  canaries,
  names,
  type Scenario,
} from "../helpers/t3-readiness-output-fixture.ts";
import { expect, test } from "vitest";
import type { T3ReadinessOutputData } from "../../src/lib/t3-readiness-output.ts";
import { T3HandoffError } from "../../src/lib/t3-error.ts";

// Explicit preimplementation adapter: expose real existing observations unchanged.
// This is new-contract assertion RED, not evidence that native guards were broken.
const baseline = process.env.D1_OUTPUT_BASELINE_ADAPTER === "1";
const output = baseline
  ? {
      formatT3ReadinessOutput: (value: unknown, _json: boolean) => ({
        text: JSON.stringify(value),
        exitCode: 0,
        data: value as T3ReadinessOutputData,
      }),
    }
  : await import("../../src/lib/t3-readiness-output.ts");
test("A22 arbitrary typed exceptions never become public details or guidance", () => {
  const error = new T3HandoffError("T3_AUTH_FAILED", canaries[7]!, {
    token: canaries[5],
    stderr: canaries[6],
  });
  for (const json of [false, true]) {
    const rendered = output.formatT3ReadinessOutput(error, json);
    for (const canary of canaries) expect(rendered.text).not.toContain(canary);
    expect(rendered.exitCode).toBe(1);
  }
});
const cases: [Scenario, string, number, string][] = [
  ["preview", "preview_passed", 0, "not_attempted"],
  ["global", "global_verified", 0, "verified"],
  ["checkout", "checkout_verified", 0, "verified"],
  ["selection-text", "checkout_verified", 0, "verified"],
  ["missing-project", "unknown", 0, "verified"],
  ["unknown-provider", "unknown", 0, "verified"],
  ["read-failed", "blocked", 1, "verified"],
  ["cleanup-failed", "checkout_verified", 1, "failed"],
  ["cleanup-unknown", "checkout_verified", 1, "unknown"],
  ["typed-error", "blocked", 1, "not_attempted"],
  ["child-stderr", "blocked", 1, "not_attempted"],
  ["untyped-error", "blocked", 1, "not_attempted"],
  ["issue-stderr", "blocked", 1, "verified"],
  ["read-cleanup-failed", "blocked", 1, "failed"],
  ["read-cleanup-unknown", "blocked", 1, "unknown"],
];
test.each(cases)(
  "A21/A22 owned collector output %s",
  async (scenario, state, exitCode, cleanup) => {
    await withOutcome(scenario, (result) => {
      for (const json of [false, true]) {
        const rendered = output.formatT3ReadinessOutput(result, json);
        expect(rendered.exitCode).toBe(exitCode);
        expect(rendered.data).toMatchObject({
          mode: "t3",
          checkMode: scenario === "preview" ? "preview" : "authenticated",
          readiness: state,
          cleanup: { state: cleanup },
        });
        expect(rendered.data.settings).toMatchObject({
          cli: expect.any(String),
          baseDir: expect.any(String),
        });
        expect(rendered.data.sources).toMatchObject({ cli: "cli", baseDir: "cli" });
        expect(rendered.data.stages.map((s) => s.name)).toEqual(names);
        for (const canary of canaries) expect(rendered.text).not.toContain(canary);
        if (json) {
          const doc = JSON.parse(rendered.text);
          expect(doc).toMatchObject({ schemaVersion: 1, command: "doctor", ok: exitCode === 0 });
          expect(exitCode ? doc.error.details : doc.data).toEqual(rendered.data);
          if (exitCode) expect(doc.error.code).toBe("DOCTOR_BLOCKING_FINDINGS");
        } else {
          expect(rendered.text).toContain(scenario === "preview" ? "Preview" : "Authenticated");
          expect(rendered.text).toContain(`Cleanup: ${cleanup}`);
          if (!["preview", "typed-error", "child-stderr"].includes(scenario))
            expect(rendered.text).toContain("administrative authority");
        }
        if (scenario === "issue-stderr")
          expect(rendered.data.stages.find((s) => s.name === "authentication")?.reason).toBe(
            "authentication_rejected",
          );
        if (scenario.startsWith("read-"))
          expect(rendered.data.stages.find((s) => s.name === "project")?.reason).toBe(
            "http_read_failed",
          );
        if (scenario.startsWith("read-"))
          expect(rendered.data.stages.find((s) => s.name === "authentication")?.state).toBe(
            "verified",
          );
        if (scenario === "missing-project") {
          expect(rendered.data.selection?.provisional).toBe(true);
          expect(rendered.text).toContain(json ? '"provisional": true' : "Provisional");
        }
      }
    });
  },
);

test("A23 retained nested fields reject malformed types/enums without coercion; extensions omitted", async () => {
  await withOutcome("checkout", (result) => {
    const invalid = [
      null,
      [],
      {},
      1,
      true,
      ["verified"],
      "CANARY-invalid",
      "\u001b[31munsafe\nvalue",
    ];
    const paths = [
      "readiness",
      "checkMode",
      "cleanup.state",
      "stages.0.name",
      "stages.0.state",
      "stages.0.code",
      "stages.0.reason",
      "selection.instanceId",
      "selection.model",
      "selection.provisional",
      "selection.options.0.id",
      "selection.options.0.value",
      "selection.sources.provider",
      "selection.optionSources.0.id",
      "selection.optionSources.0.source",
      "provider.state",
      "provider.status",
      "provider.authStatus",
      "provider.checkedAt",
      "provider.freshness",
      "provider.severity",
    ];
    for (const path of paths) {
      const parts = path.split(".");
      let parent = result as unknown as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
      const key = parts.at(-1)!;
      const had = Object.hasOwn(parent, key);
      const old = parent[key];
      for (const value of invalid) {
        if (typeof value === typeof old && value === old) continue;
        parent[key] = value;
        const formatted = output.formatT3ReadinessOutput(result, true);
        expect(formatted.exitCode, path).toBe(1);
        expect(formatted.text, path).not.toContain("CANARY-invalid");
      }
      if (had) parent[key] = old;
      else delete parent[key];
    }
    Object.assign(result, { raw: canaries });
    Object.assign(result.selection!, { extension: canaries });
    Object.assign(result.provider!, { email: canaries[2] });
    for (const nested of [
      result.cleanup,
      ...result.stages,
      ...result.selection!.options,
      ...result.selection!.optionSources,
      result.selection!.sources,
    ])
      Object.assign(nested, { extension: canaries });
    const good = output.formatT3ReadinessOutput(result, true);
    expect(good.exitCode).toBe(0);
    for (const canary of canaries) expect(good.text).not.toContain(canary);
    expect(output.formatT3ReadinessOutput({ ...result }, true).exitCode).toBe(1);
    result.selection!.instanceId = "other-valid-instance";
    expect(output.formatT3ReadinessOutput(result, true).exitCode).toBe(1);
    result.selection!.instanceId = "instance-a";
    result.selection!.model = "model\u001b[31m\n-a";
    const controls = output.formatT3ReadinessOutput(result, false);
    expect(controls.exitCode).toBe(1);
    expect(controls.text).not.toContain("\u001b");
  });
});

test("A23 warning finding scalars are bounded and all presentation extensions are omitted", async () => {
  await withOutcome("unknown-provider", (result) => {
    for (const field of ["code", "severity"] as const) {
      const entry = result.findings[0]!;
      const old = entry[field];
      for (const malformed of [
        null,
        [],
        {},
        1,
        true,
        [old],
        "CANARY-finding",
        "\u001b[31munsafe\nvalue",
      ]) {
        Object.assign(entry, { [field]: malformed });
        for (const json of [false, true]) {
          const shown = output.formatT3ReadinessOutput(result, json);
          expect(shown.exitCode).toBe(1);
          expect(shown.text).not.toContain("CANARY-finding");
        }
      }
      Object.assign(entry, { [field]: old });
    }
    Object.assign(result.findings[0]!, {
      message: canaries[7],
      details: { token: canaries[1] },
      scope: canaries[3],
      suggestedCommands: [canaries[6]],
      category: canaries[2],
    });
    const shown = output.formatT3ReadinessOutput(result, true);
    expect(shown.exitCode).toBe(0);
    for (const canary of canaries) expect(shown.text).not.toContain(canary);
  });
});
