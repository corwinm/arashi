import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeGeneratedSource } from "../../src/completion/generated-source.ts";

describe("generated completion source freshness", () => {
  test("normalizes checked-out line endings without hiding content drift", () => {
    expect(normalizeGeneratedSource("first\r\nsecond\rthird\n")).toBe("first\nsecond\nthird\n");
    expect(normalizeGeneratedSource("first\r\nsecond\n")).not.toBe("first\nchanged\n");
  });

  test("uses normalized source for the freshness comparison", () => {
    const script = readFileSync(resolve("scripts/completions.ts"), "utf8");
    expect(script).toContain('normalizeGeneratedSource(readFileSync(outputPath, "utf8"))');
  });
});
