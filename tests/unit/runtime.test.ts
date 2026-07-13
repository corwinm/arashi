import { describe, expect, test } from "vitest";
import { prepareSpawnCommand } from "../../src/lib/runtime.ts";

describe("prepareSpawnCommand", () => {
  test("runs Windows package-manager shims through cmd.exe without enabling a shell", () => {
    expect(
      prepareSpawnCommand(["pnpm.cmd", "install", "package & echo injected"], "win32", {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"pnpm.cmd" "install" "package ^& echo injected"'],
    });
  });

  test("leaves native executables and non-Windows commands unchanged", () => {
    expect(prepareSpawnCommand(["pnpm", "install"], "darwin", {})).toEqual({
      command: "pnpm",
      args: ["install"],
    });
    expect(prepareSpawnCommand(["node.exe", "script.js"], "win32", {})).toEqual({
      command: "node.exe",
      args: ["script.js"],
    });
  });
});
