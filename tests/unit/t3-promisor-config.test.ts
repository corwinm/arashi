import { afterEach, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError, readConfigForDiagnostics } from "../../src/lib/config.ts";
import { readTrackedFileFromDefaultBranch } from "../../src/lib/git.ts";
import { resolveT3ReadinessContext } from "../../src/lib/t3-readiness-context.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function snapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  async function visit(path: string, relative: string) {
    for (const name of (await readdir(path)).toSorted()) {
      const child = join(path, name);
      const info = await stat(child);
      if (info.isDirectory()) {
        await visit(child, `${relative}/${name}`);
      } else {
        result.push({
          hash: createHash("sha256")
            .update(await readFile(child))
            .digest("hex"),
          mode: info.mode,
          mtime: info.mtimeMs,
          path: `${relative}/${name}`,
          size: info.size,
        });
      }
    }
  }
  await visit(root, "");
  return result;
}

async function fixture(branch = "main", cached = false) {
  const root = await mkdtemp(join(tmpdir(), "promisor-config-"));
  roots.push(root);
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  expect(realGit).not.toBe("");
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_NO_LAZY_FETCH: "0",
    HOME: root,
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(realGit, args, { cwd, encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const source = join(root, "source");
  git(root, "init", "-b", branch, source);
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  git(source, "config", "uploadpack.allowFilter", "true");
  await mkdir(join(source, ".arashi"));
  const config = JSON.stringify({ repos: {}, reposDir: "./repos", version: "1.0.0" });
  await writeFile(join(source, ".arashi/config.json"), config);
  git(source, "add", ".");
  git(source, "commit", "-m", "fixture");
  const oid = git(source, "rev-parse", "HEAD:.arashi/config.json");
  const clone = join(root, "clone.git");
  git(root, "clone", "--bare", "--filter=blob:none", pathToFileURL(source).href, clone);
  // Real Git calibration: fixture must be partial, and this Git must honor the guard.
  const absent = spawnSync(realGit, ["cat-file", "-t", oid], {
    cwd: clone,
    encoding: "utf8",
    env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TRACE: "1" },
  });
  expect(absent.status).not.toBe(0);
  expect(absent.stderr).not.toMatch(/fetch origin|maintenance run|upload-pack/);
  if (cached) {
    expect(git(clone, "cat-file", "-t", oid)).toBe("blob");
  }
  if (branch === "detached") {
    git(clone, "update-ref", "--no-deref", "HEAD", git(clone, "rev-parse", "HEAD"));
  } else if (branch !== "main") {
    git(clone, "symbolic-ref", "HEAD", "refs/heads/unset");
  }
  const ledger = join(root, "ledger");
  const trace = join(root, "trace");
  const remoteLedger = join(root, "remote-ledger");
  await writeFile(ledger, "");
  await writeFile(trace, "");
  await writeFile(remoteLedger, "");
  const remote = join(root, "upload-pack");
  await writeFile(
    remote,
    `#!${process.execPath}\nconst fs=require('node:fs');const {spawnSync}=require('node:child_process');fs.appendFileSync(${JSON.stringify(remoteLedger)},'remote-entry\\n');const p=spawnSync(${JSON.stringify(realGit)},['upload-pack',...process.argv.slice(2)],{stdio:'inherit',env:process.env});process.exit(p.status ?? 1);\n`,
  );
  await chmod(remote, 0o755);
  git(clone, "config", "remote.origin.uploadpack", remote);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}\nconst fs=require('node:fs');const {spawn}=require('node:child_process');const args=process.argv.slice(2);const record=x=>fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify(x)+'\\n');record({event:'entry',args,pid:process.pid,noLazy:process.env.GIT_NO_LAZY_FETCH,directive:'ARASHI_DIRECTIVE_FILE' in process.env,shell:'ARASHI_SHELL' in process.env});const p=spawn(${JSON.stringify(realGit)},args,{env:process.env});let stdout=0,stderr=0;p.stdout.on('data',b=>{stdout+=b.length;process.stdout.write(b)});p.stderr.on('data',b=>{stderr+=b.length;process.stderr.write(b)});p.on('close',code=>{record({event:'complete',args,stdout,stderr});process.exitCode=code});\n`,
  );
  await chmod(join(bin, "git"), 0o755);
  for (const [key, value] of Object.entries({
    ARASHI_DIRECTIVE_FILE: "PRIVATE_DIRECTIVE_CANARY",
    ARASHI_SHELL: "bash",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_NO_LAZY_FETCH: "0",
    GIT_TRACE: trace,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
  })) {
    vi.stubEnv(key, value);
  }
  const records = async () =>
    (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            args: string[];
            noLazy: string;
            directive: boolean;
            shell: boolean;
            pid: number;
            stdout: number;
            stderr: number;
          },
      );
  const effects = async () => ({
    fetch: /fetch origin/.test(await readFile(trace, "utf8")),
    maintenance: /maintenance run/.test(await readFile(trace, "utf8")),
    remote: (await readFile(remoteLedger, "utf8")).trim() !== "",
  });
  return { clone, config, effects, records };
}
const posixTest = test.skipIf(process.platform === "win32");
posixTest.each([false, true])(
  "Bun production context reads a linked promisor checkout with cached=%s without effects",
  async (cached) => {
    const f = await fixture("main", cached);
    const checkout = join(roots.at(-1)!, "linked");
    expect(
      spawnSync("git", ["-C", f.clone, "worktree", "add", "--no-checkout", checkout, "main"])
        .status,
    ).toBe(0);
    await writeFile(join(roots.at(-1)!, "ledger"), "");
    const before = await snapshot(f.clone);
    const checkoutBefore = await snapshot(checkout);
    const module = new URL("../../src/lib/t3-readiness-context.ts", import.meta.url).href;
    const code = `import {resolveT3ReadinessContext} from ${JSON.stringify(module)};
      try {const result=await resolveT3ReadinessContext({cwd:${JSON.stringify(checkout)},explicitSettings:{}});
        console.log(JSON.stringify({version:result.workspace?.config.version,inherited:process.env.GIT_NO_LAZY_FETCH}));}
      catch(error) {console.log(JSON.stringify({name:error.name,message:error.message,inherited:process.env.GIT_NO_LAZY_FETCH}));}`;
    const result = spawnSync("bun", ["--eval", code], {
      encoding: "utf8",
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(
      cached
        ? { inherited: "0", version: "1.0.0" }
        : { inherited: "0", message: "Failed to read tracked configuration", name: "ConfigError" },
    );
    expect(await f.effects()).toEqual({ fetch: false, maintenance: false, remote: false });
    expect(await snapshot(f.clone)).toEqual(before);
    expect(await snapshot(checkout)).toEqual(checkoutBefore);
    const entries = (await f.records()).filter((r) => r.event === "entry");
    expect(entries.some((r) => r.args[0] === "worktree")).toBe(true);
    expect(entries.every((r) => r.noLazy === "1" && !r.directive && !r.shell)).toBe(true);
    for (const entry of entries) {
      expect(() => process.kill(entry.pid, 0)).toThrow();
    }
  },
);
posixTest(
  "missing promisor config is a screened error without lazy-fetch effects or object database writes",
  async () => {
    const f = await fixture();
    const before = await snapshot(f.clone);
    const result = await readConfigForDiagnostics(f.clone, { bareRepoPath: f.clone }).catch(
      (error: unknown) => error,
    );
    expect.soft(result).toBeInstanceOf(ConfigError);
    expect.soft(String(result)).toBe("ConfigError: Failed to read tracked configuration");
    expect.soft(JSON.stringify(result)).not.toContain(f.clone);
    expect.soft(await f.effects()).toEqual({ fetch: false, maintenance: false, remote: false });
    expect.soft(await snapshot(f.clone)).toEqual(before);
    const entries = (await f.records()).filter((r) => r.event === "entry");
    expect.soft(entries.every((r) => r.noLazy === "1" && !r.directive && !r.shell)).toBe(true);
    for (const entry of entries) {
      expect(() => process.kill(entry.pid, 0)).toThrow();
    }
    expect(process.env.GIT_NO_LAZY_FETCH).toBe("0");
  },
);
posixTest.each(["main", "master", "develop", "topic", "detached"])(
  "cached promisor %s keeps all diagnostic branch and blob subprocesses guarded",
  async (branch) => {
    const f = await fixture(branch, true);
    const before = await snapshot(f.clone);
    expect(
      (await readConfigForDiagnostics(f.clone, { bareRepoPath: f.clone }))?.config.version,
    ).toBe("1.0.0");
    expect(await f.effects()).toEqual({ fetch: false, maintenance: false, remote: false });
    expect(await snapshot(f.clone)).toEqual(before);
    const records = await f.records();
    const entries = records.filter((r) => r.event === "entry");
    expect(entries.every((r) => r.noLazy === "1" && !r.directive && !r.shell)).toBe(true);
    expect(entries.map((r) => r.args.slice(0, 2).join(" "))).toEqual(
      expect.arrayContaining([
        "symbolic-ref --short",
        "show-ref --verify",
        "rev-parse --verify",
        "ls-tree -z",
        "cat-file -t",
        "cat-file -s",
        "cat-file -p",
      ]),
    );
    if (branch === "topic") {
      expect(entries.some((r) => r.args[0] === "for-each-ref")).toBe(true);
    }
    expect(
      records
        .filter((r) => r.event === "complete")
        .every((r) => r.stdout <= 64 * 1024 && r.stderr <= 64 * 1024),
    ).toBe(true);
    for (const entry of entries) {
      expect(() => process.kill(entry.pid, 0)).toThrow();
    }
  },
);
posixTest(
  "ordinary tracked reader can still lazy fetch a controlled missing promisor blob",
  async () => {
    const f = await fixture();
    const before = await snapshot(f.clone);
    expect(await readTrackedFileFromDefaultBranch(f.clone, ".arashi/config.json")).toBe(f.config);
    expect(await f.effects()).toEqual({ fetch: true, maintenance: true, remote: true });
    expect(await snapshot(f.clone)).not.toEqual(before);
    expect(
      (await f.records()).filter((r) => r.event === "entry").every((r) => r.noLazy === "0"),
    ).toBe(true);
  },
);
posixTest(
  "diagnostic context Git root and ref discovery is guarded without changing ordinary Git environment",
  async () => {
    const f = await fixture();
    // A real checkout with no workspace config reaches identity + unborn/ref probes.
    const checkout = join(roots.at(-1)!, "checkout");
    expect(spawnSync("git", ["init", "-b", "main", checkout]).status).toBe(0);
    await writeFile(join(roots.at(-1)!, "ledger"), "");
    await resolveT3ReadinessContext({ cwd: checkout, explicitSettings: {} });
    const entries = (await f.records()).filter((r) => r.event === "entry");
    expect(entries.some((r) => r.args[0] === "worktree")).toBe(true);
    expect(entries.some((r) => r.args.join(" ") === "show-ref --head")).toBe(true);
    expect(entries.every((r) => r.noLazy === "1" && !r.directive && !r.shell)).toBe(true);
    expect(process.env.GIT_NO_LAZY_FETCH).toBe("0");
  },
);
