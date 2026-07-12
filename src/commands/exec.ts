import { runtime } from "#runtime";
/**
 * CLI Command: Exec
 *
 * Runs a child command once per selected managed repository.
 */

import {
  createJsonErrorEnvelope,
  createJsonSuccessEnvelope,
  unknownErrorToJsonError,
  writeJsonEnvelope,
} from "../lib/json-output.ts";
import { findWorkspaceRoot, loadWorkspaceRepositories } from "../lib/config.ts";
import { Command } from "commander";
import { filterRepositories } from "../lib/repo-filter.ts";
import { normalizeSpawnEnvironment } from "../lib/shell-directives.ts";

const ZERO = 0;
const ONE = 1;
const ERROR_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const DEFAULT_JOBS = 1;
const DECIMAL_RADIX = 10;

class CliUsageError extends Error {}

interface ExecRepository {
  name: string;
  path: string;
}

export interface ExecCommandOptions {
  dirty?: boolean;
  failFast?: boolean;
  group?: string[];
  jobs?: string;
  json?: boolean;
  only?: string[];
}

export interface ExecResult {
  repositoryId: string;
  path: string;
  command: string[];
  exitCode: number | null;
  status: "passed" | "failed" | "skipped" | "not-started";
  stdout: string;
  stderr: string;
  elapsedMs: number;
  errorMessage?: string;
}

export interface ExecSummary {
  command: string[];
  options: {
    dirty: boolean;
    failFast: boolean;
    jobs: number;
    json: boolean;
    only: string[];
    groups?: string[];
  };
  selectedRepositories: { name: string; path: string }[];
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: ExecResult[];
}

const parseJobs = (value: string | undefined): number => {
  if (!value) {
    return DEFAULT_JOBS;
  }

  const parsed = Number.parseInt(value, DECIMAL_RADIX);
  if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < ONE) {
    throw new CliUsageError("--jobs must be a positive integer");
  }

  return parsed;
};

const formatCommand = (command: string[]): string =>
  command.map((part) => JSON.stringify(part)).join(" ");

