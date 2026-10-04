import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { T3HandoffError } from "./t3-error.ts";
import type { T3ProcessResult } from "./t3-handoff.ts";
import type { T3Settings } from "./t3-settings.ts";

// Stable releases are checked against the negotiated wire protocol/capabilities.
export const T3_NATIVE_MIN_VERSION = "0.0.43";
export type JsonObject = Record<string, unknown>;
export const record = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
export const records = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.map(record) : [];
export const identifier = (value: unknown): string | null =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/u.test(value) ? value : null;

export interface T3Selection {
  instanceId: string;
  model: string;
  options: { id: string; value: string | boolean }[];
}
export interface T3NativeEnvironment {
  baseDir: string;
  cli: string;
  origin: string;
  environmentId: string;
  serverVersion: string;
  settings: T3Settings;
  config: JsonObject;
}
export interface T3NativeDependencies {
  runProcess?: (
    command: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<T3ProcessResult>;
  fetch?: typeof fetch;
  readRuntime?: (path: string) => Promise<string>;
  getConfig?: (
    origin: string,
    token: string,
    request: (path: string, payload?: unknown) => Promise<JsonObject>,
  ) => Promise<JsonObject>;
}

const fail = (code: string, message: string): never => {
  throw new T3HandoffError(code, message);
};
/** Native children must never inherit the shell directory-switch directive. */
export const nativeChildEnvironment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const environment = { ...process.env, ...extra };
  delete environment.ARASHI_DIRECTIVE_FILE;
  return environment;
};

const runProcess: NonNullable<T3NativeDependencies["runProcess"]> = (command, options) =>
  new Promise((done) => {
    execFile(
      command[0]!,
      command.slice(1),
      { ...options, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        done({ exitCode: error ? -1 : 0, stdout, stderr });
      },
    );
  });

export function verifyT3Version(version: unknown): asserts version is string {
  const components =
    typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
      ? version.split(".").map(Number)
      : [];
  const minimum = T3_NATIVE_MIN_VERSION.split(".").map(Number);
  const difference = components.findIndex((value, index) => value !== minimum[index]);
  if (
    components.length !== 3 ||
    components.some((value) => !Number.isSafeInteger(value)) ||
    (difference !== -1 && components[difference]! < minimum[difference]!)
  ) {
    fail(
      "T3_VERSION_UNSUPPORTED",
      `Native T3 handoff requires a stable official T3 release ${T3_NATIVE_MIN_VERSION} or later, matching CLI/server versions, and orchestration protocol 1. Nightly/prerelease builds are unsupported.`,
    );
  }
}

export function verifyT3Protocol(descriptor: JsonObject): void {
  if (descriptor.orchestrationProtocolVersion !== 1)
    fail(
      "T3_PROTOCOL_UNSUPPORTED",
      "Native T3 handoff requires orchestration protocol 1. Update Arashi or select a compatible T3 release.",
    );
}

