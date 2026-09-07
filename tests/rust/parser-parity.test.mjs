import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { tmpdir } from "node:os";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const parserParity = join(root, "tests/rust/parser-parity.mjs");

function runWithFaults(faults, { primary = false } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "arashi-parser-lifecycle-test-"));
  const preload = join(fixture, "faults.cjs");
  const source = join(fixture, "source.mjs");
  const report = join(fixture, "report.json");
  writeFileSync(source, "");
  writeFileSync(
    preload,
    `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const configured = new Set(JSON.parse(process.env.ARASHI_PARSER_TEST_FAULTS));
const faults = Object.fromEntries([...configured].map((kind) => {
  const error = new Error(kind + " failure");
  error.kind = kind;
  return [kind, error];
}));
const originalWriteFileSync = fs.writeFileSync;
const originalReaddirSync = fs.readdirSync;
const originalRmSync = fs.rmSync;
const attempts = { cleanup: false, mutation: false, report: false };
fs.writeFileSync = (path, ...args) => {
  if (String(path).endsWith("parser-help.json")) return;
  if (String(path) === process.env.ARASHI_PARSER_TEST_REPORT) {
    attempts.report = true;
    if (faults.report) throw faults.report;
  }
  return originalWriteFileSync(path, ...args);
};
fs.readdirSync = (...args) => {
  attempts.mutation = true;
  if (faults.mutation) throw faults.mutation;
  return originalReaddirSync(...args);
};
fs.rmSync = (...args) => {
  attempts.cleanup = true;
  originalRmSync(...args);
  if (faults.cleanup) throw faults.cleanup;
};
syncBuiltinESMExports();
process.on("uncaughtException", (error) => {
  const errors = error instanceof AggregateError ? error.errors : [error];
  const identify = (entry) =>
    entry?.kind ?? entry?.code ?? (entry?.message?.startsWith('{"command"') ? "primary" : entry?.message);
  console.error("PARSER_LIFECYCLE_ERROR:" + JSON.stringify({
    attempts,
    cause: error.cause ? identify(error.cause) : null,
    errors: errors.map(identify),
    name: error.name,
    same: Object.fromEntries(Object.entries(faults).map(([kind, fault]) => [kind, error === fault])),
  }));
  process.exitCode = 86;
});
`,
  );
  const output = spawnSync(
    process.execPath,
    ["--require", preload, parserParity, join(fixture, "unused-binary"), report, "--capture-help"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ARASHI_PARSER_TEST_FAULTS: JSON.stringify(faults),
        ARASHI_PARSER_TEST_REPORT: report,
        ARASHI_TS_SOURCE: primary ? join(fixture, "missing-source.mjs") : source,
      },
      timeout: 30_000,
    },
  );
  rmSync(fixture, { force: true, recursive: true });
  assert.equal(output.status, 86, output.stderr || output.stdout);
  const line = output.stderr
    .split("\n")
    .find((entry) => entry.startsWith("PARSER_LIFECYCLE_ERROR:"));
  assert.ok(line, output.stderr || output.stdout);
  return JSON.parse(line.slice("PARSER_LIFECYCLE_ERROR:".length));
}

test("parser parity preserves each lifecycle failure unchanged when alone", () => {
  const primary = runWithFaults([], { primary: true });
  assert.equal(primary.name, "Error");
  assert.deepEqual(primary.errors, ["primary"]);
  assert.equal(primary.cause, null);
  assert.deepEqual(primary.attempts, { cleanup: true, mutation: true, report: true });

  for (const kind of ["report", "mutation", "cleanup"]) {
    const error = runWithFaults([kind]);
    assert.equal(error.name, "Error");
    assert.deepEqual(error.errors, [kind]);
    assert.equal(error.same[kind], true);
    assert.deepEqual(error.attempts, { cleanup: true, mutation: true, report: true });
  }
});

test("parser parity aggregates lifecycle failures in deterministic order", () => {
  const error = runWithFaults(["report", "mutation", "cleanup"], { primary: true });
  assert.equal(error.name, "AggregateError");
  assert.deepEqual(error.errors, ["primary", "report", "mutation", "cleanup"]);
  assert.equal(error.cause, "primary");
  assert.deepEqual(error.attempts, { cleanup: true, mutation: true, report: true });
});
