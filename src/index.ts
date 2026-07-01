#!/usr/bin/env bun
import { Command } from "commander";
import { closeSync } from "fs";
import { createCommand as createAddCommand } from "./commands/add.ts";
import { createCommand as createCloneCommand } from "./commands/clone.ts";
import { createCommand } from "./commands/create.ts";
import { createCommand as createInitCommand } from "./commands/init.ts";
import { createCommand as createInstallCommand } from "./commands/install.ts";
import { createCommand as createListCommand } from "./commands/list.ts";
import { createCommand as createMoveCommand } from "./commands/move.ts";
import { createCommand as createPruneCommand } from "./commands/prune.ts";
import { createCommand as createPullCommand } from "./commands/pull.ts";
import { createCommand as createRemoveCommand } from "./commands/remove.ts";
import { createCommand as createSetupCommand } from "./commands/setup.ts";
import { createCommand as createShellCommand } from "./commands/shell.ts";
import { createCommand as createStatusCommand } from "./commands/status.ts";
import { createCommand as createSwitchCommand } from "./commands/switch.ts";
import { createCommand as createSyncCommand } from "./commands/sync.ts";
import { createCommand as createUpdateCommand } from "./commands/update.ts";
import { detectTerminalContext } from "./lib/terminal-context.ts";
import pkg from "../package.json";
import { renderHelpBanner } from "./lib/logo.ts";

// FZF compatibility: close stdin for list or forced remove when piping output
const argv = process.argv.slice(2);
let command = "";
let forceRemove = false;
for (const arg of argv) {
  if (arg.startsWith("-")) {
    if (arg === "-f" || arg === "--force") {
      forceRemove = true;
    }
    continue;
  }
  command = arg;
  break;
}

if (!process.stdout.isTTY && (command === "list" || (command === "remove" && forceRemove))) {
  try {
    closeSync(0);
  } catch {
    try {
      process.stdin.pause();
      process.stdin.destroy();
    } catch {
      // Ignore all errors - stdin closing is best-effort
    }
  }
}

const program = new Command();

program
  .name("arashi")
  .description("Git worktree manager for meta-repositories")
  .version(pkg.version);

const terminalContext = detectTerminalContext(process.stdout);
program.addHelpText("before", `\n${renderHelpBanner(terminalContext)}`);

// Register commands
program.addCommand(createInitCommand());
program.addCommand(createInstallCommand());
program.addCommand(createAddCommand());
program.addCommand(createCloneCommand());
program.addCommand(createCommand());
program.addCommand(createMoveCommand());
program.addCommand(createListCommand());
program.addCommand(createStatusCommand());
program.addCommand(createRemoveCommand());
program.addCommand(createPruneCommand());
program.addCommand(createPullCommand());
program.addCommand(createSyncCommand());
program.addCommand(createShellCommand());
program.addCommand(createSetupCommand());
program.addCommand(createSwitchCommand());
program.addCommand(createUpdateCommand(pkg.version));

program.parse();
