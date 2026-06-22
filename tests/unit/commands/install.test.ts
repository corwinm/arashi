import { describe, expect, test } from "bun:test";
import { createCommand } from "../../../src/commands/install.ts";

describe("install command", () => {
  test("registers visible direct-binary guidance", () => {
    const command = createCommand();

    expect(command.name()).toBe("install");
    expect(command.description()).toContain("npm-managed Arashi platform binary");
  });
});