export async function discoverT3Environment(
  settings: T3Settings,
  dependencies: T3NativeDependencies = {},
): Promise<{ baseDir: string; origin: string }> {
  const baseDir = await realpath(
    settings.baseDir ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3"),
  ).catch(() =>
    fail(
      "T3_ENVIRONMENT_MISSING",
      "T3 data directory is missing. Start T3 on this host or select --t3-base-dir <absolute-path>.",
    ),
  );
  let runtime: JsonObject;
  try {
    runtime = record(
      JSON.parse(
        await (dependencies.readRuntime ?? ((path) => readFile(path, "utf8")))(
          join(baseDir, "userdata", "server-runtime.json"),
        ),
      ),
    );
  } catch {
    return fail(
      "T3_ENVIRONMENT_MISSING",
      "No readable running T3 environment. Start T3 or select its data directory with --t3-base-dir.",
    );
  }
  if (
    runtime.version !== 1 ||
    !Number.isInteger(runtime.pid) ||
    (runtime.pid as number) < 1 ||
    !Number.isInteger(runtime.port) ||
    typeof runtime.origin !== "string"
  ) {
    fail(
      "T3_DISCOVERY_INVALID",
      "T3 runtime discovery is stale or incompatible. Restart the selected T3 environment.",
    );
  }
  try {
    process.kill(runtime.pid as number, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM")
      return fail(
        "T3_ENVIRONMENT_STALE",
        "The selected T3 runtime process is no longer running. Restart that environment before handoff.",
      );
  }
  let url: URL;
  try {
    url = new URL(runtime.origin as string);
  } catch {
    return fail("T3_DISCOVERY_INVALID", "Invalid T3 runtime endpoint. Restart T3.");
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
  ) {
    fail(
      "T3_DISCOVERY_INVALID",
      "Native handoff requires the selected local T3 environment's loopback endpoint. Remote routes are not supported.",
    );
  }
  // No port scanning or guessing among alternate profiles. The selected base directory owns auth.
  return { baseDir, origin: url.origin };
}

export function t3Http(
  origin: string,
  token: string | undefined,
  dependencies: T3NativeDependencies = {},
) {
  return async (path: string, payload?: unknown): Promise<JsonObject> => {
    try {
      const response = await (dependencies.fetch ?? fetch)(new URL(path, origin), {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!response.ok)
        return fail(
          response.status === 401 || response.status === 403 ? "T3_AUTH_FAILED" : "T3_HTTP_FAILED",
          "T3 rejected the request. Verify the selected environment, authentication, and supported version.",
        );
      const body = record(await response.json());
      if (Object.keys(body).length === 0)
        return fail("T3_RESPONSE_INVALID", "T3 returned an incompatible response.");
      return body;
    } catch (error) {
      if (error instanceof T3HandoffError) throw error;
      // Never include response bodies, URLs, process stderr, or the request in diagnostics.
      return fail(
        "T3_UNREACHABLE",
        "The selected T3 environment is unreachable or timed out. Restart it and reconcile any pending handoff before retrying.",
      );
    }
  };
}

/** Only one read-only RPC: official catalog/settings are not exposed over HTTP. */
export async function readT3Config(
  origin: string,
  token: string,
  request: ReturnType<typeof t3Http>,
): Promise<JsonObject> {
  const ticket = await request("/api/auth/websocket-ticket", {});
  if (!identifier(ticket.ticket))
    return fail("T3_RESPONSE_INVALID", "T3 omitted its WebSocket ticket.");
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("orchestrationProtocol", "1");
  url.searchParams.set("wsTicket", ticket.ticket as string);
  return new Promise((resolveConfig, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (value?: JsonObject) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (value) resolveConfig(value);
      else
        reject(
          new T3HandoffError(
            "T3_CATALOG_UNAVAILABLE",
            "T3's official catalog RPC is unavailable or incompatible.",
          ),
        );
    };
    const timer = setTimeout(() => finish(), 15_000);
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "server.getConfig",
          payload: {},
          headers: [],
        }),
      ),
    );
    socket.addEventListener("message", (event) => {
      try {
        const decoded = JSON.parse(String(event.data));
        for (const value of Array.isArray(decoded) ? decoded : [decoded]) {
          const message = record(value);
          if (message._tag === "Ping") {
            socket.send(JSON.stringify({ _tag: "Pong" }));
            continue;
          }
          if (message._tag !== "Exit" || String(message.requestId) !== "1") continue;
          const exit = record(message.exit);
          finish(exit._tag === "Success" ? record(exit.value) : undefined);
        }
      } catch {
        finish();
      }
    });
    socket.addEventListener("error", () => finish());
    socket.addEventListener("close", () => finish());
  });
}

/** Internal lifecycle evidence, not public diagnostic output. No credential/ID is retained. */
export interface T3OwnedSessionResult<T> {
  use: { status: "not_attempted" | "failed" } | { status: "succeeded"; value: T };
  failure?: T3HandoffError;
  cleanup: {
    status: "verified" | "unknown" | "failed";
    revoke: "not_attempted" | "succeeded" | "failed";
  };
}

