import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { projectUsesWorkspace } from "./t3-handoff.ts";
import { constants } from "node:fs";
import {
  discoverT3Environment,
  identifier,
  readT3CliVersion,
  readT3Config,
  resolveT3Selection,
  type T3Selection,
  withOwnedT3Session,
  type T3OwnedSessionResult,
  type JsonObject,
  record,
  t3Http,
  verifyT3Protocol,
  verifyT3Version,
  type T3NativeDependencies,
} from "./t3-native.ts";
import { T3HandoffError } from "./t3-error.ts";
import { checkT3Read, runT3Read, t3Now } from "./t3-operation.ts";
import {
  resolveT3ReadinessContext,
  type T3ReadinessContext,
  type T3ReadinessSettingSource,
} from "./t3-readiness-context.ts";
import type { T3Settings } from "./t3-settings.ts";

const MAX_BYTES = 1024 * 1024;
const OPERATION_MS = 15_000;
export const T3_READINESS_REASONS = {
  T3_CHECK_CANCELLED: "check_cancelled",
  T3_CHECK_TIMEOUT: "check_timeout",
  T3_IDENTITY_CHANGED: "preview_identity_changed",
  T3_AUTHENTICATED_REQUIRED: "explicit_authenticated_required",
  T3_PREVIEW_REQUIRED: "passing_preview_required",
  T3_SELECTION_VERIFIED: "selection_verified",
  T3_SELECTION_INVALID: "selection_invalid",
  T3_CLI_VERIFIED: "cli_verified",
  T3_RUNTIME_VERIFIED: "runtime_verified",
  T3_CAPABILITIES_MISSING: "public_capabilities_missing",
  T3_CAPABILITIES_DEFERRED: "public_capabilities_deferred",
  T3_COMPATIBILITY_VERIFIED: "compatibility_verified",
  T3_CLI_NOT_FOUND: "cli_missing",
  T3_ENVIRONMENT_MISSING: "runtime_missing",
  T3_DISCOVERY_INVALID: "runtime_invalid",
  T3_ENVIRONMENT_STALE: "runtime_stale",
  T3_VERSION_UNSUPPORTED: "version_unsupported",
  T3_PROTOCOL_UNSUPPORTED: "protocol_unsupported",
  T3_VERSION_MISMATCH: "version_mismatch",
  T3_ENVIRONMENT_INVALID: "environment_invalid",
  T3_AUTH_FAILED: "authentication_rejected",
  T3_HTTP_FAILED: "http_read_failed",
  T3_RESPONSE_INVALID: "descriptor_invalid",
  T3_UNREACHABLE: "operation_unreachable",
  T3_CHECK_DEFERRED: "authenticated_check_deferred",
  T3_PROJECT_DEFAULTS_DEFERRED: "project_defaults_deferred",
  T3_PROJECT_NOT_APPLICABLE: "project_not_applicable",
  T3_CHECK_UNKNOWN: "prerequisite_unverified",
  T3_AUTHENTICATION_VERIFIED: "administrative_read_verified",
  T3_CATALOG_VERIFIED: "catalog_read_verified",
  T3_PROJECT_VERIFIED: "existing_project_verified",
  T3_EFFECTIVE_SELECTION_VERIFIED: "effective_selection_resolved",
  T3_PROVIDER_STATE_UNKNOWN: "provider_prerequisites_unknown",
  T3_AUTH_UNSUPPORTED: "authentication_unsupported",
  T3_CATALOG_UNAVAILABLE: "catalog_unavailable",
  T3_CATALOG_INVALID: "catalog_invalid",
  T3_PROVIDER_AMBIGUOUS: "provider_unavailable_or_ambiguous",
  T3_MODEL_UNAVAILABLE: "model_unavailable",
  T3_OPTIONS_UNSUPPORTED: "options_unsupported",
  T3_EFFORT_UNSUPPORTED: "effort_unsupported",
  T3_HANDOFF_FAILED: "authenticated_read_failed",
  T3_OUTPUT_INVALID: "output_evidence_invalid",
  T3_AUTH_CLEANUP_FAILED: "owned_cleanup_failed",
  T3_AUTH_CLEANUP_UNKNOWN: "owned_cleanup_unknown",
} as const;
const reasons = T3_READINESS_REASONS;
type Code = keyof typeof reasons;
export interface ReadinessStage {
  name:
    | "selection"
    | "cli"
    | "runtime"
    | "compatibility"
    | "authentication"
    | "catalog"
    | "project"
    | "effectiveSelection";
  state: "verified" | "failed" | "deferred" | "unknown" | "not_applicable";
  code: Code;
  reason: (typeof reasons)[Code];
}
export interface T3ReadinessPreview {
  readiness: "preview_passed" | "blocked";
  exitCode: 0 | 1;
  stages: ReadinessStage[];
  cleanup: { state: "not_attempted" };
  findings: { code: Code; reason: (typeof reasons)[Code]; severity: "error" }[];
  // Only independently validated public facts, never origin/runtime/transport bodies.
  facts: { cliVersion?: string; serverVersion?: string; protocol?: 1; environmentId?: string };
}
export interface T3ReadinessPreviewDependencies extends T3NativeDependencies {
  probePid?: (pid: number) => void;
  /** Epoch milliseconds recorded once at authenticated check entry. Separate
   * from the monotonic operation/deadline clock; never used by dispatch. */
  checkTime?: () => number;
}
interface PreviewIdentity {
  cwd: string;
  context: Pick<T3ReadinessContext, "checkout" | "settings"> &
    Partial<Pick<T3ReadinessContext, "sources" | "workspaceRoot">>;
  baseDir: string;
  origin: string;
  pid: number;
  cliVersion: string;
  serverVersion: string;
  environmentId: string;
}
// Private evidence is deliberately not a field/symbol on the public result.
// Copies/serialized previews cannot authorize a recheck; public facts are not authority.
const previewIdentities = new WeakMap<T3ReadinessPreview, PreviewIdentity>();
const previewContexts = new WeakMap<
  T3ReadinessPreview,
  {
    workspaceRoot: string | null;
    checkout: string | null;
    sources: T3ReadinessContext["sources"];
    settings: T3Settings;
  }
