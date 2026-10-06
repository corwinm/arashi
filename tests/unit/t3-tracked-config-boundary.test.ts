import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runtime } from "../../src/lib/runtime.ts";
import { ConfigError, readConfigForDiagnostics } from "../../src/lib/config.ts";
import { readTrackedFileFromDefaultBranch } from "../../src/lib/git.ts";

const limit = 1024 * 1024;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { force: true, recursive: true })));
});
async function fixture(bytes: number, mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "tracked-bound-"));
  roots.push(root);
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    HOME: root,
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env });
    expect(result.status, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(root, ".arashi"));
  const valid = JSON.stringify({
    repos: {},
    reposDir: "./" + "é".repeat(Math.floor((bytes - 100) / 2)),
    version: "1.0.0",
  });
  await writeFile(
    join(root, ".arashi/config.json"),
    valid + " ".repeat(bytes - Buffer.byteLength(valid)),
  );
  git("add", ".");
  git("commit", "-m", "fixture");
  const oid = git("rev-parse", "HEAD:.arashi/config.json");
  const originalCommit = git("rev-parse", "HEAD");
  let replacement = originalCommit;
  if (mode === "mutate") {
    await writeFile(join(root, ".arashi/config.json"), " ".repeat(limit + 1));
    git("add", ".arashi/config.json");
    git("commit", "-m", "replacement");
    replacement = git("rev-parse", "HEAD");
    git("update-ref", "refs/heads/main", originalCommit);
  }
  await rm(join(root, ".arashi/config.json"));
  const ledger = join(root, "ledger");
  const wrapper = join(root, "git.cjs");
  await writeFile(
    wrapper,
    `
    const {spawn,spawnSync}=require('node:child_process');const fs=require('node:fs');
    const args=process.argv.slice(2);const record=(x)=>fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify(x)+'\\n');
    record({args,pid:process.pid,event:'entry'});
    if(${JSON.stringify(mode)}==='inject' && args[0]==='cat-file' && args[1]==='-p') {
      record({event:'stream'});setInterval(()=>process.stdout.write(Buffer.alloc(65536,32)),1);
    } else if(${JSON.stringify(mode)}==='stall' && args[0]==='cat-file' && args[1]==='-p') {
      record({event:'stream'});process.stderr.write('PRIVATE_GIT_CANARY');setInterval(()=>{},1000);
    } else if(${JSON.stringify(mode)}==='stderr' && args[0]==='cat-file') {
      record({event:'stream'});setInterval(()=>process.stderr.write('PRIVATE_GIT_CANARY'.repeat(4096)),1);
    } else {
      const p=spawn('git',args,{env:process.env});let bytes=0;
      p.stdout.on('data',b=>{bytes+=b.length;process.stdout.write(b)});p.stderr.pipe(process.stderr);
      p.on('close',code=>{
        record({args,event:'complete',bytes});
        if(args.join(' ')==='show-ref --verify refs/heads/main' && code===0) {
          if(${JSON.stringify(mode)}==='missing-ref') fs.unlinkSync('.git/refs/heads/main');
          if(${JSON.stringify(mode)}==='corrupt-ref') fs.writeFileSync('.git/refs/heads/main','PRIVATE_REF_CANARY');
        }
        if(${JSON.stringify(mode)}==='mutate' && args[0]==='cat-file' && args[1]==='-s')
          spawnSync('git',['update-ref','refs/heads/main',${JSON.stringify(replacement)}],{env:process.env});
        process.exitCode=code;
      });
    }
  `,
  );
  const original = runtime.spawn;
  vi.spyOn(runtime, "spawn").mockImplementation((argv, options) =>
    original(argv[0] === "git" ? [process.execPath, wrapper, ...argv.slice(1)] : argv, {
      ...options,
      env: { ...options?.env, ...env },
    }),
  );
  const buffers: number[] = [];
  const { arrayBuffer } = Response.prototype;
  vi.spyOn(Response.prototype, "arrayBuffer").mockImplementation(async function (this: Response) {
    const result = await arrayBuffer.call(this);
    buffers.push(result.byteLength);
    return result;
  });
  return {
    buffers,
    git,
    oid,
    originalCommit,
    records: async () =>
      (await readFile(ledger, "utf8"))
        .trim()
        .split("\n")
        .map(
          (s) => JSON.parse(s) as { args?: string[]; event: string; bytes?: number; pid?: number },
        ),
    root,
  };
}
test("oversized tracked blob is rejected before content entry or whole-response buffering", async () => {
  const f = await fixture(limit + 1);
  await expect(readConfigForDiagnostics(f.root, { bareRepoPath: f.root })).rejects.toBeInstanceOf(
    ConfigError,
  );
  const records = await f.records();
  const content = records.filter(
    (r) => r.args?.[0] === "show" || (r.args?.[0] === "cat-file" && r.args[1] === "-p"),
  );
  console.log(
    JSON.stringify({
      contentBytes: content.filter((r) => r.event === "complete").map((r) => r.bytes),
      contentEntries: content.filter((r) => r.event === "entry").length,
      largestWholeResponseBuffer: Math.max(0, ...f.buffers),
    }),
  );
  expect.soft(content).toEqual([]);
  expect.soft(Math.max(0, ...f.buffers)).toBeLessThan(limit);
});
test("exact UTF-8 byte budget uses pinned blob and leaves ordinary reader unrestricted", async () => {
  const f = await fixture(limit);
  expect((await readConfigForDiagnostics(f.root, { bareRepoPath: f.root }))?.config.version).toBe(
    "1.0.0",
  );
  expect((await f.records()).some((r) => r.args?.join(" ") === `cat-file -p ${f.oid}`)).toBe(true);
  expect(Math.max(0, ...f.buffers)).toBeLessThan(limit);
  expect(
    Buffer.byteLength(await readTrackedFileFromDefaultBranch(f.root, ".arashi/config.json")),
  ).toBe(limit);
});
test("ref mutation after size verification still reads admitted immutable blob", async () => {
  const f = await fixture(512, "mutate");
  expect((await readConfigForDiagnostics(f.root, { bareRepoPath: f.root }))?.config.version).toBe(
    "1.0.0",
  );
  expect(
    (await f.records())
      .filter((r) => r.args?.[0] === "cat-file" && r.args[1] === "-p")
      .every((r) => r.args?.[2] === f.oid),
  ).toBe(true);
  await expect(
    readTrackedFileFromDefaultBranch(f.root, ".arashi/config.json"),
  ).resolves.toHaveLength(limit + 1);
});
test.each(["main", "master", "develop", "topic"])(
  "unset HEAD preserves %s branch fallback",
  async (branch) => {
    const f = await fixture(512);
    for (const args of [
      ...(branch === "main" ? [] : [["branch", "-m", "main", branch]]),
      ["symbolic-ref", "HEAD", "refs/heads/unset"],
    ]) {
      expect(spawnSync("git", args, { cwd: f.root }).status).toBe(0);
    }
    expect((await readConfigForDiagnostics(f.root, { bareRepoPath: f.root }))?.config.version).toBe(
      "1.0.0",
    );
    expect(
      (await f.records()).some(
        (r) => r.args?.join(" ") === `rev-parse --verify refs/heads/${branch}^{tree}`,
      ),
    ).toBe(true);
  },
);
test.each([
  ["main", "current", "different"],
  ["main", "current", "malformed"],
  ["master", "current", "different"],
  ["develop", "current", "different"],
  ["topic/custom", "current", "different"],
  ["main", "unset", "different"],
  ["master", "unset", "different"],
  ["develop", "unset", "different"],
  ["topic/custom", "unset", "different"],
  ["main", "detached", "different"],
])(
  "selected %s branch with %s HEAD ignores %s same-name tag config",
  async (branch, head, kind) => {
    const f = await fixture(512);
    if (branch !== "main") {
      f.git("branch", "-m", "main", branch!);
    }
    const stale =
      kind === "malformed"
        ? "PRIVATE_TAG_CANARY{"
        : JSON.stringify({ repos: {}, reposDir: "./stale", version: "1.0.0" });
    await writeFile(join(f.root, ".arashi/config.json"), stale);
    f.git("add", ".arashi/config.json");
    f.git("commit", "-m", "stale tag configuration");
    f.git("tag", branch!);
    if (head === "current" && branch !== "main") {
      f.git("branch", "main", `refs/tags/${branch}`);
    }
    f.git("update-ref", `refs/heads/${branch}`, f.originalCommit);
    if (head === "unset") {
      f.git("symbolic-ref", "HEAD", "refs/heads/unset");
    }
    if (head === "detached") {
      f.git("update-ref", "--no-deref", "HEAD", f.originalCommit);
    }
    await rm(join(f.root, ".arashi/config.json"));

    await expect(readConfigForDiagnostics(f.root, { bareRepoPath: f.root })).resolves.toMatchObject(
      {
        config: { reposDir: `./${"é".repeat(Math.floor((512 - 100) / 2))}`, version: "1.0.0" },
        source: "repository-content",
      },
    );
    const content = (await f.records()).filter(
      (r) => r.event === "entry" && r.args?.[0] === "cat-file" && r.args[1] === "-p",
    );
    expect(content.map((r) => r.args?.[2])).toEqual([f.oid]);
  },
);

