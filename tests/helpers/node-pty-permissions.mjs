import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensureDarwinSpawnHelperExecutable(require) {
  if (process.platform !== "darwin") return;

  const helper = join(
    dirname(require.resolve("node-pty")),
    "..",
    "prebuilds",
    `darwin-${process.arch}`,
    "spawn-helper",
  );
  if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
}