const normalizeOnlyFilters = (only: string[] | undefined): string[] | undefined => {
  if (!only) {
    return undefined;
  }

  const normalized = only.flatMap((value) =>
    value
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return normalized.length > ZERO ? normalized : undefined;
};

const createNotStartedResult = (repo: ExecRepository, command: string[]): ExecResult => ({
  command,
  elapsedMs: ZERO,
  errorMessage: "Skipped because --fail-fast stopped scheduling after an earlier failure",
  exitCode: null,
  path: repo.path,
  repositoryId: repo.name,
  status: "not-started",
  stderr: "",
  stdout: "",
});

const isRepoDirty = async (repoPath: string): Promise<boolean> => {
  const proc = runtime.spawn(["git", "status", "--porcelain=v1"], {
    cwd: repoPath,
    env: normalizeSpawnEnvironment(process.env),
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  await new Response(proc.stderr).text();
  return exitCode !== ZERO || stdout.trim().length > ZERO;
};

const runChildCommand = async (repo: ExecRepository, command: string[]): Promise<ExecResult> => {
  const startedAt = Date.now();

  try {
    const proc = runtime.spawn(command, {
      cwd: repo.path,
      env: normalizeSpawnEnvironment(process.env),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      command,
      elapsedMs: Date.now() - startedAt,
      exitCode,
      path: repo.path,
      repositoryId: repo.name,
      status: exitCode === ZERO ? "passed" : "failed",
      stderr,
      stdout,
    };
  } catch (error) {
    return {
      command,
      elapsedMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      exitCode: ERROR_EXIT_CODE,
      path: repo.path,
      repositoryId: repo.name,
      status: "failed",
      stderr: error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
      stdout: "",
    };
  }
};

interface RunWithConcurrencyOptions {
  command: string[];
  failFast: boolean;
  jobs: number;
  repositories: ExecRepository[];
}

const runWithConcurrency = async ({
  command,
  failFast,
  jobs,
  repositories,
}: RunWithConcurrencyOptions): Promise<ExecResult[]> => {
  const results: ExecResult[] = [];
  let nextIndex = ZERO;
  let shouldStop = false;

  const worker = async (): Promise<void> => {
    while (!shouldStop) {
      const index = nextIndex;
      nextIndex += ONE;
      const repo = repositories[index];
      if (!repo) {
        return;
      }

      const result = await runChildCommand(repo, command);
      results[index] = result;
      if (failFast && result.status === "failed") {
        shouldStop = true;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(jobs, repositories.length) }, async () => {
      await worker();
    }),
  );

  for (let index = ZERO; index < repositories.length; index += ONE) {
    if (!results[index]) {
      results[index] = createNotStartedResult(repositories[index], command);
    }
  }

  return results;
};

interface BuildSummaryInput {
  command: string[];
  options: {
    dirty: boolean;
    failFast: boolean;
    groups: string[];
    jobs: number;
    json: boolean;
    only: string[];
  };
  repositories: ExecRepository[];
  results: ExecResult[];
}

const buildSummary = ({
  command,
  options,
  repositories,
  results,
}: BuildSummaryInput): ExecSummary => ({
  command,
  failed: results.filter((result) => result.status === "failed").length,
  options,
  passed: results.filter((result) => result.status === "passed").length,
  results,
  selectedRepositories: repositories.map((repo) => ({ name: repo.name, path: repo.path })),
  skipped: results.filter(
    (result) => result.status === "skipped" || result.status === "not-started",
  ).length,
  total: results.length,
});

const writeIndented = (label: string, value: string): void => {
  const trimmed = value.replace(/\n$/, "");
  if (!trimmed) {
    return;
  }
  console.log(`  ${label}:`);
  for (const line of trimmed.split("\n")) {
    console.log(`    ${line}`);
  }
};

const printHumanResult = (result: ExecResult): void => {
  const status = result.status === "passed" ? "ok" : result.status;
  const exitCode = result.exitCode === null ? "n/a" : String(result.exitCode);
  console.log(`\n[${result.repositoryId}] ${status} (${exitCode}) ${result.path}`);
  if (result.errorMessage) {
    writeIndented("note", result.errorMessage);
  }
  writeIndented("stdout", result.stdout);
  writeIndented("stderr", result.stderr);
};

const executeExec = async (
  childCommand: string[],
  options: ExecCommandOptions,
): Promise<ExecSummary> => {
  if (childCommand.length === ZERO) {
    throw new CliUsageError("Missing child command. Use: arashi exec [options] -- <command>");
  }

  const jobs = parseJobs(options.jobs);
  let workspaceRoot = "";
  try {
    workspaceRoot = await findWorkspaceRoot();
  } catch {
    throw new CliUsageError(
      'Not in an arashi workspace. Run "arashi init" to initialize a workspace',
    );
  }

  const repositoriesResult = await loadWorkspaceRepositories(workspaceRoot).catch(
    (error): never => {
      throw new CliUsageError(
        `Failed to load workspace configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );

  const onlyFilters = normalizeOnlyFilters(options.only) ?? [];
  const filterResult = filterRepositories(
    repositoriesResult.repositories,
    onlyFilters.length > ZERO ? onlyFilters : undefined,
    options.group,
  );
  if (filterResult.missing.length > ZERO) {
    throw new CliUsageError(
      `Unknown repositories in --only filter: ${filterResult.missing.join(", ")}`,
    );
  }
  if (filterResult.unknownGroups.length > ZERO) {
    throw new CliUsageError(
      `Unknown repository groups in --group filter: ${filterResult.unknownGroups.join(", ")}`,
    );
  }
  if (filterResult.emptyIntersection) {
    throw new CliUsageError("No repositories matched the combined --only/--group filters");
  }

  let repositories = filterResult.selected;
  if (options.dirty) {
    const dirtyFlags = await Promise.all(
      repositories.map(async (repo) => await isRepoDirty(repo.path)),
    );
    repositories = repositories.filter((_, index) => dirtyFlags[index]);
  }

  if (repositories.length === ZERO) {
    if (!options.json) {
      console.log("No repositories selected for exec");
    }
    return buildSummary({
      command: childCommand,
      options: {
        dirty: options.dirty === true,
        failFast: options.failFast === true,
        groups: filterResult.filters.groups,
        jobs,
        json: options.json === true,
        only: onlyFilters,
      },
      repositories,
      results: [],
    });
  }

  if (!options.json) {
    console.log(`Running ${formatCommand(childCommand)} in ${repositories.length} repositories`);
  }

  const results = await runWithConcurrency({
    command: childCommand,
    failFast: options.failFast === true,
    jobs,
    repositories,
  });
  const summary = buildSummary({
    command: childCommand,
    options: {
      dirty: options.dirty === true,
      failFast: options.failFast === true,
      groups: filterResult.filters.groups,
      jobs,
      json: options.json === true,
      only: onlyFilters,
    },
    repositories,
    results,
  });

  if (!options.json) {
    for (const result of results) {
      printHumanResult(result);
    }
    console.log(
      `\nSummary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.total} total`,
    );
  }

  if (summary.failed > ZERO) {
    process.exitCode = ERROR_EXIT_CODE;
  }

  return summary;
};

export function createCommand(): Command {
  return new Command("exec")
    .description("Run a command once per selected managed repository")
    .argument("[command...]", "Command to run after --")
    .option(
      "--only <repo>",
      "Only include a specific repository (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--group <group>",
      "Only include repositories in the requested group (repeatable)",
      (value, previous: string[] = []) => [...previous, value],
    )
    .option("--dirty", "Only include repositories with uncommitted changes")
    .option(
      "--jobs <positive-int>",
      "Maximum repositories to run concurrently",
      String(DEFAULT_JOBS),
    )
    .option("--fail-fast", "Stop starting new commands after the first failure")
    .option("--json", "Output result as JSON")
    .allowUnknownOption(true)
    .action(async (childCommand: string[], options: ExecCommandOptions) => {
      try {
        const summary = await executeExec(childCommand, options);
        if (options.json) {
          if (summary.failed > ZERO) {
            writeJsonEnvelope(
              createJsonErrorEnvelope("exec", {
                code: "EXEC_COMMAND_FAILED",
                details: { ...summary },
                message: `${summary.failed} repository command(s) failed`,
              }),
            );
          } else {
            writeJsonEnvelope(
              createJsonSuccessEnvelope<Record<string, unknown>>("exec", { ...summary }),
            );
          }
        }
      } catch (error) {
        if (options.json) {
          writeJsonEnvelope(createJsonErrorEnvelope("exec", unknownErrorToJsonError(error)));
          process.exit(USAGE_EXIT_CODE);
        } else {
          console.error(error instanceof Error ? error.message : "Unknown error");
          process.exit(error instanceof CliUsageError ? USAGE_EXIT_CODE : ERROR_EXIT_CODE);
        }
      }
    });
}
