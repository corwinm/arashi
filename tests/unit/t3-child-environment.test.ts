import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { nativeChildEnvironment } from "../../src/lib/t3-native.ts";
import { promisify } from "node:util";

const directiveKeys = ["ARASHI_DIRECTIVE_FILE", "arashi_directive_file", "ArAsHi_DiReCtIvE_FiLe"];

describe("native child environment", () => {
  test("POSIX exact-case omission preserves unrelated keys and selected profile without mutation", () => {
    const extra = Object.fromEntries(directiveKeys.map((key) => [key, "fixture-only"]));
    const before = { ...extra };
    const result = nativeChildEnvironment(
      { ...extra, PATH: "fixture-path", T3CODE_HOME: "selected profile" },
      "darwin",
    );
    expect(Object.keys(result)).not.toContain("ARASHI_DIRECTIVE_FILE");
    expect(result.arashi_directive_file === extra.arashi_directive_file).toBe(true);
    expect(result.ArAsHi_DiReCtIvE_FiLe === extra.ArAsHi_DiReCtIvE_FiLe).toBe(true);
    expect(result.T3CODE_HOME === "selected profile").toBe(true);
    expect(result.PATH === "fixture-path").toBe(true);
    expect(extra).toEqual(before);
  });

  test("Windows simulation removes every case-equivalent directive through stateful environment merges", () => {
    // Pure platform injection, not native Windows execution or a global platform patch.
    let state: NodeJS.ProcessEnv = { Path: "fixture-path", T3CODE_HOME: "selected profile" };
    for (const key of directiveKeys) {
      state = { ...state, [key]: "fixture-only" };
      const before = { ...state };
      const child = nativeChildEnvironment(state, "win32");
      expect(
        Object.keys(child).filter((name) => name.toUpperCase() === "ARASHI_DIRECTIVE_FILE"),
      ).toEqual([]);
      expect(child.Path === state.Path).toBe(true);
      expect(child.T3CODE_HOME === state.T3CODE_HOME).toBe(true);
      expect(state).toEqual(before);
    }
  });

  test("default Bun process boundary: exact argv/CWD/profile, no shell/directive/UI effects", async () => {
    const { stdout } = await promisify(execFile)(
      "bun",
      ["tests/helpers/t3-child-boundary-probe.ts"],
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    const result = JSON.parse(stdout);
    expect(result.runtime).toBe("bun");
    expect(result.operations).toEqual([
      "version",
      "version",
      "issue",
      "revoke",
      "list",
      "issue",
      "revoke",
    ]);
    expect(result.denied).toBe(4);
    expect(result.shellCalibrated).toBe(true);
    expect(result.directiveUnchanged).toBe(true);
    expect(result.parentCwdUnchanged).toBe(true);
    expect(result.shellMarkerAbsent).toBe(true);
    expect(result.ledger).toHaveLength(7);
    for (const row of result.ledger) {
      expect(row.cliExact).toBe(true);
      expect(row.cwdExact).toBe(true);
      expect(row.profileExact).toBe(true);
      expect(row.envKeys.some((key: string) => key === "ARASHI_DIRECTIVE_FILE")).toBe(false);
    }
  }, 35_000);
});