>();
const authenticatedProgress = new WeakMap<T3ReadinessPreview, ReadinessStage[]>();
function observeRead(
  preview: T3ReadinessPreview,
  name: ReadinessStage["name"],
  state: ReadinessStage["state"],
  code: Code,
): void {
  const stage = authenticatedProgress.get(preview)?.find((s) => s.name === name);
  if (stage) Object.assign(stage, { state, code, reason: reasons[code] });
}

/** Foundation only: call immediately before future owned acquisition, never issue here. */
export async function recheckT3ReadinessPreview(
  preview: T3ReadinessPreview,
  options: { authenticated: boolean; signal?: AbortSignal },
  dependencies: T3ReadinessPreviewDependencies = {},
): Promise<void> {
  if (options.authenticated !== true) fail("T3_AUTHENTICATED_REQUIRED");
  const identity = previewIdentities.get(preview);
  if (!identity || preview.readiness !== "preview_passed" || preview.exitCode !== 0)
    fail("T3_PREVIEW_REQUIRED");
  const checked = await collectPreview(
    { cwd: identity.cwd, context: identity.context },
    dependencies,
    identity,
  );
  if (checked.exitCode !== 0) fail(checked.findings[0]!.code);
}
/** Internal acquisition/read evidence, not a doctor result or public projection. */
export interface T3AuthenticatedReadFoundation {
  authentication: "verified";
  authority: "administrative";
  catalog: "read";
  project: "verified" | "deferred" | "not_applicable";
  effectiveSelection: "deferred";
}
// Retain only the matched ID/default snapshot, never thread/message bodies.
interface ProjectDefaults {
  id: string;
  defaultModelSelection: {
    instanceId: string;
    model: string;
    options?: { id: string; value: string | boolean }[];
  } | null;
  defaultThreadEnvMode?: "local" | "worktree" | null;
}
const authenticatedReads = new WeakMap<
  T3AuthenticatedReadFoundation,
  {
    config: JsonObject;
    project?: ProjectDefaults;
    context: PreviewIdentity["context"];
    checkTime: number;
  }
>();
const scopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "review:write",
  "relay:read",
  "relay:write",
  "access:read",
  "access:write",
];
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const timestamp = (value: unknown): boolean => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  )
    return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"))
  );
};
function validAuthDescriptor(value: unknown): boolean {
  const auth = record(value);
  return (
    typeof auth.policy === "string" &&
    ["desktop-managed-local", "loopback-browser", "remote-reachable", "unsafe-no-auth"].includes(
      auth.policy,
    ) &&
    Array.isArray(auth.bootstrapMethods) &&
    auth.bootstrapMethods.every(
      (v) => typeof v === "string" && ["desktop-bootstrap", "one-time-token"].includes(v),
    ) &&
    Array.isArray(auth.sessionMethods) &&
    auth.sessionMethods.every(
      (v) =>
        typeof v === "string" &&
        ["browser-session-cookie", "bearer-access-token", "dpop-access-token"].includes(v),
    ) &&
    auth.sessionMethods.includes("bearer-access-token") &&
    text(auth.sessionCookieName)
  );
}
function readFailure(code: string): never {
  throw new T3HandoffError(
    code,
    "The official T3 authenticated read is incompatible or unavailable.",
  );
}

