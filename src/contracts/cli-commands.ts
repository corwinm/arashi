import type { Command } from "commander";
import { discoverCommandPaths } from "../cli-program.ts";

export type JsonPolicy =
  | { support: "full" }
  | { support: "conditional" | "unsupported"; reason: string };
export type SurfacePolicy =
  | { expectation: "required" }
  | { expectation: "represented" | "excluded"; reason: string };
export interface CommandSemanticMetadata {
  json: JsonPolicy;
  docs: SurfacePolicy;
  skills: SurfacePolicy;
  vscode: SurfacePolicy;
}
export type CommandSemantics = Record<string, CommandSemanticMetadata>;

const unsupported = (reason: string): JsonPolicy => ({ support: "unsupported", reason });
const required = (): SurfacePolicy => ({ expectation: "required" });
const excluded = (reason: string): SurfacePolicy => ({ expectation: "excluded", reason });
const represented = (reason: string): SurfacePolicy => ({ expectation: "represented", reason });
const standard = (
  json: JsonPolicy = unsupported("This interactive command has no machine-readable output mode."),
): CommandSemanticMetadata => ({
  json,
  docs: required(),
  skills: required(),
  vscode: required(),
});

export const commandSemantics: CommandSemantics = {
  add: standard({ support: "full" }),
  clone: standard(),
  create: standard({
    support: "conditional",
    reason: "JSON is available only for non-interactive create operations.",
  }),
  doctor: {
    ...standard({ support: "full" }),
    vscode: excluded("Diagnostics remain a terminal-focused maintenance workflow."),
  },
  exec: {
    ...standard({ support: "full" }),
    vscode: excluded(
      "Arbitrary cross-repository process execution is intentionally terminal-only.",
    ),
  },
  handoff: {
    ...standard({ support: "full" }),
    vscode: excluded("Agent handoff generation is intentionally terminal-only."),
  },
  init: standard({ support: "full" }),
  install: {
    json: { support: "full" },
    docs: excluded(
      "The install command is an npm bootstrap implementation detail; user installation guidance lives on the website.",
    ),
    skills: excluded(
      "The skill assumes Arashi is already installed; bootstrap guidance belongs in installation docs.",
    ),
    vscode: required(),
  },
  list: {
    ...standard({ support: "full" }),
    vscode: represented("The worktree panel represents the CLI list workflow."),
  },
  move: standard({ support: "full" }),
  prune: standard({ support: "full" }),
  pull: standard({ support: "full" }),
  push: {
    ...standard({ support: "full" }),
    vscode: excluded("Push remains explicit terminal source-control behavior."),
  },
  remove: standard({
    support: "conditional",
    reason: "JSON mode requires an explicit branch and is non-interactive.",
  }),
  setup: standard({ support: "full" }),
  shell: standard(unsupported("Shell integration emits shell code rather than JSON.")),
  "shell init": {
    json: unsupported(
      "Shell initialization emits shell code; --json only returns an unsupported-mode error.",
    ),
    docs: excluded("This subcommand is documented on the parent shell command page."),
    skills: represented("Shell initialization is covered as part of the shell workflow."),
    vscode: excluded("Shell initialization configures terminals and is not an editor command."),
  },
  "shell install": {
    json: unsupported("Shell installation mutates shell configuration and has no JSON mode."),
    docs: excluded("This subcommand is documented on the parent shell command page."),
    skills: represented("Shell installation is covered as part of the shell workflow."),
    vscode: excluded("Shell configuration installation is outside extension scope."),
  },
  status: standard({ support: "full" }),
  switch: standard(
    unsupported("Switch launches a shell; --json only returns an unsupported-mode error."),
  ),
  sync: standard({ support: "full" }),
  update: standard({
    support: "conditional",
    reason: "JSON cannot be combined with interactive confirmation options.",
  }),
};

export function validateCommandSemantics(paths: string[], metadata: CommandSemantics): string[] {
  const errors: string[] = [];
  const pathSet = new Set(paths);
  for (const path of paths)
    if (!metadata[path]) errors.push(`Missing semantic metadata for command path "${path}"`);
  for (const path of Object.keys(metadata).toSorted()) {
    if (!pathSet.has(path)) {
      errors.push(`Semantic metadata references unregistered command path "${path}"`);
      continue;
    }
    const item = metadata[path];
    if (item.json.support !== "full" && !item.json.reason.trim())
      errors.push(`Command "${path}" ${item.json.support} JSON support requires a reason`);
    for (const surface of ["docs", "skills", "vscode"] as const) {
      const policy = item[surface];
      if (policy.expectation !== "required" && !policy.reason.trim())
        errors.push(
          `Command "${path}" ${surface} ${policy.expectation === "excluded" ? "exclusion" : "representation"} requires a reason`,
        );
    }
  }
  return errors;
}

export interface CliCommandContract {
  schemaVersion: 1;
  cliVersion: string;
  commands: ContractCommand[];
}
interface ContractCommand {
  path: string;
  description: string;
  aliases: string[];
  hidden: boolean;
  arguments: Array<{ name: string; required: boolean; variadic: boolean; description: string }>;
  options: Array<{
    flags: string;
    description: string;
    required: boolean;
    optional: boolean;
    variadic: boolean;
  }>;
  semantics: CommandSemanticMetadata;
}

export function generateCommandContract(
  program: Command,
  metadata: CommandSemantics,
): CliCommandContract {
  const paths = discoverCommandPaths(program);
  const errors = validateCommandSemantics(paths, metadata);
  if (errors.length) throw new Error(`Invalid CLI command semantics:\n${errors.join("\n")}`);
  const commands: ContractCommand[] = [];
  const visit = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      commands.push({
        path,
        description: command.description(),
        aliases: command.aliases().toSorted(),
        hidden: Boolean((command as Command & { _hidden?: boolean })._hidden),
        arguments: command.registeredArguments.map((argument) => ({
          name: argument.name(),
          required: argument.required,
          variadic: argument.variadic,
          description: argument.description,
        })),
        options: command.options
          .map((option) => ({
            flags: option.flags,
            description: option.description,
            required: option.required,
            optional: option.optional,
            variadic: option.variadic,
          }))
          .toSorted((a, b) => a.flags.localeCompare(b.flags)),
        semantics: metadata[path]!,
      });
      visit(command, path);
    }
  };
  visit(program, "");
  return {
    schemaVersion: 1,
    cliVersion: program.version() ?? "",
    commands: commands.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

export function serializeCommandContract(contract: CliCommandContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
