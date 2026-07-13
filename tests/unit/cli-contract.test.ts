import { describe, expect, test } from "vitest";
import { Command } from "commander";
import { buildProgram, discoverCommandPaths } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  serializeCommandContract,
  validateCommandSemantics,
} from "../../src/contracts/cli-commands.ts";

const expectedPaths = [
  "add",
  "clone",
  "create",
  "doctor",
  "exec",
  "handoff",
  "init",
  "install",
  "list",
  "move",
  "prune",
  "pull",
  "push",
  "remove",
  "setup",
  "shell",
  "shell init",
  "shell install",
  "status",
  "switch",
  "sync",
  "update",
];

describe("CLI command contract", () => {
  test("constructs a fresh reusable program without parsing or process side effects", () => {
    const first = buildProgram({ includeHelpBanner: false });
    const second = buildProgram({ includeHelpBanner: false });
    expect(first).toBeInstanceOf(Command);
    expect(second).not.toBe(first);
    expect(first.name()).toBe("arashi");
  });

  test("discovers every registered command path exactly", () => {
    expect(discoverCommandPaths(buildProgram({ includeHelpBanner: false }))).toEqual(expectedPaths);
  });

  test("requires complete, non-stale semantic metadata", () => {
    const paths = discoverCommandPaths(buildProgram({ includeHelpBanner: false }));
    expect(validateCommandSemantics(paths, commandSemantics)).toEqual([]);
    expect(
      validateCommandSemantics(paths, { ...commandSemantics, stale: commandSemantics.add }),
    ).toContain('Semantic metadata references unregistered command path "stale"');
    const { add: _add, ...missing } = commandSemantics;
    expect(validateCommandSemantics(paths, missing)).toContain(
      'Missing semantic metadata for command path "add"',
    );
  });

  test("requires reasons for conditional JSON and non-required companion policies", () => {
    const invalid = structuredClone(commandSemantics);
    invalid.create.json = { support: "conditional", reason: "" };
    invalid.install.docs = { expectation: "excluded", reason: "" };
    expect(validateCommandSemantics(expectedPaths, invalid)).toEqual([
      'Command "create" conditional JSON support requires a reason',
      'Command "install" docs exclusion requires a reason',
    ]);
  });

  test("serializes deterministically with structural metadata", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const first = serializeCommandContract(generateCommandContract(program, commandSemantics));
    const second = serializeCommandContract(
      generateCommandContract(buildProgram({ includeHelpBanner: false }), commandSemantics),
    );
    expect(first).toBe(second);
    const contract = JSON.parse(first);
    expect(contract.schemaVersion).toBe(1);
    expect(contract.commands.map((command: { path: string }) => command.path)).toEqual(
      expectedPaths,
    );
    expect(contract.commands[0]).toHaveProperty("options");
    expect(first.endsWith("\n")).toBe(true);
  });
});
