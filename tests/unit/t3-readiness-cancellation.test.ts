import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectT3AuthenticatedReadFoundation,
  collectT3ReadinessPreview,
} from "../../src/lib/t3-readiness.ts";
import {
  withOwnedT3Session,
  withT3Session,
  readT3Config,
  t3Http,
  type T3NativeDependencies,
} from "../../src/lib/t3-native.ts";
import { T3HandoffError } from "../../src/lib/t3-error.ts";
import { nativeEnvironment } from "../helpers/t3-native.ts";

const output = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const issued = output(JSON.stringify({ sessionId: "owned-session", token: "PRIVATE_TOKEN" }));
const never = () => new Promise<never>(() => {});
const controls = (signal?: AbortSignal, deadline = Date.now() + 90_000) => ({
  signal,
  deadline,
  now: Date.now,
});
const dependencies = (value: object) => value as T3NativeDependencies;
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function fixture(signal?: AbortSignal, deadline?: number) {
  const operations: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const entryAborted: (boolean | undefined)[] = [];
  return {
    operations,
    signals,
    entryAborted,
    dependencies: dependencies({
      readiness: controls(signal, deadline),
      runProcess: async (argv: string[], options: { signal?: AbortSignal }) => {
        operations.push(argv[3]);
        signals.push(options.signal);
        entryAborted.push(options.signal?.aborted);
        return argv[3] === "issue" ? issued : output(argv[3] === "list" ? "[]" : "");
      },
    }),
  };
}

