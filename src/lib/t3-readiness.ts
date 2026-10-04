import { open } from "node:fs/promises";
import { constants } from "node:fs";
import {
  discoverT3Environment,
  identifier,
  readT3CliVersion,
  readT3Config,
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
import { resolveT3ReadinessContext, type T3ReadinessContext } from "./t3-readiness-context.ts";
import type { T3Settings } from "./t3-settings.ts";

const MAX_BYTES = 1024 * 1024;
const OPERATION_MS = 15_000;
const reasons = {
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
  T3_AUTH_FAILED: "public_descriptor_rejected",
  T3_HTTP_FAILED: "public_descriptor_failed",
  T3_RESPONSE_INVALID: "descriptor_invalid",
  T3_UNREACHABLE: "operation_unreachable",
  T3_CHECK_DEFERRED: "authenticated_check_deferred",
  T3_PROJECT_DEFAULTS_DEFERRED: "project_defaults_deferred",
  T3_PROJECT_NOT_APPLICABLE: "project_not_applicable",
  T3_CHECK_UNKNOWN: "prerequisite_unverified",
} as const;
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
}
interface PreviewIdentity {
  cwd: string;
  context: Pick<T3ReadinessContext, "checkout" | "settings">;
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
  project: "deferred" | "not_applicable";
  effectiveSelection: "deferred";
}
// Catalog/shell bodies remain private for subsequent selection work. No body,
// origin, token, session identifier or private evidence handle is serialized.
const authenticatedReads = new WeakMap<
  T3AuthenticatedReadFoundation,
  { config: JsonObject; shell?: JsonObject }
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
      let shell: JsonObject | undefined;
      if (identity.context.checkout) {
        shell = await request("/api/orchestration/shell");
        if (
          !Number.isSafeInteger(shell.snapshotSequence) ||
          (shell.snapshotSequence as number) < 0 ||
          !timestamp(shell.updatedAt) ||
          !Array.isArray(shell.projects) ||
          !Array.isArray(shell.threads)
        )
          readFailure("T3_RESPONSE_INVALID");
        // Identity-bearing primitive shells only, not project/default matching.
        for (const project of shell.projects) {
          const value = record(project);
          if (!identifier(value.id) || !text(value.workspaceRoot))
            readFailure("T3_RESPONSE_INVALID");
        }
        for (const thread of shell.threads) {
          const value = record(thread);
          if (!identifier(value.id) || !identifier(value.projectId))
            readFailure("T3_RESPONSE_INVALID");
        }
      }
      const value: T3AuthenticatedReadFoundation = {
        authentication: "verified",
        authority: "administrative",
        catalog: "read",
        project: shell ? "deferred" : "not_applicable",
        effectiveSelection: "deferred",
      };
      authenticatedReads.set(value, { config, shell });
      return value;
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    for (const signal of signals) signal.removeEventListener("abort", cancel);
  }
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
    context?: Pick<T3ReadinessContext, "checkout" | "settings">;
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
    // Snapshot the selected checkout/settings before any native await. Never
    // re-resolve mutable configuration or environment fallback at the gate.
    const context = { checkout: selected.checkout, settings: { ...selected.settings } };
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
