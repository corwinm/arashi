import { describe, expect, test } from "vitest";
import { cliRuntime, nodeRuntime } from "../../scripts/benchmark/runtime.ts";

describe("benchmark runtime metadata", () => {
  test("does not claim an embedded runtime version for a compiled executable", () => {
    expect(cliRuntime(false)).toEqual({
      method: "compiled-executable",
      name: "bun",
      version: {
        available: false,
        reason:
          "The embedded Bun runtime version is not introspected from the compiled executable.",
      },
    });
  });

  test("preserves source-mode Node runtime metadata", () => {
    expect(cliRuntime(true)).toEqual(nodeRuntime("node-source"));
  });
});
