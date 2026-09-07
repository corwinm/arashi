import { terminateChild, waitForOutput } from "./child-process.mjs";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

function nodeEmitter() {
  // Node child processes and streams use EventEmitter rather than EventTarget.
  // oxlint-disable-next-line unicorn/prefer-event-target
  return new EventEmitter();
}

function nodeChild(source) {
  return spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

test("waitForOutput accumulates a readiness marker split across chunks", async () => {
  const child = nodeChild(
    "process.stdout.write('LOC'); setTimeout(() => process.stdout.write('KED'), 25); setInterval(() => {}, 1000)",
  );
  try {
    assert.match(await waitForOutput(child, "LOCKED", 1000), /LOCKED/);
  } finally {
    await terminateChild(child, 1000);
  }
});

test("waitForOutput drains output emitted between child exit and close", async () => {
  const child = nodeEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = nodeEmitter();
  child.stderr = nodeEmitter();

  const output = waitForOutput(child, "LOCKED", 1000);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.emit("data", Buffer.from("LOCKED"));
  child.emit("close", 0, null);

  assert.equal(await output, "LOCKED");
});

test("waitForOutput retains diagnostics emitted between child exit and close", async () => {
  const child = nodeEmitter();
  child.exitCode = 7;
  child.signalCode = null;
  child.stdout = nodeEmitter();
  child.stderr = nodeEmitter();

  const output = waitForOutput(child, "LOCKED", 1000);
  child.emit("exit", 7, null);
  child.stderr.emit("data", Buffer.from("late holder failure"));
  child.emit("close", 7, null);

  await assert.rejects(output, /exited with code 7.*late holder failure/s);
});

test("waitForOutput rejects when the child exits before readiness", async () => {
  const child = nodeChild("process.stderr.write('holder failed'); process.exit(7)");
  await assert.rejects(waitForOutput(child, "LOCKED", 1000), /exited with code 7.*holder failed/s);
});

test("waitForOutput rejects when the child cannot start", async () => {
  const child = spawn(`missing-arashi-lock-holder-${process.pid}`, [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await assert.rejects(waitForOutput(child, "LOCKED", 1000), /failed.*ENOENT/s);
});

test("waitForOutput times out when readiness is absent", async () => {
  const child = nodeChild("setInterval(() => {}, 1000)");
  try {
    await assert.rejects(waitForOutput(child, "LOCKED", 50), /timed out.*LOCKED/i);
  } finally {
    await terminateChild(child, 1000);
  }
});

test("terminateChild kills the exact child and bounds the close wait", async () => {
  const listeners = new Map();
  const child = {
    exitCode: null,
    off(event, listener) {
      if (listeners.get(event) === listener) {
        listeners.delete(event);
      }
    },
    once(event, listener) {
      listeners.set(event, listener);
    },
    signalCode: null,
  };
  let kills = 0;
  child.kill = () => {
    kills += 1;
    return true;
  };

  await assert.rejects(terminateChild(child, 25), /did not close within 25ms/);
  assert.equal(kills, 1);
});
