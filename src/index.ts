#!/usr/bin/env bun
import { Command } from 'commander';
import { createCommand as createInitCommand } from './commands/init.ts';
import { createCommand } from './commands/create.ts';
import { createCommand as createListCommand } from './commands/list.ts';
import { createCommand as createAddCommand } from './commands/add.ts';
import { createCommand as createStatusCommand } from './commands/status.ts';
import { createCommand as createRemoveCommand } from './commands/remove.ts';
import { closeSync } from 'fs';
import pkg from '../package.json' with { type: 'json' };

// FZF compatibility: close stdin only when piping `list` output
const argv = process.argv.slice(2);
let command = "";
for (const arg of argv) {
  if (arg.startsWith('-')) {
    continue;
  }
  command = arg;
  break;
}

if (command === 'list' && !process.stdout.isTTY) {
  try {
    closeSync(0);
  } catch (e) {
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
  .name('arashi')
  .description('Git worktree manager for meta-repositories')
  .version(pkg.version);

// Register commands
program.addCommand(createInitCommand());
program.addCommand(createAddCommand());
program.addCommand(createCommand());
program.addCommand(createListCommand());
program.addCommand(createStatusCommand());
program.addCommand(createRemoveCommand());

program.parse();
