import { describe, expect, test } from "vitest";
import { Command } from "commander";
import { buildProgram } from "../../src/cli-program.ts";
import { optionAuditPolicies, validateOptionAudit } from "../../src/contracts/cli-commands.ts";

const expectedCommonAliases: Record<string, Record<string, string>> = {
  add: { "--force": "-f", "--json": "-j" },
  clone: { "--json": "-j" },
  configure: { "--json": "-j" },
  create: {
    "--dry-run": "-n",
    "--group": "-g",
    "--json": "-j",
    "--only": "-o",
  },
  delete: { "--dry-run": "-n", "--force": "-f", "--json": "-j" },
  doctor: { "--json": "-j" },
  exec: { "--group": "-g", "--json": "-j", "--only": "-o" },
  handoff: { "--json": "-j" },
  init: { "--dry-run": "-n", "--force": "-f", "--json": "-j", "--verbose": "-v" },
  install: { "--json": "-j" },
  list: { "--json": "-j", "--verbose": "-v" },
  move: { "--json": "-j" },
  prune: { "--dry-run": "-n", "--json": "-j" },
  pull: { "--group": "-g", "--json": "-j", "--only": "-o", "--verbose": "-v" },
  push: { "--dry-run": "-n", "--group": "-g", "--json": "-j", "--only": "-o" },
  remove: { "--dry-run": "-n", "--force": "-f", "--json": "-j" },
  setup: { "--group": "-g", "--json": "-j", "--only": "-o", "--verbose": "-v" },
  "shell init": { "--json": "-j" },
  status: { "--group": "-g", "--json": "-j", "--only": "-o", "--verbose": "-v" },
  switch: { "--json": "-j" },
  sync: { "--group": "-g", "--json": "-j", "--only": "-o", "--verbose": "-v" },
  update: { "--dry-run": "-n", "--json": "-j" },
};

const collectCommonAliases = (program: Command): Record<string, Record<string, string>> => {
  const aliases: Record<string, Record<string, string>> = {};
  const commonLongs = new Set(["--dry-run", "--force", "--group", "--json", "--only", "--verbose"]);
  const visit = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      const registrations = Object.fromEntries(
        command.options
          .filter((option) => option.long && commonLongs.has(option.long))
          .map((option) => [option.long!, option.short ?? ""]),
      );
      if (Object.keys(registrations).length > 0) aliases[path] = registrations;
      visit(command, path);
    }
  };
  visit(program, "");
  return aliases;
};

describe("Commander common option aliases", () => {
  test("registers the exact approved alias on every command-local common option", () => {
    expect(collectCommonAliases(buildProgram({ includeHelpBanner: false }))).toEqual(
      expectedCommonAliases,
    );
  });

  test("keeps reserved add name and exec jobs spellings without common-alias collisions", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const add = program.commands.find((command) => command.name() === "add")!;
    const exec = program.commands.find((command) => command.name() === "exec")!;

    expect(add.options.find((option) => option.long === "--name")?.short).toBe("-n");
    expect(exec.options.find((option) => option.long === "--jobs")?.short).toBeUndefined();
    expect(exec.options.find((option) => option.long === "--json")?.short).toBe("-j");
    expect(validateOptionAudit(program, optionAuditPolicies)).toEqual([]);
  });

  test("semantic validation rejects missing, stale, and conceptually wrong common aliases", () => {
    const missing = new Command().name("arashi");
    missing.addCommand(new Command("sample").option("--json"));
    expect(validateOptionAudit(missing, {})).toContain(
      'Command "sample" common option "--json" requires short alias "-j"',
    );

    const stale = new Command().name("arashi");
    stale.addCommand(new Command("sample").option("-j, --jobs <count>"));
    expect(validateOptionAudit(stale, {})).toContain(
      'Command "sample" short alias "-j" is reserved for common option "--json", not "--jobs"',
    );

    const wrong = new Command().name("arashi");
    wrong.addCommand(new Command("sample").option("-n, --json"));
    expect(validateOptionAudit(wrong, {})).toEqual(
      expect.arrayContaining([
        'Command "sample" common option "--json" requires short alias "-j"',
        'Command "sample" short alias "-n" is reserved for common option "--dry-run", not "--json"',
      ]),
    );
  });
});
