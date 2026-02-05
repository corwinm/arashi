#!/usr/bin/env bun
import { Command } from 'commander';
import { createCommand } from './commands/create.ts';

const program = new Command();

program
  .name('arashi')
  .description('Git worktree manager for meta-repositories')
  .version('0.1.0');

// Register commands
program.addCommand(createCommand());

// Future commands
// program.command('init').description('Initialize arashi in current repository');
// program.command('add').description('Add a repository to the repos folder');
// program.command('list').description('List all worktrees');
// program.command('remove').description('Remove a worktree');
// program.command('setup').description('Setup development environment');
// program.command('status').description('Show status of all repositories');

program.parse();
