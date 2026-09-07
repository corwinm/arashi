import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";

import { ensureDarwinSpawnHelperExecutable } from "./node-pty-permissions.mjs";

function spawnHelperFixture(mode) {
  const root = mkdtempSync(join(tmpdir(), "arashi-node-pty-permissions-"));
  const library = join(root, "node-pty", "lib", "index.js");
  const helper = join(root, "node-pty", "prebuilds", `darwin-${process.arch}`, "spawn-helper");
  mkdirSync(join(root, "node-pty", "lib"), { recursive: true });
  mkdirSync(join(root, "node-pty", "prebuilds", `darwin-${process.arch}`), {
    recursive: true,
  });
  writeFileSync(library, "");
  writeFileSync(helper, "");
  chmodSync(helper, mode);

  return {
    helper,
    require: { resolve: () => library },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("grants effective execute access without broadening restrictive permissions", () => {
  if (process.platform !== "darwin") return;
  const fixture = spawnHelperFixture(0o400);
  try {
    ensureDarwinSpawnHelperExecutable(fixture.require);
    accessSync(fixture.helper, constants.X_OK);
    assert.equal(statSync(fixture.helper).mode & 0o777, 0o500);
  } finally {
    fixture.cleanup();
  }
});

test("checks effective access instead of trusting an unrelated execute bit", () => {
  if (process.platform !== "darwin") return;
  const fixture = spawnHelperFixture(0o010);
  try {
    assert.throws(() => accessSync(fixture.helper, constants.X_OK));
    ensureDarwinSpawnHelperExecutable(fixture.require);
    accessSync(fixture.helper, constants.X_OK);
    assert.equal(statSync(fixture.helper).mode & 0o777, 0o110);
  } finally {
    fixture.cleanup();
  }
});
