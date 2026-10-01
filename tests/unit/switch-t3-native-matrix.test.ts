import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  discoverT3Environment,
  preflightT3Native,
  resolveT3Selection,
  type T3NativeDependencies,
} from "../../src/lib/t3-native.ts";
import { mergeT3Settings } from "../../src/lib/t3-settings.ts";
import { nativeConfig } from "../helpers/t3-native.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "arashi-392-native-")));
  roots.push(root);
  const baseDir = join(root, "selected t3 日本");
  await mkdir(join(baseDir, "userdata"), { recursive: true });
  const runtime = { version: 1, pid: process.pid, port: 3773, origin: "http://127.0.0.1:3773" };
  const runtimePath = join(baseDir, "userdata/server-runtime.json");
  await writeFile(runtimePath, JSON.stringify(runtime));
  return { root, baseDir, runtime, runtimePath };
}
describe("issue392 A13 inherited selected native environment resolution", () => {
  test.each(["explicit", "authored-default", "environment", "home"])(
    "base directory %s is selected without scanning alternatives",
    async (source) => {
      const f = await fixture();
      vi.stubEnv("HOME", f.root);
      vi.stubEnv("T3CODE_HOME", f.baseDir);
      let settings = {};
      if (source === "explicit")
        settings = mergeT3Settings(
          { baseDir: f.baseDir },
          { baseDir: join(f.root, "absent-other") },
        );
      if (source === "authored-default") settings = mergeT3Settings({}, { baseDir: f.baseDir });
      if (source === "home") {
        delete process.env.T3CODE_HOME;
        await mkdir(join(f.root, ".t3/userdata"), { recursive: true });
        await writeFile(
          join(f.root, ".t3/userdata/server-runtime.json"),
          JSON.stringify(f.runtime),
        );
      }
      const result = await discoverT3Environment(settings);
      expect(result.baseDir).toBe(source === "home" ? join(f.root, ".t3") : f.baseDir);
    },
  );
  test.each(["t3-selected", "/installed official t3/bin/t3"])(
    "official CLI %s receives selected checkout CWD and direct argv",
    async (cli) => {
      const f = await fixture();
      const calls: { command: readonly string[]; cwd: string }[] = [];
      const dependencies: T3NativeDependencies = {
        runProcess: async (command, options) => {
          calls.push({ command: [...command], cwd: options.cwd });
          return { exitCode: 0, stderr: "RAW-CANARY", stdout: "t3 v0.0.43" };
        },
        fetch: (async () =>
          Response.json({
            environmentId: "environment-1",
            serverVersion: "0.0.43",
            orchestrationProtocolVersion: 1,
            platform: { os: process.platform === "win32" ? "windows" : process.platform },
          })) as typeof fetch,
      };
      await preflightT3Native(
        "/selected checkout with spaces",
        dependencies,
        { baseDir: f.baseDir, cli },
        true,
      );
      expect(calls).toEqual([
        { command: [cli, "--version"], cwd: "/selected checkout with spaces" },
      ]);
    },
  );
  test("an unavailable selected profile never falls back to a working environment", async () => {
    const f = await fixture();
    vi.stubEnv("T3CODE_HOME", f.baseDir);
    await expect(
      discoverT3Environment({ baseDir: join(f.root, "missing-selected") }),
    ).rejects.toMatchObject({ code: "T3_ENVIRONMENT_MISSING" });
  });
});
describe("issue392 A14 enumerated inherited catalog boundary", () => {
  const cases = ["instance", "unique-driver", "ambiguous-driver", "unavailable"].flatMap(
    (provider) =>
      ["slug", "alias", "default", "unsupported"].flatMap((model) =>
        ["supported", "unsupported"].flatMap((effort) =>
          ["project", "server", "catalog"].map((source) => ({ provider, model, effort, source })),
        ),
      ),
  );
  test.each(cases)(
    "provider=$provider model=$model effort=$effort source=$source",
    ({ provider, model, effort, source }) => {
      const config = nativeConfig();
      config.providers[0]!.instanceId = "codex-home";
      Object.assign(config.providers[0]!.models[0]!, { aliases: ["default-alias"] });
      if (provider === "ambiguous-driver")
        config.providers.push({ ...config.providers[0]!, instanceId: "codex-work" });
      if (provider === "unavailable") config.providers[0]!.enabled = false;
      const saved = {
        instanceId: "codex-home",
        model: "catalog-default",
        options: [{ id: "reasoningEffort", value: source === "project" ? "high" : "low" }],
      };
      const live =
        source === "server" ? { ...config, settings: { defaultModelSelection: saved } } : config;
      const project = source === "project" ? { defaultModelSelection: saved } : undefined;
      const settings = {
        provider: provider === "instance" ? "codex-home" : "codex",
        ...(model === "default"
          ? {}
          : {
              model:
                model === "slug"
                  ? "catalog-default"
                  : model === "alias"
                    ? "default-alias"
                    : "missing-model",
            }),
        effort: effort === "supported" ? "medium" : "impossible-effort",
      };
      const before = JSON.stringify({ live, project });
      if (["ambiguous-driver", "unavailable"].includes(provider))
        expect(() => resolveT3Selection(live, settings, project)).toThrowError(
          expect.objectContaining({ code: "T3_PROVIDER_AMBIGUOUS" }),
        );
      else if (model === "unsupported")
        expect(() => resolveT3Selection(live, settings, project)).toThrowError(
          expect.objectContaining({ code: "T3_MODEL_UNAVAILABLE" }),
        );
      else if (effort === "unsupported")
        expect(() => resolveT3Selection(live, settings, project)).toThrowError(
          expect.objectContaining({ code: "T3_EFFORT_UNSUPPORTED" }),
        );
      else
        expect(resolveT3Selection(live, settings, project)).toEqual({
          instanceId: "codex-home",
          model: "catalog-default",
          options: [{ id: "reasoningEffort", value: "medium" }],
        });
      expect(JSON.stringify({ live, project })).toBe(before);
    },
  );
  test.each(["project", "server", "catalog"])(
    "omitted effort follows actual %s selection without a guessed model",
    (source) => {
      const config = nativeConfig();
      const saved = {
        instanceId: "codex",
        model: "catalog-default",
        options: [{ id: "reasoningEffort", value: source === "project" ? "high" : "low" }],
      };
      const live =
        source === "server" ? { ...config, settings: { defaultModelSelection: saved } } : config;
      expect(
        resolveT3Selection(
          live,
          {},
          source === "project" ? { defaultModelSelection: saved } : undefined,
        ).options,
      ).toEqual([
        {
          id: "reasoningEffort",
          value: source === "catalog" ? "medium" : source === "project" ? "high" : "low",
        },
      ]);
    },
  );
});
describe("issue392 A15 actual inherited official preflight failure inventory", () => {
  const cases = [
    { kind: "missing-CLI", code: "T3_CLI_NOT_FOUND" },
    { kind: "missing-runtime", code: "T3_ENVIRONMENT_MISSING" },
    { kind: "stale-PID", code: "T3_ENVIRONMENT_STALE" },
    { kind: "remote-URL", code: "T3_DISCOVERY_INVALID" },
    { kind: "auth-failure", code: "T3_AUTH_FAILED" },
    { kind: "missing-scopes", code: "T3_AUTH_FAILED" },
    { kind: "catalog", code: "T3_CATALOG_INVALID" },
    { kind: "snapshot", code: "T3_RESPONSE_INVALID" },
    { kind: "old-CLI", code: "T3_VERSION_UNSUPPORTED" },
    { kind: "old-server", code: "T3_VERSION_UNSUPPORTED" },
    { kind: "prerelease-CLI", code: "T3_VERSION_UNSUPPORTED" },
    { kind: "prerelease-server", code: "T3_VERSION_UNSUPPORTED" },
    { kind: "malformed-CLI", code: "T3_VERSION_UNSUPPORTED" },
    { kind: "malformed-server", code: "T3_VERSION_UNSUPPORTED" },
    { kind: "version-mismatch", code: "T3_VERSION_MISMATCH" },
    { kind: "protocol-change", code: "T3_PROTOCOL_UNSUPPORTED" },
  ];
  test.each(cases)(
    "$kind blocks orchestration mutation and suppresses transport secrets",
    async ({ kind, code }) => {
      const f = await fixture();
      const commands: readonly string[][] = [];
      const urls: string[] = [];
      if (kind === "missing-runtime") await rm(f.runtimePath);
      if (kind === "stale-PID")
        vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("RAW-TOKEN-CANARY"), { code: "ESRCH" });
        });
      if (kind === "remote-URL")
        await writeFile(
          f.runtimePath,
          JSON.stringify({ ...f.runtime, origin: "http://remote.invalid:3773/?SECRET-CANARY" }),
        );
      const version = (side: string) =>
        kind === "old-" + side
          ? "0.0.42"
          : kind === "prerelease-" + side
            ? "0.0.43-nightly"
            : kind === "malformed-" + side
              ? "RAW-TOKEN-CANARY"
              : kind === "version-mismatch" && side === "CLI"
                ? "0.0.44"
                : "0.0.43";
      const deps: T3NativeDependencies = {
        runProcess: async (command) => {
          (commands as string[][]).push([...command]);
          return {
            exitCode:
              kind === "missing-CLI" || (kind === "auth-failure" && command.includes("issue"))
                ? -1
                : 0,
            stderr: "SESSION-OUTPUT-CANARY",
            stdout: command.includes("--version")
              ? "t3 v" + version("CLI")
              : command.includes("issue")
                ? JSON.stringify({ sessionId: "session-1", token: "RAW-TOKEN-CANARY" })
                : "revoked",
          };
        },
        getConfig: async () =>
          kind === "catalog" ? { auth: nativeConfig().auth } : nativeConfig(),
        fetch: (async (url, init) => {
          const path = new URL(String(url)).pathname;
          urls.push(path);
          expect(init?.redirect).toBe("error");
          if (path.endsWith("environment"))
            return Response.json({
              environmentId: "environment-1",
              serverVersion: version("server"),
              orchestrationProtocolVersion: kind === "protocol-change" ? 2 : 1,
              platform: { os: process.platform === "win32" ? "windows" : process.platform },
            });
          if (path.endsWith("session"))
            return Response.json({
              authenticated: true,
              scopes:
                kind === "missing-scopes"
                  ? ["orchestration:read"]
                  : ["orchestration:read", "orchestration:operate"],
            });
          if (path.endsWith("snapshot"))
            return Response.json(
              kind === "snapshot" ? { projects: null, threads: [] } : { projects: [], threads: [] },
            );
          throw new Error("Unexpected mutation endpoint");
        }) as typeof fetch,
      };
      const error = await preflightT3Native("/selected-checkout", deps, {
        baseDir: f.baseDir,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toMatch(
        /RAW-TOKEN-CANARY|SESSION-OUTPUT-CANARY|SECRET-CANARY|remote\.invalid/,
      );
      expect(urls).not.toContain("/api/orchestration/dispatch");
      expect(commands.some((command) => command.includes("issue"))).toBe(
        ["auth-failure", "missing-scopes", "catalog", "snapshot"].includes(kind),
      );
    },
  );
});
