import { describe, expect, test } from "vitest";
import { Command } from "commander";
import pkg from "../../package.json";
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
    expect(first.version()).toBe(pkg.version);
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

  test("classifies standalone support and configured-only boundaries", () => {
    expect(commandSemantics.create.standalone).toEqual({ support: "full" });
    expect(commandSemantics.move.standalone).toEqual({ support: "full" });
    expect(commandSemantics.init.standalone.support).toBe("conditional");
    for (const command of ["add", "clone", "exec", "pull", "push", "setup", "sync"] as const) {
      expect(commandSemantics[command].standalone.support).toBe("configured-only");
      expect(commandSemantics[command].standalone).toHaveProperty("reason");
    }
  });

  test("publishes enforceable init zero-config option and output policy", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    const init = contract.commands.find((command) => command.path === "init");

    expect(init?.semantics.zeroConfig).toEqual({
      compatibleOptions: ["--dry-run", "--json", "--verbose"],
      dryRun: { finalState: "unchanged", supported: true },
      incompatibleOptions: [
        "--force",
        "--ignore-scope",
        "--no-discover",
        "--repos-dir",
        "--worktrees-dir",
      ],
      json: { singleEnvelope: true, supported: true, suppressesHumanStdout: true },
      option: "--zero-config",
    });
  });

  test("publishes enforceable explicit tmux option policies", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
    );
    const create = contract.commands.find((command) => command.path === "create");
    const switchCommand = contract.commands.find((command) => command.path === "switch");

    expect(create?.semantics.optionPolicies?.["--tmux"]).toEqual({
      compatibleOptions: ["--no-launch", "--no-switch"],
      conflicts: ["--herdr", "--sesh"],
      environment: { name: "TMUX", nonEmptyAfterTrim: true },
      implies: ["launch", "switch"],
      json: {
        guardPrecedence: "before-option-validation",
        mode: "interactive-or-launch",
        unsupported: true,
      },
      persisted: false,
    });
    expect(switchCommand?.semantics.optionPolicies?.["--tmux"]).toEqual({
      compatibleOptions: ["--no-cd", "--no-default-launch"],
      conflicts: ["--cd", "--cursor", "--herdr", "--kiro", "--sesh", "--vscode"],
      environment: { name: "TMUX", nonEmptyAfterTrim: true },
      implies: ["launch"],
      json: {
        guardPrecedence: "before-option-validation",
        mode: "launch",
        unsupported: true,
      },
      persisted: false,
    });
  });

  test("serializes deterministically with structural metadata", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const first = serializeCommandContract(generateCommandContract(program, commandSemantics));
    const second = serializeCommandContract(
      generateCommandContract(buildProgram({ includeHelpBanner: false }), commandSemantics),
    );
    expect(first).toBe(second);
    const contract = JSON.parse(first);
    expect(contract.schemaVersion).toBe(3);
    expect(contract).not.toHaveProperty("cliVersion");
    expect(contract.commands.map((command: { path: string }) => command.path)).toEqual(
      expectedPaths,
    );
    expect(contract.commands[0]).toHaveProperty("options");
    expect(first.endsWith("\n")).toBe(true);
  });

  test("does not change when only the runtime release version changes", () => {
    const current = buildProgram({ includeHelpBanner: false });
    const alternateRelease = new Command().name("arashi").version("999.0.0");
    for (const command of buildProgram({ includeHelpBanner: false }).commands)
      alternateRelease.addCommand(command);

    expect(serializeCommandContract(generateCommandContract(current, commandSemantics))).toBe(
      serializeCommandContract(generateCommandContract(alternateRelease, commandSemantics)),
    );
  });
});
