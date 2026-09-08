// Cross-language filesystem locking, NOT Kitty vendor acceptance.
// MANAGED_TEST_BIN=/absolute/test-binary node tests/rust/managed-launch-lock-interop.mjs
import { join, resolve } from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
const root = mkdtempSync(join(tmpdir(), "arashi-lock-interop-"));
const test = process.env.MANAGED_TEST_BIN;
assert.ok(test);
const source = pathToFileURL(resolve("src/lib/kitty-launcher.ts")).href;
const children = [];
function start(kind, timeout = 1000) {
  const code = `import {acquireKittyIdentityLock} from ${JSON.stringify(source)};
try {const lock=await acquireKittyIdentityLock('arashi-v1-interop',{lockRoot:process.env.LOCK_FIXTURE_ROOT,timeoutMs:${timeout}});console.log('LOCK_READY='+process.pid);process.stdin.once('data',async(data)=>{if(data.toString().trim()==='crash')process.exit(0);await lock.release();console.log('LOCK_RELEASED');process.exit(0);});process.stdin.resume();}
catch(e){console.log('LOCK_DENIED='+e.message);process.exit(0);}`;
  const child =
    kind === "rust"
      ? spawn(test, ["--ignored", "--exact", "native::lock_entry", "--nocapture"], {
          env: { ...process.env, LOCK_FIXTURE_ROOT: root, LOCK_FIXTURE_TIMEOUT: String(timeout) },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn("bun", ["-e", code], {
          env: { ...process.env, LOCK_FIXTURE_ROOT: root },
          stdio: ["pipe", "pipe", "pipe"],
        });
  let output = "";
  let errors = "";
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    errors += d;
  });
  const done = new Promise((ok, bad) => {
    child.on("error", bad);
    child.on("exit", (code) =>
      code === 0 ? ok() : bad(new Error(`exit ${code}: ${errors} ${output}`)),
    );
  });
  async function waitFor(token) {
    if (output.includes(token)) {
      return;
    }
    await new Promise((ok, bad) => {
      const timer = setTimeout(() => {
        cleanup();
        bad(new Error(`timeout ${token}: ${output} ${errors}`));
      }, 5000);
      const onData = () => {
        if (output.includes(token)) {
          cleanup();
          ok();
        }
      };
      const onExit = () => {
        if (!output.includes(token)) {
          cleanup();
          bad(new Error(`missing ${token}: ${output} ${errors}`));
        }
      };
      function cleanup() {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("exit", onExit);
      }
      child.stdout.on("data", onData);
      child.on("exit", onExit);
    });
  }
  const result = { child, done, waitFor };
  children.push(result);
  return result;
}
try {
  for (const kind of ["source", "rust"]) {
    for (const [spelling, pid, createdAt = "0"] of [
      ["decimal", `${process.pid}.0`],
      ["exponent", `${process.pid}e0`],
      ["duplicate", `0,"pid":${process.pid}`],
      ["extreme-created-at", `${process.pid}`, "1e400"],
      ["safe-integer-outside-os", "9007199254740991"],
    ]) {
      // Native capability failures must stay conservative, even when Bun reports absence.
      if (kind === "source" && spelling === "safe-integer-outside-os") {
        continue;
      }
      for (const suffix of ["", ".recovery"]) {
        const path = join(root, `arashi-v1-interop.lock${suffix}`);
        mkdirSync(path);
        const identity = `arashi-v1-interop${suffix ? ":recovery" : ""}`;
        const duplicates = spelling === "duplicate" ? '"identity":null,"owner":"old",' : "";
        const raw = `{${duplicates}"createdAt":${createdAt},"identity":${JSON.stringify(identity)},"owner":"live","pid":${pid}}`;
        writeFileSync(join(path, "owner.json"), raw);
        utimesSync(path, new Date(0), new Date(0));
        const waiter = start(kind, 80);
        waiter.child.stdin.end("release\n");
        await waiter.waitFor("LOCK_DENIED=");
        await waiter.done;
        assert.equal(readFileSync(join(path, "owner.json"), "utf8"), raw);
        assert.deepEqual(readdirSync(root), [`arashi-v1-interop.lock${suffix}`]);
        rmSync(path, { recursive: true });
        console.log(`PASS ${kind} ${spelling}${suffix} denied; exact aged owner bytes preserved`);
      }
    }
    for (const spelling of ["decimal", "exponent", "duplicate"]) {
      const holder = start(kind);
      await holder.waitFor("LOCK_READY=");
      const path = join(root, "arashi-v1-interop.lock", "owner.json");
      const owner = JSON.parse(readFileSync(path));
      const pid = {
        decimal: `${owner.pid}.0`,
        duplicate: `0,"pid":${owner.pid}`,
        exponent: `${owner.pid}e0`,
      }[spelling];
      const raw = JSON.stringify(owner).replace(/"pid":\d+/, `"pid":${pid}`);
      writeFileSync(path, raw);
      holder.child.stdin.end("release\n");
      await holder.waitFor("LOCK_RELEASED");
      await holder.done;
      assert.deepEqual(readdirSync(root), []);
      console.log(`PASS ${kind} releases equivalent ${spelling} owner`);
    }
  }
  for (const [holderKind, waiterKind] of [
    ["source", "rust"],
    ["rust", "source"],
  ]) {
    const holder = start(holderKind);
    await holder.waitFor("LOCK_READY=");
    const owner = JSON.parse(readFileSync(join(root, "arashi-v1-interop.lock", "owner.json")));
    assert.equal(owner.pid, holder.child.pid);
    const waiter = start(waiterKind, 80);
    await waiter.waitFor("LOCK_DENIED=");
    await waiter.done;
    assert.equal(
      JSON.parse(readFileSync(join(root, "arashi-v1-interop.lock", "owner.json"))).owner,
      owner.owner,
    );
    holder.child.stdin.end("release\n");
    await holder.waitFor("LOCK_RELEASED");
    await holder.done;
    assert.deepEqual(readdirSync(root), []);
    console.log(`PASS ${holderKind} holder excludes ${waiterKind}; verified owner and cleanup`);
  }
  for (const [crashedKind, recoveryKind] of [
    ["source", "rust"],
    ["rust", "source"],
  ]) {
    const crashed = start(crashedKind);
    await crashed.waitFor("LOCK_READY=");
    crashed.child.stdin.end("crash\n");
    await crashed.done;
    assert.equal(
      JSON.parse(readFileSync(join(root, "arashi-v1-interop.lock", "owner.json"))).pid,
      crashed.child.pid,
    );
    const recovery = start(recoveryKind);
    await recovery.waitFor("LOCK_READY=");
    assert.equal(
      JSON.parse(readFileSync(join(root, "arashi-v1-interop.lock", "owner.json"))).pid,
      recovery.child.pid,
    );
    recovery.child.stdin.end("release\n");
    await recovery.done;
    assert.deepEqual(readdirSync(root), []);
    console.log(`PASS ${recoveryKind} recovers real exited ${crashedKind} process and releases`);
  }
} finally {
  for (const { child } of children) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  await Promise.allSettled(children.map((c) => c.done));
  rmSync(root, { force: true, recursive: true });
}
