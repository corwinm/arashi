import { describe, expect, test } from "vitest";
import { executableNamesForPlatform } from "../../scripts/benchmark/platform.ts";

describe("benchmark executable paths", () => {
  test("accepts Bun's native and explicit Windows executable names", () => {
    expect(executableNamesForPlatform("win32")).toEqual(["arashi.bin.exe", "arashi.bin"]);
  });

  test("uses the extensionless executable on macOS and Linux", () => {
    expect(executableNamesForPlatform("darwin")).toEqual(["arashi.bin"]);
    expect(executableNamesForPlatform("linux")).toEqual(["arashi.bin"]);
  });
});