describe("Task4.5 bounded owned cancellation", () => {
  test("A16 preissue cancellation has zero external issuance", async () => {
    const abort = new AbortController();
    abort.abort();
    const f = fixture(abort.signal);
    const result = await withOwnedT3Session(
      nativeEnvironment(),
      ".",
      f.dependencies,
      async () => true,
    );
    expect(f.operations).toEqual([]);
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "not_attempted" });
    expect(result.failure?.code).toBe("T3_CHECK_CANCELLED");
  });
  test("A16 cancellation immediately after attributable issuance skips use and cleans independently", async () => {
    const abort = new AbortController();
    const f = fixture(abort.signal);
    const run = f.dependencies.runProcess!;
    f.dependencies.runProcess = async (argv, options) => {
      const out = await run(argv, options);
      if (argv[3] === "issue") abort.abort();
      return out;
    };
    let uses = 0;
    const result = await withOwnedT3Session(nativeEnvironment(), ".", f.dependencies, async () => {
      uses++;
    });
    expect(uses).toBe(0);
    expect(result.failure?.code).toBe("T3_CHECK_CANCELLED");
    expect(f.operations).toEqual(["issue", "revoke", "list"]);
    expect(f.entryAborted.slice(1)).toEqual([false, false]);
    expect(result.cleanup.status).toBe("verified");
  });
  test("A16 nonsettling use is bounded at 15s; cancellation subscription and timers released", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const f = fixture(abort.signal);
    let entered!: () => void;
    const barrier = new Promise<void>((r) => {
      entered = r;
    });
    f.dependencies.fetch = never as typeof fetch;
    const pending = withOwnedT3Session(
      nativeEnvironment(),
      ".",
      f.dependencies,
      async (request) => {
        entered();
        return request("/fixture");
      },
    );
    await barrier;
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result.failure?.code).toBe("T3_UNREACHABLE");
    expect(result.use.status).toBe("failed");
    expect(result.cleanup.status).toBe("verified");
    expect(vi.getTimerCount()).toBe(0);
  });
  test("A16 exhausted check deadline still grants independent 45s cleanup with 15s operations", async () => {
    vi.useFakeTimers();
    const f = fixture(undefined, Date.now() + 1000);
    let entered!: () => void;
    const barrier = new Promise<void>((r) => {
      entered = r;
    });
    const pending = withOwnedT3Session(nativeEnvironment(), ".", f.dependencies, async () => {
      entered();
      return never();
    });
    await barrier;
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.failure?.code).toBe("T3_CHECK_TIMEOUT");
    expect(result.cleanup.status).toBe("verified");
    expect(f.operations).toEqual(["issue", "revoke", "list"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  test("A16 interrupted issuance without observed ID stays unknown; never guesses or lists", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let entered!: () => void;
    const barrier = new Promise<void>((r) => {
      entered = r;
    });
    const calls: string[] = [];
    const pending = withOwnedT3Session(
      nativeEnvironment(),
      ".",
      dependencies({
        readiness: controls(abort.signal),
        runProcess: async (argv: string[]) => {
          calls.push(argv[3]);
          entered();
          return never();
        },
      }),
      async () => true,
    );
    await barrier;
    abort.abort();
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    expect(calls).toEqual(["issue"]);
    expect(result.failure?.code).toBe("T3_CHECK_CANCELLED");
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "not_attempted" });
    expect(vi.getTimerCount()).toBe(0);
  });
  test.each([
    ["empty cancellation", "", false, "T3_CHECK_CANCELLED"],
    ["partial cancellation", "{", false, "T3_CHECK_CANCELLED"],
    ["empty aggregate deadline", "", true, "T3_CHECK_TIMEOUT"],
    ["attributable cancellation control", issued.stdout, false, "T3_CHECK_CANCELLED"],
  ] as const)(
    "R1 stopped issue preserves interruption: %s",
    async (_name, stdout, deadline, code) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      const f = fixture(abort.signal, Date.now() + (deadline ? 1000 : 90_000));
      const run = f.dependencies.runProcess!;
      let entered!: () => void;
      const barrier = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.dependencies.runProcess = async (argv, options) => {
        if (argv[3] !== "issue") return run(argv, options);
        f.operations.push("issue");
        return new Promise((resolve) => {
          options.signal!.addEventListener(
            "abort",
            () => resolve({ ...output(stdout), exitCode: -1 }),
            { once: true },
          );
          entered();
        });
      };
      let uses = 0;
      const pending = withOwnedT3Session(nativeEnvironment(), ".", f.dependencies, async () => {
        uses++;
      });
      await barrier;
      if (deadline) await vi.advanceTimersByTimeAsync(1000);
      else abort.abort();
      const result = await pending;
      expect(uses).toBe(0);
      expect(result.use.status).toBe("not_attempted");
      expect(f.operations).toEqual(
        stdout === issued.stdout ? ["issue", "revoke", "list"] : ["issue"],
      );
      expect(result.cleanup).toEqual(
        stdout === issued.stdout
          ? { status: "verified", revoke: "succeeded" }
          : { status: "unknown", revoke: "not_attempted" },
      );
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
      expect(vi.getTimerCount()).toBe(0);
      expect(result.failure?.code).toBe(code);
    },
  );
  test.each(["", "{"])(
    "R1 uninterrupted malformed issuance remains auth failure: %j",
    async (stdout) => {
      const f = fixture();
      f.dependencies.runProcess = async (argv) => {
        f.operations.push(argv[3]);
        return output(stdout);
      };
      const result = await withOwnedT3Session(
        nativeEnvironment(),
        ".",
        f.dependencies,
        async () => {
          throw new Error("must not use malformed issue");
        },
      );
      expect(result.failure?.code).toBe("T3_AUTH_FAILED");
      expect(result.cleanup).toEqual({ status: "unknown", revoke: "not_attempted" });
      expect(f.operations).toEqual(["issue"]);
      f.operations.length = 0;
      await expect(
        withT3Session(nativeEnvironment(), ".", f.dependencies, async () => true),
      ).rejects.toMatchObject({ code: "T3_AUTH_FAILED" });
      expect(f.operations).toEqual(["issue"]);
    },
  );
  test("A16 cleanup hung revoke/list each have own 15s bounds and retain read error", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const run = f.dependencies.runProcess!;
    f.dependencies.runProcess = async (argv, options) =>
      argv[3] === "issue" ? run(argv, options) : (f.operations.push(argv[3]), never());
    let entered!: () => void;
    const barrier = new Promise<void>((r) => {
      entered = r;
    });
    const pending = withOwnedT3Session(nativeEnvironment(), ".", f.dependencies, async () => {
      entered();
      throw new T3HandoffError("T3_RESPONSE_INVALID", "PRIVATE_BODY");
    });
    await barrier;
    await vi.advanceTimersByTimeAsync(30_500);
    const result = await pending;
    expect(result.failure?.code).toBe("T3_RESPONSE_INVALID");
    expect(result.cleanup).toEqual({ status: "failed", revoke: "failed" });
    expect(f.operations).toEqual(["issue", "revoke", "list"]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
    expect(vi.getTimerCount()).toBe(0);
  });
  test("A16 issue timeout retains interrupted code and salvages really observed output", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const run = f.dependencies.runProcess!;
    let entered!: () => void;
    const barrier = new Promise<void>((r) => {
      entered = r;
    });
    f.dependencies.runProcess = async (argv, options) => {
      if (argv[3] !== "issue") return run(argv, options);
      f.operations.push("issue");
      entered();
      return new Promise((resolve) =>
        options.signal?.addEventListener("abort", () => resolve({ ...issued, exitCode: -1 }), {
          once: true,
        }),
      );
    };
    let used = false;
    const pending = withOwnedT3Session(nativeEnvironment(), ".", f.dependencies, async () => {
      used = true;
    });
    await barrier;
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result.failure?.code).toBe("T3_UNREACHABLE");
    expect(used).toBe(false);
    expect(result.cleanup.status).toBe("verified");
    expect(f.operations).toEqual(["issue", "revoke", "list"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  test("A16 noncooperative late issue remains publicly unknown but exact ownership is recovered once", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const f = fixture(abort.signal);
    const run = f.dependencies.runProcess!;
    let deliver!: (value: typeof issued) => void;
    let entered!: () => void;
    const barrier = new Promise<void>((r) => {
      entered = r;
    });
    f.dependencies.runProcess = async (argv, options) =>
      argv[3] === "issue"
        ? (f.operations.push("issue"),
          entered(),
          new Promise((r) => {
            deliver = r;
          }))
        : run(argv, options);
    const pending = withOwnedT3Session(nativeEnvironment(), ".", f.dependencies, async () => true);
    await barrier;
    abort.abort();
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "not_attempted" });
    deliver(issued);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.operations).toEqual(["issue", "revoke", "list"]);
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "not_attempted" });
    expect(vi.getTimerCount()).toBe(0);
  });
  test("A16 cleanup cumulative 45s is not reset between revoke and exact list", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const run = f.dependencies.runProcess!;
    f.dependencies.runProcess = async (argv, options) => {
      const value = await run(argv, options);
      // An injected monotonic-clock jump models time spent outside native I/O.
      if (argv[3] === "revoke") vi.setSystemTime(Date.now() + 45_000);
      return value;
    };
    const result = await withOwnedT3Session(
      nativeEnvironment(),
      ".",
      f.dependencies,
      async () => true,
    );
    expect(result.use.status).toBe("succeeded");
    expect(result.cleanup).toEqual({ status: "unknown", revoke: "succeeded" });
    expect(f.operations).toEqual(["issue", "revoke"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  test("A16 oversize issue stderr cannot discard an already observed strict owned ID", async () => {
    const f = fixture();
    const run = f.dependencies.runProcess!;
    f.dependencies.runProcess = async (argv, options) => {
      const out = await run(argv, options);
      return argv[3] === "issue" ? { ...out, stderr: "x".repeat(1024 * 1024 + 1) } : out;
    };
    let used = false;
    const result = await withOwnedT3Session(nativeEnvironment(), ".", f.dependencies, async () => {
      used = true;
    });
    expect(used).toBe(false);
    expect(result.failure?.code).toBe("T3_AUTH_FAILED");
    expect(result.cleanup.status).toBe("verified");
    expect(f.operations).toEqual(["issue", "revoke", "list"]);
  });
  test("A16 oversize revoke output cannot certify successful exact cleanup", async () => {
    const f = fixture();
    const run = f.dependencies.runProcess!;
    f.dependencies.runProcess = async (argv, options) => {
      const out = await run(argv, options);
      return argv[3] === "revoke" ? { ...out, stdout: "x".repeat(1024 * 1024 + 1) } : out;
    };
    const result = await withOwnedT3Session(
      nativeEnvironment(),
      ".",
      f.dependencies,
      async () => true,
    );
    expect(result.use.status).toBe("succeeded");
    expect(result.cleanup).toEqual({ status: "failed", revoke: "failed" });
    expect(f.operations).toEqual(["issue", "revoke", "list"]);
  });
  test("A16 ordinary wrapper ignores readiness cancellation and performs no new list", async () => {
    const abort = new AbortController();
    abort.abort();
    const f = fixture(abort.signal);
    await expect(
      withT3Session(nativeEnvironment(), ".", f.dependencies, async () => 3),
    ).resolves.toBe(3);
    expect(f.operations).toEqual(["issue", "revoke"]);
    expect(f.signals).toEqual([undefined, undefined]);
  });
  test("A16 HTTP operation propagates readiness cancellation and cancels body", async () => {
    const abort = new AbortController();
    let cancelled = 0;
    let observed: AbortSignal | null | undefined;
    const request = t3Http(
      "http://127.0.0.1",
      undefined,
      dependencies({
        readiness: controls(abort.signal),
        fetch: async (_input: unknown, init: RequestInit) => {
          observed = init.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
              },
              cancel() {
                cancelled++;
              },
            }),
          );
        },
      }),
    );
    const pending = request("/fixture");
    await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "T3_CHECK_CANCELLED" });
    expect(observed?.aborted).toBe(true);
    expect(cancelled).toBe(1);
  });
  test("A14 noncooperating socket is force-closed at deadline; listeners removed", async () => {
    vi.useFakeTimers();
    const peers: Peer[] = [];
    class Peer extends EventTarget {
      static CLOSED = 3;
      readyState = 1;
      closes = 0;
      terminated = 0;
      listeners = 0;
      constructor() {
        super();
        peers.push(this);
      }
      send() {}
      close() {
        this.closes++;
      }
      terminate() {
        this.terminated++;
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
      }
      override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
        this.listeners++;
        super.addEventListener(...args);
      }
      override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
        this.listeners--;
        super.removeEventListener(...args);
      }
    }
    vi.stubGlobal("WebSocket", Peer);
    const pending = readT3Config(
      "http://127.0.0.1",
      "PRIVATE",
      async () => ({ ticket: "ticket" }),
      { boundedRead: true },
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "T3_CATALOG_UNAVAILABLE" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_250);
    await assertion;
    const socket = peers[0]!;
    expect(socket.terminated).toBe(1);
    expect(socket.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function readFixture() {
  const root = await mkdtemp(join(tmpdir(), "t3-budget-"));
  roots.push(root);
  const auth = {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "fixture-cookie",
  };
  const descriptor = {
    environmentId: "environment-1",
    serverVersion: "0.0.43",
    orchestrationProtocolVersion: 1,
    platform: { os: process.platform, arch: process.arch },
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  };
  const config = { environment: descriptor, auth, providers: [], settings: {} };
  const calls: string[] = [];
  let delay = 0;
  let interrupt: string | undefined;
  let error: string | undefined;
  const abort = new AbortController();
  const step = async (name: string) => {
    calls.push(name);
    if (interrupt === name) abort.abort();
    if (delay) await new Promise<void>((r) => setTimeout(r, delay));
  };
  const deps: T3NativeDependencies = {
    runProcess: async (argv) => {
      const name = argv[1] === "--version" ? "version" : argv[3]!;
      if (!["revoke", "list"].includes(name)) await step(name);
      else calls.push(name);
      return name === "version"
        ? output("t3 v0.0.43")
        : name === "issue"
          ? issued
          : output(name === "list" ? "[]" : "");
    },
    readRuntime: async () => {
      await step("runtime");
      return JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 1,
        origin: "http://127.0.0.1:1",
      });
    },
    fetch: (async (input) => {
      const path = new URL(String(input)).pathname;
      const name = path.includes(".well-known")
        ? "public"
        : path.endsWith("session")
          ? "session"
          : path.endsWith("ticket")
            ? "ticket"
            : "shell";
      await step(name);
      if (error === "shell" && name === "shell")
        return new Response("PRIVATE_BODY", { status: 500 });
      return Response.json(
        name === "public"
          ? descriptor
          : name === "session"
            ? {
                authenticated: true,
                auth,
                sessionMethod: "bearer-access-token",
                scopes: ["orchestration:read"],
              }
            : name === "ticket"
              ? { ticket: error === "ticket" ? [] : "ticket" }
              : {
                  snapshotSequence: 0,
                  projects: [],
                  threads: [],
                  updatedAt: "2026-10-04T12:00:00Z",
                },
      );
    }) as typeof fetch,
  };
  const preview = await collectT3ReadinessPreview(
    {
      cwd: root,
      context: {
        checkout: root,
        settings: { baseDir: root, cli: "fixture-cli" },
        workspaceRoot: null,
        workspace: null,
        roots: null,
        sources: {},
      },
    },
    deps,
  );
  expect(preview.readiness).toBe("preview_passed");
  calls.length = 0;
  const sockets: Peer[] = [];
  class Peer extends EventTarget {
    static CLOSED = 3;
    readyState = 1;
    listeners = 0;
    closed = false;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw: string) {
      if (JSON.parse(raw)._tag === "Pong") {
        calls.push("Pong");
        return;
      }
      void step("config").then(() => {
        if (this.closed) return;
        const payload =
          error === "malformed"
            ? "{"
            : JSON.stringify(
                error === "wrong-id"
                  ? { _tag: "Exit", requestId: "wrong" }
                  : {
                      _tag: "Exit",
                      requestId: "1",
                      exit:
                        error === "rpc" ? { _tag: "Failure" } : { _tag: "Success", value: config },
                    },
              );
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ _tag: "Ping" }) }));
        this.dispatchEvent(new MessageEvent("message", { data: payload }));
      });
    }
    close() {
      this.closed = true;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    terminate() {
      this.close();
    }
    override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
      this.listeners++;
      super.addEventListener(...args);
    }
    override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
      this.listeners--;
      super.removeEventListener(...args);
    }
  }
  vi.stubGlobal("WebSocket", Peer);
  return {
    deps,
    preview,
    calls,
    abort,
    sockets,
    delay: (ms: number) => {
      delay = ms;
    },
    interrupt: (name: string) => {
      interrupt = name;
    },
    error: (name: string) => {
      error = name;
    },
  };
}

