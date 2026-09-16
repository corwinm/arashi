import { checkRepoStatus } from "../../src/commands/status.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitProbeContext, runGitProbe } from "../../src/lib/git-probe-context.ts";
import type { ProbeCall } from "../helpers/git-probe-ledger.ts";

let root: string,
  repo: string,
  common: string,
  linked: string,
  env: Record<string, string>,
  executable: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync(executable, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const calls: ProbeCall[] = [];
const context = (extra: Record<string, string> = {}) =>
  new GitProbeContext({
    executable,
    environment: { ...env, ...extra },
    run: async (call: ProbeCall) => {
      calls.push(call);
      return runGitProbe(call);
    },
  });
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "arashi-probe-contract-")));
  repo = join(root, "one", "repo");
  common = join(root, "common");
  linked = join(root, "two", "repo");
  executable = await realpath(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
  env = {
    PATH: `${dirname(executable)}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "global"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  await writeFile(env.GIT_CONFIG_GLOBAL!, "");
  await mkdir(repo, { recursive: true });
  await mkdir(join(root, "two"));
  git(repo, "init", "--separate-git-dir", common, "-b", "main");
  git(repo, "config", "user.name", "Contract");
  git(repo, "config", "user.email", "contract@example.invalid");
  git(repo, "commit", "--allow-empty", "-m", "first");
  git(repo, "worktree", "add", "-b", "linked", linked);
  calls.length = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("real Git identity and spawn equivalence", () => {
  test("root/subdirectory/symlink canonicalize, linked worktree shares only repository identity", async () => {
    const sub = join(repo, "sub");
    const alias = join(root, "alias");
    await mkdir(sub);
    await symlink(repo, alias);
    const ctx = context();
    const ids = await Promise.all([repo, sub, alias, linked].map((p) => ctx.identity(p)));
    expect(new Set(ids.map((i) => i.repositoryKey)).size).toBe(1);
    expect(new Set(ids.slice(0, 3).map((i) => i.worktreeKey)).size).toBe(1);
    expect(ids[3]!.worktreeKey).not.toBe(ids[0]!.worktreeKey);
    await writeFile(join(linked, "only-linked"), "untracked");
    expect(await ctx.porcelain(ids[0]!)).not.toContain("only-linked");
    expect(await ctx.porcelain(ids[3]!)).toContain("only-linked");
  });
  test("bare sentinel, missing-path retry, separate directory and discovery overrides", async () => {
    const bare = join(root, "bare");
    git(root, "init", "--bare", bare);
    expect(await context().identity(bare)).toMatchObject({
      bare: true,
      topLevel: null,
      repositoryKey: bare,
    });
    const missing = join(repo, "later");
    const ctx = context();
    await expect(ctx.identity(missing)).rejects.toThrow();
    await mkdir(missing);
    expect((await ctx.identity(missing)).topLevel).toBe(repo);
    expect(
      (await context({ GIT_DIR: common, GIT_WORK_TREE: repo }).identity(root)).repositoryKey,
    ).toBe(common);
  });
  test("relative discovery overrides retain meaning after canonical top-level discovery", async () => {
    const ctx = context({ GIT_DIR: "common", GIT_WORK_TREE: "one/repo" });
    const id = await ctx.identity(root);
    expect(id.topLevel).toBe(repo);
    expect((await ctx.configuration(id)).entries.some((entry) => entry.key === "user.name")).toBe(
      true,
    );
    expect(await ctx.porcelain(id)).toContain("# branch.head main");
  });

  test("a unique symbolic remote HEAD comes from the snapshot even without remote config", async () => {
    git(repo, "switch", "-c", "feature");
    git(repo, "update-ref", "refs/remotes/team/trunk", "main");
    git(repo, "symbolic-ref", "refs/remotes/team/HEAD", "refs/remotes/team/trunk");
    const status = await checkRepoStatus("repo", repo, { local: true });
    expect(status.defaultBranch).toMatchObject({
      state: "available",
      branch: "trunk",
      remote: "team",
    });
  });

  test("missing PATH uses the platform default executable search", async () => {
    const { PATH: _path, ...withoutPath } = env;
    const id = await new GitProbeContext({ environment: withoutPath }).identity(repo);
    expect(id.repositoryKey).toBe(common);
  });
  test.runIf(process.platform !== "win32")(
    "PATH-selected symlink dispatcher preserves invoked-path spawning and canonical fetch equivalence",
    async () => {
      const bin = join(root, "dispatcher-bin");
      const dispatcher = join(bin, "git-dispatcher");
      const selectedGit = join(bin, "git");
      const remote = join(root, "dispatcher-remote.git");
      const quotedGit = `'${executable.replaceAll("'", `'\\''`)}'`;
      await mkdir(bin);
      await writeFile(
        dispatcher,
        `#!/bin/sh\n[ "\${0##*/}" = git ] || exit 97\nexec ${quotedGit} "$@"\n`,
      );
      await chmod(dispatcher, 0o755);
      await symlink(dispatcher, selectedGit);
      git(root, "init", "--bare", "-b", "main", remote);
      git(repo, "remote", "add", "origin", remote);
      git(repo, "push", "-u", "origin", "main");

      const dispatcherCalls: ProbeCall[] = [];
      const ctx = new GitProbeContext({
        environment: { ...env, PATH: bin },
        run: async (call: ProbeCall) => {
          dispatcherCalls.push(call);
          return runGitProbe(call);
        },
      });
      const ids = await Promise.all([repo, linked].map((path) => ctx.identity(path)));
      await Promise.all(ids.map((id) => ctx.configuration(id)));
      await ctx.porcelain(ids[0]!);
      await ctx.refs(ids[0]!, git(repo, "rev-parse", "HEAD").trim());
      await ctx.nativeStatus(ids[0]!);
      await Promise.all(
        ids.map((id) =>
          ctx.fetch(id, { remote: "origin", branch: "main", upstream: "origin/main" }),
        ),
      );

      expect(ids[0]!.repositoryKey).toBe(common);
      expect(dispatcherCalls.every((call) => call.executable === selectedGit)).toBe(true);
      expect(dispatcherCalls.filter((call) => call.argv[0] === "fetch")).toHaveLength(1);
    },
  );
  test("relative PATH entries cannot authorize cross-worktree fetch equivalence", async () => {
    const remote = join(root, "relative-path-remote.git");
    git(root, "init", "--bare", remote);
    git(repo, "push", remote, "main");
    git(repo, "remote", "add", "origin", remote);
    const ctx = context({ PATH: `relative-bin:${env.PATH}` });
    const ids = await Promise.all([repo, linked].map((path) => ctx.identity(path)));
    await Promise.all(ids.map((id) => ctx.configuration(id)));
    await Promise.all(
      ids.map((id) => ctx.fetch(id, { remote: "origin", branch: "main", upstream: "origin/main" })),
    );
    expect(calls.filter((call) => call.argv[0] === "fetch")).toHaveLength(2);
  });

  test("local branch upstream preserves HEAD-relative divergence", async () => {
    git(repo, "switch", "-c", "feature");
    git(repo, "branch", "--set-upstream-to=main", "feature");
    git(repo, "commit", "--allow-empty", "-m", "feature-only");
    const status = await checkRepoStatus("repo", repo, { local: true });
    expect(status.branch).toMatchObject({
      ahead: 1,
      behind: 0,
      localBranch: "feature",
      remoteBranch: "main",
    });
  });

  test("post-fetch refs replace a provisional default selected before the target existed", async () => {
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "origin", "main");
    git(repo, "switch", "-c", "feature");
    git(repo, "config", "branch.feature.remote", "origin");
    git(repo, "config", "branch.feature.merge", "refs/heads/main");
    git(repo, "branch", "-D", "main");
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    const status = await checkRepoStatus("repo", repo);
    expect(status.defaultBranch).toMatchObject({
      state: "available",
      branch: "main",
      remote: "origin",
    });
  });

  test("detached configured-base reporting stays detached even without a remote", async () => {
    git(repo, "checkout", "--detach");
    const status = await checkRepoStatus("repo", repo, { baseBranch: "main", local: true });
    expect(status.branch.isDetached).toBe(true);
    expect(status.baseBranch).toMatchObject({
      state: "skipped",
      branch: "main",
      reason: "detached-head",
    });
    expect(status.freshness?.remoteRefsRefreshed).toBe(false);
  });

  test("relative remote resolves to different endpoints and must execute twice", async () => {
    const remotes = [join(root, "one", "remote.git"), join(root, "two", "remote.git")];
    for (const remote of remotes) {
      git(root, "init", "--bare", remote);
      git(repo, "push", remote, "main");
    }
    git(repo, "remote", "add", "origin", "../remote.git");
    const ctx = context();
    const ids = await Promise.all([repo, linked].map((p) => ctx.identity(p)));
    const configs = await Promise.all(ids.map((id) => ctx.configuration(id)));
    expect(configs[0]!.bytes.equals(configs[1]!.bytes)).toBe(true);
    await Promise.all(
      ids.map((id) => ctx.fetch(id, { remote: "origin", branch: "main", upstream: "origin/main" })),
    );
    expect(calls.filter((c) => c.argv[0] === "fetch")).toHaveLength(2);
  });
  test("absolute endpoint and exact clean semantics positively share one concurrent attempt", async () => {
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", remote);
    git(repo, "push", remote, "main");
    git(repo, "remote", "add", "origin", remote);
    const ctx = context();
    const ids = await Promise.all([repo, linked].map((p) => ctx.identity(p)));
    const configs = await Promise.all(ids.map((id) => ctx.configuration(id)));
    expect(configs[0]!.bytes.equals(configs[1]!.bytes)).toBe(true);
    await Promise.all(
      ids.map((id) => ctx.fetch(id, { remote: "origin", branch: "main", upstream: "origin/main" })),
    );
    expect(calls.filter((c) => c.argv[0] === "fetch")).toHaveLength(1);
  });
  test("asymmetric atom divergence equals rev-list and separates linked HEADs", async () => {
    git(repo, "commit", "--allow-empty", "-m", "second");
    git(repo, "commit", "--allow-empty", "-m", "third");
    const ctx = context();
    const ids = await Promise.all([repo, linked].map((p) => ctx.identity(p)));
    for (const id of ids) {
      const head = git(id.topLevel!, "rev-parse", "HEAD").trim();
      const refs = await ctx.refs(id, head);
      for (const ref of ["refs/heads/main", "refs/heads/linked"]) {
        const [ahead, behind] = git(
          id.topLevel!,
          "rev-list",
          "--left-right",
          "--count",
          `HEAD...${ref}`,
        )
          .trim()
          .split(/\s+/)
          .map(Number);
        expect(refs.get(ref)).toMatchObject({ ahead, behind });
      }
    }
    expect(
      (await ctx.refs(ids[0]!, git(repo, "rev-parse", "HEAD").trim())).get("refs/heads/linked")
        ?.ahead,
    ).toBe(2);
    expect(
      (await ctx.refs(ids[1]!, git(linked, "rev-parse", "HEAD").trim())).get("refs/heads/main")
        ?.behind,
    ).toBe(2);
  });
  test("synthetic hash collision does not merge different CWD-sensitive attempts", async () => {
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", remote);
    git(repo, "push", remote, "main");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "config", "credential.helper", "!pwd");
    const ctx = new GitProbeContext({
      executable,
      environment: env,
      digest: () => "collision",
      run: async (call: ProbeCall) => {
        calls.push(call);
        return runGitProbe(call);
      },
    });
    const ids = await Promise.all([repo, linked].map((p) => ctx.identity(p)));
    await Promise.all(ids.map((id) => ctx.configuration(id)));
    await Promise.all(
      ids.map((id) => ctx.fetch(id, { remote: "origin", branch: "main", upstream: "origin/main" })),
    );
    expect(calls.filter((c) => c.argv[0] === "fetch")).toHaveLength(2);
  });
});
