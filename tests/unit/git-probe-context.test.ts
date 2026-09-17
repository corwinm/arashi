import { describe, expect, test } from "vitest";
import {
  GitProbeContext,
  parseIdentity,
  parseEffectiveConfig,
  parseRefSnapshot,
  normalizeSpawnRecord,
  RetrySafeCache,
} from "../../src/lib/git-probe-context.ts";
import { ProbeLedger, deferred, result } from "../helpers/git-probe-ledger.ts";

const identityArgs = ["rev-parse", "--show-toplevel", "--git-common-dir", "--is-bare-repository"];
const configArgs = ["config", "--null", "--list", "--show-origin", "--show-scope"];
const statusArgs = ["status", "--porcelain=v2", "--branch", "-z"];
const refArgs = [
  "for-each-ref",
  "--format=%(refname)%00%(objectname)%00%(symref)%00%(ahead-behind:HEAD)%00",
  "refs/heads",
  "refs/remotes",
];
const metadataArgs = [
  "for-each-ref",
  "--format=%(refname)%00%(objectname)%00%(symref)%00",
  "refs/heads",
  "refs/remotes",
];
const oid = "a".repeat(40);
const config = "local\0file:/repo/common/config\0remote.origin.url\n/remote\0";
const porcelain = `# branch.oid ${oid}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +8 -9\0? tab\tnewline\n雪\0`;
const ref = (ahead = 0, behind = 0) => `refs/remotes/origin/main\0${oid}\0\0${behind} ${ahead}\0\n`;
const make = (ledger = new ProbeLedger()) =>
  new GitProbeContext({
    run: ledger.run,
    realpath: async (p: string) => p,
    executable: "/tools/git",
    environment: { PATH: "/tools" },
    platform: "linux",
  });
const discover = (ledger: ProbeLedger) =>
  ledger.enqueue(identityArgs, result("/repo\n/repo/common\nfalse\n"));
