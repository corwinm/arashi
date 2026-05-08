import { describe, expect, test } from "bun:test";
import { resolveDefaultWithPrecedence } from "../../src/lib/default-resolution.ts";

describe("resolveDefaultWithPrecedence", () => {
  test("prefers explicit values over all other sources", () => {
    const resolved = resolveDefaultWithPrecedence({
      builtInValue: false,
      configValue: false,
      explicitValue: true,
      hasExplicitValue: true,
      optOut: true,
    });

    expect(resolved).toEqual({
      source: "explicit",
      value: true,
    });
  });

  test("applies opt-out before config defaults", () => {
    const resolved = resolveDefaultWithPrecedence({
      builtInValue: "auto",
      configValue: "sesh",
      optOut: true,
    });

    expect(resolved).toEqual({
      source: "opt-out",
      value: "auto",
    });
  });

  test("uses config value when no explicit value or opt-out is present", () => {
    const resolved = resolveDefaultWithPrecedence({
      builtInValue: false,
      configValue: true,
    });

    expect(resolved).toEqual({
      source: "config",
      value: true,
    });
  });

  test("falls back to built-in defaults", () => {
    const resolved = resolveDefaultWithPrecedence({
      builtInValue: "auto",
    });

    expect(resolved).toEqual({
      source: "built-in",
      value: "auto",
    });
  });
});
