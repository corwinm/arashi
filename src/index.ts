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

// CRITICAL FIX FOR FZF COMPATIBILITY:
// We need to close stdin file descriptor 0 to allow fzf to access /dev/tty
// Standard process.stdin.destroy() doesn't actually close FD 0 in Bun compiled executables
try {
  // Close file descriptor 0 (stdin) using the low-level fs.closeSync
  closeSync(0);
} catch (e) {
  // If closeSync fails (e.g., stdin already closed), fall back to process API
  try {
    process.stdin.pause();
    process.stdin.destroy();
  } catch (e2) {
    // Ignore all errors - stdin closing is best-effort
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
