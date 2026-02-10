/**
 * CLI Command: List Worktrees
 *
 * Lists all worktrees associated with the main repository. Supports both
 * human-readable table output and machine-parseable JSON output. Can optionally
 * include detailed sub-repository information in verbose mode.
 */

import { Command } from "commander";
import { listCommand } from "../core/list.ts";
import * as logger from "../lib/logger.ts";
import {
  NotInRepositoryError,
  ConfigurationMissingError,
  ListCommandError,
  type ListCommandOptions,
} from "../types/list.ts";

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
        if (error instanceof NotInRepositoryError) {
          logger.error("Not in a git repository");
          logger.error("Run this command from a repository root.");
          process.exit(1);
        } else if (error instanceof ConfigurationMissingError) {
          logger.error("Arashi configuration not found");
          logger.error('Run "arashi init" to create configuration.');
          process.exit(1);
        } else if (error instanceof ListCommandError) {
          logger.error(`List command error: ${error.message}`);
          if (error.context) {
            console.error("Context:", error.context);
          }
          process.exit(1);
        } else if (error instanceof Error) {
          logger.error(`Unexpected error: ${error.message}`);
          console.error(error.stack);
          process.exit(1);
        } else {
          logger.error("An unknown error occurred");
          process.exit(1);
        }
      }
    });
}

async function executeList(options: CliOptions): Promise<void> {
  const listOptions: ListCommandOptions = {
    verbose: options.verbose || false,
    json: options.json || false,
    table: options.table || false,
    maxDepth: parseInt(options.maxDepth || "3", 10),
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
