/**
 * CLI Command: Create Worktree
 * 
 * Creates coordinated worktrees across multiple repositories with a single command.
 * Supports repository filtering, conflict resolution, progress tracking, and automatic rollback.
 */

import { Command } from 'commander';
import * as config from '../lib/config.ts';
import * as logger from '../lib/logger.ts';
import { discoverRepositories } from '../core/repository.ts';
import { 
  createCoordinatedWorktrees, 
  applyRepositoryFilter,
  type RepositoryFilter,
  type WorktreeOperationOptions,
  type ConflictResolutionStrategy,
  InvalidBranchNameError,
  RepositoryValidationError,
  ConflictAbortedError,
} from '../core/worktree.ts';

interface CreateCommandOptions {
  /** Only create worktrees in specified repositories (comma-separated) */
  only?: string;
  
  /** Interactively select repositories */
  interactive?: boolean;
  
  /** Pre-select conflict resolution strategy */
  conflict?: ConflictResolutionStrategy;
  
  /** Disable hook execution */
  noHooks?: boolean;
  
  /** Hide progress indicators */
  noProgress?: boolean;
  
  /** Dry run - show what would be done without making changes */
  dryRun?: boolean;
}

export function createCommand(): Command {
  return new Command('create')
    .description('Create coordinated worktrees across multiple repositories')
    .argument('<branch>', 'Branch name to create across repositories')
    .option('--only <repos>', 'Only create in specified repositories (comma-separated)')
    .option('-i, --interactive', 'Interactively select repositories')
    .option('--conflict <strategy>', 'Pre-select conflict resolution strategy (ABORT, REUSE_EXISTING)')
    .option('--no-hooks', 'Disable hook execution')
    .option('--no-progress', 'Hide progress indicators')
    .option('--dry-run', 'Show what would be done without making changes')
    .action(async (branchName: string, options: CreateCommandOptions) => {
      try {
        await executeCreate(branchName, options);
      } catch (error) {
        if (error instanceof InvalidBranchNameError) {
          logger.error(`Invalid branch name: ${error.branchName}`);
          logger.error(error.reason);
          process.exit(1);
        } else if (error instanceof RepositoryValidationError) {
          logger.error(`Repository validation error: ${error.message}`);
          process.exit(1);
        } else if (error instanceof ConflictAbortedError) {
          logger.warn('Operation aborted by user');
          process.exit(2);
        } else if (error instanceof Error) {
          logger.error(`Unexpected error: ${error.message}`);
          console.error(error.stack);
          process.exit(1);
        } else {
          logger.error('An unknown error occurred');
          process.exit(1);
        }
      }
    });
}

async function executeCreate(branchName: string, options: CreateCommandOptions): Promise<void> {
  // 1. Load configuration
  const arashiConfig = await config.load();
  
  // 2. Discover repositories
  const discoveredRepos = await discoverRepositories(arashiConfig);
  
  if (discoveredRepos.length === 0) {
    logger.error('No repositories found in configuration');
    logger.info('Run "arashi add <path>" to add repositories');
    process.exit(1);
  }
  
  logger.info(`Found ${discoveredRepos.length} configured repositories`);
  
  // 3. Apply repository filter
  const filter: RepositoryFilter = {
    mode: options.interactive ? 'interactive' : options.only ? 'explicit' : 'all',
    explicitList: options.only ? options.only.split(',').map(s => s.trim()) : [],
    selectedRepositories: null,
  };
  
  const selectedRepos = await applyRepositoryFilter(filter, discoveredRepos);
  
  if (selectedRepos.length === 0) {
    logger.warn('No repositories selected for worktree creation');
    process.exit(0);
  }
  
  logger.info(`Creating worktrees in ${selectedRepos.length} repositories...`);
  
  // 4. Build options for worktree orchestration
  const worktreeOptions: WorktreeOperationOptions = {
    executeHooks: !options.noHooks,
    showProgress: !options.noProgress,
    interactive: options.interactive || false,
    conflictResolution: options.conflict || null,
    dryRun: options.dryRun || false,
  };
  
  // 5. Execute coordinated worktree creation
  const summary = await createCoordinatedWorktrees(
    branchName,
    selectedRepos,
    worktreeOptions
  );
  
  // 6. Display results
  console.log('');
  if (summary.rolledBack) {
    logger.error('Operation failed and was rolled back');
    logger.error(summary.errorSummary || 'Unknown error');
    process.exit(1);
  } else {
    logger.success(`Successfully created worktrees in ${summary.successCount} repositories`);
    
    // Display worktree paths
    console.log('');
    logger.info('Worktree locations:');
    for (const result of summary.repositoryResults) {
      if (result.status === 'success' && result.worktreePath) {
        console.log(`  • ${result.repository.name}: ${result.worktreePath}`);
      }
    }
    
    // Display warnings if any
    const warnings = summary.repositoryResults.flatMap(r => r.warnings);
    if (warnings.length > 0) {
      console.log('');
      logger.warn('Warnings:');
      for (const warning of warnings) {
        console.log(`  • ${warning}`);
      }
    }
    
    console.log('');
    logger.info(`Total duration: ${(summary.totalDuration / 1000).toFixed(2)}s`);
  }
}
