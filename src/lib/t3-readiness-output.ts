import { isAbsolute } from "node:path";
import { t3WireTimestamp as dateValid } from "./t3-wire.ts";
import { stripVTControlCharacters } from "node:util";
import { summarizeDoctorFindings, type DoctorFinding, type DoctorSummary } from "./doctor.ts";
import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  stringifyJsonEnvelope,
} from "./json-output.ts";
import { identifier } from "./t3-native.ts";
import type { T3Settings } from "./t3-settings.ts";
import {
  T3_READINESS_REASONS,
  t3ReadinessOutputContext,
  type T3ReadinessOutcome,
  type ReadinessStage,
  type T3EffectiveSelectionSource,
} from "./t3-readiness.ts";

const names = [
  "selection",
  "cli",
  "runtime",
  "compatibility",
  "authentication",
  "catalog",
  "project",
  "effectiveSelection",
] as const;
const origins = [
  "cli",
  "workspace",
  "user",
  "environment",
  "builtin",
  "project",
  "server",
  "catalog",
] as const;
const leaves = ["cli", "baseDir", "provider", "model", "effort"] as const;
type Code = keyof typeof T3_READINESS_REASONS;
export interface T3ReadinessOutputData {
  mode: "t3";
  checkMode: T3ReadinessOutcome["checkMode"];
  workspaceRoot: string | null;
  checkout: string | null;
  sources: Partial<Record<(typeof leaves)[number], T3EffectiveSelectionSource>>;
  settings: T3Settings;
  readiness: T3ReadinessOutcome["readiness"];
  stages: ReadinessStage[];
  cleanup: T3ReadinessOutcome["cleanup"];
  selection?: NonNullable<T3ReadinessOutcome["selection"]>;
  provider?: NonNullable<T3ReadinessOutcome["provider"]>;
  checkedCategories: ("t3" | "configuration")[];
  findings: DoctorFinding[];
  summary: DoctorSummary;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error("T3_OUTPUT_INVALID");
}
function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((item) => item === value);
}
const codeValid = (value: unknown): value is Code =>
  typeof value === "string" && Object.hasOwn(T3_READINESS_REASONS, value);
// Native catalog admission permits canonical text IDs/choices, not a new
// slug grammar. Retain exact privately observed values; reject URLs/controls
// instead of coercing or repairing identity at the presentation boundary.
const selectionText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  value.trim() === value &&
  !/[\p{Cc}\p{Cf}]/u.test(value) &&
  !value.includes("://");
