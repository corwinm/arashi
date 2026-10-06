// Run with Bun, not Vitest: default Bun HTTP/WebSocket/process/signal boundary.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectT3AuthenticatedReadFoundation,
  collectT3ReadinessPreview,
} from "../../src/lib/t3-readiness.ts";
import {
  nativeChildEnvironment,
  readT3CliVersion,
  readT3Config,
  t3Http,
} from "../../src/lib/t3-native.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const here = fileURLToPath(import.meta.url);
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "fixture-cookie",
};
const descriptor = {
  environmentId: "fixture-environment",
  serverVersion: "0.0.43",
  orchestrationProtocolVersion: 1,
  platform: { os: process.platform, arch: process.arch },
  capabilities: { repositoryIdentity: true, connectionProbe: true },
};
const catalog = { environment: descriptor, auth, providers: [], settings: {} };
const json = (value: unknown) => JSON.stringify(value);
const controls = () => ({
  now: performance.now.bind(performance),
  deadline: performance.now() + 90_000,
});
async function until(predicate: () => boolean | Promise<boolean>, ms = 1000) {
  const start = performance.now();
  while (!(await predicate())) {
    if (performance.now() - start > ms) throw new Error("owned fixture barrier/resource deadline");
    await sleep(10);
  }
}
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const source = `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const root=process.env.FIXTURE_ROOT; const a=process.argv.slice(2); const op=a[0]==='--version'?'version':a[2];
const expected=op==='version'?['--version']:op==='issue'?['auth','session','issue','--base-dir',root,'--ttl','5m','--label','Arashi readiness','--json']:op==='revoke'?['auth','session','revoke','owned-session','--base-dir',root]:['auth','session','list','--base-dir',root,'--json'];
if(JSON.stringify(a)!==JSON.stringify(expected)||process.cwd()!==root||process.env.T3CODE_HOME!==root||process.env.ARASHI_DIRECTIVE_FILE)process.exit(9);
appendFileSync(root+'/ledger.jsonl',JSON.stringify({operation:op,argv:a,cwd:process.cwd(),envKeys:Object.keys(process.env).sort()})+'\\n');
if(op==='version') console.log('t3 v0.0.43');
if(op==='issue'){writeFileSync(root+'/active.json',JSON.stringify({sessionId:'owned-session',token:'PRIVATE_TOKEN'}));console.log(JSON.stringify({sessionId:'owned-session',token:'PRIVATE_TOKEN'}));}
if(op==='revoke')writeFileSync(root+'/active.json','null');
if(op==='list')console.log(readFileSync(root+'/active.json','utf8')==='null'?'[]':JSON.stringify([{sessionId:'owned-session',method:'bearer-access-token',scopes:['orchestration:read'],subject:'PRIVATE_SUBJECT',client:{deviceType:'bot'},connected:false,issuedAt:'2026-10-04T11:00:00Z',expiresAt:'2026-10-04T12:00:00Z',lastConnectedAt:null}]));
`;

