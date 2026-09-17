import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProbeContext } from "../../src/lib/git-probe-context.ts";
import { checkRepoStatus } from "../../src/commands/status.ts";
import { ProbeLedger, result } from "../helpers/git-probe-ledger.ts";
let path: string;
beforeEach(async () => {
  path = await mkdtemp(join(tmpdir(), "status-probe-"));
});
afterEach(async () => {
  await rm(path, { recursive: true, force: true });
});
const oid = "a".repeat(40);
const identity = ["rev-parse", "--show-toplevel", "--git-common-dir", "--is-bare-repository"];
const config = ["config", "--null", "--list", "--show-origin", "--show-scope"];
const porcelain = ["status", "--porcelain=v2", "--branch", "-z"];
const refs = [
  "for-each-ref",
  "--format=%(refname)%00%(objectname)%00%(symref)%00%(ahead-behind:HEAD)%00",
  "refs/heads",
  "refs/remotes",
];
const fetch = [
  "fetch",
  "--no-tags",
  "--prune",
  "origin",
  "+refs/heads/main:refs/remotes/origin/main",
];
const bytes = `local\0file:config\0remote.origin.url\n/remote\0local\0file:config\0branch.main.remote\norigin\0local\0file:config\0branch.main.merge\nrefs/heads/main\0`;
const snapshot = (ahead = 0, behind = 0) =>
  `refs/remotes/origin/main\0${oid}\0\0${behind} ${ahead}\0\nrefs/remotes/origin/HEAD\0${oid}\0refs/remotes/origin/main\0${behind} ${ahead}\0\n`;
const setup = () =>
  new ProbeLedger()
    .enqueue(identity, result(`${path}\n/common\nfalse\n`))
    .enqueue(config, result(bytes))
    .enqueue(
      porcelain,
      result(
        `# branch.oid ${oid}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +9 -8\0`,
      ),
    );
const context = (ledger: ProbeLedger) =>
  new GitProbeContext({
    run: ledger.run,
    realpath: async (p: string) => p,
    executable: "/tools/git",
    environment: { PATH: "/tools" },
  });
test.each([false, true])("one context drives exact clean ledger; verbose=%s", async (verbose) => {
  const ledger = setup()
    .enqueue(refs, result(snapshot(9, 8)))
    .enqueue(fetch, result())
    .enqueue(refs, result(snapshot(2, 3)));
  if (verbose) ledger.enqueue(["status"], result("Native status with diagnostics\n"));
  const probeContext = context(ledger);
  const status = await checkRepoStatus("repo", path, { context: probeContext, verbose });
  expect(status.error).toBeNull();
  expect(status.branch).toMatchObject({ ahead: 2, behind: 3 });
  expect(status.defaultBranch).toMatchObject({ state: "available", ahead: 2, behind: 3 });
  expect(status.freshness).toEqual({ mode: "refreshed", remoteRefsRefreshed: true });
  expect(ledger.calls).toHaveLength(verbose ? 7 : 6);
  expect(status.fullStatus).toBe(verbose ? "Native status with diagnostics" : undefined);
  expect(ledger.pending).toHaveLength(0);
  expect(probeContext.auditLedger()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        argv: identity,
        cwd: path,
        parserOwner: "GitProbeContext identity parser",
        purpose: "combined repository/worktree identity",
        repository: "/common",
        repositoryAttribution: "canonical",
      }),
      expect.objectContaining({
        argv: porcelain,
        parserOwner: "existing NUL porcelain-v2 parser",
        purpose: "structured worktree status and branch/upstream discovery",
        repository: "/common",
        repositoryAttribution: "canonical",
      }),
    ]),
  );
  expect(probeContext.auditLedger()).toHaveLength(verbose ? 7 : 6);
  expect(probeContext.auditLedger().every((entry) => entry.purpose.length > 0)).toBe(true);
  expect(probeContext.auditLedger().every((entry) => entry.repository !== null)).toBe(true);
});
test("local mode starts no transport and keeps truthful local divergence", async () => {
  const ledger = setup().enqueue(refs, result(snapshot(9, 8)));
  const status = await checkRepoStatus("repo", path, { context: context(ledger), local: true });
  expect(status.freshness).toEqual({ mode: "local", remoteRefsRefreshed: false });
  expect(status.branch).toMatchObject({ ahead: 9, behind: 8 });
  expect(ledger.calls.some((c) => ["fetch", "ls-remote"].includes(c.argv[0]!))).toBe(false);
});
test("unavailable exact config is an operational error and starts no later probe", async () => {
  const ledger = new ProbeLedger()
    .enqueue(identity, result(`${path}\n/common\nfalse\n`))
    .enqueue(config, result("malformed"));
  const status = await checkRepoStatus("repo", path, { context: context(ledger) });
  expect(status.error).toBeTruthy();
  expect(status.freshness?.remoteRefsRefreshed).toBe(false);
  expect(ledger.calls).toHaveLength(2);
});
test.each(["couldn't find remote ref refs/heads/main", "canary-secret-transport"])(
  "failed fetch preserves stale/missing roles and post-failure snapshot without leaking inputs",
  async (stderr) => {
    const ledger = setup()
      .enqueue(refs, result(snapshot()))
      .enqueue(fetch, result("", 1, stderr))
      .enqueue(refs, result(snapshot(1, 4)));
    const status = await checkRepoStatus("repo", path, { context: context(ledger) });
    expect(status.error).toBeNull();
    expect(status.freshness?.remoteRefsRefreshed).toBe(false);
    expect(status.defaultBranch).toMatchObject({ state: "unavailable", reason: "refresh-failed" });
    expect(status.refreshWarning).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain("canary-secret");
    expect(ledger.pending).toHaveLength(0);
  },
);

