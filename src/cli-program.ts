import { Command } from "commander";
import { createCommand as createAddCommand } from "./commands/add.ts";
import { createCommand as createCloneCommand } from "./commands/clone.ts";
import { createCommand } from "./commands/create.ts";
import { createCommand as createDoctorCommand } from "./commands/doctor.ts";
import { createCommand as createExecCommand } from "./commands/exec.ts";
import { createCommand as createHandoffCommand } from "./commands/handoff.ts";
import { createCommand as createInitCommand } from "./commands/init.ts";
import { createCommand as createInstallCommand } from "./commands/install.ts";
import { createCommand as createListCommand } from "./commands/list.ts";
import { createCommand as createMoveCommand } from "./commands/move.ts";
import { createCommand as createPruneCommand } from "./commands/prune.ts";
import { createCommand as createPullCommand } from "./commands/pull.ts";
import { createCommand as createPushCommand } from "./commands/push.ts";
import { createCommand as createRemoveCommand } from "./commands/remove.ts";
import { createCommand as createSetupCommand } from "./commands/setup.ts";
import { createCommand as createShellCommand } from "./commands/shell.ts";
import { createCommand as createStatusCommand } from "./commands/status.ts";
import { createCommand as createSwitchCommand } from "./commands/switch.ts";
import { createCommand as createSyncCommand } from "./commands/sync.ts";
import { createCommand as createUpdateCommand } from "./commands/update.ts";
import { detectTerminalContext } from "./lib/terminal-context.ts";
import { renderHelpBanner } from "./lib/logo.ts";
import pkg from "../package.json" with { type: "json" };

export interface BuildProgramOptions {
  includeHelpBanner?: boolean;
}

/** Construct the complete CLI without parsing arguments or mutating process state. */
export function buildProgram(options: BuildProgramOptions = {}): Command {
  const program = new Command()
    .name("arashi")
    .description("Git worktree manager for meta-repositories")
    .version(pkg.version);

  if (options.includeHelpBanner !== false) {
    program.addHelpText("before", `\n${renderHelpBanner(detectTerminalContext(process.stdout))}`);
  }

  for (const command of [
    createInitCommand(),
    createInstallCommand(),
    createAddCommand(),
    createCloneCommand(),
    createCommand(),
    createDoctorCommand(),
    createExecCommand(),
    createHandoffCommand(),
    createMoveCommand(),
    createListCommand(),
    createStatusCommand(),
    createRemoveCommand(),
    createPruneCommand(),
    createPullCommand(),
    createPushCommand(),
    createSyncCommand(),
    createShellCommand(),
    createSetupCommand(),
    createSwitchCommand(),
    createUpdateCommand(pkg.version),
  ])
    program.addCommand(command);
  return program;
}

export function discoverCommandPaths(program: Command): string[] {
  const paths: string[] = [];
  const visit = (parent: Command, prefix: string): void => {
    for (const command of parent.commands) {
      const path = prefix ? `${prefix} ${command.name()}` : command.name();
      paths.push(path);
      visit(command, path);
    }
  };
  visit(program, "");
  return paths.toSorted((a, b) => a.localeCompare(b));
}
