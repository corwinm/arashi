import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  discoverT3Environment,
  preflightT3Native,
  readT3Config,
  resolveT3Selection,
  t3Http,
  verifyT3Protocol,
  verifyT3Version,
  withT3Session,
  type T3NativeDependencies,
} from "../../src/lib/t3-native.ts";
import { resolveT3Settings, validateT3Settings } from "../../src/lib/t3-settings.ts";
import { nativeConfig, nativeEnvironment } from "../helpers/t3-native.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function runtimeFixture() {
  const baseDir = await realpath(await mkdtemp(join(tmpdir(), "arashi-native-t3-")));
  roots.push(baseDir);
  await mkdir(join(baseDir, "userdata"));
  const runtime = { version: 1, pid: process.pid, port: 3773, origin: "http://127.0.0.1:3773" };
  const path = join(baseDir, "userdata", "server-runtime.json");
  await writeFile(path, JSON.stringify(runtime));
  return { baseDir, runtime, path };
}

describe("official T3 discovery and auth", () => {
  test("bounds the official release and wire protocol explicitly", () => {
    expect(() => verifyT3Version("0.0.43")).not.toThrow();
    for (const version of ["0.1.0", "0.0.42", "0.0.44", "0.0.43-nightly"])
      expect(() => verifyT3Version(version)).toThrow();
    expect(() => verifyT3Protocol({ orchestrationProtocolVersion: 1 })).not.toThrow();
    expect(() => verifyT3Protocol({ orchestrationProtocolVersion: 2 })).toThrow();
  });
  test("uses only selected runtime discovery; rejects malformed, remote, and credential-bearing endpoints", async () => {
    const fixture = await runtimeFixture();
    await expect(discoverT3Environment({ baseDir: fixture.baseDir })).resolves.toMatchObject({
      origin: fixture.runtime.origin,
    });
    for (const origin of [
      "http://remote:3773",
      "http://token@127.0.0.1:3773",
      "http://127.0.0.1:3774",
      "http://127.0.0.1:3773/?secret=token",
    ]) {
      await writeFile(fixture.path, JSON.stringify({ ...fixture.runtime, origin }));
      await expect(discoverT3Environment({ baseDir: fixture.baseDir })).rejects.toMatchObject({
        code: "T3_DISCOVERY_INVALID",
      });
    }
    await writeFile(fixture.path, "{}");
    await expect(discoverT3Environment({ baseDir: fixture.baseDir })).rejects.toMatchObject({
      code: "T3_DISCOVERY_INVALID",
    });
    await rm(fixture.path);
    await expect(discoverT3Environment({ baseDir: fixture.baseDir })).rejects.toMatchObject({
      code: "T3_ENVIRONMENT_MISSING",
    });
  });
  test("preflights official CLI, auth scopes, snapshot, and catalog; always revokes owned sessions", async () => {
    const fixture = await runtimeFixture();
    const commands: readonly string[][] = [];
    const seen: string[][] = commands as string[][];
    const dependencies: T3NativeDependencies = {
      runProcess: async (command) => {
        seen.push([...command]);
        return {
          exitCode: 0,
          stderr: "SECRET",
          stdout: command.includes("--version")
            ? "t3 v0.0.43"
            : command.includes("issue")
              ? JSON.stringify({ token: "SECRET", sessionId: "owned-session" })
              : "revoked",
        };
      },
      getConfig: async () => nativeConfig(),
      fetch: (async (url, init) => {
        const path = new URL(String(url)).pathname;
        expect(init?.redirect).toBe("error");
        if (path.endsWith("environment"))
          return Response.json({
            environmentId: "environment-1",
            serverVersion: "0.0.43",
            orchestrationProtocolVersion: 1,
            platform: { os: process.platform === "win32" ? "windows" : process.platform },
          });
        expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
          "Bearer SECRET",
        );
        if (path.endsWith("session"))
          return Response.json({
            authenticated: true,
            scopes: ["orchestration:read", "orchestration:operate"],
          });
        return Response.json({ projects: [], threads: [] });
      }) as typeof fetch,
    };
    await expect(
      preflightT3Native(".", dependencies, { baseDir: fixture.baseDir }, true),
    ).resolves.toMatchObject({ serverVersion: "0.0.43", config: {} });
    expect(seen).toEqual([["t3", "--version"]]);
    seen.length = 0;
    await expect(
      preflightT3Native(".", dependencies, { baseDir: fixture.baseDir }),
    ).resolves.toMatchObject({ serverVersion: "0.0.43" });
    expect(seen[0]).toEqual(["t3", "--version"]);
    expect(seen.at(-1)).toContain("revoke");
    expect(seen.flat().join(" ")).not.toContain("SECRET");
    const multiple = nativeConfig();
    multiple.providers.push({ ...multiple.providers[0]!, instanceId: "project-provider" });
    dependencies.getConfig = async () => multiple;
    await expect(
      preflightT3Native(".", dependencies, { baseDir: fixture.baseDir, effort: "medium" }),
    ).resolves.toMatchObject({ config: multiple });
    dependencies.getConfig = async () => {
      throw new Error("SECRET");
    };
    await expect(
      preflightT3Native(".", dependencies, { baseDir: fixture.baseDir }),
    ).rejects.toThrow();
    expect(seen.at(-1)).toContain("revoke");
  });
  test("missing official CLI fails before runtime/auth discovery without invoking the bridge", async () => {
    const commands: string[][] = [];
    await expect(
      preflightT3Native(".", {
        runProcess: async (command) => {
          commands.push([...command]);
          return { exitCode: -1, stderr: "SECRET", stdout: "" };
        },
      }),
    ).rejects.toMatchObject({ code: "T3_CLI_NOT_FOUND" });
    expect(commands).toEqual([["t3", "--version"]]);
  });
  test("redacts raw HTTP and process failures and reports session cleanup failures", async () => {
    const request = t3Http("http://127.0.0.1:3773", "SECRET", {
      fetch: (async () => Response.json({ secret: "SECRET" }, { status: 403 })) as typeof fetch,
    });
    await expect(request("/api/orchestration/snapshot")).rejects.toMatchObject({
      code: "T3_AUTH_FAILED",
    });
    try {
      await request("/api/orchestration/snapshot");
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
    }
    await expect(
      withT3Session(
        nativeEnvironment(),
        ".",
        {
          runProcess: async (command) => ({
            exitCode: command.includes("revoke") ? -1 : 0,
            stderr: "SECRET",
            stdout: JSON.stringify({ token: "SECRET", sessionId: "session-1" }),
          }),
        },
        async () => "accepted",
      ),
    ).rejects.toMatchObject({
      code: "T3_AUTH_CLEANUP_FAILED",
      details: { sessionCleanupFailed: true },
    });
  });
  test("uses official ticket and just the catalog RPC, including protocol negotiation", async () => {
    let opened: URL | undefined;
    let sent: unknown;
    class Socket {
      openedCallback?: () => void;
      messageCallback?: (event: { data: string }) => void;
      errorCallback?: () => void;
      closeCallback?: () => void;
      constructor(url: URL) {
        opened = url;
        queueMicrotask(() => this.openedCallback?.());
      }
      addEventListener(name: string, callback: unknown) {
        if (name === "open") this.openedCallback = callback as () => void;
        if (name === "message")
          this.messageCallback = callback as (event: { data: string }) => void;
      }
      send(value: string) {
        sent = JSON.parse(value);
        queueMicrotask(() =>
          this.messageCallback?.({
            data: JSON.stringify({
              _tag: "Exit",
              requestId: "1",
              exit: { _tag: "Success", value: nativeConfig() },
            }),
          }),
        );
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", Socket);
    const request = vi.fn(async () => ({ ticket: "owned-ticket" }));
    await expect(readT3Config("http://127.0.0.1:3773", "SECRET", request)).resolves.toEqual(
      nativeConfig(),
    );
    expect(request).toHaveBeenCalledWith("/api/auth/websocket-ticket", {});
    expect(opened?.searchParams.get("orchestrationProtocol")).toBe("1");
    expect(opened?.toString()).not.toContain("SECRET");
    expect(sent).toEqual({
      _tag: "Request",
      id: "1",
      tag: "server.getConfig",
      payload: {},
      headers: [],
    });
  });
});

describe("catalog selection and preferences", () => {
  test("resolves explicit model/effort without a hardcoded model", () => {
    const config = nativeConfig();
    config.providers[0]!.models[0]!.slug = "gpt-6.1-sol";
    expect(
      resolveT3Selection(config, { provider: "codex", model: "gpt-6.1-sol", effort: "high" }),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(() => resolveT3Selection(config, { effort: "unsupported" })).toThrow();
    expect(() => resolveT3Selection(config, { model: "missing" })).toThrow();
    config.providers[0]!.models[0]!.isDefault = false;
    expect(() => resolveT3Selection(config, {})).toThrow();
  });
  test("honors project selection over server defaults, validates saved options, and rejects ambiguous drivers", () => {
    const config = nativeConfig();
    const project = {
      defaultModelSelection: {
        instanceId: "codex",
        model: "catalog-default",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    };
    expect(resolveT3Selection(config, {}, project).options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
    expect(resolveT3Selection(config, { effort: "low" }, project).options).toEqual([
      { id: "reasoningEffort", value: "low" },
    ]);
    config.providers.push({ ...config.providers[0]!, instanceId: "codex-work" });
    expect(() => resolveT3Selection(config, { provider: "unknown" })).toThrow();
    expect(() => resolveT3Selection(config, {})).toThrow();
    config.providers[0]!.instanceId = "codex-home";
    expect(() => resolveT3Selection(config, { provider: "codex" })).toThrow();
    expect(resolveT3Selection(config, { provider: "codex-work" }).instanceId).toBe("codex-work");
  });
  test("merges explicit > workspace > user per field and rejects invalid applicable preferences", async () => {
    const fixture = await runtimeFixture();
    const user = join(fixture.baseDir, "user.json");
    await writeFile(
      user,
      JSON.stringify({
        defaults: {
          create: { switch: true },
          t3: { provider: "codex", model: "personal", effort: "medium" },
        },
      }),
    );
    expect(await resolveT3Settings({ effort: "high" }, { model: "workspace" }, user)).toEqual({
      provider: "codex",
      model: "workspace",
      effort: "high",
    });
    expect(() => validateT3Settings({ token: "SECRET" }, "defaults.t3")).toThrow(
      "defaults.t3.token",
    );
    expect(() => validateT3Settings({ baseDir: "relative" }, "defaults.t3")).toThrow("absolute");
    expect(() => validateT3Settings({ cli: "./bin/t3" }, "defaults.t3")).toThrow("absolute");
    expect(() => validateT3Settings({ cli: "bin\\t3" }, "defaults.t3")).toThrow("absolute");
    expect(validateT3Settings({ cli: "/installed/bin/t3" }, "defaults.t3")).toEqual({
      cli: "/installed/bin/t3",
    });
    await writeFile(user, "{");
    await expect(resolveT3Settings({}, undefined, user)).rejects.toThrow("invalid JSON");
    await rm(user);
    expect(await resolveT3Settings({}, undefined, user)).toEqual({});
  });
});
