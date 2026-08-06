import { describe, expect, test } from "vitest";
import { buildProgram } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
  serializeCommandContract,
} from "../../src/contracts/cli-commands.ts";

describe("completion canonical contract", () => {
  test("publishes root, built-ins, choices, conflicts, hidden state, and candidate ownership", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    expect(contract.schemaVersion).toBe(6);
    expect(contract.root).toMatchObject({
      name: "arashi",
      description: "Git worktree manager for meta-repositories",
    });
    expect(contract.root.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--help", "--version"]),
    );
    const completion = contract.commands.find((command) => command.path === "completion");
    expect(completion).toMatchObject({
      hidden: false,
      semantics: { vscode: { expectation: "excluded" } },
    });
    expect(completion?.arguments[0]).toMatchObject({
      choices: ["bash", "fish", "zsh"],
      candidateKind: "shell",
    });
    expect(completion?.semantics.standalone).toEqual({ support: "full" });
    expect(contract.commands.find((command) => command.path === "completion __query")?.hidden).toBe(
      true,
    );
    const create = contract.commands.find((command) => command.path === "create");
    expect(create?.options.find((option) => option.long === "--conflict")).toMatchObject({
      choices: ["ABORT", "REUSE_EXISTING"],
      candidateKind: "choice",
    });
    expect(create?.options.find((option) => option.long === "--only")?.candidateKind).toBe(
      "repository",
    );
    expect(create?.options.find((option) => option.long === "--group")?.candidateKind).toBe(
      "group",
    );
    const switchCommand = contract.commands.find((command) => command.path === "switch");
    expect(switchCommand?.arguments[0]?.candidateKind).toBe("worktree");
    expect(switchCommand?.options.find((option) => option.long === "--cd")?.conflicts).toContain(
      "--launch",
    );
    expect(switchCommand?.options.find((option) => option.long === "--no-cd")?.hidden).toBe(true);
  });

  test("serializes deterministically and includes completion-critical fields", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const first = serializeCommandContract(
      generateCommandContract(program, commandSemantics, optionAuditPolicies),
    );
    const second = serializeCommandContract(
      generateCommandContract(
        buildProgram({ includeHelpBanner: false }),
        commandSemantics,
        optionAuditPolicies,
      ),
    );
    expect(second).toBe(first);
    expect(first).toContain('"candidateKind"');
    expect(first).toContain('"choices"');
    expect(first).toContain('"conflicts"');
  });
});
