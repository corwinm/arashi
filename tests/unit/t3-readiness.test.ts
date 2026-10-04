import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { readT3Config, t3Http } from "../../src/lib/t3-native.ts";
import { createReadinessFixture } from "../helpers/t3-readiness-fixture.ts";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { runLifecycleHook } from "../../src/lib/hooks.ts";

const fixtures: Awaited<ReturnType<typeof createReadinessFixture>>[] = [];
async function fixture() {
  const value = await createReadinessFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()));
});

describe("D1 effect-ledger fixture foundation (not readiness acceptance)", () => {
  test("registers approved public descriptor and authenticated shell routes without admitting task snapshots", async () => {
    const f = await fixture();
    f.allowHttp("GET", "/.well-known/t3/environment");
    f.allowHttp("GET", "/api/orchestration/shell");
    expect(
      await t3Http(f.origin, undefined, f.dependencies)("/.well-known/t3/environment"),
    ).toMatchObject({ environmentId: "environment-1", orchestrationProtocolVersion: 1 });
    const token = await f.issueOwnedSession();
    expect(await t3Http(f.origin, token, f.dependencies)("/api/orchestration/shell")).toEqual({
      projects: [],
      snapshotSequence: 0,
      threads: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(() => f.allowHttp("GET", "/api/orchestration/snapshot")).toThrow("unknown route");
    expect((await fetch(`${f.origin}/api/orchestration/snapshot`)).status).toBe(403);
    await f.revokeOwnedSession();
    expect((await f.effects()).filter((e) => e.kind === "http").map((e) => e.path)).toEqual([
      "/.well-known/t3/environment",
      "/api/orchestration/shell",
    ]);
  });
  test("denies unlisted HTTP paths and methods, even through the real server", async () => {
    const f = await fixture();
    f.allowHttp("GET", "/.well-known/t3/environment");
    expect(
      (await f.dependencies.fetch!(`${f.origin}/.well-known/t3/environment`, { redirect: "error" }))
        .status,
    ).toBe(200);
    await expect(
      f.dependencies.fetch!(`${f.origin}/forbidden`, { redirect: "error" }),
    ).rejects.toThrow("denied");
    await expect(
      f.dependencies.fetch!(`${f.origin}/.well-known/t3/environment`, {
        method: "POST",
        redirect: "error",
      }),
    ).rejects.toThrow("denied");
    expect((await fetch(`${f.origin}/forbidden`)).status).toBe(403);
    expect((await fetch(`${f.origin}/.well-known/t3/environment`, { method: "POST" })).status).toBe(
      403,
    );
    expect((await f.effects()).filter((e) => e.kind === "denied")).toHaveLength(4);
  });

  test("requires strict redirect policy and never follows a redirect", async () => {
    const f = await fixture();
    f.allowHttp("GET", "/redirect");
    await expect(f.dependencies.fetch!(`${f.origin}/redirect`)).rejects.toThrow("denied");
    await expect(
      f.dependencies.fetch!(`${f.origin}/redirect`, { redirect: "error" }),
    ).rejects.toThrow();
    expect((await f.effects()).filter((e) => e.kind === "http").map((e) => e.path)).toEqual([
      "/redirect",
    ]);
  });

  test("denies unlisted WebSocket tags at the actual transport boundary", async () => {
    const f = await fixture();
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    f.allowWs("server.getConfig");
    const token = await f.issueOwnedSession();
    const ticket = await t3Http(f.origin, token, f.dependencies)("/api/auth/websocket-ticket", {});
    await f.sendWs(String(ticket.ticket), {
      _tag: "Request",
      headers: [],
      id: "1",
      payload: {},
      tag: "thread.turn.start",
    });
    const effects = await f.effects();
    expect(effects.some((e) => e.kind === "denied" && e.boundary === "ws")).toBe(true);
    expect(effects.filter((e) => e.kind === "ws")).toEqual([]);
  });

  test("runs real HTTP, catalog WebSocket and fake executable with owned session cleanup", async () => {
    const f = await fixture();
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    f.allowWs("server.getConfig");
    const token = await f.issueOwnedSession();
    const config = await readT3Config(f.origin, token, t3Http(f.origin, token, f.dependencies));
    expect(config.providers).toBeInstanceOf(Array);
    await f.waitForSocketsClosed();
    await f.revokeOwnedSession();
    const events = await f.effects();
    expect(events.filter((e) => e.kind === "socket").map((e) => e.action)).toEqual([
      "open",
      "close",
    ]);
    expect(events.filter((e) => e.kind === "session").map((e) => e.action)).toEqual([
      "issue",
      "revoke",
    ]);
    expect(events.filter((e) => e.kind === "process")).toHaveLength(2);
    expect(await f.activeSessions()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  test("denies unauthorized issuance, unknown processes, CWD/env drift and unknown runtime reads", async () => {
    const f = await fixture();
    await expect(
      f.dependencies.runProcess!(f.issueArgv, { cwd: f.repo, env: f.env }),
    ).rejects.toThrow("denied");
    // Bypassing the injected runner must not bypass issuance policy.
    await expect(
      promisify(execFile)(f.cli, f.issueArgv.slice(1), { cwd: f.repo, env: f.env, timeout: 2000 }),
    ).rejects.toThrow();
    expect(await f.activeSessions()).toEqual([]);
    await expect(
      f.dependencies.runProcess!(["unlisted"], { cwd: f.repo, env: f.env }),
    ).rejects.toThrow("denied");
    f.allowProcess(f.versionArgv);
    expect(
      (
        await promisify(execFile)(f.cli, ["--version"], { cwd: f.repo, env: f.env, timeout: 2000 })
      ).stdout.trim(),
    ).toBe("t3 v0.0.43");
    expect((await f.effects()).filter((e) => e.kind === "process")).toHaveLength(1);
    await expect(
      f.dependencies.runProcess!(f.versionArgv, { cwd: f.root, env: f.env }),
    ).rejects.toThrow("denied");
    await expect(
      f.dependencies.runProcess!(f.versionArgv, {
        cwd: f.repo,
        env: { ...f.env, EXTRA: "private" },
      }),
    ).rejects.toThrow("denied");
    expect(
      (await f.dependencies.runProcess!(f.versionArgv, { cwd: f.repo, env: f.env })).stdout.trim(),
    ).toBe("t3 v0.0.43");
    await expect(f.dependencies.readRuntime!(join(f.root, "unknown"))).rejects.toThrow("denied");
    f.allowRead(f.runtimePath);
    expect(JSON.parse(await f.dependencies.readRuntime!(f.runtimePath)).origin).toBe(f.origin);
    const processEvent = (await f.effects()).find((e) => e.kind === "process")!;
    expect(processEvent.argv).toEqual(f.versionArgv);
    expect(processEvent.cwd).toBe(f.repo);
    expect(processEvent.envKeys).toEqual(Object.keys(f.env).toSorted());
  });

  test("captures immutable bytes, modes, refs and worktree registrations without status", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    expect(await f.snapshot()).toEqual(before);
    await writeFile(join(f.repo, "README.md"), "changed\n");
    await chmod(join(f.repo, "README.md"), 0o600);
    expect(await f.snapshot()).not.toEqual(before);
    expect(before.files.find((entry) => entry.path.endsWith("README.md"))?.bytes.toString()).toBe(
      "fixture\n",
    );
    expect(before.worktrees).toContain(f.repo);
    expect(before.refs).toContain("refs/heads/main");
  });

  test.each(["clean", "process", "fetch", "hook"] as const)(
    "calibrates the real %s marker separately and preserves receipt/empty-lock/orphan-temp",
    async (kind) => {
      const f = await fixture();
      // Git status can refresh other index paths even with a pathspec. Apply
      // Only the calibrated filter in this independent copy; default fixtures
      // Retain both markers for future no-status assertions.
      await f.installMarkers(kind === "clean" || kind === "process" ? kind : undefined);
      const before = await f.snapshotReceipts();
      for (const marker of Object.values(f.markers)) {
        await expect(access(marker)).rejects.toThrow();
      }
      if (kind === "hook") {
        expect((await runLifecycleHook("pre-create", f.repo, {}))?.success).toBe(true);
      } else {
        await f.calibrate(kind);
      }
      // Git may re-run a clean filter while comparing stat/index content.
      // Calibration requires positive execution, not an invented call count.
      const markerEffects = (await readFile(f.markers[kind], "utf8")).trim().split("\n");
      expect(markerEffects.length).toBeGreaterThan(0);
      expect(markerEffects.every((effect) => effect === kind)).toBe(true);
      for (const [name, path] of Object.entries(f.markers)) {
        if (name !== kind) {
          await expect(access(path)).rejects.toThrow();
        }
      }
      expect(await f.snapshotReceipts()).toEqual(before);
      expect(before.files.map((entry) => entry.path.split("/").at(-1)).toSorted()).toEqual([
        "fixture.json",
        "fixture.json.lock",
        "fixture.json.orphan.tmp",
      ]);
      expect(before.files.find((entry) => entry.path.endsWith(".lock"))?.bytes.length).toBe(0);
    },
  );

  test("denies unknown route/read registration and unauthorized tickets/bodies", async () => {
    const f = await fixture();
    expect(() => f.allowHttp("POST", "/api/orchestration/dispatch")).toThrow("unknown route");
    expect(() => f.allowRead(join(f.home, "private.json"))).toThrow("unknown read");
    f.allowHttp("POST", "/api/auth/websocket-ticket");
    expect(
      (await fetch(`${f.origin}/api/auth/websocket-ticket`, { body: "{}", method: "POST" })).status,
    ).toBe(403);
    const token = await f.issueOwnedSession();
    expect(
      (
        await f.dependencies.fetch!(`${f.origin}/api/auth/websocket-ticket`, {
          body: '{"task":"private"}',
          headers: { authorization: `Bearer ${token}` },
          method: "POST",
          redirect: "error",
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${f.origin}/ws?orchestrationProtocol=1&wsTicket=unowned`)).status).toBe(
      403,
    );
    const evidence = JSON.stringify(await f.effects());
    expect(evidence).not.toContain(token);
    expect(evidence).not.toContain("private");
    expect((await f.effects()).filter((e) => e.kind === "denied").map((e) => e.boundary)).toEqual([
      "auth",
      "body",
      "socket",
    ]);
  });

  test("disposes only owned directories and closes the server idempotently", async () => {
    const f = await fixture();
    await f.dispose();
    await f.dispose();
    await expect(access(f.root)).rejects.toThrow();
    await expect(fetch(f.origin)).rejects.toThrow();
  });
});
