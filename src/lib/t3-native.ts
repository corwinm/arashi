import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { T3HandoffError } from "./t3-error.ts";
import type { T3ProcessResult } from "./t3-handoff.ts";
import type { T3Settings } from "./t3-settings.ts";

// Deliberately fail closed across independently versioned T3 releases.
export const T3_NATIVE_VERSIONS = ["0.0.43"] as const;
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
  if (!T3_NATIVE_VERSIONS.includes(version as "0.0.43")) {
    fail(
      "T3_VERSION_UNSUPPORTED",
      "Native T3 handoff supports official T3 0.0.43 only. Install a matching official CLI and server; no component is downloaded automatically.",
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

export async function withT3Session<T>(
  environment: Pick<T3NativeEnvironment, "baseDir" | "cli" | "origin">,
  cwd: string,
  dependencies: T3NativeDependencies,
  use: (request: ReturnType<typeof t3Http>, token: string) => Promise<T>,
): Promise<T> {
  const run = dependencies.runProcess ?? runProcess;
  const options = { cwd, env: { ...process.env, T3CODE_HOME: environment.baseDir } };
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
      "Arashi handoff",
      "--json",
    ],
    options,
  );
  let session: JsonObject;
  try {
    session = record(JSON.parse(issued.stdout));
  } catch {
    return fail(
      "T3_AUTH_FAILED",
      "Official T3 session issuance failed. Verify --t3-cli and --t3-base-dir point to matching 0.0.43 components.",
    );
  }
  const sessionId = identifier(session.sessionId);
  if (issued.exitCode !== 0 || !sessionId || typeof session.token !== "string" || !session.token)
    return fail("T3_AUTH_FAILED", "Official T3 session issuance failed.");
  let outcome: T | undefined;
  let failure: unknown;
  try {
    outcome = await use(t3Http(environment.origin, session.token, dependencies), session.token);
  } catch (error) {
    failure = error;
  }
  let revoked = false;
  try {
    revoked =
      (
        await run(
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
        )
      ).exitCode === 0;
  } catch {
    /* Short-lived credential expires independently. */
  }
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
  const useSaved = saved.instanceId === instanceId && !settings.model;
  const models = records(provider.models);
  const wanted =
    settings.model ?? (useSaved && typeof saved.model === "string" ? saved.model : undefined);
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

export async function preflightT3Native(
  cwd: string,
  dependencies: T3NativeDependencies = {},
  settings: T3Settings = {},
  dryRun = false,
): Promise<T3NativeEnvironment> {
  const cli = settings.cli ?? "t3";
  const version = await (dependencies.runProcess ?? runProcess)([cli, "--version"], {
    cwd,
    env: process.env,
  });
  if (version.exitCode !== 0)
    return fail(
      "T3_CLI_NOT_FOUND",
      "Install official T3 0.0.43 (t3), or select its installed executable with --t3-cli. The desktop alone does not expose supported headless authentication.",
    );
  verifyT3Version(version.stdout.trim().match(/^(?:t3\s+)?v?(\d+\.\d+\.\d+)$/u)?.[1]);
  const discovered = await discoverT3Environment(settings, dependencies);
  const descriptor = await t3Http(
    discovered.origin,
    undefined,
    dependencies,
  )("/.well-known/t3/environment");
  verifyT3Version(descriptor.serverVersion);
  verifyT3Protocol(descriptor);
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
