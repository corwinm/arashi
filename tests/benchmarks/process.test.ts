import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

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
});
