import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";

import type { T3NativeDependencies } from "../../src/lib/t3-native.ts";
import { join } from "node:path";
import { nativeConfig } from "./t3-native.ts";
import { tmpdir } from "node:os";

const quote = (value: string) => `'${value.replaceAll("'", String.raw`'\''`)}'`;
type ChildProcess = ReturnType<typeof spawn>;

/** Private, test-only audit surface. Never contains tokens, bodies or env values. */
export interface ReadinessEffect {
  kind: "process" | "http" | "ws" | "socket" | "session" | "read" | "denied";
  boundary?: string;
  argv?: string[];
  cwd?: string;
  envKeys?: string[];
  path?: string;
  method?: string;
  body?: "absent" | "empty-object";
  tag?: string;
  action?: string;
  sessionId?: string;
}
export interface ReadinessSnapshot {
  files: { path: string; mode: number; type: string; bytes: Buffer }[];
  refs: string;
  worktrees: string;
}

const run = (argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      { cwd, env, maxBuffer: 1024 * 1024, timeout: 10_000 },
      (error, stdout, stderr) => resolve({ exitCode: error ? 1 : 0, stderr, stdout }),
    );
  });

// Real Bun HTTP+WebSocket server in an owned child; no installed T3 server/profile.
// Policy and token state live in mode-0600 owned files, not command arguments.
const serverSource = `
import { readFileSync, appendFileSync } from 'node:fs';
const root = process.env.FIXTURE_CONTROL;
const load = name => JSON.parse(readFileSync(root + '/' + name, 'utf8'));
const log = event => appendFileSync(root + '/effects.jsonl', JSON.stringify(event) + '\\n');
const denied = boundary => { log({kind:'denied',boundary}); return new Response('denied',{status:403}); };
const sessions = () => load('sessions.json');
const authorized = request => sessions().some(s => request.headers.get('authorization') === 'Bearer ' + s.token);
const server = Bun.serve({hostname:'127.0.0.1',port:0,
  async fetch(request, server) {
    const url = new URL(request.url);
    const policy = load('policy.json');
    if (url.pathname === '/ws') {
      const ticket = url.searchParams.get('wsTicket');
      if (request.method !== 'GET' || url.searchParams.get('orchestrationProtocol') !== '1' || [...url.searchParams.keys()].some(k => !['wsTicket','orchestrationProtocol'].includes(k)) || !sessions().some(s => ticket === s.ticket) || !policy.ws.length) return denied('socket');
      if (server.upgrade(request)) return;
      return denied('socket');
    }
    if (url.search || !policy.http.includes(request.method + ' ' + url.pathname)) return denied('http');
    const body = await request.text();
    if (request.method === 'POST' && body !== '{}') return denied('body');
    if (request.method === 'GET' && body) return denied('body');
    if (!['/api/server/environment','/redirect'].includes(url.pathname) && !authorized(request)) return denied('auth');
    if (url.pathname === '/api/server/environment' && request.headers.has('authorization')) return denied('public-auth');
    log({kind:'http',method:request.method,path:url.pathname,body:body ? 'empty-object' : 'absent'});
    if (url.pathname === '/redirect') return new Response(null,{status:302,headers:{location:'/forbidden'}});
    if (url.pathname === '/api/server/environment') return Response.json({environmentId:'environment-1',serverVersion:'0.0.43',orchestrationProtocolVersion:1,platform:{os:process.platform}});
    if (url.pathname === '/api/auth/websocket-ticket') return Response.json({ticket:sessions().find(s => request.headers.get('authorization') === 'Bearer ' + s.token).ticket});
    if (url.pathname === '/api/auth/session') return Response.json({authenticated:true,scopes:['orchestration:read','orchestration:operate']});
    if (url.pathname === '/api/orchestration/snapshot') return Response.json({projects:[],threads:[]});
    return denied('route');
  },
  websocket:{
    open(ws) {log({kind:'socket',action:'open'});},
    close(ws) {log({kind:'socket',action:'close'});},
    message(ws, raw) {
      try {
        const message = JSON.parse(String(raw));
        const policy = load('policy.json');
        if (message._tag === 'Pong' && policy.ws.includes('Pong') && Object.keys(message).length === 1) {log({kind:'ws',tag:'Pong'});return;}
        if (message._tag !== 'Request' || !policy.ws.includes(message.tag) || message.tag !== 'server.getConfig' || typeof message.id !== 'string' || JSON.stringify(message.payload) !== '{}' || JSON.stringify(message.headers) !== '[]' || Object.keys(message).toSorted().join(',') !== '_tag,headers,id,payload,tag') {
          log({kind:'denied',boundary:'ws'}); ws.close(1008,'denied'); return;
        }
        log({kind:'ws',tag:message.tag});
        ws.send(JSON.stringify({_tag:'Exit',requestId:message.id,exit:{_tag:'Success',value:load('catalog.json')}}));
      } catch {log({kind:'denied',boundary:'ws'});ws.close(1008,'denied');}
    }
  }
});
console.log(JSON.stringify({port:server.port,pid:process.pid}));
`;

