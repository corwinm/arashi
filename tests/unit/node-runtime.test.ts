import { describe, expect, test } from "vitest";
import { resolveTestCommand } from "../helpers/node-runtime.ts";

describe("Node test runtime", () => {
  test("converts Windows TypeScript entrypoints to file URLs", () => {
    const command = resolveTestCommand(
      ["node", "--import", "tsx", "D:\\a\\arashi\\arashi\\src\\index.ts", "status"],
      "win32",
    );

    expect(command[3]).toBe("file:///D:/a/arashi/arashi/src/index.ts");
  });

  test("leaves POSIX TypeScript entrypoints as paths", () => {
    const command = resolveTestCommand(
      ["node", "--import", "tsx", "/workspace/arashi/src/index.ts", "status"],
      "linux",
    );

    expect(command[3]).toBe("/workspace/arashi/src/index.ts");
  });
});