const sessionListString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const sessionListTimestamp = (value: unknown): boolean => {
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

/** Official CLI formatSessionList emits active records, not an HTTP envelope.
 * Validate the entire list before using even one identity; retain no records.
 */
function exactSessionAbsence(
  output: T3ProcessResult,
  sessionId: string,
): "absent" | "active" | "unknown" {
  if (
    output.exitCode !== 0 ||
    typeof output.stdout !== "string" ||
    typeof output.stderr !== "string" ||
    Buffer.byteLength(output.stdout, "utf8") > 1024 * 1024 ||
    Buffer.byteLength(output.stderr, "utf8") > 1024 * 1024
  )
    return "unknown";
  try {
    const entries: unknown = JSON.parse(output.stdout);
    if (!Array.isArray(entries)) return "unknown";
    const ids = new Set<string>();
    const methods = ["browser-session-cookie", "bearer-access-token", "dpop-access-token"];
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
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "unknown";
      const session = entry as JsonObject;
      const id = identifier(session.sessionId);
      const client = record(session.client);
      if (
        !id ||
        ids.has(id) ||
        typeof session.method !== "string" ||
        !methods.includes(session.method) ||
        !Array.isArray(session.scopes) ||
        !session.scopes.every(
          (scope: unknown) => typeof scope === "string" && scopes.includes(scope),
        ) ||
        !sessionListString(session.subject) ||
        typeof client.deviceType !== "string" ||
        !["desktop", "mobile", "tablet", "bot", "unknown"].includes(client.deviceType) ||
        ["label", "ipAddress", "userAgent", "os", "browser"].some(
          (key) => key in client && !sessionListString(client[key]),
        ) ||
        typeof session.connected !== "boolean" ||
        !sessionListTimestamp(session.issuedAt) ||
        !sessionListTimestamp(session.expiresAt) ||
        (session.lastConnectedAt !== null && !sessionListTimestamp(session.lastConnectedAt))
      )
        return "unknown";
      ids.add(id);
    }
    return ids.has(sessionId) ? "active" : "absent";
  } catch {
    return "unknown";
  }
}

