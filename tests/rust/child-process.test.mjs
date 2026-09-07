import { terminateChild, waitForOutput } from "./child-process.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

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
