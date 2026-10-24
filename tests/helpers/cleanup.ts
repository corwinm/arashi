import { rm } from "node:fs/promises";

export async function removeTemporaryDirectory(directory: string): Promise<void> {
  // Git for Windows' launcher can exit before its short-lived child releases cwd.
  // Retry only fs.rm's transient errors; exhaustion still fails the owning test.
  await rm(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
}
