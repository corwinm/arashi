import { execFile } from "node:child_process";
import { checkT3Read, runT3Read, t3Now, t3ReadError, type T3ReadControls } from "./t3-operation.ts";
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
  /** Opt-in, never applied by the ordinary handoff compatibility wrapper. */
  readiness?: T3ReadControls;
  runProcess?: (
    command: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
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
export const nativeChildEnvironment = (
  extra: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const environment = { ...process.env, ...extra };
  for (const key of Object.keys(environment)) {
    if ((platform === "win32" ? key.toUpperCase() : key) === "ARASHI_DIRECTIVE_FILE") {
      delete environment[key];
    }
  }
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

/** Same native execFile engine, readiness-only hard stop and stream release. */
const runReadProcess: NonNullable<T3NativeDependencies["runProcess"]> = (command, options) =>
  new Promise((resolve) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: T3ProcessResult) => {
      if (settled) return;
      settled = true;
      if (grace !== undefined) clearTimeout(grace);
      options.signal?.removeEventListener("abort", stop);
      resolve(result);
    };
    const child = execFile(
      command[0]!,
      command.slice(1),
      {
        cwd: options.cwd,
        env: options.env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        finish({ exitCode: error || options.signal?.aborted ? -1 : 0, stdout, stderr });
      },
    );
    const stop = () => {
      child.kill("SIGKILL");
      // Closing the pipe ends prevents inherited/wedged streams from keeping
      // the library subscribed after the exact child has been stopped.
      child.stdout?.destroy();
      child.stderr?.destroy();
      grace = setTimeout(() => finish({ exitCode: -1, stdout: "", stderr: "" }), 100);
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
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
    const read = async (signal: AbortSignal): Promise<JsonObject> => {
      const response = await (dependencies.fetch ?? fetch)(new URL(path, origin), {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal,
        redirect: "error",
      });
      if (dependencies.readiness) {
        if (!response.ok || response.redirected) {
          void response.body?.cancel().catch(() => {});
          return fail(
            response.status === 401 || response.status === 403
              ? "T3_AUTH_FAILED"
              : "T3_HTTP_FAILED",
            "T3 rejected the bounded request.",
          );
        }
        const reader = response.body?.getReader();
        if (!reader) return fail("T3_RESPONSE_INVALID", "T3 returned an incompatible response.");
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (signal.aborted) throw signal.reason;
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 1024 * 1024)
              return fail("T3_RESPONSE_INVALID", "T3 returned an oversized response.");
            chunks.push(part.value);
          }
          const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!Object.keys(body).length)
            return fail("T3_RESPONSE_INVALID", "T3 returned an incompatible response.");
          return body;
        } catch (error) {
          cancel();
          if (error instanceof T3HandoffError) throw error;
          return fail("T3_RESPONSE_INVALID", "T3 returned an incompatible response.");
        } finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      }
      if (!response.ok)
        return fail(
          response.status === 401 || response.status === 403 ? "T3_AUTH_FAILED" : "T3_HTTP_FAILED",
          "T3 rejected the request. Verify the selected environment, authentication, and supported version.",
        );
      const body = record(await response.json());
      if (Object.keys(body).length === 0)
        return fail("T3_RESPONSE_INVALID", "T3 returned an incompatible response.");
      return body;
    };
    try {
      return dependencies.readiness
        ? await runT3Read(dependencies.readiness, read)
        : await read(AbortSignal.timeout(15_000));
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
  options: { boundedRead?: boolean; readiness?: T3ReadControls } = {},
): Promise<JsonObject> {
  const ticket = await request("/api/auth/websocket-ticket", {});
  if (!identifier(ticket.ticket))
    return fail("T3_RESPONSE_INVALID", "T3 omitted its WebSocket ticket.");
  const url = new URL("/ws", origin);
  url.protocol = "ws:";
  url.searchParams.set("orchestrationProtocol", "1");
  url.searchParams.set("wsTicket", ticket.ticket as string);
  const socketRead = (signal?: AbortSignal) =>
    new Promise<JsonObject>((resolveConfig, reject) => {
      const socket = new WebSocket(url);
      const handlers: [string, EventListener][] = [];
      const listen = (name: string, listener: EventListener) => {
        handlers.push([name, listener]);
        socket.addEventListener(name, listener);
      };
      let closeGrace: ReturnType<typeof setTimeout> | undefined;
      const force = () => {
        // Bun WebSocket.terminate is supported and hard-closes a peer that does
        // not acknowledge the close handshake. Ordinary transport is untouched.
        const terminable = socket as WebSocket & { terminate?: () => void };
        terminable.terminate?.();
      };
      const abort = () => {
        socket.close();
        force();
        complete(undefined, signal?.reason);
      };
      let settled = false;
      let closing = false;
      let pending: JsonObject | undefined;
      let bytes = 0;
      const complete = (value?: JsonObject, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (closeGrace !== undefined) clearTimeout(closeGrace);
        signal?.removeEventListener("abort", abort);
        if (options.boundedRead) {
          for (const [name, handler] of handlers) socket.removeEventListener(name, handler);
        }
        if (value) resolveConfig(value);
        else
          reject(
            error instanceof T3HandoffError
              ? error
              : new T3HandoffError(
                  "T3_CATALOG_UNAVAILABLE",
                  "T3's official catalog RPC is unavailable or incompatible.",
                ),
          );
      };
      const finish = (value?: JsonObject) => {
        if (settled || closing) return;
        if (options.boundedRead) {
          closing = true;
          pending = value;
          socket.close();
          // The existing socket deadline includes the close handshake. Never
          // return a successful read before observing close, or extend its bound.
          if (socket.readyState === WebSocket.CLOSED) complete(pending);
          else
            closeGrace = setTimeout(() => {
              force();
              complete();
            }, 100);
        } else {
          socket.close();
          complete(value);
        }
      };
      const timer = setTimeout(() => {
        socket.close();
        if (options.boundedRead) force();
        complete();
      }, 15_000);
      listen("open", () =>
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
      listen("message", (rawEvent) => {
        const event = rawEvent as MessageEvent;
        try {
          if (settled || closing) return;
          if (options.boundedRead) {
            if (typeof event.data !== "string") return finish();
            bytes += Buffer.byteLength(event.data, "utf8");
            if (bytes > 1024 * 1024) return finish();
          }
          const decoded = JSON.parse(String(event.data));
          for (const value of Array.isArray(decoded) ? decoded : [decoded]) {
            const message = record(value);
            if (message._tag === "Ping") {
              socket.send(JSON.stringify({ _tag: "Pong" }));
              continue;
            }
            if (options.boundedRead && (message._tag !== "Exit" || message.requestId !== "1"))
              return finish();
            if (message._tag !== "Exit" || String(message.requestId) !== "1") continue;
            const exit = record(message.exit);
            const config = record(exit.value);
            finish(
              exit._tag === "Success" && (!options.boundedRead || Object.keys(config).length > 0)
                ? config
                : undefined,
            );
          }
        } catch {
          finish();
        }
      });
      listen("error", () => finish());
      listen("close", () => (options.boundedRead ? complete(pending) : finish()));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  return options.readiness
    ? runT3Read(options.readiness, socketRead, { timeoutCode: "T3_CATALOG_UNAVAILABLE" })
    : socketRead();
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
  const now = dependencies.readiness?.now ?? t3Now;
  const control = legacy
    ? undefined
    : (dependencies.readiness ?? { deadline: now() + 90_000, now });
  const run = dependencies.runProcess ?? (control ? runReadProcess : runProcess);
  const options = { cwd, env: nativeChildEnvironment({ T3CODE_HOME: environment.baseDir }) };
  const evidence: T3OwnedSessionResult<T> = {
    use: { status: "not_attempted" },
    cleanup: { status: "unknown", revoke: "not_attempted" },
  };
  let session: JsonObject = {};
  let issueSucceeded = false;
  let failure: unknown;
  let cleanup: Promise<T3OwnedSessionResult<T>["cleanup"]> | undefined;
  const clean = (id: string) => {
    // A single ownership ledger retains late attributable issuance, even from
    // a noncooperative injected runner. Its late result never certifies the
    // already-returned unknown result. Production stops within the grace bound.
    if (cleanup) return cleanup;
    const budget = { deadline: now() + 45_000, now };
    const execute = (argv: string[]) =>
      control
        ? runT3Read(budget, (signal) => run(argv, { ...options, signal }))
        : run(argv, options);
    cleanup = (async () => {
      let outcome: T3OwnedSessionResult<T>["cleanup"];
      try {
        const revoked = await execute([
          environment.cli,
          "auth",
          "session",
          "revoke",
          id,
          "--base-dir",
          environment.baseDir,
        ]);
        outcome =
          revoked.exitCode === 0 &&
          (legacy ||
            (Buffer.byteLength(revoked.stdout) <= 1024 * 1024 &&
              Buffer.byteLength(revoked.stderr) <= 1024 * 1024))
            ? { status: "unknown", revoke: "succeeded" }
            : { status: "failed", revoke: "failed" };
      } catch {
        outcome = { status: "failed", revoke: "failed" };
      }
      if (!legacy) {
        let verification: "absent" | "active" | "unknown" = "unknown";
        try {
          verification = exactSessionAbsence(
            await execute([
              environment.cli,
              "auth",
              "session",
              "list",
              "--base-dir",
              environment.baseDir,
              "--json",
            ]),
            id,
          );
        } catch {
          /* Do not expose process output or erase independent use. */
        }
        if (outcome.revoke === "succeeded")
          outcome.status =
            verification === "absent"
              ? "verified"
              : verification === "active"
                ? "failed"
                : "unknown";
      }
      return outcome;
    })();
    return cleanup;
  };
  const parseIssue = (issued: T3ProcessResult): JsonObject => {
    if (!legacy && Buffer.byteLength(issued.stdout) > 1024 * 1024)
      throw t3ReadError("T3_RESPONSE_INVALID");
    return record(JSON.parse(issued.stdout));
  };
  try {
    try {
      const argv = [
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
      ];
      let issueInterrupted: T3HandoffError | undefined;
      const issued = control
        ? await runT3Read(control, (signal) => run(argv, { ...options, signal }), {
            interruptedOutput: true,
            interrupted: (error) => {
              issueInterrupted = error;
            },
            lateOutput: (output) => {
              try {
                const id = identifier(parseIssue(output).sessionId);
                if (id) void clean(id);
              } catch {
                /* Unknown is not guessed ownership. */
              }
            },
          })
        : await run(argv, options);
      try {
        session = parseIssue(issued);
      } catch {
        // Failed ownership parsing must not replace a captured interruption.
        if (issueInterrupted) throw issueInterrupted;
        throw new T3HandoffError(
          "T3_AUTH_FAILED",
          "Official T3 session issuance failed. Verify --t3-cli and --t3-base-dir point to matching compatible CLI/server components.",
        );
      }
      issueSucceeded =
        issued.exitCode === 0 &&
        (legacy || Buffer.byteLength(issued.stderr) <= 1024 * 1024) &&
        identifier(session.sessionId) !== null &&
        typeof session.token === "string" &&
        session.token.length > 0;
      // Observe attributable output before checking interruption, so finally
      // can revoke an ID actually returned by a stopped issue process.
      if (issueInterrupted) throw issueInterrupted;
      if (control) checkT3Read(control);
      if (!issueSucceeded)
        throw new T3HandoffError("T3_AUTH_FAILED", "Official T3 session issuance failed.");
    } catch (error) {
      failure = error;
      const code =
        error instanceof T3HandoffError &&
        ["T3_CHECK_CANCELLED", "T3_CHECK_TIMEOUT", "T3_UNREACHABLE"].includes(error.code)
          ? error.code
          : "T3_AUTH_FAILED";
      evidence.failure = new T3HandoffError(
        code,
        "Official T3 session issuance failed or was interrupted.",
      );
    }
    if (issueSucceeded && failure === undefined) {
      try {
        const invoke = (signal?: AbortSignal) =>
          use(
            t3Http(environment.origin, session.token as string, {
              ...dependencies,
              readiness: control ? { ...control, signal } : undefined,
            }),
            session.token as string,
          );
        evidence.use = {
          status: "succeeded",
          value: control
            ? await runT3Read(control, invoke, { operationMs: 90_000 })
            : await invoke(),
        };
      } catch (error) {
        evidence.use = { status: "failed" };
        failure = error;
        const codes = [
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
          "T3_CHECK_CANCELLED",
          "T3_CHECK_TIMEOUT",
        ];
        evidence.failure = new T3HandoffError(
          error instanceof T3HandoffError && codes.includes(error.code)
            ? error.code
            : "T3_HANDOFF_FAILED",
          "The official T3 request failed. Verify compatibility and reconcile pending handoffs.",
        );
      }
    }
  } finally {
    const id = identifier(session.sessionId);
    if (id && (issueSucceeded || !legacy)) evidence.cleanup = await clean(id);
  }
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

// Readiness-only wire admission. Ordinary dispatch retains its compatibility
// policy. Validate consumed scalars without retaining extensions or classifying
// freshness; checkedAt's time interpretation belongs to the later state gate.
const object = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.trim() === v;
const optionalBoolean = (v: JsonObject, key: string) =>
  !Object.hasOwn(v, key) || typeof v[key] === "boolean";
function admitReadinessCatalog(config: JsonObject, project?: JsonObject): void {
  const reject = () => fail("T3_CATALOG_INVALID", "T3 returned an incompatible selection catalog.");
  const scalar = (v: unknown) => text(v) || typeof v === "boolean";
  const selection = (v: unknown) => {
    if (v === undefined || v === null) return;
    if (!object(v) || !text(v.instanceId) || !text(v.model)) reject();
    const s = v as JsonObject;
    if (
      Object.hasOwn(s, "options") &&
      (!Array.isArray(s.options) ||
        s.options.some((o) => !object(o) || !text(o.id) || !scalar(o.value)))
    )
      reject();
    // Multiple values for one saved option cannot establish exact intent.
    const optionIds = new Set<string>();
    for (const option of (s.options ?? []) as JsonObject[]) {
      if (optionIds.has(option.id as string)) reject();
      optionIds.add(option.id as string);
    }
  };
  if (!Array.isArray(config.providers) || !object(config.settings)) reject();
  selection(record(config.settings).defaultModelSelection);
  selection(project?.defaultModelSelection);
  const ids = new Set<string>();
  for (const raw of config.providers as unknown[]) {
    if (!object(raw)) reject();
    const p = raw as JsonObject;
    if (
      !identifier(p.instanceId) ||
      !text(p.driver) ||
      ids.has(p.instanceId as string) ||
      typeof p.enabled !== "boolean" ||
      typeof p.installed !== "boolean" ||
      !text(p.status) ||
      !["ready", "warning", "error", "disabled"].includes(p.status) ||
      !object(p.auth) ||
      !text(p.auth.status) ||
      !["authenticated", "unauthenticated", "unknown"].includes(p.auth.status) ||
      typeof p.checkedAt !== "string" ||
      !(p.version === null || text(p.version)) ||
      (Object.hasOwn(p, "availability") &&
        (!text(p.availability) || !["available", "unavailable"].includes(p.availability))) ||
      !Array.isArray(p.models)
    )
      reject();
    ids.add(p.instanceId as string);
    for (const rawModel of p.models as unknown[]) {
      if (!object(rawModel)) reject();
      const m = rawModel as JsonObject;
      if (
        !text(m.slug) ||
        !optionalBoolean(m, "isDefault") ||
        (Object.hasOwn(m, "aliases") && (!Array.isArray(m.aliases) || !m.aliases.every(text))) ||
        !(m.capabilities === null || object(m.capabilities))
      )
        reject();
      const capabilities = record(m.capabilities);
      if (
        Object.hasOwn(capabilities, "optionDescriptors") &&
        !Array.isArray(capabilities.optionDescriptors)
      )
        reject();
      const descriptorIds = new Set<string>();
      for (const rawDescriptor of (capabilities.optionDescriptors ?? []) as unknown[]) {
        if (!object(rawDescriptor)) reject();
        const d = rawDescriptor as JsonObject;
        if (
          !text(d.id) ||
          (d.type !== "select" && d.type !== "boolean") ||
          (Object.hasOwn(d, "currentValue") &&
            (d.type === "select" ? !text(d.currentValue) : typeof d.currentValue !== "boolean"))
        )
          reject();
        if (descriptorIds.has(d.id as string)) reject();
        descriptorIds.add(d.id as string);
        if (d.type === "select") {
          if (!Array.isArray(d.options)) reject();
          const choiceIds = new Set<string>();
          let defaults = 0;
          for (const rawChoice of d.options as unknown[]) {
            if (
              !object(rawChoice) ||
              !text(rawChoice.id) ||
              !optionalBoolean(rawChoice, "isDefault")
            )
              reject();
            const choice = rawChoice as JsonObject;
            if (choiceIds.has(choice.id as string)) reject();
            choiceIds.add(choice.id as string);
            if (choice.isDefault === true) defaults++;
          }
          if (
            defaults > 1 ||
            (Object.hasOwn(d, "currentValue") && !choiceIds.has(d.currentValue as string))
          )
            reject();
        }
      }
    }
  }
}

export function resolveT3Selection(
  config: JsonObject,
  settings: T3Settings,
  project?: JsonObject,
  policy: {
    readiness?: boolean;
    provenance?: (sources: {
      provider: "authored" | "saved" | "catalog";
      model: "authored" | "saved" | "catalog";
      options: Record<string, "authored" | "saved" | "catalog">;
    }) => void;
  } = {},
): T3Selection {
  if (policy.readiness) admitReadinessCatalog(config, project);
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
  if (policy.readiness) {
    const exact =
      settings.provider &&
      records(config.providers).some((p) => p.instanceId === settings.provider);
    // A routing identity, even when rejected, never becomes a driver alias.
    if (exact && (candidates.length !== 1 || candidates[0]!.status === "disabled"))
      return fail("T3_PROVIDER_AMBIGUOUS", "The selected T3 provider instance is unavailable.");
    candidates = candidates.filter((p) => p.status !== "disabled");
    if (settings.provider && !exact && candidates.length === 0)
      candidates = providers.filter(
        (p) => p.driver === settings.provider && p.status !== "disabled",
      );
  } else if (settings.provider && candidates.length === 0)
    candidates = providers.filter((provider) => provider.driver === settings.provider);
  if (!settings.provider && candidates.length === 0 && !saved.instanceId)
    candidates = policy.readiness ? providers.filter((p) => p.status !== "disabled") : providers;
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
  const optionSources: Record<string, "authored" | "saved" | "catalog"> = Object.create(null);
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
    optionSources[descriptor.id] =
      ["effort", "reasoningEffort"].includes(descriptor.id) && settings.effort !== undefined
        ? "authored"
        : authored.some((o) => o.id === descriptor.id)
          ? "saved"
          : "catalog";
  }
  if (
    settings.effort !== undefined &&
    !descriptors.some((descriptor) =>
      ["effort", "reasoningEffort"].includes(descriptor.id as string),
    )
  )
    return fail("T3_EFFORT_UNSUPPORTED", "The selected model does not advertise reasoning effort.");
  policy.provenance?.({
    provider: settings.provider !== undefined ? "authored" : saved.instanceId ? "saved" : "catalog",
    model:
      settings.model !== undefined
        ? "authored"
        : sameProvider && typeof saved.model === "string"
          ? "saved"
          : "catalog",
    options: optionSources,
  });
  return { instanceId, model: model.slug as string, options };
}

export async function readT3CliVersion(
  cli: string,
  cwd: string,
  dependencies: T3NativeDependencies = {},
  childEnvironment: NodeJS.ProcessEnv = {},
): Promise<string> {
  const options = { cwd, env: nativeChildEnvironment(childEnvironment) };
  const run = dependencies.runProcess ?? (dependencies.readiness ? runReadProcess : runProcess);
  const version = dependencies.readiness
    ? await runT3Read(dependencies.readiness, (signal) =>
        run([cli, "--version"], { ...options, signal }),
      )
    : await run([cli, "--version"], options);
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
