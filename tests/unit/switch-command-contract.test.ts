import { Command } from "commander";
import { describe, expect, test } from "vitest";
import { buildProgram } from "../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
} from "../../src/contracts/cli-commands.ts";

describe("unified switch mode command contract", () => {
  test("publishes switch descriptions and flags in CLI help", () => {
    const program = buildProgram({ includeHelpBanner: false });
    const command = program.commands.find((candidate: Command) => candidate.name() === "switch");
    expect(command?.description()).toBe(
      "Switch to an existing worktree using explicit, configured, or contextual modes",
    );
    expect(command?.options.find((option) => option.long === "--launch")?.description).toBe(
      "Launch the selected worktree while preserving a configured launcher",
    );
    expect(
      command?.options.find((option) => option.long === "--ignore-configured-launcher")
        ?.description,
    ).toBe("Bypass a configured sesh or Herdr launcher for this invocation");
  });
  test("publishes canonical descriptions and explicit legacy deprecation metadata", () => {
    const contract = generateCommandContract(
      buildProgram({ includeHelpBanner: false }),
      commandSemantics,
      optionAuditPolicies,
    );
    const options = contract.commands.find((command) => command.path === "switch")?.options;
    const byLong = (long: string) => options?.find((option) => option.long === long);

    expect(byLong("--launch")).toMatchObject({
      deprecated: false,
      description: "Launch the selected worktree while preserving a configured launcher",
      hidden: false,
    });
    expect(byLong("--ignore-configured-launcher")).toMatchObject({
      deprecated: false,
      description: "Bypass a configured sesh or Herdr launcher for this invocation",
      hidden: false,
    });
    expect(byLong("--no-cd")).toMatchObject({
      deprecated: true,
      description: "Deprecated compatibility spelling for --launch",
      hidden: true,
    });
    expect(byLong("--no-default-launch")).toMatchObject({
      deprecated: true,
      description: "Deprecated compatibility spelling for --ignore-configured-launcher",
      hidden: true,
    });
  });
});
