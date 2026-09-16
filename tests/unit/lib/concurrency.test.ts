import { describe, expect, test, vi } from "vitest";
import mapWithConcurrency from "../../../src/lib/concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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

  test("stops queued work after failure and waits for in-flight work", async () => {
    const failure = new Error("first mapper failure");
    const releases = [deferred<number>(), deferred<number>()];
    const started: number[] = [];
    let settled = false;

    const outcomePromise = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      return releases[value].promise;
    })
      .finally(() => {
        settled = true;
      })
      .catch((error: unknown) => error);

    expect(started).toEqual([0, 1]);
    releases[0].reject(failure);
    await nextEventLoopTurn();

    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);

    releases[1].resolve(1);

    await expect(outcomePromise).resolves.toBe(failure);
    expect(started).toEqual([0, 1]);
  });

  test("observes every in-flight rejection without changing the first error", async () => {
    const failures = [
      new Error("first observed failure"),
      new Error("second observed failure"),
      new Error("third observed failure"),
    ];
    const releases = failures.map(() => deferred<number>());
    const started: number[] = [];
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      const outcomePromise = mapWithConcurrency([0, 1, 2, 3, 4], 3, async (value) => {
        started.push(value);
        return releases[value].promise;
      }).catch((error: unknown) => error);

      expect(started).toEqual([0, 1, 2]);
      releases[1].reject(failures[1]);
      await nextEventLoopTurn();
      releases[0].reject(failures[0]);
      releases[2].reject(failures[2]);

      await expect(outcomePromise).resolves.toBe(failures[1]);
      await nextEventLoopTurn();
      expect(started).toEqual([0, 1, 2]);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandledRejection);
    }
  });

  test("maps an empty input without calling the mapper", async () => {
    const mapper = vi.fn<(value: number) => Promise<number>>();

    await expect(mapWithConcurrency([], 2, mapper)).resolves.toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  test("rejects a non-integer concurrency limit", async () => {
    await expect(mapWithConcurrency([1], 1.5, async (value) => value)).rejects.toThrow(
      "Concurrency limit must be a positive integer",
    );
  });
});