describe("Task4.5 whole pinned check", () => {
  test("A16 virtual 90s includes recheck + issue + authenticated reads; independent cleanup still verifies", async () => {
    const f = await readFixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    f.delay(14_000);
    f.deps.readiness = controls(undefined);
    const before = process.listenerCount("SIGINT");
    const pending = collectT3AuthenticatedReadFoundation(
      f.preview,
      { authenticated: true },
      f.deps,
    );
    // Realpath is real I/O: synchronize each operation entry before advancing.
    for (const name of ["version", "runtime", "public", "issue", "session", "ticket"]) {
      for (let n = 0; !f.calls.includes(name) && n < 100; n++)
        await new Promise<void>((r) => setImmediate(r));
      expect(f.calls).toContain(name);
      await vi.advanceTimersByTimeAsync(14_000);
    }
    expect(f.calls).toContain("config");
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(result.failure?.code).toBe("T3_CHECK_TIMEOUT");
    expect(result.cleanup.status).toBe("verified");
    expect(f.calls.filter((s) => ["issue", "revoke", "list"].includes(s))).toEqual([
      "issue",
      "revoke",
      "list",
    ]);
    expect(f.calls).not.toContain("shell");
    expect(f.sockets.every((s) => s.closed && s.listeners === 0)).toBe(true);
    // This intentionally noncooperative injected peer owns its delayed delivery
    // timer. Production's socket subscription is already closed, no late read.
    await vi.advanceTimersByTimeAsync(8000);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
  test.each(["version", "runtime", "public", "issue", "session", "ticket", "config", "shell"])(
    "A16 cancellation at %s propagates without retry",
    async (name) => {
      const f = await readFixture();
      f.interrupt(name);
      const before = process.listenerCount("SIGINT");
      const pending = collectT3AuthenticatedReadFoundation(
        f.preview,
        { authenticated: true, signal: f.abort.signal },
        f.deps,
      );
      if (["version", "runtime", "public"].includes(name)) {
        await expect(pending).rejects.toMatchObject({ code: "T3_CHECK_CANCELLED" });
        expect(f.calls).not.toContain("issue");
      } else {
        const result = await pending;
        expect(result.failure?.code).toBe("T3_CHECK_CANCELLED");
        expect(result.cleanup.status).toBe("verified");
        expect(f.calls.filter((s) => ["issue", "revoke", "list"].includes(s))).toEqual([
          "issue",
          "revoke",
          "list",
        ]);
      }
      expect(f.sockets.every((s) => s.closed && s.listeners === 0)).toBe(true);
      expect(process.listenerCount("SIGINT")).toBe(before);
    },
  );
  test.each([
    ["rpc", "T3_CATALOG_UNAVAILABLE"],
    ["malformed", "T3_CATALOG_UNAVAILABLE"],
    ["wrong-id", "T3_CATALOG_UNAVAILABLE"],
    ["ticket", "T3_RESPONSE_INVALID"],
    ["shell", "T3_HTTP_FAILED"],
  ])("A14 %s original read failure survives once-only exact cleanup", async (fault, code) => {
    const f = await readFixture();
    f.error(fault!);
    const result = await collectT3AuthenticatedReadFoundation(
      f.preview,
      { authenticated: true },
      f.deps,
    );
    expect(result.failure?.code).toBe(code);
    expect(result.cleanup.status).toBe("verified");
    expect(f.calls.filter((s) => ["issue", "revoke", "list"].includes(s))).toEqual([
      "issue",
      "revoke",
      "list",
    ]);
    expect(f.sockets.every((s) => s.closed && s.listeners === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|127\.0\.0\.1|owned-session/);
  });
});
