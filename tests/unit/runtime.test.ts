import { describe, expect, test } from "vitest";
import { prepareSpawnCommand, spawn } from "../../src/lib/runtime.ts";
import { fileURLToPath } from "node:url";

describe("prepareSpawnCommand", () => {
  test("runs Windows package-manager shims through cmd.exe without enabling a shell", () => {
    expect(
      prepareSpawnCommand(["pnpm.cmd", "install", "package & echo injected"], "win32", {
        comspec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      args: [
        "/d",
        "/v:off",
        "/s",
        "/c",
        '"%ARASHI_CMD_ARGUMENT_0% %ARASHI_CMD_ARGUMENT_1% %ARASHI_CMD_ARGUMENT_2%"',
      ],
      command: "C:\\Windows\\System32\\cmd.exe",
      env: {
        ARASHI_CMD_ARGUMENT_0: '"pnpm.cmd"',
        ARASHI_CMD_ARGUMENT_1: '"install"',
        ARASHI_CMD_ARGUMENT_2: '"package & echo injected"',
        comspec: "C:\\Windows\\System32\\cmd.exe",
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
          ARASHI_CMD_ARGUMENT_99: "hostile",
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
        '"%ARASHI_CMD_ARGUMENT_0% %ARASHI_CMD_ARGUMENT_1% %ARASHI_CMD_ARGUMENT_2% %ARASHI_CMD_ARGUMENT_3% %ARASHI_CMD_ARGUMENT_4% %ARASHI_CMD_ARGUMENT_5%"',
      ],
      command: "custom-cmd.exe",
      env: {
        ARASHI_CMD_ARGUMENT_0: String.raw`"C:\Program Files\pnpm.cmd"`,
        ARASHI_CMD_ARGUMENT_1: '""',
        ARASHI_CMD_ARGUMENT_2: String.raw`"embedded \"quote\""`,
        ARASHI_CMD_ARGUMENT_3:
          '"100% %PATH% %CD% %NAME:old=new% !important! ^ caret & pipe| <in> (group)"',
        ARASHI_CMD_ARGUMENT_4: String.raw`"trailing\\"`,
        ARASHI_CMD_ARGUMENT_5: String.raw`"slashes\\\\\"quote"`,
        COMSPEC: "custom-cmd.exe",
        Path: String.raw`C:\Windows`,
      },
      windowsVerbatimArguments: true,
    });
  });

  test("uses the canonical call form only for lifecycle batch hooks", () => {
    expect(
      prepareSpawnCommand(
        [String.raw`C:\hook path %TEAM% !&()\pre-create.cmd`],
        "win32",
        { ARASHI_CMD_LITERAL_PERCENT: "hostile", COMSPEC: "cmd.exe", TEAM: "expanded" },
        false,
        true,
      ),
    ).toMatchObject({
      args: ["/d", "/e:on", "/v:off", "/s", "/c", '"call %ARASHI_CMD_ARGUMENT_0%"'],
      command: "cmd.exe",
      env: {
        ARASHI_CMD_ARGUMENT_0: String.raw`"C:\hook path %ARASHI_CMD_LITERAL_PERCENT%TEAM%ARASHI_CMD_LITERAL_PERCENT% !&()\pre-create.cmd"`,
        ARASHI_CMD_LITERAL_PERCENT: "%",
        COMSPEC: "cmd.exe",
        TEAM: "expanded",
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
