import { buildProgram } from "../../../src/cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
} from "../../../src/contracts/cli-commands.ts";

export const contract = generateCommandContract(
  buildProgram({ includeHelpBanner: false }),
  commandSemantics,
  optionAuditPolicies,
);
export type Owner =
  | "static"
  | "dynamic repository"
  | "dynamic group"
  | "dynamic worktree"
  | "none/free-text";
export function owner(slot: { choices?: string[]; candidateKind?: string }): Owner {
  if (slot.choices?.length) return "static";
  switch (slot.candidateKind) {
    case "repository":
    case "configured-repository":
      return "dynamic repository";
    case "group":
      return "dynamic group";
    case "workspace":
    case "worktree":
      return "dynamic worktree";
    case undefined:
      return "none/free-text";
    default:
      throw new Error(`Unclassified candidate kind: ${slot.candidateKind}`);
  }
}
// Every command/alias spelling, option spelling, value slot and positional slot,
// including hidden entries. This is an audit snapshot, never a production model.
export const ownership = [
  ...contract.commands.flatMap((command) =>
    [command.path, ...command.aliasPaths].map((path) => [
      path,
      "command",
      command.hidden ? "none/free-text" : "static",
    ]),
  ),
  ...[
    { path: "<root>", options: contract.root.options, arguments: [] },
    ...contract.commands,
  ].flatMap((command) => [
    ...command.options.flatMap((option) => [
      ...[option.long, option.short]
        .filter(Boolean)
        .map((spelling) => [
          command.path,
          spelling,
          "name",
          option.hidden ? "none/free-text" : "static",
        ]),
      ...(option.valueShape === "boolean"
        ? []
        : [[command.path, option.long, "value", owner(option)]]),
    ]),
    ...command.arguments.map((argument, index) => [
      command.path,
      String(index),
      argument.name,
      owner(argument),
    ]),
  ]),
];