// Legacy policy deliberately does not salvage malformed acquisition: ordinary
// handoff must retain its historical effects as well as its error precedence.
async function ownedT3SessionLifecycle<T>(
  environment: Pick<T3NativeEnvironment, "baseDir" | "cli" | "origin">,
  cwd: string,
  dependencies: T3NativeDependencies,
  use: (request: ReturnType<typeof t3Http>, token: string) => Promise<T>,
  legacy: boolean,
): Promise<{ evidence: T3OwnedSessionResult<T>; failure?: unknown; issueFailed: boolean }> {
  const run = dependencies.runProcess ?? runProcess;
  const options = { cwd, env: nativeChildEnvironment({ T3CODE_HOME: environment.baseDir }) };
  const evidence: T3OwnedSessionResult<T> = {
    use: { status: "not_attempted" },
    cleanup: { status: "unknown", revoke: "not_attempted" },
  };
  let session: JsonObject = {};
  let issueSucceeded = false;
  let failure: unknown;
  try {
    const issued = await run(
      [
        environment.cli,
        "auth",
        "session",
        "issue",
        "--base-dir",
        environment.baseDir,
        "--ttl",
        "5m",
        "--label",
        legacy ? "Arashi handoff" : "Arashi readiness",
        "--json",
      ],
      options,
    );
    try {
      session = record(JSON.parse(issued.stdout));
    } catch {
      throw new T3HandoffError(
        "T3_AUTH_FAILED",
        "Official T3 session issuance failed. Verify --t3-cli and --t3-base-dir point to matching compatible CLI/server components.",
      );
    }
    issueSucceeded =
      issued.exitCode === 0 &&
      identifier(session.sessionId) !== null &&
      typeof session.token === "string" &&
      session.token.length > 0;
    if (!issueSucceeded)
      throw new T3HandoffError("T3_AUTH_FAILED", "Official T3 session issuance failed.");
  } catch (error) {
    failure = error;
    evidence.failure = new T3HandoffError("T3_AUTH_FAILED", "Official T3 session issuance failed.");
  }
  const sessionId = identifier(session.sessionId);
  if (issueSucceeded) {
    try {
      evidence.use = {
        status: "succeeded",
        value: await use(
          t3Http(environment.origin, session.token as string, dependencies),
          session.token as string,
        ),
      };
    } catch (error) {
      evidence.use = { status: "failed" };
      failure = error;
      // Callback errors may carry credentials in messages/details/results. Only
      // known native read failure codes cross the structured evidence boundary;
      // the raw error stays private for the compatibility wrapper.
      const readFailureCodes = [
        "T3_AUTH_FAILED",
        "T3_AUTH_UNSUPPORTED",
        "T3_HTTP_FAILED",
        "T3_UNREACHABLE",
        "T3_RESPONSE_INVALID",
        "T3_CATALOG_UNAVAILABLE",
        "T3_CATALOG_INVALID",
        "T3_PROVIDER_AMBIGUOUS",
        "T3_MODEL_UNAVAILABLE",
        "T3_OPTIONS_UNSUPPORTED",
        "T3_EFFORT_UNSUPPORTED",
      ];
      evidence.failure = new T3HandoffError(
        error instanceof T3HandoffError && readFailureCodes.includes(error.code)
          ? error.code
          : "T3_HANDOFF_FAILED",
        "The official T3 request failed. Verify compatibility and reconcile pending handoffs.",
      );
    }
  }
  // Only the exact strict ID from this issue response is attributable. Never
  // infer it from stderr, exceptions, token text or a list of other sessions.
  if (sessionId && (issueSucceeded || !legacy)) {
    try {
      const revoked = await run(
        [
          environment.cli,
          "auth",
          "session",
          "revoke",
          sessionId,
          "--base-dir",
          environment.baseDir,
        ],
        options,
      );
      evidence.cleanup =
        revoked.exitCode === 0
          ? { status: "unknown", revoke: "succeeded" }
          : { status: "failed", revoke: "failed" };
    } catch {
      evidence.cleanup = { status: "failed", revoke: "failed" };
    }
    if (!legacy) {
      // One read after the one attributable revoke attempt, with identical
      // selected profile/CWD. Failure cannot be erased by subsequent absence.
      let verification: "absent" | "active" | "unknown" = "unknown";
      try {
        verification = exactSessionAbsence(
          await run(
            [
              environment.cli,
              "auth",
              "session",
              "list",
              "--base-dir",
              environment.baseDir,
              "--json",
            ],
            options,
          ),
          sessionId,
        );
      } catch {
        // Keep process output/errors private and preserve independent use evidence.
      }
      if (evidence.cleanup.revoke === "succeeded") {
        evidence.cleanup.status =
          verification === "absent" ? "verified" : verification === "active" ? "failed" : "unknown";
      }
    }
  }
  // Verification is readiness-only; this foundation does not certify a total
  // deadline, cancellation/crash cleanup, or authenticated command readiness.
  return { evidence, failure, issueFailed: !issueSucceeded };
}

export async function withOwnedT3Session<T>(
  environment: Pick<T3NativeEnvironment, "baseDir" | "cli" | "origin">,
  cwd: string,
  dependencies: T3NativeDependencies,
  use: (request: ReturnType<typeof t3Http>, token: string) => Promise<T>,
): Promise<T3OwnedSessionResult<T>> {
  return (await ownedT3SessionLifecycle(environment, cwd, dependencies, use, false)).evidence;
}

export async function withT3Session<T>(
  environment: Pick<T3NativeEnvironment, "baseDir" | "cli" | "origin">,
  cwd: string,
  dependencies: T3NativeDependencies,
  use: (request: ReturnType<typeof t3Http>, token: string) => Promise<T>,
): Promise<T> {
  const lifecycle = await ownedT3SessionLifecycle(environment, cwd, dependencies, use, true);
  if (lifecycle.issueFailed) throw lifecycle.failure;
  const failure = lifecycle.failure;
  const outcome =
    lifecycle.evidence.use.status === "succeeded" ? lifecycle.evidence.use.value : undefined;
  const revoked = lifecycle.evidence.cleanup.revoke === "succeeded";
  if (!revoked) {
    const cleanup = new T3HandoffError(
      "T3_AUTH_CLEANUP_FAILED",
      "The Arashi session could not be revoked; it expires within five minutes. Reconcile the receipt before retrying.",
      { sessionCleanupFailed: true },
    );
    if (failure instanceof T3HandoffError) {
      throw new T3HandoffError(
        failure.code,
        failure.message,
        { ...failure.details, sessionCleanupFailed: true },
        failure.result,
      );
    }
    throw cleanup;
  }
  if (failure)
    throw failure instanceof T3HandoffError
      ? failure
      : new T3HandoffError(
          "T3_HANDOFF_FAILED",
          "The official T3 request failed. Verify compatibility and reconcile pending handoffs.",
        );
  return outcome!;
}

