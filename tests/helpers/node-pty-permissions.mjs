import { accessSync, chmodSync, constants, statSync } from "node:fs";
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
  try {
    accessSync(helper, constants.X_OK);
    return;
  } catch (error) {
    if (error.code !== "EACCES") throw error;
  }

  const stats = statSync(helper);
  const groups = new Set([process.getgid(), ...process.getgroups()]);
  const executeBit = process.getuid() === stats.uid ? 0o100 : groups.has(stats.gid) ? 0o010 : 0o001;
  chmodSync(helper, stats.mode | executeBit);
  accessSync(helper, constants.X_OK);
}