test("all distinct refresh targets use one pre-view and one post-view", async () => {
  const multiSnapshot = `${snapshot()}refs/remotes/origin/develop\0${oid}\0\0${"0 0"}\0\n`;
  const ledger = setup()
    .enqueue(refs, result(multiSnapshot))
    .enqueue(fetch, result())
    .enqueue(
      [
        "fetch",
        "--no-tags",
        "--prune",
        "origin",
        "+refs/heads/develop:refs/remotes/origin/develop",
      ],
      result(),
    )
    .enqueue(refs, result(multiSnapshot));
  const status = await checkRepoStatus("repo", path, {
    baseBranch: "develop",
    context: context(ledger),
  });
  expect(status.error).toBeNull();
  expect(ledger.calls.filter((call) => call.argv[0] === "for-each-ref")).toHaveLength(2);
  expect(ledger.pending).toHaveLength(0);
});

test("no symbolic remote HEAD is not guessed from conventional branch names", async () => {
  const noHead = `refs/remotes/origin/main\0${oid}\0\0${"0 0"}\0\n`;
  const ledger = setup()
    .enqueue(refs, result(noHead))
    .enqueue(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], result("", 1))
    .enqueue(fetch, result())
    .enqueue(refs, result(noHead));
  const status = await checkRepoStatus("repo", path, { context: context(ledger) });
  expect(status.error).toBeNull();
  expect(status.defaultBranch).toEqual({ state: "skipped", branch: null, reason: "unresolved" });
  expect(status.freshness?.remoteRefsRefreshed).toBe(false);
  expect(ledger.calls).toHaveLength(7);
  expect(ledger.pending).toHaveLength(0);
});

test("an explicit configured base remains the default comparison when symbolic HEAD is unavailable", async () => {
  const noHead = `refs/remotes/origin/main\0${oid}\0\0${"2 3"}\0\n`;
  const ledger = setup()
    .enqueue(refs, result(noHead))
    .enqueue(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], result("", 1))
    .enqueue(fetch, result())
    .enqueue(refs, result(noHead));
  const status = await checkRepoStatus("repo", path, {
    baseBranch: "main",
    context: context(ledger),
  });
  expect(status.baseBranch).toMatchObject({ branch: "main", state: "available" });
  expect(status.defaultBranch).toMatchObject({ branch: "main", state: "available" });
  expect(status.freshness?.remoteRefsRefreshed).toBe(true);
  expect(ledger.pending).toHaveLength(0);
});

test("ambiguous remaining symbolic remote HEADs are not guessed", async () => {
  const ambiguous = [
    `refs/remotes/origin/main\0${oid}\0\0${"0 0"}\0\n`,
    `refs/remotes/alpha/main\0${oid}\0\0${"0 0"}\0\n`,
    `refs/remotes/alpha/HEAD\0${oid}\0refs/remotes/alpha/main\0${"0 0"}\0\n`,
    `refs/remotes/beta/main\0${oid}\0\0${"0 0"}\0\n`,
    `refs/remotes/beta/HEAD\0${oid}\0refs/remotes/beta/main\0${"0 0"}\0\n`,
  ].join("");
  const ledger = setup()
    .enqueue(refs, result(ambiguous))
    .enqueue(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], result("", 1))
    .enqueue(fetch, result())
    .enqueue(refs, result(ambiguous));
  const status = await checkRepoStatus("repo", path, { context: context(ledger) });
  expect(status.error).toBeNull();
  expect(status.defaultBranch).toEqual({ state: "skipped", branch: null, reason: "unresolved" });
  expect(status.freshness?.remoteRefsRefreshed).toBe(false);
  expect(ledger.pending).toHaveLength(0);
});
