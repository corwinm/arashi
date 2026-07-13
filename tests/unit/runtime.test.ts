import { describe, expect, test } from "vitest";
import { prepareSpawnCommand, spawn } from "../../src/lib/runtime.ts";
import { fileURLToPath } from "node:url";

describe("prepareSpawnCommand", () => {
  test("runs Windows package-manager shims through cmd.exe without enabling a shell", () => {
    expect(
      prepareSpawnCommand(["pnpm.cmd", "install", "package & echo injected"], "win32", {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      args: ["/d", "/v:off", "/s", "/c", '"pnpm.cmd ^"install^" ^"package^ ^&^ echo^ injected^""'],
      command: "C:\\Windows\\System32\\cmd.exe",
      env: {
        ARASHI_CMD_LITERAL_PERCENT: "%",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      windowsVerbatimArguments: true,
    });
  });

  test("quotes hostile and loss-prone batch-file arguments for cmd.exe", () => {
    expect(
      prepareSpawnCommand(
        [
          String.raw`C:\Program Files\pnpm.cmd`,
          "",
          'embedded "quote"',
          "100% %PATH% %CD% %NAME:old=new% !important! ^ caret & pipe| <in> (group)",
          "trailing\\",
          String.raw`slashes\\"quote`,
        ],
        "win32",
        {
          ARASHI_CMD_LITERAL_PERCENT: "hostile",
          COMSPEC: "custom-cmd.exe",
          Path: String.raw`C:\Windows`,
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/v:off",
        "/s",
        "/c",
        String.raw`"C:\Program^ Files\pnpm.cmd ^"^" ^"embedded^ \^"quote\^"^" ^"100%ARASHI_CMD_LITERAL_PERCENT%^ %ARASHI_CMD_LITERAL_PERCENT%PATH%ARASHI_CMD_LITERAL_PERCENT%^ %ARASHI_CMD_LITERAL_PERCENT%CD%ARASHI_CMD_LITERAL_PERCENT%^ %ARASHI_CMD_LITERAL_PERCENT%NAME:old=new%ARASHI_CMD_LITERAL_PERCENT%^ ^!important^!^ ^^^ caret^ ^&^ pipe^|^ ^<in^>^ ^(group^)^" ^"trailing\\^" ^"slashes\\\\\\^"quote^""`,
      ],
      command: "custom-cmd.exe",
      env: {
        ARASHI_CMD_LITERAL_PERCENT: "%",
        COMSPEC: "custom-cmd.exe",
        Path: String.raw`C:\Windows`,
      },
      windowsVerbatimArguments: true,
    });
  });

  test("leaves native executables and non-Windows commands unchanged", () => {
    expect(prepareSpawnCommand(["pnpm", "install"], "darwin", {})).toEqual({
      args: ["install"],
      command: "pnpm",
      windowsVerbatimArguments: false,
    });
    expect(prepareSpawnCommand(["node.exe", "script.js"], "win32", {})).toEqual({
      args: ["script.js"],
      command: "node.exe",
      windowsVerbatimArguments: false,
    });
  });

  test.runIf(process.platform === "win32")(
    "preserves arguments when a batch file actually runs through cmd.exe",
    async () => {
      const fixture = fileURLToPath(new URL("../fixtures/record-argv.cmd", import.meta.url));
      const expected = [
        "",
        'embedded "quote"',
        "100% %PATH% %CD% %NAME:old=new% !important! ^ caret & pipe| <in> (group)",
        "trailing\\",
        String.raw`slashes\\"quote`,
      ];
      const child = spawn([fixture, ...expected]);
      const stdout = await new Response(child.stdout).text();

      expect(await child.exited).toBe(0);
      expect(JSON.parse(stdout)).toEqual(expected);
    },
  );
});