const fetchArgs = (branch = "main") => [
  "fetch",
  "--no-tags",
  "--prune",
  "origin",
  `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
];
const target = (branch = "main") => ({ remote: "origin", branch, upstream: `origin/${branch}` });

describe("section 1: exact plumbing contracts", () => {
  test("classifiers use a stable locale without changing config or native output locale", async () => {
    const ledger = discover(new ProbeLedger()).enqueue(configArgs, result(config));
    const ctx = new GitProbeContext({
      run: ledger.run,
      realpath: async (path: string) => path,
      executable: "/tools/git",
      environment: { PATH: "/tools", LC_ALL: "fr_FR.UTF-8" },
    });
    const id = await ctx.identity("/repo");
    await ctx.configuration(id);
    expect(ledger.calls[0]?.environment.LC_ALL).toBe("C");
    expect(ledger.calls[1]?.environment.LC_ALL).toBe("fr_FR.UTF-8");
  });
  test("local context forbids fetch and disables implicit promisor lazy fetch", async () => {
    const ledger = discover(new ProbeLedger());
    const ctx = new GitProbeContext({
      local: true,
      run: ledger.run,
      realpath: async (path: string) => path,
      executable: "/tools/git",
      environment: { PATH: "/tools" },
    });
    const id = await ctx.identity("/repo");
    expect(ledger.calls[0]?.environment.GIT_NO_LAZY_FETCH).toBe("1");
    await expect(ctx.fetch(id, target())).rejects.toThrow();
    expect(ledger.calls).toHaveLength(1);
  });
  test("combined identity and config precede all status and mutation probes", async () => {
    const ledger = discover(new ProbeLedger())
      .enqueue(configArgs, result(config))
      .enqueue(statusArgs, result(porcelain));
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    expect(id.repositoryKey).toBe("/repo/common");
    expect(id.topLevel).toBe("/repo");
    await ctx.configuration(id);
    expect(await ctx.porcelain(id)).toBe(porcelain);
    expect(ledger.calls.map((c) => c.argv)).toEqual([identityArgs, configArgs, statusArgs]);
  });
  test.each([
    "",
    "/repo\n/common\n",
    "/repo\n/common\ntrue\n",
    "/repo\0\n/common\nfalse\n",
    "/repo\n/common\nfalse\nextra\n",
  ])("rejects malformed combined identity %j", async (output) => {
    await expect(
      parseIdentity(Buffer.from(output), "/repo", async (p: string) => p),
    ).rejects.toThrow();
  });
  test("bare fallback only follows the classified absence of a top level", async () => {
    const ledger = new ProbeLedger()
      .enqueue(identityArgs, result("", 128, "fatal: this operation must be run in a work tree\n"))
      .enqueue(["rev-parse", "--git-common-dir", "--is-bare-repository"], result("/bare\ntrue\n"));
    const id = await make(ledger).identity("/bare");
    expect(id.topLevel).toBeNull();
    expect(id.bare).toBe(true);
  });
  test("arbitrary identity failure does not authorize bare fallback", async () => {
    const ledger = new ProbeLedger().enqueue(identityArgs, result("", 128, "permission denied"));
    await expect(make(ledger).identity("/repo")).rejects.toThrow();
    expect(ledger.calls).toHaveLength(1);
  });
  test("effective config preserves exact bytes, order, duplicate, valueless and empty values", () => {
    const bytes = Buffer.from(
      "local\0file:a\0a.flag\0local\0file:a\0a.flag\n\0global\0file:b\0a.flag\na\nb\0",
    );
    const parsed = parseEffectiveConfig(bytes);
    expect(parsed.bytes.equals(bytes)).toBe(true);
    expect(parsed.entries.map((e) => e.value)).toEqual([
      null,
      Buffer.alloc(0),
      Buffer.from("a\nb"),
    ]);
  });
  test.each(["local\0file:a\0key", "local\0file:a\0key\0extra\0", "local\0file:a\0\0"])(
    "rejects malformed exact config %j",
    (s) => expect(() => parseEffectiveConfig(Buffer.from(s))).toThrow(),
  );
  test("born ref framing normalizes asymmetric orientation", () => {
    const refs = parseRefSnapshot(Buffer.from(ref(2, 7)), true);
    expect(refs.get("refs/remotes/origin/main")).toMatchObject({ ahead: 2, behind: 7, oid });
  });
  test.each([
    ref().slice(0, -1),
    ref() + ref(),
    `refs/tags/v1\0${oid}\0\0${"0 0"}\0\n`,
    `refs/heads/main\0invalid\0\0${"0 0"}\0\n`,
    ref().replace("0 0", "-1 0"),
  ])("rejects malformed or duplicate ref bytes", (s) =>
    expect(() => parseRefSnapshot(Buffer.from(s), true)).toThrow(),
  );
  test("unborn snapshot uses metadata directly", async () => {
    const ledger = discover(new ProbeLedger()).enqueue(
      metadataArgs,
      result(`refs/heads/main\0${oid}\0\0\n`),
    );
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    const refs = await ctx.refs(id, null);
    expect(refs.get("refs/heads/main")?.ahead).toBeNull();
    expect(ledger.calls).toHaveLength(2);
  });
  test("unsupported atom alone authorizes metadata fallback and scoped rev-list", async () => {
    const ledger = discover(new ProbeLedger())
      .enqueue(refArgs, result("", 128, "fatal: unknown field name: ahead-behind:HEAD"))
      .enqueue(metadataArgs, result(`refs/remotes/origin/main\0${oid}\0\0\n`))
      .enqueue(
        ["rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/main"],
        result("2\t7\n"),
      );
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    await ctx.refs(id, oid);
    expect(await ctx.compare(id, oid, "refs/remotes/origin/main")).toEqual({ ahead: 2, behind: 7 });
    expect(await ctx.compare(id, oid, "refs/remotes/origin/main")).toEqual({ ahead: 2, behind: 7 });
    expect(ledger.pending).toHaveLength(0);
  });
  test("symbolic fallback and verbose have exact argv and native bytes", async () => {
    const ledger = discover(new ProbeLedger())
      .enqueue(
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        result("origin/main\n"),
      )
      .enqueue(["status"], result("Native diagnostic\n  with formatting\n"));
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    expect(await ctx.remoteHead(id, "origin")).toBe("main");
    expect(await ctx.nativeStatus(id)).toBe("Native diagnostic\n  with formatting\n");
  });
});

describe("section 1.4: rejection eviction", () => {
  for (const scope of ["repository", "worktree", "ref", "configuration", "identity", "derived"]) {
    test(`${scope}: concurrent failure shares, corrected retry succeeds`, async () => {
      const cache = new RetrySafeCache();
      const gate = deferred<string>();
      let starts = 0;
      const run = () => {
        starts++;
        return gate.promise;
      };
      const a = cache.get(scope, run);
      const b = cache.get(scope, run);
      gate.reject(new Error("retry-safe failure"));
      const outcomes = await Promise.allSettled([a, b]);
      expect(outcomes.every((r) => r.status === "rejected")).toBe(true);
      expect(starts).toBe(1);
      expect(
        await cache.get(scope, async () => {
          starts++;
          return "corrected";
        }),
      ).toBe("corrected");
      expect(starts).toBe(2);
    });
  }
  test("older rejection cannot remove a newer entry", async () => {
    const cache = new RetrySafeCache();
    const old = deferred<string>();
    const first = cache.get("key", () => old.promise);
    cache.delete("key");
    const newer = cache.get("key", async () => "newer");
    old.reject(new Error("old"));
    await expect(first).rejects.toThrow();
    await newer;
    expect(await cache.get("key", async () => "incorrect extra probe")).toBe("newer");
  });
  test.each([result("", 1, "unsupported option"), result("truncated")])(
    "config failure stops the inspection before status or fetch and permits retry",
    async (bad) => {
      const ledger = discover(new ProbeLedger())
        .enqueue(configArgs, bad)
        .enqueue(configArgs, result(config));
      const ctx = make(ledger);
      const id = await ctx.identity("/repo");
      await expect(ctx.configuration(id)).rejects.toThrow();
      expect(ledger.calls).toHaveLength(2);
      await ctx.configuration(id);
      expect(ledger.calls).toHaveLength(3);
    },
  );
});

const spawnRecord = {
  repositoryKey: "/common",
  cwdProjection: "cwd:/repo",
  executable: "/tools/git",
  lookupMode: "PATH",
  environment: { PATH: "/tools", HOME: "/home" },
  configBytes: Buffer.from(config),
  argv: fetchArgs(),
  endpoint: "/remote",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: null,
  signal: null,
  platform: "linux",
  windowsHide: true,
};
describe("section 1.5: complete normalized fingerprint", () => {
  test("stable environment order and full record domain separation", () => {
    const a = normalizeSpawnRecord(spawnRecord);
    const b = normalizeSpawnRecord({
      ...spawnRecord,
      environment: { HOME: "/home", PATH: "/tools" },
    });
    expect(a.bytes.equals(b.bytes)).toBe(true);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(a.bytes.includes(Buffer.from("arashi.git-fetch-equivalence.v1"))).toBe(true);
  });
  test.each([
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "HTTPS_PROXY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "ARBITRARY",
  ])("captures entire environment: %s", (key) => {
    const a = normalizeSpawnRecord(spawnRecord);
    const b = normalizeSpawnRecord({
      ...spawnRecord,
      environment: { ...spawnRecord.environment, [key]: "changed" },
    });
    expect(a.bytes.equals(b.bytes)).toBe(false);
  });
  test("absence and empty are distinct", () =>
    expect(
      normalizeSpawnRecord(spawnRecord).bytes.equals(
        normalizeSpawnRecord({
          ...spawnRecord,
          environment: { ...spawnRecord.environment, EMPTY: "" },
        }).bytes,
      ),
    ).toBe(false));
  test("executable, CWD, config bytes, argv, policy and endpoint each distinguish records", () => {
    for (const change of [
      { executable: "/other/git" },
      { cwdProjection: "cwd:/other" },
      { configBytes: Buffer.from(config + "local\0file:x\0a.b\nc\0") },
      { argv: fetchArgs("next") },
      { timeout: 5 },
      { endpoint: "/other" },
      { lookupMode: "absolute" },
      { windowsHide: false },
    ])
      expect(
        normalizeSpawnRecord(spawnRecord).bytes.equals(
          normalizeSpawnRecord({ ...spawnRecord, ...change }).bytes,
        ),
      ).toBe(false);
  });
  test("Windows keys case fold, but duplicate variants reject", () => {
    expect(
      normalizeSpawnRecord({
        ...spawnRecord,
        platform: "win32",
        environment: { Path: "x" },
      }).bytes.equals(
        normalizeSpawnRecord({ ...spawnRecord, platform: "win32", environment: { PATH: "x" } })
          .bytes,
      ),
    ).toBe(true);
    expect(() =>
      normalizeSpawnRecord({
        ...spawnRecord,
        platform: "win32",
        environment: { Path: "x", PATH: "x" },
      }),
    ).toThrow();
  });
  test("fingerprints and sources cannot leak through serialization or errors", () => {
    const canary = "canary-credential-do-not-log";
    const secret = normalizeSpawnRecord({
      ...spawnRecord,
      environment: { TOKEN: canary },
      configBytes: Buffer.from(`local\0file:x\0credential.helper\n${canary}\0`),
    });
    expect(JSON.stringify(secret)).not.toContain(canary);
    expect(JSON.stringify(secret)).not.toContain(secret.digest);
  });
});

describe("section 1.8–1.10: epochs, linearizable reads and disposal", () => {
  test("audit serialization is secret-free, append-only, and cleared on disposal", async () => {
    const canary = "audit-canary-secret-do-not-serialize";
    const gate = deferred<ReturnType<typeof result>>();
    const ledger = new ProbeLedger().enqueue(identityArgs, gate.promise);
    const ctx = new GitProbeContext({
      run: ledger.run,
      realpath: async (path: string) => path,
      executable: "/tools/git",
      environment: { PATH: "/tools", TOKEN: canary },
    });
    const pending = ctx.identity("/repo");
    while (ledger.calls.length === 0) await Promise.resolve();
    const observed = ctx.auditLedger()[0]!;
    const observedBytes = JSON.stringify(observed);
    expect(observed).toMatchObject({
      eventType: "probe",
      repository: "provisional:/repo",
      repositoryAttribution: "provisional",
    });
    expect(observedBytes).not.toContain(canary);
    expect(observedBytes).not.toContain("environment");
    gate.resolve(result("/repo\n/repo/common\nfalse\n"));
    await pending;
    const completed = ctx.auditLedger();
    expect(JSON.stringify(observed)).toBe(observedBytes);
    expect(completed[0]).toEqual(observed);
    expect(completed[1]).toMatchObject({
      eventType: "attribution-resolution",
      resolvesEventId: observed.eventId,
      provisionalRepository: "provisional:/repo",
      canonicalRepository: "/repo/common",
    });
    expect(JSON.stringify(completed)).not.toContain(canary);
    ctx.dispose();
    expect(ctx.auditLedger()).toEqual([]);
  });

  test("concurrent exact fetch shares success; A then overlapping B then A reruns with new tokens", async () => {
    const gate = deferred<ReturnType<typeof result>>();
    const ledger = discover(new ProbeLedger())
      .enqueue(configArgs, result(config))
      .enqueue(fetchArgs(), gate.promise)
      .enqueue(fetchArgs("main/child"), result())
      .enqueue(fetchArgs(), result());
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    await ctx.configuration(id);
    const a = ctx.fetch(id, target());
    const same = ctx.fetch(id, target());
    gate.resolve(result());
    await Promise.all([a, same]);
    await ctx.fetch(id, target("main/child"));
    await ctx.fetch(id, target());
    const calls = ledger.calls.filter((c) => c.argv[0] === "fetch");
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.attemptToken)).size).toBe(3);
  });
  test("concurrent failed attempt shares and explicit retry uses a new token", async () => {
    const gate = deferred<ReturnType<typeof result>>();
    const ledger = discover(new ProbeLedger())
      .enqueue(configArgs, result(config))
      .enqueue(fetchArgs(), gate.promise)
      .enqueue(fetchArgs(), result());
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    await ctx.configuration(id);
    const a = ctx.fetch(id, target());
    const b = ctx.fetch(id, target());
    gate.resolve(result("", 1, "transport failure"));
    const [x, y] = await Promise.all([a, b]);
    expect(x).toEqual(y);
    expect(x.ok).toBe(false);
    expect((await ctx.fetch(id, target(), { retry: true })).ok).toBe(true);
    const calls = ledger.calls.filter((c) => c.argv[0] === "fetch");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.attemptToken).not.toBe(calls[1]?.attemptToken);
  });
  test("a later caller cannot reuse a settled failure without holding its attempt token", async () => {
    const ledger = discover(new ProbeLedger())
      .enqueue(configArgs, result(config))
      .enqueue(fetchArgs(), result("", 1, "failure"))
      .enqueue(fetchArgs(), result());
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    await ctx.configuration(id);
    expect((await ctx.fetch(id, target())).ok).toBe(false);
    expect((await ctx.fetch(id, target())).ok).toBe(true);
    expect(ledger.calls.filter((call) => call.argv[0] === "fetch")).toHaveLength(2);
  });

  test.each([0, 1])(
    "a snapshot started before mutation retries after settlement (fetch exit %i)",
    async (exit) => {
      const gate = deferred<ReturnType<typeof result>>();
      const ledger = discover(new ProbeLedger())
        .enqueue(configArgs, result(config))
        .enqueue(refArgs, gate.promise)
        .enqueue(fetchArgs(), result("", exit, "transport failure"))
        .enqueue(refArgs, result(ref(1, 3)));
      const ctx = make(ledger);
      const id = await ctx.identity("/repo");
      await ctx.configuration(id);
      const reading = ctx.refs(id, oid);
      while (!ledger.calls.some((c) => c.argv[0] === "for-each-ref")) await Promise.resolve();
      await ctx.fetch(id, target());
      gate.resolve(result(ref(9, 8)));
      expect((await reading).get("refs/remotes/origin/main")).toMatchObject({
        ahead: 1,
        behind: 3,
      });
      expect(ledger.calls.filter((c) => c.argv[0] === "for-each-ref")).toHaveLength(2);
    },
  );
  test("reader during mutation waits; distinct mutations serialize", async () => {
    const gate = deferred<ReturnType<typeof result>>();
    const ledger = discover(new ProbeLedger())
      .enqueue(configArgs, result(config))
      .enqueue(fetchArgs(), gate.promise)
      .enqueue(fetchArgs("main/child"), result())
      .enqueue(refArgs, result(ref()));
    const ctx = make(ledger);
    const id = await ctx.identity("/repo");
    await ctx.configuration(id);
    const a = ctx.fetch(id, target());
    while (!ledger.calls.some((c) => c.argv[0] === "fetch")) await Promise.resolve();
    const b = ctx.fetch(id, target("main/child"));
    const reading = ctx.refs(id, oid);
    await Promise.resolve();
    expect(ledger.calls.filter((c) => c.argv[0] === "fetch")).toHaveLength(1);
    gate.resolve(result());
    await Promise.all([a, b, reading]);
    expect(ledger.pending).toHaveLength(0);
  });
  test("fresh contexts do not retain identities or generations; disposed contexts reject", async () => {
    const ledger = discover(discover(new ProbeLedger()));
    const first = make(ledger);
    await first.identity("/repo");
    first.dispose();
    await expect(first.identity("/repo")).rejects.toThrow();
    await make(ledger).identity("/repo");
    expect(ledger.calls).toHaveLength(2);
  });
  test("no optional seeding command is run without charged proof", async () => {
    const ledger = discover(new ProbeLedger());
    await make(ledger).identity("/repo");
    expect(ledger.calls.some((c) => c.argv.includes("worktree"))).toBe(false);
  });
});
