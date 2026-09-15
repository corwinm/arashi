import { describe, expect, test, vi } from "vitest";
import mapWithConcurrency from "../../../src/lib/concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency()", () => {
  test("obeys the concurrency bound and preserves input order", async () => {
    const releases = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;

    const resultPromise = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const result = await releases[value].promise;
      active -= 1;
      return result;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releases[1].resolve(10);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases[2].resolve(20);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[0].resolve(0);
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    releases[4].resolve(40);
    releases[3].resolve(30);

    await expect(resultPromise).resolves.toEqual([0, 10, 20, 30, 40]);
    expect(maximumActive).toBe(2);
  });

  test("rejects a non-positive concurrency limit", async () => {
    await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow(
      "Concurrency limit must be a positive integer",
    );
  });
});
