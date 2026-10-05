import { afterEach, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readConfigForDiagnostics, ConfigError, ConfigParseError } from "../../src/lib/config.ts";
import { loadUserConfig, readUserConfigForDiagnostics } from "../../src/lib/user-config.ts";

const limit = 1024 * 1024; // Existing completion config budget; diagnostics only.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "t3-config-boundary-"));
  roots.push(root);
  await mkdir(join(root, ".arashi"));
  return { root, path: join(root, ".arashi/config.json") };
}
const valid = JSON.stringify({ version: "1.0.0", reposDir: "./repos", repos: {} });

// Real operation-entry barrier, not a fixture/startup timer. Instrument only the
// owned child, leaving production behavior unchanged. A writer releases old
// blocking readFile workers before teardown; the test never leaves a FIFO read.
async function probe(root: string, path: string, operation: string, fifo?: string, home = root) {
  const config = resolve("src/lib/config.ts");
  const context = resolve("src/lib/t3-readiness-context.ts");
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    for (const name of ['readFile', 'open']) {
      const original = fs[name];
      fs[name] = function(p, ...args) {
        if (p === ${JSON.stringify(path)}) console.log('OPERATION_ENTRY');
        return original.call(this, p, ...args);
      };
    }
    syncBuiltinESMExports();
    const { readConfigForDiagnostics } = await import(${JSON.stringify(config)});
    const { resolveT3ReadinessContext } = await import(${JSON.stringify(context)});
    try {
      ${operation === "workspace" ? `await readConfigForDiagnostics(${JSON.stringify(root)});` : `await resolveT3ReadinessContext({cwd:${JSON.stringify(root)},explicitSettings:{}});`}
      console.log('RESULT:accepted');
    } catch(e) { console.log('RESULT:' + e.constructor.name + ':' + e.message); }
  `;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let stderr = "";
  let entered = false;
  let timedOut = false;
  let writer: ReturnType<typeof spawn> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const hardStop = setTimeout(() => child.kill("SIGKILL"), 8000);
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.stdout.on("data", (data) => {
    output += data;
    if (!entered && output.includes("OPERATION_ENTRY")) {
      entered = true;
      watchdog = setTimeout(() => {
        timedOut = true;
        if (fifo)
          writer = spawn(
            process.execPath,
            [
              "-e",
              `const fs=require('node:fs');const fd=fs.openSync(${JSON.stringify(fifo)},'w');fs.writeSync(fd,'{}');fs.closeSync(fd);`,
            ],
            { stdio: "ignore" },
          );
      }, 1000);
    }
  });
  const code = await new Promise<number | null>((done) => child.on("close", done));
  clearTimeout(hardStop);
  clearTimeout(watchdog);
  if (writer) {
    // The original child should consume the watchdog writer and exit normally.
    if (writer.exitCode === null) writer.kill("SIGKILL");
    await new Promise<void>((done) => {
      if (writer!.exitCode !== null || writer!.signalCode !== null) done();
      else writer!.on("close", () => done());
    });
  }
  expect(entered, stderr).toBe(true);
  expect(code, output + stderr).toBe(0);
  expect(timedOut, `operation entered; watchdog writer released original child: ${output}`).toBe(
    false,
  );
  expect(output).toContain("RESULT:ConfigError:");
  expect(output).not.toContain(path);
}

describe("bounded diagnostic config reads", () => {
  test.each([limit, limit + 1])(
    "tracked whole document uses the same %s-byte budget",
    async (size) => {
      const f = await fixture();
      const env = {
        ...process.env,
        HOME: f.root,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
      };
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.email", "fixture@example.invalid"],
        ["config", "user.name", "Fixture"],
      ]) {
        expect(spawnSync("git", args, { cwd: f.root, env }).status).toBe(0);
      }
      await writeFile(f.path, valid + " ".repeat(size - Buffer.byteLength(valid)));
      expect(spawnSync("git", ["add", ".arashi/config.json"], { cwd: f.root, env }).status).toBe(0);
      expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: f.root, env }).status).toBe(0);
      await rm(f.path);
      if (size === limit)
        expect(
          (await readConfigForDiagnostics(f.root, { bareRepoPath: f.root }))?.config.version,
        ).toBe("1.0.0");
      else
        await expect(
          readConfigForDiagnostics(f.root, { bareRepoPath: f.root }),
        ).rejects.toBeInstanceOf(ConfigError);
    },
  );
  test.each(["directory", "oversize", "malformed", "valid"])(
    "personal %s retains semantics and read-only metadata",
    async (kind) => {
      const f = await fixture();
      if (kind === "directory") await mkdir(f.path);
      else
        await writeFile(
          f.path,
          kind === "malformed"
            ? "{"
            : JSON.stringify({ version: "1.0.0" }) + (kind === "oversize" ? " ".repeat(limit) : ""),
        );
      const before = await stat(f.path);
      const env = { ...process.env, HOME: f.root };
      if (kind === "valid")
        expect((await readUserConfigForDiagnostics(env))?.config.version).toBe("1.0.0");
      else
        await expect(readUserConfigForDiagnostics(env)).rejects.toBeInstanceOf(
          kind === "malformed" ? ConfigParseError : ConfigError,
        );
      const after = await stat(f.path);
      expect([after.mode, after.size, after.mtimeMs]).toEqual([
        before.mode,
        before.size,
        before.mtimeMs,
      ]);
    },
  );
  test("ordinary workspace and user loaders retain documents beyond diagnostic budget", async () => {
    const f = await fixture();
    await writeFile(f.path, valid + " ".repeat(limit));
    const { loadConfig } = await import("../../src/lib/config.ts");
    expect((await loadConfig(f.root)).version).toBe("1.0.0");
    await writeFile(f.path, JSON.stringify({ version: "1.0.0" }) + " ".repeat(limit));
    expect((await loadUserConfig({ ...process.env, HOME: f.root }))?.config.version).toBe("1.0.0");
  });
  test.skipIf(process.platform === "win32")(
    "rejects a character device symlink without reading it",
    async () => {
      const f = await fixture();
      await symlink("/dev/null", f.path);
      await expect(readConfigForDiagnostics(f.root)).rejects.toBeInstanceOf(ConfigError);
    },
  );
  test.each(["directory", "oversize", "UTF-8 oversize"])(
    "rejects %s with screened ConfigError",
    async (kind) => {
      const f = await fixture();
      if (kind === "directory") await mkdir(f.path);
      else
        await writeFile(
          f.path,
          kind === "oversize"
            ? valid + " ".repeat(limit)
            : JSON.stringify({
                version: "1.0.0",
                reposDir: "./repos",
                repos: {},
                $schema: "é".repeat(limit / 2),
              }),
        );
      await expect(readConfigForDiagnostics(f.root)).rejects.toBeInstanceOf(ConfigError);
    },
  );
  test.each([false, true])(
    "accepts a regular target (symlink %s) at the full byte budget without writes",
    async (linked) => {
      const f = await fixture();
      const target = linked ? join(f.root, "target.json") : f.path;
      const bytes = valid + " ".repeat(limit - Buffer.byteLength(valid));
      await writeFile(target, bytes, { mode: 0o640 });
      if (linked) await symlink(target, f.path);
      const before = await stat(target);
      expect((await readConfigForDiagnostics(f.root))?.config.version).toBe("1.0.0");
      const after = await stat(target);
      expect([after.mode, after.size, after.mtimeMs]).toEqual([
        before.mode,
        before.size,
        before.mtimeMs,
      ]);
      expect(await readFile(target, "utf8")).toBe(bytes);
    },
  );
  test("keeps malformed regular JSON in its existing error category", async () => {
    const f = await fixture();
    await writeFile(f.path, "{");
    await expect(readConfigForDiagnostics(f.root)).rejects.toBeInstanceOf(ConfigParseError);
  });
  test.skipIf(process.platform === "win32").each(["fifo", "symlink fifo"])(
    "rejects owned %s before its writer watchdog",
    async (kind) => {
      const f = await fixture();
      const fifo = kind === "fifo" ? f.path : join(f.root, "owned.fifo");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      if (kind !== "fifo") await symlink(fifo, f.path);
      await probe(f.root, f.path, "workspace", fifo);
    },
  );
  test.skipIf(process.platform === "win32").each([false, true])(
    "rejects personal FIFO in context (workspace %s)",
    async (workspace) => {
      const f = await fixture();
      expect(spawnSync("mkfifo", [f.path]).status).toBe(0);
      let cwd = f.root;
      if (workspace) {
        cwd = join(f.root, "repo");
        await mkdir(join(cwd, ".arashi"), { recursive: true });
        expect(spawnSync("git", ["init", cwd]).status).toBe(0);
        await writeFile(join(cwd, ".arashi/config.json"), valid);
      }
      await probe(cwd, f.path, "personal", f.path, f.root);
    },
  );
});