const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Read the canonical shell wire defaults structurally only. Catalog routing,
// precedence, option support and provider readiness belong to later gates.
function projectDefaults(project: JsonObject): ProjectDefaults {
  const selected = project.defaultModelSelection;
  let defaultModelSelection: ProjectDefaults["defaultModelSelection"] = null;
  if (selected !== null) {
    if (!object(selected) || !text(selected.instanceId) || !text(selected.model))
      readFailure("T3_RESPONSE_INVALID");
    let options: { id: string; value: string | boolean }[] | undefined;
    if (Object.hasOwn(selected, "options")) {
      if (!Array.isArray(selected.options)) readFailure("T3_RESPONSE_INVALID");
      options = selected.options.map((entry) => {
        if (
          !object(entry) ||
          !text(entry.id) ||
          !(text(entry.value) || typeof entry.value === "boolean")
        )
          readFailure("T3_RESPONSE_INVALID");
        return { id: entry.id, value: entry.value };
      });
    }
    defaultModelSelection = {
      instanceId: selected.instanceId,
      model: selected.model,
      ...(options ? { options } : {}),
    };
  }
  const mode = project.defaultThreadEnvMode;
  if (
    Object.hasOwn(project, "defaultThreadEnvMode") &&
    mode !== null &&
    mode !== "local" &&
    mode !== "worktree"
  )
    readFailure("T3_RESPONSE_INVALID");
  return {
    id: project.id as string,
    defaultModelSelection,
    ...(Object.hasOwn(project, "defaultThreadEnvMode")
      ? { defaultThreadEnvMode: mode as "local" | "worktree" | null }
      : {}),
  };
}

async function matchProject(
  shell: JsonObject,
  checkout: string,
): Promise<ProjectDefaults | undefined> {
  const physical = await realpath(checkout);
  const matches: JsonObject[] = [];
  const ids = new Set<string>();
  for (const raw of shell.projects as unknown[]) {
    const project = record(raw);
    const id = identifier(project.id);
    if (!id || ids.has(id) || !text(project.workspaceRoot) || !isAbsolute(project.workspaceRoot))
      readFailure("T3_RESPONSE_INVALID");
    ids.add(id);
    if (await projectUsesWorkspace(project.workspaceRoot, physical)) matches.push(project);
  }
  if (matches.length > 1) readFailure("T3_RESPONSE_INVALID");
  const project = matches[0];
  if (!project) return undefined;
  const identity = project.repositoryIdentity;
  if (identity !== undefined && identity !== null) {
    if (
      !object(identity) ||
      !text(identity.canonicalKey) ||
      !object(identity.locator) ||
      identity.locator.source !== "git-remote" ||
      !text(identity.locator.remoteName) ||
      !text(identity.locator.remoteUrl)
    )
      readFailure("T3_RESPONSE_INVALID");
    for (const key of ["webUrl", "rootPath", "displayName", "provider", "owner", "name"]) {
      if (Object.hasOwn(identity, key) && !text(identity[key])) readFailure("T3_RESPONSE_INVALID");
    }
    if (
      Object.hasOwn(identity, "rootPath") &&
      !(await projectUsesWorkspace(identity.rootPath, physical))
    )
      readFailure("T3_RESPONSE_INVALID");
  }
  return projectDefaults(project);
}

/** Task-free foundation. The same private preview identity pins every effect.
 * Public recheck is adjacent to actual owned issuance; this is not an atomic lease.
 */