if (process.argv[2] === "child") {
  const root = process.env.FIXTURE_ROOT!;
  const listeners = process.listenerCount("SIGINT");
  const preview = await collectT3ReadinessPreview({
    cwd: root,
    context: {
      checkout: root,
      settings: { cli: join(root, "t3"), baseDir: root },
      workspaceRoot: null,
      workspace: null,
      roots: null,
      sources: {},
    },
  });
  assert.equal(preview.readiness, "preview_passed");
  const result = await collectT3AuthenticatedReadFoundation(preview, { authenticated: true });
  console.log(json({ result, released: process.listenerCount("SIGINT") === listeners }));
} else {
  const reports: object[] = [];
  const root = await mkdtemp(join(tmpdir(), "arashi-cancel-bun-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "userdata"));
  await writeFile(join(root, "t3"), source);
  await chmod(join(root, "t3"), 0o700);
  await writeFile(join(root, "active.json"), "null", { mode: 0o600 });
  await writeFile(join(root, "ledger.jsonl"), "", { mode: 0o600 });
  const children = new Set<ReturnType<typeof spawn>>();
  let mode = "success";
  await writeFile(join(root, "peer.jsonl"), "");
  await writeFile(join(root, "mode.json"), json(mode));
  await writeFile(
    join(root, "shape.json"),
    json({
      descriptor,
      catalog,
      session: {
        authenticated: true,
        auth,
        scopes: ["orchestration:read"],
        sessionMethod: "bearer-access-token",
      },
      shell: { snapshotSequence: 0, projects: [], threads: [], updatedAt: "2026-10-04T12:00:00Z" },
    }),
  );
  const server = spawn(
    "node",
    [fileURLToPath(new URL("./t3-cancellation-peer.ts", import.meta.url))],
    {
      cwd: root,
      env: nativeChildEnvironment({ FIXTURE_ROOT: root }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const address = await new Promise<{
    port: number;
    pid: number;
    runtime: string;
    executable: string;
  }>((resolve, reject) => {
    let line = "";
    const timer = setTimeout(() => reject(new Error("peer startup")), 5000);
    server.stdout!.on("data", (raw) => {
      line += String(raw);
      if (line.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(line.split("\n")[0]!));
      }
    });
    server.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("peer exit"));
    });
  });
  const peer = async (action: string) =>
    (await readFile(join(root, "peer.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x))
      .some((e) => e.case === mode && e.action === action);
  const select = async (value: string) => {
    mode = value;
    await writeFile(join(root, "mode.json"), json(mode));
  };
  const origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    join(root, "userdata", "server-runtime.json"),
    json({ version: 1, pid: address.pid, port: address.port, origin }),
  );
  try {
    for (const scenario of ["HTTP-hang", "HTTP-oversize", "HTTP-rejected"]) {
      await select(scenario);
      console.log(json({ entering: scenario }));
      const start = performance.now();
      await assert.rejects(
        t3Http(origin, "PRIVATE_TOKEN", { readiness: controls() })("/api/auth/session"),
      );
      const outcomeMs = performance.now() - start;
      console.log(json({ outcome: scenario, outcomeMs }));
      await until(() => peer("http-close"), Math.max(1000, 15_300 - outcomeMs));
      reports.push({
        case: scenario,
        outcomeMs,
        resourceMs: performance.now() - start,
        bodyClosed: true,
      });
    }
    for (const scenario of [
      "WS-hang",
      "WS-malformed",
      "WS-rpc-failed",
      "WS-wrong-id",
      "WS-oversize",
    ]) {
      await select(scenario);
      console.log(json({ entering: scenario }));
      const start = performance.now();
      await assert.rejects(
        readT3Config(
          origin,
          "PRIVATE_TOKEN",
          t3Http(origin, "PRIVATE_TOKEN", { readiness: controls() }),
          { boundedRead: true, readiness: controls() },
        ),
      );
      await until(() => peer("ws-close"), 1000);
      assert(await peer("ws-entry"));
      reports.push({
        case: scenario,
        outcomeMs: performance.now() - start,
        resourceClosed: true,
        closeAcknowledgedByPeer: false,
      });
    }
    for (const scenario of [
      "success",
      "WS-hang",
      "WS-malformed",
      "WS-rpc-failed",
      "WS-wrong-id",
      "WS-oversize",
      "WS-ping",
      "ticket-invalid",
      "shell-error",
    ]) {
      await select(scenario);
      await writeFile(join(root, "ledger.jsonl"), "");
      await writeFile(join(root, "peer.jsonl"), "");
      const child = spawn(process.execPath, [here, "child"], {
        cwd: root,
        env: nativeChildEnvironment({ FIXTURE_ROOT: root, T3CODE_HOME: root }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (x) => {
        stdout += String(x);
      });
      child.stderr!.on("data", (x) => {
        stderr += String(x);
      });
      const exited = new Promise<number | null>((r) => child.once("exit", r));
      let watchdog: ReturnType<typeof setTimeout>;
      const code = await Promise.race([
        exited,
        new Promise<never>((_r, reject) => {
          watchdog = setTimeout(() => reject(new Error("pipeline child hung")), 20_000);
        }),
      ]).finally(() => clearTimeout(watchdog!));
      children.delete(child);
      assert.equal(code, 0, stderr);
      const observed = JSON.parse(stdout);
      assert.equal(observed.result.use.status, scenario === "success" ? "succeeded" : "failed");
      assert.equal(observed.result.cleanup.status, "verified");
      assert.equal(observed.released, true);
      if (scenario !== "success")
        assert.equal(
          observed.result.failure.code,
          scenario === "ticket-invalid"
            ? "T3_RESPONSE_INVALID"
            : scenario === "shell-error"
              ? "T3_HTTP_FAILED"
              : "T3_CATALOG_UNAVAILABLE",
        );
      const events = (await readFile(join(root, "ledger.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      assert.deepEqual(
        events.map((e) => e.operation),
        ["version", "version", "issue", "revoke", "list"],
      );
      assert.equal(JSON.parse(await readFile(join(root, "active.json"), "utf8")), null);
      if (scenario.startsWith("WS-")) await until(() => peer("ws-close"));
      if (scenario === "WS-ping") assert(await peer("pong"));
      reports.push({
        case: "owned Bun pipeline " + scenario,
        innerExit: code,
        use: observed.result.use.status,
        failureCode: observed.result.failure?.code,
        cleanup: "verified",
        listenersReleased: true,
        events,
      });
    }
    for (const signal of ["SIGINT", "SIGKILL"] as const) {
      await select(signal);
      await writeFile(join(root, "ledger.jsonl"), "");
      const child = spawn(process.execPath, [here, "child"], {
        cwd: root,
        env: nativeChildEnvironment({ FIXTURE_ROOT: root, T3CODE_HOME: root }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (x) => {
        stdout += String(x);
      });
      child.stderr!.on("data", (x) => {
        stderr += String(x);
      });
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await until(() => peer("http-entry"), 5000);
      const start = performance.now();
      child.kill(signal);
      const exit = await Promise.race([
        ended,
        sleep(5000).then(() => {
          throw new Error("signal child hung");
        }),
      ]);
      children.delete(child);
      const active = JSON.parse(await readFile(join(root, "active.json"), "utf8"));
      const events = (await readFile(join(root, "ledger.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x));
      if (signal === "SIGINT") {
        assert.equal(exit.code, 0, stderr);
        const observed = JSON.parse(stdout);
        assert.equal(observed.result.failure.code, "T3_CHECK_CANCELLED");
        assert.equal(observed.result.cleanup.status, "verified");
        assert.equal(observed.released, true);
        assert.equal(active, null);
        assert.deepEqual(
          events.map((e) => e.operation),
          ["version", "version", "issue", "revoke", "list"],
        );
        reports.push({
          case: signal,
          exit,
          elapsedMs: performance.now() - start,
          cleanup: "verified",
          listenersReleased: true,
          events,
        });
      } else {
        assert.equal(exit.signal, "SIGKILL");
        assert(active);
        assert.deepEqual(
          events.map((e) => e.operation),
          ["version", "version", "issue"],
        );
        reports.push({
          case: signal,
          exit,
          elapsedMs: performance.now() - start,
          cleanup: "unknown",
          attributableFixtureSessionRemaining: true,
          ttlIsNotProof: true,
          productionCleanupAttempted: false,
          events,
        });
        const tidy = spawn(
          join(root, "t3"),
          ["auth", "session", "revoke", active.sessionId, "--base-dir", root],
          {
            cwd: root,
            env: nativeChildEnvironment({ FIXTURE_ROOT: root, T3CODE_HOME: root }),
            stdio: "ignore",
          },
        );
        const code = await new Promise<number | null>((r) => tidy.once("exit", r));
        assert.equal(code, 0);
        assert.equal(JSON.parse(await readFile(join(root, "active.json"), "utf8")), null);
        reports.push({
          case: "SIGKILL fixture-owner tidy",
          attribution: "separate fixture owner, not production cleanup",
          exactId: true,
          remaining: 0,
        });
      }
      await until(() => peer("http-close"));
    }
    const hang = join(root, "hang-t3");
    await writeFile(
      hang,
      `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${json(join(root, "hang.pid"))},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`,
    );
    await chmod(hang, 0o700);
    const start = performance.now();
    await assert.rejects(readT3CliVersion(hang, root, { readiness: controls() }));
    const pid = Number(await readFile(join(root, "hang.pid"), "utf8"));
    await until(() => !isAlive(pid));
    reports.push({
      case: "process SIGTERM ignored",
      outcomeMs: performance.now() - start,
      exactChildStopped: !isAlive(pid),
    });
    const evidence = process.env.D1_CANCELLATION_EVIDENCE;
    if (evidence)
      await appendFile(
        join(evidence, "bun-probes.jsonl"),
        reports
          .map((r) => json({ runtime: process.versions.bun, executable: process.execPath, ...r }))
          .join("\n") + "\n",
      );
    console.log(
      json({
        passed: reports.length,
        runtime: process.versions.bun,
        peerRuntime: { version: address.runtime, executable: address.executable },
        cases: reports,
      }),
    );
  } finally {
    for (const child of children) child.kill("SIGKILL");
    const exited = new Promise<void>((r) => server.once("exit", () => r()));
    server.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}
