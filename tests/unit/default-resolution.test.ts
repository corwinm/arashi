import { describe, expect, test } from "bun:test";
import { resolveDefaultWithPrecedence } from "../../src/lib/default-resolution.ts";

describe("resolveDefaultWithPrecedence", () => {
  test("prefers explicit values over all other sources", () => {
    const resolved = resolveDefaultWithPrecedence({
      explicitValue: true,
      hasExplicitValue: true,
      optOut: true,
      configValue: false,
      builtInValue: false,
    });

    expect(resolved).toEqual({
      value: true,
      source: "explicit",
    });
  });

  test("applies opt-out before config defaults", () => {
    const resolved = resolveDefaultWithPrecedence({
      optOut: true,
      configValue: "sesh",
      builtInValue: "auto",
    });

    expect(resolved).toEqual({
      value: "auto",
      source: "opt-out",
    });
  });

  test("uses config value when no explicit value or opt-out is present", () => {
    const resolved = resolveDefaultWithPrecedence({
      configValue: true,
      builtInValue: false,
    });

    expect(resolved).toEqual({
      value: true,
      source: "config",
    });
  });

  test("falls back to built-in defaults", () => {
    const resolved = resolveDefaultWithPrecedence({
      builtInValue: "auto",
    });

    expect(resolved).toEqual({
      value: "auto",
      source: "built-in",
    });
  });
});
