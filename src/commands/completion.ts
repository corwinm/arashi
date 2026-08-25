import { Argument, Command } from "commander";
import { GENERATED_COMPLETIONS } from "../generated/completions.ts";
import {
  SUPPORTED_COMPLETION_SHELLS,
  isSupportedCompletionShell,
} from "../lib/shell-integration.ts";
import { buildProgram } from "../cli-program.ts";
import {
  commandSemantics,
  generateCommandContract,
  optionAuditPolicies,
} from "../contracts/cli-commands.ts";
import { encodeCompletionRecords, queryCompletionCandidates } from "../completion/query.ts";
import { error as logError } from "../lib/logger.ts";

const supported = SUPPORTED_COMPLETION_SHELLS.join(", ");

export function createCommand(): Command {
  const command = new Command("completion")
    .description("Generate native shell completion code")
    .addArgument(
      new Argument("[shell]", `Shell name (${supported})`).choices([
        ...SUPPORTED_COMPLETION_SHELLS,
      ]),
    )
    .action((shell: string | undefined) => {
      if (!shell || !isSupportedCompletionShell(shell)) {
        logError(
          `${shell ? `Unsupported shell \`${shell}\`` : "Missing required shell"}. Supported shells: ${supported}.`,
        );
        process.exit(2);
      }
      process.stdout.write(GENERATED_COMPLETIONS[shell]);
    });

  const query = new Command("__query")
    .description("Internal lossless completion candidate query")
    .helpOption(false)
    .addArgument(new Argument("<cursor>", "Zero-based cursor word index"))
    .addArgument(new Argument("[words...]", "Exact completion argument vector"))
    .allowUnknownOption(true)
    .action((cursor: string, words: string[]) => {
      const index = Number.parseInt(cursor, 10);
      if (!Number.isInteger(index) || index < 0) return;
      const contract = generateCommandContract(
        buildProgram({ includeHelpBanner: false }),
        commandSemantics,
        optionAuditPolicies,
      );
      process.stdout.write(
        encodeCompletionRecords(queryCompletionCandidates(contract, words, index)),
      );
    });
  command.addCommand(query, { hidden: true });
  return command;
}
