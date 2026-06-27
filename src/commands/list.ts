/**
 * CLI Command: List Worktrees
 *
 * Lists all worktrees associated with the main repository. Supports both
 * human-readable table output and machine-parseable JSON output. Can optionally
 * include detailed sub-repository information in verbose mode.
 */

import {
  ConfigurationMissingError,
  ListCommandError,
  NotInRepositoryError,
} from "../types/list.ts";
import {
  createJsonErrorEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { Command } from "commander";
import { listCommand } from "../core/list.ts";
import { error as logError } from "../lib/logger.ts";

type ListCommandOptions = Parameters<typeof listCommand>[0];

interface CliOptions {
  /** Show detailed sub-repository information */
  verbose?: boolean;
  /** Output in JSON format */
  json?: boolean;
  /** Show table format with headers */
  table?: boolean;
  /** Maximum depth for sub-repository discovery */
  maxDepth?: string;
}

export function createCommand(): Command {
  return new Command("list")
    .description("List all worktrees and their status")
    .option("-v, --verbose", "Show detailed sub-repository information")
    .option("-j, --json", "Output in JSON format")
    .option("-t, --table", "Show table format with headers (default: simple list)")
    .option("--max-depth <depth>", "Maximum depth for sub-repo discovery (default: 3)", "3")
    .addHelpText(
      "after",
      `
Examples:
  $ arashi list                    # Simple list of paths (pipe-friendly)
  $ arashi list --table            # Table format with headers
  $ arashi list --json             # Output as JSON
  $ arashi list --verbose          # Show sub-repositories
  $ arashi list | fzf              # Interactive selection with fzf
`,
    )
    .action(async (options: CliOptions) => {
      try {
        await executeList(options);
      } catch (error) {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("list", mapListErrorToJsonError(error)));
          process.exit(1);
        }
        if (error instanceof NotInRepositoryError) {
          logError("Not in a git repository");
          logError("Run this command from a repository root.");
          process.exit(1);
        } else if (error instanceof ConfigurationMissingError) {
          logError("Arashi configuration not found");
          logError('Run "arashi init" to create configuration.');
          process.exit(1);
        } else if (error instanceof ListCommandError) {
          logError(`List command error: ${error.message}`);
          if (error.context) {
            console.error("Context:", error.context);
          }
          process.exit(1);
        } else if (error instanceof Error) {
          logError(`Unexpected error: ${error.message}`);
          console.error(error.stack);
          process.exit(1);
        } else {
          logError("An unknown error occurred");
          process.exit(1);
        }
      }
    });
}

export default createCommand;

function asJsonDetails(details: unknown): Record<string, unknown> | undefined {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }

  return undefined;
}

function mapListErrorToJsonError(error: unknown): ReturnType<typeof unknownErrorToJsonError> {
  if (error instanceof NotInRepositoryError) {
    return {
      code: "NOT_IN_REPOSITORY",
      details: asJsonDetails(error.context),
      message: error.message,
    };
  }

  if (error instanceof ConfigurationMissingError) {
    return {
      code: "CONFIGURATION_MISSING",
      details: asJsonDetails(error.context),
      message: error.message,
    };
  }

  if (error instanceof ListCommandError) {
    return {
      code: "LIST_COMMAND_FAILED",
      details: asJsonDetails(error.context),
      message: error.message,
    };
  }

  return unknownErrorToJsonError(error);
}

async function executeList(options: CliOptions): Promise<void> {
  const listOptions: ListCommandOptions = {
    json: options.json || false,
    maxDepth: parseInt(options.maxDepth || "3", 10),
    table: options.table || false,
    verbose: options.verbose || false,
  };

  await listCommand(listOptions);

  // Aggressively close stdin to prevent TTY conflicts with fzf
  if (process.stdin.readable) {
    process.stdin.pause();
    process.stdin.destroy();
  }

  // Hard exit
  process.exit(0);
}