export function resolveT3Selection(
  config: JsonObject,
  settings: T3Settings,
  project?: JsonObject,
): T3Selection {
  const providers = records(config.providers).filter(
    (provider) =>
      provider.enabled === true &&
      provider.installed === true &&
      provider.availability !== "unavailable" &&
      provider.status !== "error" &&
      record(provider.auth).status !== "unauthenticated",
  );
  const saved = record(
    project?.defaultModelSelection ?? record(config.settings).defaultModelSelection,
  );
  let candidates = settings.provider
    ? providers.filter((provider) => provider.instanceId === settings.provider)
    : providers.filter((provider) => provider.instanceId === saved.instanceId);
  if (settings.provider && candidates.length === 0)
    candidates = providers.filter((provider) => provider.driver === settings.provider);
  if (!settings.provider && candidates.length === 0 && !saved.instanceId) candidates = providers;
  if (candidates.length !== 1)
    return fail(
      "T3_PROVIDER_AMBIGUOUS",
      "Select one available T3 provider instance with --t3-provider; configure/authenticate it in T3 first.",
    );
  const provider = candidates[0]!;
  const instanceId = identifier(provider.instanceId);
  if (!instanceId)
    return fail("T3_CATALOG_INVALID", "T3 omitted the provider instance identifier.");
  const sameProvider = saved.instanceId === instanceId;
  const models = records(provider.models);
  const wanted =
    settings.model ?? (sameProvider && typeof saved.model === "string" ? saved.model : undefined);
  const matches = wanted
    ? models.filter(
        (model) =>
          model.slug === wanted || (Array.isArray(model.aliases) && model.aliases.includes(wanted)),
      )
    : models.filter((model) => model.isDefault === true);
  if (matches.length !== 1 || typeof matches[0]!.slug !== "string")
    return fail(
      "T3_MODEL_UNAVAILABLE",
      "Select a model advertised by the selected T3 provider with --t3-model, or configure a supported T3 default.",
    );
  const model = matches[0]!;
  const useSaved =
    sameProvider &&
    typeof saved.model === "string" &&
    (saved.model === model.slug ||
      (Array.isArray(model.aliases) && model.aliases.includes(saved.model)));
  const descriptors = records(record(model.capabilities).optionDescriptors);
  const authored = useSaved ? records(saved.options) : [];
  const options: T3Selection["options"] = [];
  if (authored.some((option) => !descriptors.some((descriptor) => descriptor.id === option.id)))
    return fail(
      "T3_OPTIONS_UNSUPPORTED",
      "T3's saved selection contains options not advertised for this model. Update its defaults before handoff.",
    );
  for (const descriptor of descriptors) {
    if (typeof descriptor.id !== "string")
      return fail("T3_CATALOG_INVALID", "T3 returned an incompatible option catalog.");
    const choices = records(descriptor.options);
    const defaults = choices.filter((choice) => choice.isDefault === true);
    const value =
      ["effort", "reasoningEffort"].includes(descriptor.id as string) &&
      settings.effort !== undefined
        ? settings.effort
        : (authored.find((option) => option.id === descriptor.id)?.value ??
          descriptor.currentValue ??
          (defaults.length === 1 ? defaults[0]!.id : undefined));
    if (value === undefined) continue;
    if (
      descriptor.type === "select"
        ? !choices.some((choice) => choice.id === value)
        : descriptor.type !== "boolean" || typeof value !== "boolean"
    )
      return fail(
        "T3_EFFORT_UNSUPPORTED",
        "The selected model does not support the requested or saved option. Choose a supported --t3-effort or update T3's defaults.",
      );
    options.push({ id: descriptor.id, value: value as string | boolean });
  }
  if (
    settings.effort !== undefined &&
    !descriptors.some((descriptor) =>
      ["effort", "reasoningEffort"].includes(descriptor.id as string),
    )
  )
    return fail("T3_EFFORT_UNSUPPORTED", "The selected model does not advertise reasoning effort.");
  return { instanceId, model: model.slug as string, options };
}

