import { describe, expect, test } from "vitest";
import { summarizeDurations } from "../../scripts/benchmark/statistics.ts";

describe("benchmark statistics", () => {
  test("reports the median and nearest-rank p95 without rounding samples", () => {
    expect(summarizeDurations([9, 1, 7, 3, 5, 11])).toEqual({
      medianMs: 6,
      p95Ms: 11,
      samplesMs: [1, 3, 5, 7, 9, 11],
    });
  });

  test("rejects an empty measured sample", () => {
    expect(() => summarizeDurations([])).toThrow("at least one measured sample");
  });
});