export async function collectT3AuthenticatedReadFoundation(
  preview: T3ReadinessPreview,
  options: { authenticated: boolean; signal?: AbortSignal },
  dependencies: T3ReadinessPreviewDependencies = {},
): Promise<T3OwnedSessionResult<T3AuthenticatedReadFoundation>> {
  const identity = previewIdentities.get(preview);
  // Consent and provenance fail before recheck effects, including on copied results.
  if (options.authenticated !== true) fail("T3_AUTHENTICATED_REQUIRED");
  if (!identity || preview.readiness !== "preview_passed" || preview.exitCode !== 0)
    fail("T3_PREVIEW_REQUIRED");
  const checkTime = (dependencies.checkTime ?? Date.now)();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signals = [options.signal, dependencies.readiness?.signal].filter(
    (s): s is AbortSignal => !!s,
  );
  for (const signal of signals) {
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  }
  // Scoped recoverable SIGINT only. Do not exit globally or affect ordinary
  // handoffs. Repeated SIGINT cannot abort the independent cleanup budget.
  process.on("SIGINT", cancel);
  const now = dependencies.readiness?.now ?? t3Now;
  const control = {
    now,
    deadline: Math.min(now() + 90_000, dependencies.readiness?.deadline ?? Infinity),
    signal: controller.signal,
  };
  const native: T3NativeDependencies = { ...dependencies, readiness: control };
  const environment = {
    baseDir: identity.baseDir,
    cli: identity.context.settings.cli!,
    origin: identity.origin,
  };
  const cwd = identity.context.checkout ?? identity.cwd;
  try {
    checkT3Read(control);
    await recheckT3ReadinessPreview(preview, options, native);
    checkT3Read(control);
    return await withOwnedT3Session(environment, cwd, native, async (request, token) => {
      const session = await request("/api/auth/session");
      // AuthSessionState exposes NO sessionId/environmentId. The authenticated
      // method is checked here; environment binding comes from config.environment.
      if (
        session.authenticated !== true ||
        !validAuthDescriptor(session.auth) ||
        session.sessionMethod !== "bearer-access-token" ||
        !Array.isArray(session.scopes) ||
        !session.scopes.every((scope) => typeof scope === "string" && scopes.includes(scope)) ||
        !session.scopes.includes("orchestration:read") ||
        (Object.hasOwn(session, "expiresAt") && !timestamp(session.expiresAt))
      )
        readFailure("T3_AUTH_FAILED");
      observeRead(preview, "authentication", "verified", "T3_AUTHENTICATION_VERIFIED");
      const config = await readT3Config(identity.origin, token, request, {
        boundedRead: true,
        readiness: control,
      });
      const descriptor = record(config.environment);
      if (
        descriptor.environmentId !== identity.environmentId ||
        descriptor.serverVersion !== identity.serverVersion ||
        descriptor.orchestrationProtocolVersion !== 1 ||
        !validAuthDescriptor(config.auth)
      )
        readFailure("T3_RESPONSE_INVALID");
      // Primitive container validation only. No provider classification/defaults.
      if (
        !Array.isArray(config.providers) ||
        !config.settings ||
        typeof config.settings !== "object" ||
        Array.isArray(config.settings)
      )
        readFailure("T3_RESPONSE_INVALID");
      observeRead(preview, "catalog", "verified", "T3_CATALOG_VERIFIED");
      let project: ProjectDefaults | undefined;
      if (identity.context.checkout) {
        const shell = await request("/api/orchestration/shell");
        if (
          !Number.isSafeInteger(shell.snapshotSequence) ||
          (shell.snapshotSequence as number) < 0 ||
          !timestamp(shell.updatedAt) ||
          !Array.isArray(shell.projects) ||
          !Array.isArray(shell.threads)
        )
          readFailure("T3_RESPONSE_INVALID");
        for (const thread of shell.threads) {
          const value = record(thread);
          if (!identifier(value.id) || !identifier(value.projectId))
            readFailure("T3_RESPONSE_INVALID");
        }
        // Pure identity reads share the existing operation/check deadline.
        // No status, filters, hooks, creation, receipt or repair effects.
        project = await runT3Read(control, () => matchProject(shell, identity.context.checkout!));
      }
      const value: T3AuthenticatedReadFoundation = {
        authentication: "verified",
        authority: "administrative",
        catalog: "read",
        project: identity.context.checkout ? (project ? "verified" : "deferred") : "not_applicable",
        effectiveSelection: "deferred",
      };
      observeRead(
        preview,
        "project",
        value.project === "verified"
          ? "verified"
          : value.project === "deferred"
            ? "deferred"
            : "not_applicable",
        value.project === "verified"
          ? "T3_PROJECT_VERIFIED"
          : value.project === "deferred"
            ? "T3_PROJECT_DEFAULTS_DEFERRED"
            : "T3_PROJECT_NOT_APPLICABLE",
      );
      authenticatedReads.set(value, { config, project, context: identity.context, checkTime });
      return value;
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    for (const signal of signals) signal.removeEventListener("abort", cancel);
  }
}

export type T3EffectiveSelectionSource =
  | T3ReadinessSettingSource
  | "project"
  | "server"
  | "catalog";
/** Bounded internal selection evidence, NOT final readiness/provider acceptance.
 * Model/options semantic expansion and freshness remain separate later gates.
 */
export interface T3EffectiveSelectionFoundation {
  effectiveSelection: "resolved";
  project: T3AuthenticatedReadFoundation["project"];
  provisional: boolean;
  selection: T3Selection;
  sources: Partial<Record<keyof T3Settings, T3EffectiveSelectionSource>>;
  optionSources: { id: string; source: T3EffectiveSelectionSource }[];
}

interface ProviderStateEvidence {
  status: "ready" | "warning";
  authStatus: "authenticated" | "unknown";
  checkedAt: string;
  checkTime: number;
  project: T3AuthenticatedReadFoundation["project"];
}
const providerStates = new WeakMap<T3EffectiveSelectionFoundation, ProviderStateEvidence>();

/** Internal observed prerequisite classification, not a command result or a
 * guarantee of task execution. Cleanup remains independent of these observations. */
export interface T3ProviderStateFoundation {
  readiness: "global_verified" | "checkout_verified" | "unknown";
  provider: {
    state: "verified" | "unknown";
    status: "ready" | "warning";
    authStatus: "authenticated" | "unknown";
    checkedAt: string | null;
    freshness: "fresh" | "stale" | "unknown";
    severity?: "warning";
  };
}

/** Pure readiness-only gate over same-object private selection evidence. */
export function classifyT3ReadinessProviderState(
  selected: T3EffectiveSelectionFoundation,
): T3ProviderStateFoundation {
  const evidence = providerStates.get(selected);
  if (!evidence) readFailure("T3_RESPONSE_INVALID");
  const { status, authStatus, checkedAt, checkTime, project } = evidence;
  const valid = timestamp(checkedAt) && Number.isFinite(checkTime);
  const age = valid ? checkTime - Date.parse(checkedAt) : NaN;
  const freshness = !valid || age < -30_000 ? "unknown" : age > 300_000 ? "stale" : "fresh";
  const verified = freshness === "fresh" && status === "ready" && authStatus === "authenticated";
  return {
    readiness:
      !verified || project === "deferred"
        ? "unknown"
        : project === "not_applicable"
          ? "global_verified"
          : "checkout_verified",
    provider: {
      state: verified ? "verified" : "unknown",
      status,
      authStatus,
      checkedAt: freshness === "unknown" ? null : checkedAt,
      freshness,
      ...(!verified ? { severity: "warning" as const } : {}),
    },
  };
}

/** Resolve only exact private authenticated evidence; no I/O or context reload.
 * This separate gate leaves project-read success and cleanup independently intact.
 */
export function resolveT3ReadinessEffectiveSelection(
  read: T3AuthenticatedReadFoundation,
): T3EffectiveSelectionFoundation {
  const evidence = authenticatedReads.get(read);
  if (!evidence) readFailure("T3_RESPONSE_INVALID");
  const { config, project, context } = evidence;
  const inherited: T3EffectiveSelectionSource = project?.defaultModelSelection
    ? "project"
    : "server";
  const sources: T3EffectiveSelectionFoundation["sources"] = {};
  const optionSources: T3EffectiveSelectionFoundation["optionSources"] = [];
  for (const key of ["cli", "baseDir"] as const)
    if (context.sources?.[key]) sources[key] = context.sources[key];
  const source = (
    value: "authored" | "saved" | "catalog",
    leaf: keyof T3Settings,
  ): T3EffectiveSelectionSource =>
    value === "authored"
      ? (context.sources?.[leaf] ?? "cli")
      : value === "saved"
        ? inherited
        : "catalog";
  const selection = resolveT3Selection(
    config,
    context.settings,
    project ? { defaultModelSelection: project.defaultModelSelection } : undefined,
    {
      readiness: true,
      provenance: (resolved) => {
        sources.provider = source(resolved.provider, "provider");
        sources.model = source(resolved.model, "model");
        for (const [id, origin] of Object.entries(resolved.options)) {
          const optionSource = source(origin, "effort");
          optionSources.push({ id, source: optionSource });
          if (id === "effort" || id === "reasoningEffort") sources.effort = optionSource;
        }
      },
    },
  );
  const result: T3EffectiveSelectionFoundation = {
    effectiveSelection: "resolved",
    project: context.checkout ? (project ? "verified" : "deferred") : "not_applicable",
    provisional: !!context.checkout && !project,
    selection,
    sources,
    optionSources,
  };
  // Strict shared resolution has already validated the whole catalog and
  // rejected explicit blockers. Bind only the exact routing ID it selected.
  const provider = (config.providers as JsonObject[]).find(
    (entry) => entry.instanceId === selection.instanceId,
  )!;
  providerStates.set(result, {
    status: provider.status as ProviderStateEvidence["status"],
    authStatus: record(provider.auth).status as ProviderStateEvidence["authStatus"],
    checkedAt: provider.checkedAt as string,
    checkTime: evidence.checkTime,
    project: result.project,
  });
  return result;
}

function fail(code: Code): never {
  throw new T3HandoffError(code, reasons[code]);
}
function bounded<T>(operation: () => Promise<T>, code: Code): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new T3HandoffError(code, reasons[code])), OPERATION_MS);
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
async function readBoundedFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) fail("T3_DISCOVERY_INVALID");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) fail("T3_DISCOVERY_INVALID");
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}

