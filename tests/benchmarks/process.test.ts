import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("benchmark process completion", () => {
  test("waits for close so stdout can drain after process exit", async () => {
    const { waitForProcessClose } = await import("../../scripts/benchmark/process.ts");
    const child = new EventEmitter();
    const settled = vi.fn();

    const completion = waitForProcessClose(child);
    void completion.then(settled);
    child.emit("exit", 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    child.emit("close", 0);
    await expect(completion).resolves.toBe(0);
  });

  test("uses close-waiting for fixture Git and does not leave stdout pipes unread", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "scripts", "benchmark", "fixtures.ts"),
      "utf8",
    );

    expect(source).toContain('import { waitForProcessClose } from "./process.ts";');
    expect(source).toContain("await waitForProcessClose(child)");
    expect(source).not.toContain('child.once("exit"');
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(source).toContain('child.stdout.setEncoding("utf8").on("data"');
  });
});
