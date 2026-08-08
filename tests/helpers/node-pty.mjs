import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as pty from "node-pty";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const helper = join(
    dirname(require.resolve("node-pty")),
    "..",
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
}

export const spawnPty = pty.spawn;
