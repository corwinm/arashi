import { withWorkspaceTransactionLock } from "../../src/lib/workspace-transaction-lock.ts";
import { mkdtemp, open, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const [path, ready, release] = process.argv.slice(2);
if (path === "--regressions") {
  const dir = await mkdtemp(join(tmpdir(), "arashi-source-lock-"));
  const lock = join(dir, "lock");
  let pin;
  let writer;
  try {
    for (const [bytes, live] of [
      [`{"pid":${process.pid},"pid":${process.pid},"token":"live"}`, true],
      [`{"pid":"invalid","pid":${process.pid}.0,"token":"live"}`, true],
      [`{"pid":${process.pid}e0,"token":null,"token":"live"}`, true],
      [`{"pid":${process.pid},"token":"old","token":"live"}`, true],
      [`{"pid":${process.pid},"pid":"invalid","token":"live"}`, false],
      [`{"pid":${process.pid},"pid":1.5,"token":"live"}`, false],
      [`{"pid":${process.pid},"token":"live","token":null}`, false],
    ]) {
      await writeFile(lock, bytes);
      // Isolate owner validity from sub-millisecond mtime/Date.now rounding.
      await utimes(lock, 0, 0);
      let entered = false;
      const run = () =>
        withWorkspaceTransactionLock(
          lock,
          async () => {
            entered = true;
          },
          0,
          2,
        );
      if (live) {
        await assert.rejects(run, /Timed out waiting/);
        assert.equal(entered, false);
        assert.equal(await readFile(lock, "utf8"), bytes);
      } else {
        await run();
        assert.equal(entered, true);
        await assert.rejects(readFile(lock), { code: "ENOENT" });
      }
    }
    console.log("PASS source duplicate-member final-value matrix");

    // Instrument only a disposable copy of the oracle, at its initial stat read.
    // The reclaim decision is unchanged. Production source is never rewritten.
    const sourceUrl = new URL("../../src/lib/workspace-transaction-lock.ts", import.meta.url);
    let source = await readFile(sourceUrl, "utf8");
    const boundary = "lockStat = await stat(lockPath);";
    assert.equal(source.split(boundary).length, 2);
    source = source
      .replace(boundary, `${boundary} await globalThis.__workspaceLockSwap();`)
      .replace('"./git.ts"', JSON.stringify(new URL("./git.ts", sourceUrl).href));
    const copy = join(dir, "scheduled.ts");
    await writeFile(copy, source);
    const { withWorkspaceTransactionLock: scheduled } = await import(pathToFileURL(copy).href);
    pin = await open(lock, "wx");
    await pin.utimes(0, 0);
    globalThis.__workspaceLockSwap = async () => {
      await rm(lock);
      writer = await open(lock, "wx");
    };
    await assert.rejects(
      () =>
        scheduled(
          lock,
          async () => {
            assert.fail("fresh incomplete writer must exclude acquisition");
          },
          30_000,
          1,
        ),
      /Timed out waiting/,
    );
    assert.equal(await readFile(lock, "utf8"), "");
    await writer.writeFile(JSON.stringify({ pid: process.pid, token: "writer" }));
    await writer.sync();
    await assert.rejects(
      () => withWorkspaceTransactionLock(lock, async () => assert.fail("live writer"), 0, 2),
      /Timed out waiting/,
    );
    console.log("PASS source fresh incomplete generation keeps its own grace");
  } finally {
    delete globalThis.__workspaceLockSwap;
    await writer?.close();
    await pin?.close();
    await rm(dir, { recursive: true, force: true });
  }
} else {
  await withWorkspaceTransactionLock(
    path,
    async () => {
      await writeFile(ready, "ready");
      if (release === "stdin") await new Promise((resolve) => process.stdin.once("data", resolve));
    },
    30_000,
    5,
  );
}