function boundedReadFetch(dependencies: T3NativeDependencies): typeof fetch {
  return (async (input, init) => {
    const response = await (dependencies.fetch ?? fetch)(input, init);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return response;
    }
    if (response.redirected) fail("T3_HTTP_FAILED");
    const reader = response.body?.getReader();
    if (!reader) fail("T3_RESPONSE_INVALID");
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    const timer = setTimeout(cancel, OPERATION_MS);
    init?.signal?.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) fail("T3_RESPONSE_INVALID");
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), { status: response.status });
  }) as typeof fetch;
}

/** Preview only. No session, catalog, socket, receipt or ordinary doctor collector. */
export async function collectT3ReadinessPreview(
  options: {
    cwd: string;
    path?: string;
    explicitSettings?: T3Settings;
    context?: T3ReadinessContext;
  },
  dependencies: T3ReadinessPreviewDependencies = {},
): Promise<T3ReadinessPreview> {
  return collectPreview(options, dependencies);
}

async function collectPreview(
  options: {
    cwd: string;
    path?: string;
    explicitSettings?: T3Settings;
    context?: PreviewIdentity["context"];
  },
  dependencies: T3ReadinessPreviewDependencies,
  expected?: PreviewIdentity,
): Promise<T3ReadinessPreview> {
  const result: T3ReadinessPreview = {
    readiness: "blocked",
    exitCode: 1,
    cleanup: { state: "not_attempted" },
    findings: [],
    facts: {},
    stages: (
      [
        "selection",
        "cli",
        "runtime",
        "compatibility",
        "authentication",
        "catalog",
        "project",
        "effectiveSelection",
      ] as const
    ).map((name) => ({
      name,
      state: ["selection", "cli", "runtime", "compatibility"].includes(name)
        ? "unknown"
        : "deferred",
      code: "T3_CHECK_UNKNOWN",
      reason: reasons.T3_CHECK_UNKNOWN,
    })),
  };
  const set = (name: ReadinessStage["name"], state: ReadinessStage["state"], code: Code) => {
    Object.assign(result.stages.find((stage) => stage.name === name)!, {
      state,
      code,
      reason: reasons[code],
    });
  };
  for (const name of ["authentication", "catalog", "effectiveSelection"] as const)
    set(name, "deferred", "T3_CHECK_DEFERRED");
  set("project", "deferred", "T3_PROJECT_DEFAULTS_DEFERRED");
  let active: ReadinessStage["name"] = "selection";
  try {
    const selected =
      options.context ??
      (await resolveT3ReadinessContext({
        ...options,
        explicitSettings: options.explicitSettings ?? {},
      }));
    previewContexts.set(result, {
      workspaceRoot: selected.workspaceRoot ?? null,
      checkout: selected.checkout,
      sources: { ...selected.sources },
      settings: { ...selected.settings },
    });
    // Snapshot the selected checkout/settings before any native await. Never
    // re-resolve mutable configuration or environment fallback at the gate.
    const context = {
      checkout: selected.checkout,
      settings: { ...selected.settings },
      sources: { ...selected.sources },
    };
    let runtimePid = 0;
    set("selection", "verified", "T3_SELECTION_VERIFIED");
    if (!context.checkout) set("project", "not_applicable", "T3_PROJECT_NOT_APPLICABLE");
    active = "cli";
    const native: T3NativeDependencies = {
      ...dependencies,
      ...(dependencies.runProcess
        ? {
            runProcess: (argv, processOptions) =>
              bounded(async () => {
                const output = await dependencies.runProcess!(argv, {
                  ...processOptions,
                  env: { ...processOptions.env, T3CODE_HOME: context.settings.baseDir },
                });
                if (
                  Buffer.byteLength(output.stdout) > MAX_BYTES ||
                  Buffer.byteLength(output.stderr) > MAX_BYTES
                )
                  fail("T3_RESPONSE_INVALID");
                return output;
              }, "T3_UNREACHABLE"),
          }
        : {}),
      readRuntime: (path) =>
        (dependencies.readiness
          ? (operation: () => Promise<string>) => runT3Read(dependencies.readiness!, operation)
          : (operation: () => Promise<string>) => bounded(operation, "T3_UNREACHABLE"))(
          async () => {
            let text: string;
            try {
              text = await (dependencies.readRuntime ?? readBoundedFile)(path);
            } catch (error) {
              if (error instanceof T3HandoffError) throw error;
              return fail("T3_ENVIRONMENT_MISSING");
            }
            if (Buffer.byteLength(text) > MAX_BYTES) fail("T3_DISCOVERY_INVALID");
            let runtime: ReturnType<typeof record>;
            try {
              runtime = record(JSON.parse(text));
            } catch {
              return fail("T3_DISCOVERY_INVALID");
            }
            if (
              runtime.version !== 1 ||
              !Number.isSafeInteger(runtime.pid) ||
              (runtime.pid as number) < 1 ||
              !Number.isSafeInteger(runtime.port) ||
              (runtime.port as number) < 1 ||
              (runtime.port as number) > 65535 ||
              typeof runtime.origin !== "string"
            )
              fail("T3_DISCOVERY_INVALID");
            let url: URL;
            try {
              url = new URL(runtime.origin);
            } catch {
              return fail("T3_DISCOVERY_INVALID");
            }
            if (
              url.protocol !== "http:" ||
              !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash ||
              url.pathname !== "/" ||
              Number(url.port) !== runtime.port
            )
              fail("T3_DISCOVERY_INVALID");
            try {
              (dependencies.probePid ?? ((pid) => process.kill(pid, 0)))(runtime.pid as number);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EPERM") fail("T3_ENVIRONMENT_STALE");
            }
            runtimePid = runtime.pid as number;
            return text;
          },
        ),
      fetch: dependencies.readiness ? dependencies.fetch : boundedReadFetch(dependencies),
    };
    result.facts.cliVersion = await bounded(
      () =>
        readT3CliVersion(context.settings.cli ?? "t3", context.checkout ?? options.cwd, native, {
          T3CODE_HOME: context.settings.baseDir,
        }),
      "T3_UNREACHABLE",
    );
    if (expected && result.facts.cliVersion !== expected.cliVersion) fail("T3_IDENTITY_CHANGED");
    set("cli", "verified", "T3_CLI_VERIFIED");
    active = "runtime";
    // Native discovery retains physical base ownership and its real PID probe.
    // Capture stricter preview failures outside native discovery's generic read catch.
    let runtimeError: unknown;
    const readRuntime = native.readRuntime!;
    native.readRuntime = async (path) => {
      try {
        return await readRuntime(path);
      } catch (error) {
        runtimeError = error;
        throw error;
      }
    };
    let discovered: Awaited<ReturnType<typeof discoverT3Environment>>;
    try {
      discovered = dependencies.readiness
        ? await runT3Read(dependencies.readiness, () =>
            discoverT3Environment(context.settings, native),
          )
        : await discoverT3Environment(context.settings, native);
    } catch (error) {
      throw runtimeError ?? error;
    }
    if (
      expected &&
      (discovered.baseDir !== expected.baseDir ||
        discovered.origin !== expected.origin ||
        runtimePid !== expected.pid)
    )
      fail("T3_IDENTITY_CHANGED");
    set("runtime", "verified", "T3_RUNTIME_VERIFIED");
    active = "compatibility";
    const publicDescriptor = await bounded(
      () => t3Http(discovered.origin, undefined, native)("/.well-known/t3/environment"),
      "T3_UNREACHABLE",
    );
    verifyT3Version(publicDescriptor.serverVersion);
    verifyT3Protocol(publicDescriptor);
    if (
      expected &&
      (publicDescriptor.serverVersion !== expected.serverVersion ||
        publicDescriptor.environmentId !== expected.environmentId)
    )
      fail("T3_IDENTITY_CHANGED");
    if (publicDescriptor.serverVersion !== result.facts.cliVersion) fail("T3_VERSION_MISMATCH");
    const environmentId = identifier(publicDescriptor.environmentId);
    const platform = record(publicDescriptor.platform);
    if (
      !environmentId ||
      platform.os !== (process.platform === "win32" ? "windows" : process.platform)
    )
      fail("T3_ENVIRONMENT_INVALID");
    // Validate the advertised scalar, not equality with the local architecture.
    if (typeof platform.arch !== "string" || !["arm64", "x64", "other"].includes(platform.arch)) {
      fail("T3_RESPONSE_INVALID");
    }
    if (!Object.hasOwn(publicDescriptor, "capabilities")) {
      fail("T3_CAPABILITIES_MISSING");
    }
    const advertised = publicDescriptor.capabilities;
    if (!advertised || typeof advertised !== "object" || Array.isArray(advertised)) {
      fail("T3_RESPONSE_INVALID");
    }
    const capabilities = record(advertised);
    for (const key of ["repositoryIdentity", "connectionProbe"] as const) {
      if (Object.hasOwn(capabilities, key) && typeof capabilities[key] !== "boolean") {
        fail("T3_RESPONSE_INVALID");
      }
    }
    // Official repositoryIdentity omission decodes to false; connectionProbe
    // Is optional. Neither absence nor false proves support, but neither is a
    // Malformed descriptor. Explicitly defer that evidence without probing or
    // Requiring unrelated optional features (or inventing an auth capability).
    const capabilitiesVerified =
      capabilities.repositoryIdentity === true && capabilities.connectionProbe === true;
    result.facts = {
      ...result.facts,
      serverVersion: publicDescriptor.serverVersion,
      protocol: 1,
      environmentId,
    };
    set(
      "compatibility",
      capabilitiesVerified ? "verified" : "deferred",
      capabilitiesVerified ? "T3_COMPATIBILITY_VERIFIED" : "T3_CAPABILITIES_DEFERRED",
    );
    result.readiness = "preview_passed";
    result.exitCode = 0;
    previewIdentities.set(result, {
      cwd: options.cwd,
      context: {
        checkout: context.checkout,
        sources: { ...context.sources },
        settings: {
          ...context.settings,
          cli: context.settings.cli ?? "t3",
          baseDir: discovered.baseDir,
        },
      },
      baseDir: discovered.baseDir,
      origin: discovered.origin,
      pid: runtimePid,
      cliVersion: result.facts.cliVersion!,
      serverVersion: publicDescriptor.serverVersion as string,
      environmentId,
    });
  } catch (error) {
    const code: Code =
      error instanceof T3HandoffError && Object.hasOwn(reasons, error.code)
        ? (error.code as Code)
        : active === "selection"
          ? "T3_SELECTION_INVALID"
          : "T3_UNREACHABLE";
    set(active, "failed", code);
    result.findings.push({ code, reason: reasons[code], severity: "error" });
  }
  return result;
}

