import {
  buildCdDirective,
  getDirectiveContext,
  normalizeSpawnEnvironment,
  stripDirectiveEnvironment,
} from "../../../src/lib/shell-directives.ts";
import { describe, expect, test } from "bun:test";

describe("shell directives", () => {
  test("detects active directive context for supported shells", () => {
    expect(
      getDirectiveContext({
        ARASHI_DIRECTIVE_FILE: "/tmp/arashi-directive",
        ARASHI_SHELL: "bash",
      }),
    ).toEqual({
      filePath: "/tmp/arashi-directive",
      shell: "bash",
    });
  });

  test("returns null for incomplete directive context", () => {
    expect(getDirectiveContext({ ARASHI_DIRECTIVE_FILE: "/tmp/arashi-directive" })).toBeNull();
    expect(getDirectiveContext({ ARASHI_SHELL: "nu" })).toBeNull();
  });

  test("strips directive variables from child environments", () => {
    expect(
      stripDirectiveEnvironment({
        ARASHI_DIRECTIVE_FILE: "/tmp/arashi-directive",
        ARASHI_SHELL: "bash",
        PATH: "/usr/bin",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });

  test("normalizes child environments to string-only records", () => {
    expect(
      normalizeSpawnEnvironment({
        ARASHI_DIRECTIVE_FILE: "/tmp/arashi-directive",
        ARASHI_SHELL: "bash",
        HOME: "/tmp/home",
        OPTIONAL: undefined,
      }),
    ).toEqual({ HOME: "/tmp/home" });
  });

  test("escapes bash directives with single quotes", () => {
    expect(buildCdDirective("/tmp/it'\"s here", "bash")).toBe("cd -- '/tmp/it'\\''\"s here'\n");
  });

  test("escapes fish directives with double quotes", () => {
    expect(buildCdDirective('/tmp/space "quote" $HOME', "fish")).toBe(
      'cd -- "/tmp/space \\\"quote\\\" \\$HOME"\n',
    );
  });
});