function safePath(value: unknown): string | null {
  if (value === null) return null;
  requireValid(typeof value === "string" && isAbsolute(value));
  return stripVTControlCharacters(value).replace(
    /[\p{Cc}\p{Cf}]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function sources(value: unknown): T3ReadinessOutputData["sources"] {
  requireValid(object(value));
  const result: T3ReadinessOutputData["sources"] = {};
  for (const leaf of leaves)
    if (Object.hasOwn(value, leaf)) {
      requireValid(member(value[leaf], origins));
      result[leaf] = value[leaf];
    }
  return result;
}
// Every message/command is local static text. Caught messages, remote reasons,
// profile labels, stdout/stderr and error.details never enter this projection.
function finding(code: Code, severity: "error" | "warning"): DoctorFinding {
  const message =
    code === "T3_AUTH_CLEANUP_FAILED"
      ? "Owned-session cleanup failed; successful check observations remain valid."
      : code === "T3_AUTH_CLEANUP_UNKNOWN"
        ? "Owned-session cleanup could not be verified; successful check observations remain valid."
        : code === "T3_PROVIDER_STATE_UNKNOWN"
          ? "Provider prerequisites are unknown or stale; no task-readiness guarantee is made."
          : code === "T3_OUTPUT_INVALID"
            ? "T3 readiness output evidence is invalid or unavailable."
            : "A T3 readiness prerequisite could not be verified. Review the bounded stage code.";
  return {
    code,
    severity,
    category: "t3",
    scope: "t3",
    message,
    suggestedCommands: ["aw doctor --help"],
  };
}
function invalidData(): T3ReadinessOutputData {
  const findings = [finding("T3_OUTPUT_INVALID", "error")];
  return {
    mode: "t3",
    checkMode: "preview",
    workspaceRoot: null,
    checkout: null,
    sources: {},
    settings: {},
    readiness: "blocked",
    cleanup: { state: "not_attempted" },
    stages: names.map((name) => ({
      name,
      state: "unknown",
      code: "T3_OUTPUT_INVALID",
      reason: T3_READINESS_REASONS.T3_OUTPUT_INVALID,
    })),
    checkedCategories: ["t3"],
    findings,
    summary: summarizeDoctorFindings(findings),
  };
}
function project(value: unknown): T3ReadinessOutputData {
  requireValid(object(value));
  const context = t3ReadinessOutputContext(value as unknown as T3ReadinessOutcome);
  requireValid(context);
  requireValid(member(value.checkMode, ["preview", "authenticated"]));
  requireValid(
    member(value.readiness, [
      "preview_passed",
      "global_verified",
      "checkout_verified",
      "unknown",
      "blocked",
    ]),
  );
  requireValid(
    object(value.cleanup) &&
      member(value.cleanup.state, ["not_attempted", "verified", "failed", "unknown"]),
  );
  requireValid(Array.isArray(value.stages) && value.stages.length === names.length);
  const stages: ReadinessStage[] = value.stages.map((raw, index) => {
    requireValid(
      object(raw) &&
        raw.name === names[index] &&
        member(raw.state, ["verified", "failed", "deferred", "unknown", "not_applicable"]) &&
        codeValid(raw.code) &&
        raw.reason === T3_READINESS_REASONS[raw.code],
    );
    return {
      name: names[index]!,
      state: raw.state,
      code: raw.code,
      reason: T3_READINESS_REASONS[raw.code],
    };
  });
  requireValid(Array.isArray(value.findings));
  const findings = value.findings.map((raw) => {
    requireValid(object(raw) && codeValid(raw.code) && member(raw.severity, ["error", "warning"]));
    return finding(raw.code, raw.severity);
  });
  const data: T3ReadinessOutputData = {
    mode: "t3",
    checkMode: value.checkMode,
    readiness: value.readiness,
    workspaceRoot: safePath(context.workspaceRoot),
    checkout: safePath(context.checkout),
    sources: sources(context.sources),
    settings: {},
    stages,
    cleanup: { state: value.cleanup.state },
    checkedCategories: ["t3"],
    findings,
    summary: summarizeDoctorFindings(findings),
  };
  for (const leaf of leaves) {
    const setting = context.settings[leaf];
    if (setting !== undefined) {
      requireValid(typeof setting === "string" && setting.length > 0);
      if (leaf === "baseDir" || (leaf === "cli" && isAbsolute(setting)))
        data.settings[leaf] = safePath(setting)!;
      else {
        requireValid(selectionText(setting));
        data.settings[leaf] = setting;
      }
    }
  }
  if (Object.hasOwn(value, "selection")) {
    const s = value.selection;
    requireValid(
      object(s) &&
        identifier(s.instanceId) &&
        selectionText(s.model) &&
        typeof s.provisional === "boolean" &&
        Array.isArray(s.options) &&
        Array.isArray(s.optionSources),
    );
    const options = s.options.map((entry) => {
      requireValid(
        object(entry) &&
          selectionText(entry.id) &&
          (selectionText(entry.value) || typeof entry.value === "boolean"),
      );
      return { id: entry.id as string, value: entry.value };
    });
    const optionSources = s.optionSources.map((entry) => {
      requireValid(object(entry) && selectionText(entry.id) && member(entry.source, origins));
      return { id: entry.id as string, source: entry.source };
    });
    requireValid(
      new Set(options.map((o) => o.id)).size === options.length &&
        new Set(optionSources.map((o) => o.id)).size === optionSources.length &&
        options.length === optionSources.length &&
        options.every((o) => optionSources.some((p) => p.id === o.id)),
    );
    data.selection = {
      instanceId: s.instanceId as string,
      model: s.model,
      options,
      provisional: s.provisional,
      sources: sources(s.sources),
      optionSources,
    };
  }
  if (Object.hasOwn(value, "provider")) {
    const p = value.provider;
    requireValid(
      object(p) &&
        member(p.state, ["verified", "unknown"]) &&
        member(p.status, ["ready", "warning"]) &&
        member(p.authStatus, ["authenticated", "unknown"]) &&
        member(p.freshness, ["fresh", "stale", "unknown"]) &&
        (p.checkedAt === null || dateValid(p.checkedAt)) &&
        (!Object.hasOwn(p, "severity") || p.severity === "warning"),
    );
    requireValid((p.freshness === "unknown") === (p.checkedAt === null));
    requireValid(
      (p.state === "verified") ===
        (p.status === "ready" && p.authStatus === "authenticated" && p.freshness === "fresh"),
    );
    data.provider = {
      state: p.state,
      status: p.status,
      authStatus: p.authStatus,
      checkedAt: p.checkedAt,
      freshness: p.freshness,
      ...(p.severity === "warning" ? { severity: "warning" } : {}),
    };
  }
  // Cross-field admission: valid enum markers alone cannot invent a lifecycle.
  const stage = (name: ReadinessStage["name"]) => stages.find((s) => s.name === name)!;
  if (data.checkMode === "preview") {
    requireValid(
      data.cleanup.state === "not_attempted" &&
        !data.selection &&
        !data.provider &&
        ["preview_passed", "blocked"].includes(data.readiness),
    );
    requireValid(
      ["authentication", "catalog", "effectiveSelection"].every(
        (name) => stage(name as ReadinessStage["name"]).state === "deferred",
      ),
    );
  } else
    requireValid(data.readiness !== "preview_passed" || data.cleanup.state === "not_attempted");
  if (data.selection) {
    requireValid(
      data.checkMode === "authenticated" &&
        data.cleanup.state !== "not_attempted" &&
        ["authentication", "catalog", "effectiveSelection"].every(
          (name) => stage(name as ReadinessStage["name"]).state === "verified",
        ),
    );
    requireValid(data.selection.provisional === (stage("project").state === "deferred"));
  }
  if (["global_verified", "checkout_verified", "unknown"].includes(data.readiness)) {
    requireValid(data.selection && data.provider);
    if (data.readiness !== "unknown")
      requireValid(data.provider.state === "verified" && !data.selection.provisional);
    if (data.readiness === "global_verified")
      requireValid(data.checkout === null && stage("project").state === "not_applicable");
    if (data.readiness === "checkout_verified")
      requireValid(data.checkout !== null && stage("project").state === "verified");
  }
  requireValid(
    (data.readiness === "blocked") ===
      findings.some(
        (f) =>
          f.severity === "error" &&
          !["T3_AUTH_CLEANUP_FAILED", "T3_AUTH_CLEANUP_UNKNOWN"].includes(f.code),
      ),
  );
  if (["failed", "unknown"].includes(data.cleanup.state))
    requireValid(
      findings.some(
        (f) =>
          f.code ===
            (data.cleanup.state === "failed"
              ? "T3_AUTH_CLEANUP_FAILED"
              : "T3_AUTH_CLEANUP_UNKNOWN") && f.severity === "error",
      ),
    );
  const observed = context.observed;
  requireValid(
    data.checkMode === observed.checkMode &&
      data.readiness === observed.readiness &&
      data.cleanup.state === observed.cleanup.state,
  );
  requireValid(JSON.stringify(data.stages) === JSON.stringify(observed.stages));
  requireValid(JSON.stringify(data.selection) === JSON.stringify(observed.selection));
  requireValid(JSON.stringify(data.provider) === JSON.stringify(observed.provider));
  requireValid(
    JSON.stringify(data.findings.map(({ code, severity }) => ({ code, severity }))) ===
      JSON.stringify(observed.findings),
  );
  return data;
}
function human(data: T3ReadinessOutputData): string {
  const lines = [
    data.checkMode === "preview"
      ? "T3 Preview readiness (not an authenticated check)"
      : "T3 Authenticated prerequisite check (administrative authority)",
    `Readiness: ${data.readiness}`,
    `Cleanup: ${data.cleanup.state} (independent of check observations)`,
  ];
  if (data.workspaceRoot) lines.push(`Workspace: ${data.workspaceRoot}`);
  if (data.checkout) lines.push(`Checkout: ${data.checkout}`);
  for (const leaf of leaves)
    if (data.settings[leaf] !== undefined)
      lines.push(`Selected ${leaf}: ${data.settings[leaf]} (${data.sources[leaf] ?? "builtin"})`);
  for (const s of data.stages) lines.push(`${s.name}: ${s.state} [${s.code}] ${s.reason}`);
  if (data.selection) {
    lines.push(
      `${data.selection.provisional ? "Provisional" : "Effective"} selection: ${data.selection.instanceId} / ${data.selection.model}`,
    );
    for (const [leaf, origin] of Object.entries(data.selection.sources))
      lines.push(`  ${leaf}: ${origin}`);
    for (const option of data.selection.options)
      lines.push(
        `  ${option.id}: ${option.value} (${data.selection.optionSources.find((p) => p.id === option.id)!.source})`,
      );
  }
  if (data.provider)
    lines.push(`Provider prerequisites: ${data.provider.state} (${data.provider.freshness})`);
  lines.push(
    `Summary: ${data.summary.error} blocking, ${data.summary.warning} warning, ${data.summary.info} info (${data.summary.total} total)`,
  );
  for (const f of data.findings) {
    lines.push(`${f.severity}: ${f.code}: ${f.message}`);
    lines.push(...f.suggestedCommands.map((command) => `  ${command}`));
  }
  lines.push(
    "No task was created. Deferred or unknown prerequisites are not a task-readiness guarantee.",
  );
  return lines.join("\n");
}
/** Pure boundary: no process.exit, global output, prompt or raw error conversion. */
export function formatT3ReadinessOutput(
  value: unknown,
  json: boolean,
): { data: T3ReadinessOutputData; text: string; exitCode: 0 | 1 } {
  let data: T3ReadinessOutputData;
  try {
    data = project(value);
  } catch {
    data = invalidData();
  }
  const exitCode =
    data.summary.error > 0 || ["failed", "unknown"].includes(data.cleanup.state) ? 1 : 0;
  const envelope =
    exitCode === 0
      ? createJsonSuccessEnvelope("doctor", { ...data })
      : createJsonErrorEnvelope("doctor", {
          code: "DOCTOR_BLOCKING_FINDINGS",
          message: "Blocking T3 readiness findings were detected.",
          details: { ...data },
        });
  return { data, exitCode, text: json ? stringifyJsonEnvelope(envelope) : human(data) };
}