/** Internal composed observations; consumers must use the screened output helper.
 * The same-object binding supplies paths/provenance, never copied public facts. */
export interface T3ReadinessOutcome {
  checkMode: "preview" | "authenticated";
  readiness: "preview_passed" | "global_verified" | "checkout_verified" | "unknown" | "blocked";
  stages: ReadinessStage[];
  cleanup: { state: "not_attempted" | "verified" | "failed" | "unknown" };
  findings: { code: Code; severity: "error" | "warning" }[];
  selection?: T3Selection &
    Pick<T3EffectiveSelectionFoundation, "provisional" | "sources" | "optionSources">;
  provider?: T3ProviderStateFoundation["provider"];
}
const outputContexts = new WeakMap<
  T3ReadinessOutcome,
  {
    workspaceRoot: string | null;
    checkout: string | null;
    sources: T3ReadinessContext["sources"];
    settings: T3Settings;
    observed: T3ReadinessOutcome;
  }
>();
/** Internal projection authority. No transport, catalog, profile or credentials. */
export function t3ReadinessOutputContext(value: T3ReadinessOutcome) {
  const evidence = outputContexts.get(value);
  return evidence ? structuredClone(evidence) : undefined;
}
export async function collectT3ReadinessOutcome(
  options: Parameters<typeof collectT3ReadinessPreview>[0] & {
    authenticated?: boolean;
    signal?: AbortSignal;
  },
  dependencies: T3ReadinessPreviewDependencies = {},
): Promise<T3ReadinessOutcome> {
  const preview = await collectT3ReadinessPreview(options, dependencies);
  const result: T3ReadinessOutcome = {
    checkMode: options.authenticated === true ? "authenticated" : "preview",
    readiness: preview.readiness,
    stages: preview.stages.map((stage) => ({ ...stage })),
    cleanup: { state: "not_attempted" },
    findings: preview.findings.map(({ code, severity }) => ({ code, severity })),
  };
  const retain = () => {
    outputContexts.set(result, {
      ...(previewContexts.get(preview) ?? {
        workspaceRoot: null,
        checkout: null,
        sources: {},
        settings: {},
      }),
      observed: structuredClone(result),
    });
    return result;
  };
  if (options.authenticated !== true || preview.exitCode !== 0) return retain();
  // The read collector marks only independently completed stages. A later read
  // error/cleanup failure cannot erase authentication/catalog observations.
  authenticatedProgress.set(preview, result.stages);
  let active: ReadinessStage["name"] = "authentication";
  const failure = (error: unknown) => {
    const code =
      error instanceof T3HandoffError && Object.hasOwn(reasons, error.code)
        ? (error.code as Code)
        : "T3_HANDOFF_FAILED";
    const incomplete = result.stages.find(
      (stage) =>
        ["authentication", "catalog", "project"].includes(stage.name) &&
        !["verified", "not_applicable"].includes(stage.state),
    );
    if (active !== "effectiveSelection") active = incomplete?.name ?? active;
    const stage = result.stages.find((s) => s.name === active)!;
    Object.assign(stage, { state: "failed", code, reason: reasons[code] });
    result.readiness = "blocked";
    result.findings.push({ code, severity: "error" });
  };
  try {
    const read = await collectT3AuthenticatedReadFoundation(
      preview,
      { authenticated: true, signal: options.signal },
      dependencies,
    );
    result.cleanup = { state: read.cleanup.status };
    if (read.use.status !== "succeeded") {
      failure(read.failure);
    } else {
      active = "effectiveSelection";
      const effective = resolveT3ReadinessEffectiveSelection(read.use.value);
      result.selection = {
        instanceId: effective.selection.instanceId,
        model: effective.selection.model,
        options: effective.selection.options.map((option) => ({ ...option })),
        provisional: effective.provisional,
        sources: { ...effective.sources },
        optionSources: effective.optionSources.map((option) => ({ ...option })),
      };
      observeRead(preview, "effectiveSelection", "verified", "T3_EFFECTIVE_SELECTION_VERIFIED");
      const classified = classifyT3ReadinessProviderState(effective);
      result.provider = { ...classified.provider };
      result.readiness = classified.readiness;
      if (classified.provider.state === "unknown")
        result.findings.push({ code: "T3_PROVIDER_STATE_UNKNOWN", severity: "warning" });
    }
  } catch (error) {
    failure(error);
  } finally {
    authenticatedProgress.delete(preview);
  }
  if (result.cleanup.state === "failed" || result.cleanup.state === "unknown")
    result.findings.push({
      code:
        result.cleanup.state === "failed" ? "T3_AUTH_CLEANUP_FAILED" : "T3_AUTH_CLEANUP_UNKNOWN",
      severity: "error",
    });
  return retain();
}
