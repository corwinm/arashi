import { describe, expect, test } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/cli-program.ts";

const renderHelp = (command: Command): string => {
  let output = "";
  command.configureOutput({
    writeOut: (text) => {
      output += text;
    },
  });
  command.outputHelp();
  return output;
};

describe("CLI help command naming", () => {
  test("shows aw first and arashi as the supported spelling in root help", () => {
    const program = buildProgram({ includeHelpBanner: false });

    expect(program.name()).toBe("arashi");
    expect(program.aliases()).toEqual([]);
    expect(renderHelp(program)).toContain("Usage: aw|arashi [options] [command]");
  });

  test("uses aw throughout every command's rendered help", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const pending = [...program.commands];

    while (pending.length > 0) {
      const command = pending.shift()!;
      const help = renderHelp(command);
      expect(help).toMatch(/^Usage: aw(?:\s|$)/);
      expect(help).not.toMatch(/(?:^|[\s"'`])arashi\s/m);
      pending.push(...command.commands);
    }
  });

  test.each(["create", "switch", "init", "list", "status", "prune", "doctor", "move", "handoff"])(
    "renders aw examples in %s help",
    (name) => {
      const program = buildProgram({ includeHelpBanner: false });
      const command = program.commands.find((candidate) => candidate.name() === name)!;
      const help = renderHelp(command);
      const examples = help.split("\n").filter((line) => /^\s*\$ /.test(line));

      expect(help).toContain("Examples:");
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        expect(example).toMatch(/^\s*\$ aw /);
      }
    },
  );
});
