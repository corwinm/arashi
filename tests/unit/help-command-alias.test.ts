import { describe, expect, test } from "vitest";
import { buildProgram } from "../../src/cli-program.ts";

describe("CLI help command naming", () => {
  test("shows aw first and arashi as the supported spelling in root help", () => {
    const program = buildProgram({ includeHelpBanner: false });

    expect(program.name()).toBe("arashi");
    expect(program.aliases()).toEqual([]);
    expect(program.helpInformation()).toContain("Usage: aw|arashi [options] [command]");
  });

  test("uses aw in every command help usage line", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const pending = [...program.commands];

    while (pending.length > 0) {
      const command = pending.shift()!;
      expect(command.helpInformation()).toMatch(/^Usage: aw(?:\s|$)/);
      pending.push(...command.commands);
    }
  });
});