const cliSource = `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const root = process.env.FIXTURE_CONTROL;
const argv = process.argv.slice(2);
const load = name => JSON.parse(readFileSync(root + '/' + name,'utf8'));
const policy = load('policy.json');
const log = event => appendFileSync(root + '/effects.jsonl',JSON.stringify(event)+'\\n');
if (!policy.process.some(p => JSON.stringify(p.argv.slice(1)) === JSON.stringify(argv) && p.cwd === process.cwd() && JSON.stringify(p.envKeys) === JSON.stringify(Object.keys(process.env).toSorted()))) {log({kind:'denied',boundary:'executable'});process.exit(1);}
log({kind:'process',argv:[process.argv[1],...argv],cwd:process.cwd(),envKeys:Object.keys(process.env).toSorted()});
const save = sessions => writeFileSync(root + '/sessions.json',JSON.stringify(sessions),{mode:0o600});
if (argv[0] === '--version') console.log('t3 v0.0.43');
else if (argv[2] === 'issue') {
  const sessions=load('sessions.json');
  if (sessions.length) process.exit(1);
  const session={sessionId:'fixture-session-1',token:crypto.randomUUID(),ticket:crypto.randomUUID()};
  save([session]);log({kind:'session',action:'issue',sessionId:session.sessionId});console.log(JSON.stringify(session));
} else if (argv[2] === 'revoke' && argv[3] === 'fixture-session-1') {
  save([]);log({kind:'session',action:'revoke',sessionId:argv[3]});console.log('{}');
} else if (argv[2] === 'list') console.log(JSON.stringify(load('sessions.json').map(s=>({sessionId:s.sessionId}))));
else {log({kind:'denied',boundary:'executable-route'});process.exit(1);}
`;

/** Snapshot without git status/filter execution. Buffers are private, copied per call. */
async function fileSnapshot(roots: string[]): Promise<ReadinessSnapshot["files"]> {
  const files: ReadinessSnapshot["files"] = [];
  async function visit(path: string) {
    const stat = await lstat(path);
    let type = "file";
    let bytes: Buffer = Buffer.alloc(0);
    if (stat.isSymbolicLink()) {
      type = "link";
      bytes = Buffer.from(await readlink(path));
    } else if (stat.isDirectory()) {
      type = "directory";
    } else {
      bytes = await readFile(path);
    }
    files.push({
      bytes,
      mode: stat.mode & 0o7777,
      path,
      type,
    });
    if (type === "directory") {
      for (const entry of (await readdir(path)).toSorted()) {
        await visit(join(path, entry));
      }
    }
  }
  for (const root of roots) {
    await visit(root);
  }
  return files;
}