test("HEAD tag cannot override detached HEAD or the existing default-branch fallback", async () => {
  const f = await fixture(512, "mutate");
  const replacement = f.git("rev-parse", "HEAD@{1}");
  f.git("update-ref", "refs/tags/HEAD", replacement);
  f.git("update-ref", "--no-deref", "HEAD", replacement);
  await expect(readConfigForDiagnostics(f.root, { bareRepoPath: f.root })).resolves.toMatchObject({
    config: { version: "1.0.0" },
  });
  const content = (await f.records()).filter(
    (r) => r.event === "entry" && r.args?.[0] === "cat-file" && r.args[1] === "-p",
  );
  expect(content.map((r) => r.args?.[2])).toEqual([f.oid]);
});

test("symbolic HEAD outside branch namespace retains branch fallback", async () => {
  const f = await fixture(512, "mutate");
  const replacement = f.git("rev-parse", "HEAD@{1}");
  f.git("tag", "selected-tag", replacement);
  f.git("symbolic-ref", "HEAD", "refs/tags/selected-tag");
  await expect(readConfigForDiagnostics(f.root, { bareRepoPath: f.root })).resolves.toMatchObject({
    config: { version: "1.0.0" },
  });
  const content = (await f.records()).filter(
    (r) => r.event === "entry" && r.args?.[0] === "cat-file" && r.args[1] === "-p",
  );
  expect(content.map((r) => r.args?.[2])).toEqual([f.oid]);
});

