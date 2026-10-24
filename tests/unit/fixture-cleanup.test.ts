import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { removeTemporaryDirectory } from "../helpers/cleanup.ts";

for (const transient of [true, false]) {
  test.skipIf(process.platform !== "win32")(
    transient
      ? "removes a fixture after a transient Windows directory lock"
      : "surfaces an exhausted Windows directory lock",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "arashi-cleanup-lock-"));
      const child = spawn(
        process.execPath,
        [
          "-e",
          transient
            ? "process.stdout.write('ready'); setTimeout(() => process.exit(0), 200)"
            : "process.stdout.write('ready'); setInterval(() => {}, 1000)",
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = once(child, "close");
      try {
        await once(child.stdout!, "data");
        // Calibrate the actual native lock before exercising the cleanup policy.
        expect(() => rmSync(root, { recursive: true })).toThrow();
        if (transient) {
          await removeTemporaryDirectory(root);
          expect(existsSync(root)).toBe(false);
        } else {
          await expect(removeTemporaryDirectory(root)).rejects.toThrow();
          expect(existsSync(root)).toBe(true);
        }
      } finally {
        child.kill();
        await closed;
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );
}