export async function createReadinessFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "arashi-readiness-fixture-")));
  await chmod(root, 0o700);
  const repo = join(root, "checkout with spaces");
  const home = join(root, "home");
  const baseDir = join(root, "profile");
  const control = join(root, "private-control");
  const bin = join(root, "bin");
  for (const path of [repo, home, baseDir, control, bin, join(baseDir, "userdata")]) {
    await mkdir(path, { mode: 0o700, recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    FIXTURE_CONTROL: control,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    HOME: home,
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    TMPDIR: tmpdir(),
  };
  const git = async (args: string[]) => {
    const result = await run(["git", ...args], repo, env);
    if (result.exitCode) {
      throw new Error(`fixture git failed: ${args[0]}`);
    }
    return result.stdout;
  };
  let server: ChildProcess | undefined;
  let disposed = false;
  const sockets = new Set<WebSocket>();
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const socket of sockets) {
      socket.close();
    }
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((resolve) => {
        server!.once("exit", () => resolve());
      });
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { force: true, recursive: true });
  };
  try {
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(repo, "README.md"), "fixture\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "fixture"]);
    const receiptRoot = join(repo, ".git", ".arashi-t3-handoffs");
    await mkdir(receiptRoot, { mode: 0o700 });
    await writeFile(join(receiptRoot, "fixture.json"), '{"unrelated":true}\n', { mode: 0o600 });
    await writeFile(join(receiptRoot, "fixture.json.lock"), "", { mode: 0o600 });
    await writeFile(join(receiptRoot, "fixture.json.orphan.tmp"), "orphan\n", { mode: 0o600 });
    const policy: {
      http: string[];
      ws: string[];
      process: { argv: string[]; cwd: string; envKeys: string[] }[];
      reads: string[];
    } = { http: [], process: [], reads: [], ws: [] };
    // Synchronous publication makes allow* setters deterministic before next effect.
    const { writeFileSync, appendFileSync } = await import("node:fs");
    const savePolicy = () =>
      writeFileSync(join(control, "policy.json"), JSON.stringify(policy), { mode: 0o600 });
    const record = (event: ReadinessEffect) =>
      appendFileSync(join(control, "effects.jsonl"), `${JSON.stringify(event)}\n`);
    const deny = (boundary: string): never => {
      record({ boundary, kind: "denied" });
      throw new Error(`fixture effect denied: ${boundary}`);
    };
    savePolicy();
    await writeFile(join(control, "sessions.json"), "[]", { mode: 0o600 });
    await writeFile(join(control, "effects.jsonl"), "", { mode: 0o600 });
    await writeFile(join(control, "catalog.json"), JSON.stringify(nativeConfig()), { mode: 0o600 });
    await writeFile(join(control, "server.ts"), serverSource, { mode: 0o600 });
    const bun = (await run(["which", "bun"], repo, env)).stdout.trim();
    if (!bun) {
      throw new Error("Bun fixture runtime required");
    }
    const cli = join(bin, "t3");
    await writeFile(cli, `#!${bun}\n${cliSource}`, { mode: 0o700 });
    server = spawn(bun, [join(control, "server.ts")], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const address = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture server startup timed out")), 5000);
      let output = "";
      server!.stdout!.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("\n")) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(output.split("\n")[0]!));
          } catch {
            reject(new Error("fixture server invalid startup"));
          }
        }
      });
      server!.once("error", () => {
        clearTimeout(timer);
        reject(new Error("fixture server spawn failed"));
      });
      server!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("fixture server exited"));
      });
    });
    const origin = `http://127.0.0.1:${address.port}`;
    const runtimePath = join(baseDir, "userdata", "server-runtime.json");
    await writeFile(runtimePath, JSON.stringify({ version: 1, ...address, origin }), {
      mode: 0o600,
    });
    const versionArgv = [cli, "--version"];
    const issueArgv = [
      cli,
      "auth",
      "session",
      "issue",
      "--base-dir",
      baseDir,
      "--ttl",
      "5m",
      "--label",
      "Arashi handoff",
      "--json",
    ];
    const revokeArgv = [
      cli,
      "auth",
      "session",
      "revoke",
      "fixture-session-1",
      "--base-dir",
      baseDir,
    ];
    const allowProcess = (argv: readonly string[], cwd = repo, processEnv = env) => {
      policy.process.push({ argv: [...argv], cwd, envKeys: Object.keys(processEnv).toSorted() });
      savePolicy();
    };
    const dependencies: Required<
      Pick<T3NativeDependencies, "runProcess" | "readRuntime" | "fetch">
    > = {
      fetch: (async (input, init) => {
        if (input instanceof Request) {
          return deny("request-object");
        }
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (
          url.origin !== origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          init?.redirect !== "error" ||
          !policy.http.includes(`${method} ${url.pathname}`)
        ) {
          return deny("fetch");
        }
        return fetch(input, init);
      }) as typeof fetch,
      readRuntime: async (path) => {
        if (!policy.reads.includes(path)) {
          return deny("read");
        }
        record({ kind: "read", path });
        return readFile(path, "utf8");
      },
      runProcess: async (argv, options) => {
        const envKeys = Object.keys(options.env).toSorted();
        if (
          !policy.process.some(
            (p) =>
              JSON.stringify(p.argv) === JSON.stringify(argv) &&
              p.cwd === options.cwd &&
              JSON.stringify(p.envKeys) === JSON.stringify(envKeys),
          )
        ) {
          return deny("process");
        }
        if (options.env.FIXTURE_CONTROL !== control || options.env.HOME !== home) {
          return deny("process-owner");
        }
        // The executable records its own invocation so CLI-boundary tests using
        // Real subprocesses cannot bypass auditing; avoid double accounting.
        if (argv[0] !== cli) {
          record({ argv: [...argv], cwd: options.cwd, envKeys, kind: "process" });
        }
        return run(argv, options.cwd, options.env);
      },
    };
    const effects = async (): Promise<ReadinessEffect[]> =>
      (await readFile(join(control, "effects.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const waitForSocketsClosed = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const events = await effects();
        if (
          events.filter((e) => e.kind === "socket" && e.action === "open").length ===
          events.filter((e) => e.kind === "socket" && e.action === "close").length
        ) {
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      throw new Error("fixture sockets did not close");
    };
    const markers = Object.fromEntries(
      ["clean", "process", "fetch", "hook"].map((kind) => [kind, join(root, `${kind}.marker`)]),
    ) as Record<"clean" | "process" | "fetch" | "hook", string>;

    const installMarkers = async (statusFilter?: "clean" | "process") => {
      await writeFile(join(repo, "clean.txt"), "clean input\n");
      await writeFile(join(repo, "process.txt"), "process input\n");
      await writeFile(
        join(repo, ".gitattributes"),
        ["clean", "process"]
          .filter((kind) => !statusFilter || kind === statusFilter)
          .map((kind) => `${kind}.txt filter=marker-${kind}\n`)
          .join(""),
      );
      // Status only executes filters for tracked, dirty inputs.
      await git(["add", ".gitattributes", "clean.txt", "process.txt"]);
      await git([
        "config",
        "filter.marker-clean.clean",
        `printf 'clean\\n' >> ${quote(markers.clean)}; cat`,
      ]);
      const filter = join(bin, "process-filter.py");
      await writeFile(
        filter,
        `import sys\ndef packet():\n h=sys.stdin.buffer.read(4)\n if not h: sys.exit(0)\n n=int(h,16)\n return sys.stdin.buffer.read(n-4) if n else None\ndef emit(s):\n b=s.encode();sys.stdout.buffer.write(('%04x'%(len(b)+4)).encode()+b)\ndef flush():\n sys.stdout.buffer.write(b'0000');sys.stdout.buffer.flush()\ndef group():\n result=[]\n while True:\n  p=packet()\n  if p is None: return result\n  result.append(p)\ngroup();emit('git-filter-server\\n');emit('version=2\\n');flush()\ngroup();emit('capability=clean\\n');flush()\nwhile True:\n headers=group();data=b''.join(group())\n with open(${JSON.stringify(markers.process)},'a') as f: f.write('process\\n')\n emit('status=success\\n');flush()\n sys.stdout.buffer.write(('%04x'%(len(data)+4)).encode()+data);flush();flush()\n`,
        { mode: 0o600 },
      );
      await git(["config", "filter.marker-process.process", `python3 ${quote(filter)}`]);
      await git(["config", "filter.marker-process.required", "true"]);
      await writeFile(
        join(bin, "git-remote-marker"),
        `#!/bin/sh\nprintf 'fetch\\n' >> ${quote(markers.fetch)}\nexit 1\n`,
        { mode: 0o700 },
      );
      await git(["remote", "add", "calibration", "marker::owned-fixture"]);
      const hookDir = join(repo, ".arashi", "hooks");
      await mkdir(hookDir, { recursive: true });
      await writeFile(
        join(hookDir, "pre-create.sh"),
        `#!/bin/sh\nprintf 'hook\\n' >> ${quote(markers.hook)}\n`,
        { mode: 0o700 },
      );
      // Same-size dirty inputs force status to compare filtered content, rather
      // Than short-circuit on a size mismatch without invoking the filters.
      await writeFile(join(repo, "clean.txt"), "CLEAN input\n");
      await writeFile(join(repo, "process.txt"), "PROCESS input\n");
    };
    return {
      async activeSessions(): Promise<string[]> {
        return JSON.parse(await readFile(join(control, "sessions.json"), "utf8")).map(
          (s: { sessionId: string }) => s.sessionId,
        );
      },
      allowHttp(method: "GET" | "POST", path: string) {
        const known = [
          "GET /api/server/environment",
          "POST /api/auth/websocket-ticket",
          "GET /api/auth/session",
          "GET /api/orchestration/snapshot",
          "GET /redirect",
        ];
        if (!known.includes(`${method} ${path}`)) {
          throw new Error("fixture unknown route");
        }
        policy.http.push(`${method} ${path}`);
        savePolicy();
      },
      allowProcess,
      allowRead(path: string) {
        if (path !== runtimePath) {
          throw new Error("fixture unknown read");
        }
        policy.reads.push(path);
        savePolicy();
      },
      allowWs(tag: "server.getConfig" | "Pong") {
        policy.ws.push(tag);
        savePolicy();
      },
      baseDir,
      async calibrate(kind: "clean" | "process" | "fetch") {
        if (kind === "fetch") {
          const result = await run(["git", "fetch", "calibration"], repo, {
            ...env,
            PATH: `${bin}:${env.PATH}`,
          });
          if (result.exitCode === 0) {
            throw new Error("fixture fetch unexpectedly succeeded");
          }
        } else {
          await git(["status", "--porcelain=v1", "--", `${kind}.txt`]);
        }
      },
      cli,
      dependencies,
      dispose,
      effects,
      env,
      home,
      installMarkers,
      issueArgv,
      async issueOwnedSession() {
        allowProcess(issueArgv);
        const result = await dependencies.runProcess(issueArgv, { cwd: repo, env });
        if (result.exitCode) {
          throw new Error("fixture issue failed");
        }
        return JSON.parse(result.stdout).token as string;
      },
      markers,
      origin,
      repo,
      async revokeOwnedSession() {
        allowProcess(revokeArgv);
        if ((await dependencies.runProcess(revokeArgv, { cwd: repo, env })).exitCode) {
          throw new Error("fixture revoke failed");
        }
      },
      root,
      runtimePath,
      async sendWs(ticket: string, message: unknown) {
        const url = new URL("/ws", origin);
        url.protocol = "ws:";
        url.searchParams.set("wsTicket", ticket);
        url.searchParams.set("orchestrationProtocol", "1");
        const socket = new WebSocket(url);
        sockets.add(socket);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("fixture socket timed out"));
          }, 2000);
          socket.addEventListener("open", () => socket.send(JSON.stringify(message)));
          socket.addEventListener("close", () => {
            clearTimeout(timer);
            sockets.delete(socket);
            resolve();
          });
          socket.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error("fixture socket failed"));
          });
        });
        await waitForSocketsClosed();
      },
      async snapshot(): Promise<ReadinessSnapshot> {
        return {
          files: await fileSnapshot([repo, home, baseDir, bin]),
          refs: await git(["show-ref"]),
          worktrees: await git(["worktree", "list", "--porcelain"]),
        };
      },
      async snapshotReceipts(): Promise<ReadinessSnapshot> {
        return {
          files: (await fileSnapshot([receiptRoot])).filter((entry) => entry.type === "file"),
          refs: await git(["show-ref"]),
          worktrees: await git(["worktree", "list", "--porcelain"]),
        };
      },
      versionArgv,
      waitForSocketsClosed,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