test.each(["missing-ref", "corrupt-ref"])(
  "selected %s errors stay screened without tag or branch fallback",
  async (mode) => {
    const f = await fixture(512, mode);
    f.git("tag", "main", f.originalCommit);
    f.git("branch", "master", f.originalCommit);
    const error = await readConfigForDiagnostics(f.root, { bareRepoPath: f.root }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toBe("ConfigError: Failed to read tracked configuration");
    expect(JSON.stringify(error)).not.toContain(f.root);
    expect(JSON.stringify(error)).not.toContain("PRIVATE_REF_CANARY");
    const records = (await f.records()).filter((r) => r.event === "entry");
    expect(records.filter((r) => r.args?.[0] === "rev-parse").map((r) => r.args)).toEqual([
      ["rev-parse", "--verify", "refs/heads/main^{tree}"],
    ]);
    expect(
      records.some((r) => r.args?.[0] === "cat-file" || r.args?.[2] === "refs/heads/master"),
    ).toBe(false);
  },
);

test("ordinary reader retains its existing unqualified same-name tag semantics", async () => {
  const f = await fixture(512);
  await writeFile(join(f.root, ".arashi/config.json"), "ordinary-tag-content");
  f.git("add", ".arashi/config.json");
  f.git("commit", "-m", "ordinary tag");
  f.git("tag", "main");
  f.git("update-ref", "refs/heads/main", f.originalCommit);
  await rm(join(f.root, ".arashi/config.json"));
  await expect(readTrackedFileFromDefaultBranch(f.root, ".arashi/config.json")).resolves.toBe(
    "ordinary-tag-content",
  );
});

test("ordinary reader continues accepting above diagnostic budget", async () => {
  const f = await fixture(limit + 1);
  expect(
    Buffer.byteLength(await readTrackedFileFromDefaultBranch(f.root, ".arashi/config.json")),
  ).toBe(limit + 1);
});
test.each(["tree entry", "blob entry pointing to tree"])(
  "rejects actual %s before content materialization",
  async (kind) => {
    const f = await fixture(512);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: f.root });
      expect(result.status, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    const tree = git("rev-parse", "HEAD^{tree}");
    if (kind === "tree entry") {
      await mkdir(join(f.root, ".arashi/config.json"));
      await writeFile(join(f.root, ".arashi/config.json/child"), "fixture");
      git("add", ".arashi");
      const newTree = git("write-tree");
      const commit = git("commit-tree", newTree, "-p", "HEAD", "-m", "tree fixture");
      git("update-ref", "refs/heads/main", commit);
      await rm(join(f.root, ".arashi/config.json"), { recursive: true });
    } else {
      const raw = Buffer.concat([Buffer.from("100644 config.json\0"), Buffer.from(tree, "hex")]);
      const result = spawnSync(
        "git",
        ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"],
        { cwd: f.root, input: raw },
      );
      expect(result.status).toBe(0);
      const subTree = result.stdout.toString().trim();
      const rootRaw = Buffer.concat([Buffer.from("40000 .arashi\0"), Buffer.from(subTree, "hex")]);
      const rootResult = spawnSync(
        "git",
        ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"],
        { cwd: f.root, input: rootRaw },
      );
      expect(rootResult.status).toBe(0);
      const commit = git(
        "commit-tree",
        rootResult.stdout.toString().trim(),
        "-p",
        "HEAD",
        "-m",
        "wrong type fixture",
      );
      git("update-ref", "refs/heads/main", commit);
    }
    await expect(readConfigForDiagnostics(f.root, { bareRepoPath: f.root })).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect((await f.records()).some((r) => r.args?.[0] === "cat-file" && r.args[1] === "-p")).toBe(
      false,
    );
  },
);
test.each(["inject", "stderr", "stall"])(
  "bounded %s production stream kills owned child and screens output",
  async (mode) => {
    const f = await fixture(512, mode);
    const error = await readConfigForDiagnostics(f.root, { bareRepoPath: f.root }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(JSON.stringify(error)).not.toContain(f.root);
    expect(String(error)).not.toContain(f.root);
    expect(String(error)).not.toContain("PRIVATE_GIT_CANARY");
    const streaming = (await f.records()).findLast(
      (r) => r.event === "entry" && r.args?.[0] === "cat-file",
    );
    expect(streaming?.pid).toBeDefined();
    expect(() => process.kill(streaming!.pid!, 0)).toThrow();
    expect(Math.max(0, ...f.buffers)).toBeLessThan(limit);
  },
  15_000,
);
