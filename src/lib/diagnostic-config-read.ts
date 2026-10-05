import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Diagnostic-only whole-document budget, matching completion's existing 1 MiB
// config budget. Ordinary workspace/personal loaders have no byte limit and are
// intentionally unchanged. This is not hasBareConfig's 4 KiB evidence policy.
export const MAX_DIAGNOSTIC_CONFIG_BYTES = 1024 * 1024;

/** Follow regular-file symlinks, but never open a FIFO as a blocking stream. */
export async function readDiagnosticConfigText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_DIAGNOSTIC_CONFIG_BYTES) {
      throw new Error("Invalid diagnostic configuration target");
    }
    // Count actual bytes as well as stat size: the file may grow after fstat.
    // Limit + 1 distinguishes a document exactly at the limit from overflow.
    const buffer = Buffer.alloc(MAX_DIAGNOSTIC_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_DIAGNOSTIC_CONFIG_BYTES) {
      throw new Error("Diagnostic configuration exceeds byte budget");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}