export async function readT3CliVersion(
  cli: string,
  cwd: string,
  dependencies: T3NativeDependencies = {},
  childEnvironment: NodeJS.ProcessEnv = {},
): Promise<string> {
  const version = await (dependencies.runProcess ?? runProcess)([cli, "--version"], {
    cwd,
    env: nativeChildEnvironment(childEnvironment),
  });
  if (version.exitCode !== 0)
    return fail(
      "T3_CLI_NOT_FOUND",
      "Install the matching official T3 CLI (t3), or select its installed executable with --t3-cli. The desktop alone does not expose supported headless authentication.",
    );
  const cliVersion = version.stdout.trim().match(/^(?:t3\s+)?v?(\d+\.\d+\.\d+)$/u)?.[1];
  verifyT3Version(cliVersion);
  return cliVersion;
}

export async function preflightT3Native(
  cwd: string,
  dependencies: T3NativeDependencies = {},
  settings: T3Settings = {},
  dryRun = false,
): Promise<T3NativeEnvironment> {
  const cli = settings.cli ?? "t3";
  const cliVersion = await readT3CliVersion(cli, cwd, dependencies);
  const discovered = await discoverT3Environment(settings, dependencies);
  const descriptor = await t3Http(
    discovered.origin,
    undefined,
    dependencies,
  )("/.well-known/t3/environment");
  verifyT3Version(descriptor.serverVersion);
  verifyT3Protocol(descriptor);
  if (cliVersion !== descriptor.serverVersion)
    return fail(
      "T3_VERSION_MISMATCH",
      "The official T3 CLI and selected server versions differ. Install the matching CLI or select the matching environment with --t3-cli / --t3-base-dir.",
    );
  const environmentId = identifier(descriptor.environmentId);
  if (
    !environmentId ||
    record(descriptor.platform).os !== (process.platform === "win32" ? "windows" : process.platform)
  )
    return fail(
      "T3_ENVIRONMENT_INVALID",
      "T3 is not a verified environment on this repository host.",
    );
  const environment = {
    ...discovered,
    cli,
    environmentId,
    serverVersion: descriptor.serverVersion,
    settings,
    config: {},
  };
  // Preview verifies only read-only local/runtime metadata, never auth state.
  if (dryRun) return environment;
  environment.config = await withT3Session(
    environment,
    cwd,
    dependencies,
    async (request, token) => {
      const config = await (dependencies.getConfig ?? readT3Config)(
        discovered.origin,
        token,
        request,
      );
      if (
        !Array.isArray(record(config.auth).sessionMethods) ||
        !(record(config.auth).sessionMethods as unknown[]).includes("bearer-access-token")
      )
        return fail("T3_AUTH_UNSUPPORTED", "T3 does not advertise bearer session authentication.");
      if (!Array.isArray(config.providers))
        return fail(
          "T3_CATALOG_INVALID",
          "T3 did not return a compatible provider catalog. Update Arashi or select a compatible T3 release.",
        );
      const session = await request("/api/auth/session");
      if (
        session.authenticated !== true ||
        !["orchestration:read", "orchestration:operate"].every(
          (scope) => Array.isArray(session.scopes) && session.scopes.includes(scope),
        )
      )
        return fail("T3_AUTH_FAILED", "The official T3 session lacks handoff capabilities.");
      const snapshot = await request("/api/orchestration/snapshot");
      if (!Array.isArray(snapshot.projects) || !Array.isArray(snapshot.threads))
        return fail("T3_RESPONSE_INVALID", "T3 orchestration snapshot is incompatible.");
      // Resolve selection only once the exact post-move project is known. Its
      // defaults may select a different instance than the server catalog defaults.
      return config;
    },
  );
  return environment;
}
