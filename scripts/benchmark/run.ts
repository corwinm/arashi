import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBenchmarkFixture, type BenchmarkFixture, type FixtureId } from "./fixtures.ts";
import { readGitInvocationTrace } from "./git-trace.ts";
import { invoke, type Invocation, type ProcessResult } from "./invoke.ts";
import { executableNamesForPlatform } from "./platform.ts";
import { artifactMetadata, buildRuntime, PROVENANCE_ENVIRONMENT_VARIABLE } from "./provenance.ts";
import { cliRuntime, nodeRuntime, type RuntimeMetadata } from "./runtime.ts";
import { summarizeDurations } from "./statistics.ts";
import { validateCliStatusOutput } from "./status-behavior.ts";

interface Options {
  fixtureIds: FixtureId[];
  iterations: number;
  metrics: boolean;
  outputPath: string;
  source: boolean;
  warmup: number;
}

interface CommandDefinition {
  afterEach?: () => Promise<void>;
  args: string[];
  beforeEach?: () => Promise<void>;
  behavior(stdout: string): Record<string, unknown> | Promise<Record<string, unknown>>;
  cli?: Invocation;
  cwd: string;
  id: string;
  invocation: { method: string; refresh: string; topology: string };
  networkDependent: boolean;
  runtime?: RuntimeMetadata;
}

interface AvailabilityMetric {
  available: boolean;
  bytes?: number;
  method: string;
  reason?: string;
}

const repositoryRoot = resolve(import.meta.dirname, "../..");

function integerOption(name: string, value: string, allowZero: boolean): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    fixtureIds: ["small", "medium", "large"],
    iterations: 10,
    metrics: true,
    outputPath: join(repositoryRoot, "benchmark-results", `result-${platform()}-${arch()}.json`),
    source: false,
    warmup: 2,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (argument === "--") {
      continue;
    } else if (argument === "--fixture") {
      const fixture = value();
      if (fixture !== "small" && fixture !== "medium" && fixture !== "large") {
        throw new Error("--fixture must be small, medium, or large.");
      }
      options.fixtureIds = [fixture];
    } else if (argument === "--iterations") {
      options.iterations = integerOption("--iterations", value(), false);
    } else if (argument === "--warmup") {
      options.warmup = integerOption("--warmup", value(), true);
    } else if (argument === "--output") {
      options.outputPath = resolve(value());
    } else if (argument === "--no-metrics") {
      options.metrics = false;
    } else if (argument === "--source") {
      options.source = true;
    } else {
      throw new Error(`Unknown benchmark option: ${argument}`);
    }
  }
  return options;
}

function resolveCli(source: boolean): Invocation {
  const executable = executableNamesForPlatform(platform())
    .map((name) => join(repositoryRoot, "bin", name))
    .find((candidate) => existsSync(candidate));
  if (!source && executable) return { args: [], command: executable };
  if (!source) {
    const expected = executableNamesForPlatform(platform()).join(" or ");
    throw new Error(`Built executable not found (${expected}). Run \`pnpm benchmark\`.`);
  }
  return {
    args: ["--experimental-strip-types", join(repositoryRoot, "src", "index.ts")],
    command: process.execPath,
  };
}

async function gitInvocationCount(
  cli: Invocation,
  args: string[],
  cwd: string,
  tracePath: string,
  environment: NodeJS.ProcessEnv,
  expectedRepositoryPaths?: string[],
  beforeEach?: () => Promise<void>,
  afterEach?: () => Promise<void>,
): Promise<{
  available: boolean;
  count?: number;
  fetchCount?: number;
  method: string;
  repositories?: Array<{ count: number; path: string }>;
  reason?: string;
  unattributed?: { count: number; reason: string };
}> {
  await rm(tracePath, { force: true });
  const supportPath = `${tracePath}.support`;
  await rm(supportPath, { force: true });
  const supportProbe = await invoke({ args: [], command: "git" }, ["version"], cwd, {
    ...environment,
    GIT_TRACE2_EVENT: supportPath,
  });
  if (supportProbe.exitCode !== 0) {
    return {
      available: false,
      method: "git-trace2-event-root-sessions",
      reason: `Git trace support probe failed: ${supportProbe.stderr}`,
    };
  }
  const support = await readGitInvocationTrace(supportPath);
  await rm(supportPath, { force: true });
  if (!support.available) return support;
  await writeFile(
    tracePath,
    `${JSON.stringify({ event: "version", sid: "arashi-benchmark-support-probe" })}\n`,
    "utf8",
  );
  await beforeEach?.();
  const result = await invoke(cli, args, cwd, { ...environment, GIT_TRACE2_EVENT: tracePath });
  if (result.exitCode !== 0) throw new Error(`Trace invocation failed: ${result.stderr}`);
  await afterEach?.();

  const metric = await readGitInvocationTrace(tracePath);
  if (!metric.available) return metric;
  const fetchCount = metric.fetchCount ?? 0;
  if (
    (args.includes("--local") || cli.args.some((arg) => arg.endsWith("status-local.ts"))) &&
    fetchCount !== 0
  )
    throw new Error("Local status performed a fetch");
  if (metric.available) {
    const attributedCount = (metric.repositories ?? []).reduce(
      (sum, repository) => sum + repository.count,
      0,
    );
    if (attributedCount + (metric.unattributed?.count ?? 0) !== metric.count) {
      throw new Error("Git trace repository breakdown does not sum to the aggregate count");
    }
    if (expectedRepositoryPaths) {
      const actualPaths = (metric.repositories ?? []).map(({ path }) => path).toSorted();
      if (JSON.stringify(actualPaths) !== JSON.stringify(expectedRepositoryPaths.toSorted())) {
        throw new Error(
          "Status trace repository paths did not match the named fixture repositories",
        );
      }
    }
  }
  return { ...metric, fetchCount };
}

async function peakRss(
  cli: Invocation,
  args: string[],
  cwd: string,
  enabled: boolean,
  environment: NodeJS.ProcessEnv,
  beforeEach?: () => Promise<void>,
  afterEach?: () => Promise<void>,
): Promise<AvailabilityMetric> {
  if (!enabled) return { available: false, method: "disabled", reason: "Metrics disabled." };
  if (platform() === "win32") {
    return {
      available: false,
      method: "unavailable",
      reason: "The benchmark runner has no privilege-free Windows peak working-set adapter.",
    };
  }
  if (!existsSync("/usr/bin/time")) {
    return { available: false, method: "time", reason: "/usr/bin/time is unavailable." };
  }

  const timeArgs = platform() === "darwin" ? ["-l"] : ["-v"];
  await beforeEach?.();
  const result = await invoke(
    { args: [...timeArgs, cli.command, ...cli.args], command: "/usr/bin/time" },
    args,
    cwd,
    environment,
  );
  if (result.exitCode !== 0) {
    return { available: false, method: "time", reason: `time exited ${result.exitCode}.` };
  }
  await afterEach?.();
  const macMatch = result.stderr.match(/(\d+)\s+maximum resident set size/i);
  if (macMatch) return { available: true, bytes: Number(macMatch[1]), method: "time -l" };
  const linuxMatch = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/i);
  if (linuxMatch) {
    return { available: true, bytes: Number(linuxMatch[1]) * 1024, method: "time -v" };
  }
  return { available: false, method: "time", reason: "Peak RSS was absent from time output." };
}

const noBehavior = () => ({});
const cliInvocation = {
  method: "arashi-cli",
  refresh: "not-applicable",
  topology: "tracked-remote",
};

function completionBehavior(stdout: string, expected: string): Record<string, unknown> {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const candidates = Array.from(
    { length: Math.floor(fields.length / 2) },
    (_, index) => fields[index * 2],
  ).filter((value): value is string => value !== undefined);
  if (!candidates.includes(expected)) {
    throw new Error(`Completion candidates did not include ${expected}: ${candidates.join(", ")}`);
  }
  return { candidates };
}

function plainListBehavior(stdout: string): Record<string, unknown> {
  return { paths: stdout.trim().split("\n").filter(Boolean) };
}

function listBehavior(stdout: string): Record<string, unknown> {
  const envelope = JSON.parse(stdout) as {
    data?: {
      worktrees?: Array<{
        branch?: string;
        subRepositories?: Array<{ relativePath?: string }>;
      }>;
    };
  };
  return {
    worktrees: (envelope.data?.worktrees ?? []).map(({ branch, subRepositories }) => ({
      branch,
      subRepositories: (subRepositories ?? []).flatMap(({ relativePath }) =>
        relativePath ? [relativePath] : [],
      ),
    })),
  };
}

function cliStatusBehavior(local: boolean, verbose: boolean, fixture: BenchmarkFixture) {
  return (stdout: string): Promise<Record<string, unknown>> =>
    validateCliStatusOutput(stdout, {
      environment: fixture.environment,
      expectedRepositoryPaths: fixture.repositoryPaths,
      local,
      verbose,
    });
}

function createBehavior(stdout: string, expectedCount: number): Record<string, unknown> {
  const envelope = JSON.parse(stdout) as {
    data?: { branchName?: string; successCount?: number };
    ok?: boolean;
  };
  if (
    envelope.ok !== true ||
    envelope.data?.branchName !== "benchmark-create" ||
    envelope.data.successCount !== expectedCount
  ) {
    throw new Error("Create benchmark did not report the expected coordinated worktree creation.");
  }
  return { branchName: envelope.data.branchName, successCount: envelope.data.successCount };
}

function removeBehavior(stdout: string, expectedCount: number): Record<string, unknown> {
  const envelope = JSON.parse(stdout) as {
    data?: {
      operations?: Array<{ branchName?: string; status?: string }>;
      summary?: { successfulBranches?: number; successfulWorktrees?: number };
    };
    ok?: boolean;
  };
  const operations = envelope.data?.operations ?? [];
  const successCount =
    (envelope.data?.summary?.successfulBranches ?? 0) +
    (envelope.data?.summary?.successfulWorktrees ?? 0);
  if (
    envelope.ok !== true ||
    operations.length !== expectedCount * 2 ||
    operations.some(
      (operation) => operation.branchName !== "benchmark-remove" || operation.status !== "success",
    ) ||
    successCount !== expectedCount * 2
  ) {
    throw new Error(
      `Remove benchmark did not report the expected coordinated worktree removal (operations=${operations.length}, successes=${successCount}).`,
    );
  }
  return { branchName: "benchmark-remove", operationCount: operations.length, successCount };
}

const commandDefinitions = (fixture: BenchmarkFixture): CommandDefinition[] => [
  {
    args: ["--version"],
    behavior: noBehavior,
    cwd: fixture.refreshedRoot,
    id: "version",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["--help"],
    behavior: noBehavior,
    cwd: fixture.refreshedRoot,
    id: "help",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    afterEach: fixture.statefulCases.create.verify,
    args: [
      "create",
      "benchmark-create",
      "--only",
      "repo-01,repo-02",
      "--no-hooks",
      "--no-progress",
      "--no-launch",
      "--no-switch",
      "--json",
    ],
    beforeEach: fixture.statefulCases.create.prepare,
    behavior: (stdout) => createBehavior(stdout, Math.min(fixture.repositoryCount, 2)),
    cwd: fixture.refreshedRoot,
    id: "create-coordinated",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    afterEach: fixture.statefulCases.remove.verify,
    args: ["remove", "benchmark-remove", "--force", "--no-check-dirty", "--json"],
    beforeEach: fixture.statefulCases.remove.prepare,
    behavior: (stdout) => removeBehavior(stdout, Math.min(fixture.repositoryCount, 2)),
    cwd: fixture.refreshedRoot,
    id: "remove-coordinated",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["completion", "__query", "1", "--", "arashi", "st"],
    behavior: (stdout) => completionBehavior(stdout, "status"),
    cwd: fixture.refreshedRoot,
    id: "completion-static-query",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["completion", "__query", "3", "--", "arashi", "status", "--only", "repo-0"],
    behavior: (stdout) => completionBehavior(stdout, "repo-01"),
    cwd: fixture.refreshedRoot,
    id: "completion-repository",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["completion", "__query", "3", "--", "arashi", "status", "--group", "benchmark-c"],
    behavior: (stdout) => completionBehavior(stdout, "benchmark-core"),
    cwd: fixture.refreshedRoot,
    id: "completion-group",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["completion", "__query", "4", "--", "arashi", "move", "topic", "--from", "fixture-0"],
    behavior: (stdout) => completionBehavior(stdout, "fixture-01"),
    cwd: fixture.refreshedRoot,
    id: "completion-worktree",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["list"],
    behavior: plainListBehavior,
    cwd: fixture.refreshedRoot,
    id: "list-plain",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["list", "--verbose", "--json"],
    behavior: listBehavior,
    cwd: fixture.refreshedRoot,
    id: "list-enriched-json",
    invocation: cliInvocation,
    networkDependent: false,
  },
  {
    args: ["status", "--local", "--json"],
    behavior: cliStatusBehavior(true, false, fixture),
    cwd: fixture.refreshedRoot,
    id: "status-local",
    invocation: {
      method: "arashi-cli-status",
      refresh: "explicit-local",
      topology: "tracked-remote",
    },
    networkDependent: false,
  },
  {
    args: ["status", "--local", "--verbose", "--json"],
    behavior: cliStatusBehavior(true, true, fixture),
    cwd: fixture.refreshedRoot,
    id: "status-local-verbose",
    invocation: {
      method: "arashi-cli-status",
      refresh: "explicit-local",
      topology: "tracked-remote",
    },
    networkDependent: false,
  },
  {
    args: [fixture.refreshedRoot],
    behavior: cliStatusBehavior(true, false, fixture),
    cli: {
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        join(repositoryRoot, "scripts", "benchmark", "status-local.ts"),
      ],
    },
    cwd: fixture.refreshedRoot,
    id: "status-local-collector",
    invocation: {
      method: "checkAllRepos-without-fetch",
      refresh: "disabled-by-injected-fetch-dependency",
      topology: "tracked-remote",
    },
    networkDependent: false,
    runtime: nodeRuntime("benchmark-only-node-adapter"),
  },
  {
    args: ["status", "--json"],
    behavior: cliStatusBehavior(false, false, fixture),
    cwd: fixture.refreshedRoot,
    id: "status-refreshed",
    invocation: { method: "arashi-cli-status", refresh: "default", topology: "tracked-remote" },
    networkDependent: true,
  },
  {
    args: ["status", "--verbose", "--json"],
    behavior: cliStatusBehavior(false, true, fixture),
    cwd: fixture.refreshedRoot,
    id: "status-refreshed-verbose",
    invocation: { method: "arashi-cli-status", refresh: "default", topology: "tracked-remote" },
    networkDependent: true,
  },
];

async function executableSize(cli: Invocation, enabled: boolean): Promise<AvailabilityMetric> {
  if (!enabled) return { available: false, method: "disabled", reason: "Metrics disabled." };
  if (cli.command === process.execPath) {
    return { available: false, method: "stat", reason: "Source mode has no Arashi executable." };
  }
  try {
    return { available: true, bytes: (await stat(cli.command)).size, method: "stat" };
  } catch (error) {
    return { available: false, method: "stat", reason: String(error) };
  }
}

async function runCommandDefinition(
  definition: CommandDefinition,
  cli: Invocation,
  environment: NodeJS.ProcessEnv,
  measureCpu: boolean,
): Promise<{ behavior: Record<string, unknown>; result: ProcessResult }> {
  await definition.beforeEach?.();
  const result = await invoke(cli, definition.args, definition.cwd, environment, { measureCpu });
  if (result.exitCode !== 0) {
    throw new Error(`${definition.id} failed: ${result.stderr}`);
  }
  const behavior = await definition.behavior(result.stdout);
  await definition.afterEach?.();
  return { behavior, result };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const cli = resolveCli(options.source);
  const fixtures: BenchmarkFixture[] = [];
  try {
    for (const id of options.fixtureIds) fixtures.push(await createBenchmarkFixture(id));
    const commands = [];
    for (const fixture of fixtures) {
      for (const definition of commandDefinitions(fixture)) {
        const commandCli = definition.cli ?? cli;
        for (let index = 0; index < options.warmup; index += 1) {
          await runCommandDefinition(definition, commandCli, fixture.environment, false);
        }
        const samples: Array<{ cpu: ProcessResult["cpu"]; wallMs: number }> = [];
        let exitCode = 0;
        let behavior: Record<string, unknown> = {};
        for (let index = 0; index < options.iterations; index += 1) {
          const measured = await runCommandDefinition(
            definition,
            commandCli,
            fixture.environment,
            options.metrics,
          );
          exitCode = measured.result.exitCode;
          behavior = measured.behavior;
          samples.push({ cpu: measured.result.cpu, wallMs: measured.result.durationMs });
        }
        const tracePath = join(
          definition.cwd,
          ".git",
          `arashi-benchmark-trace-${definition.id}.json`,
        );
        const durationSummary = summarizeDurations(samples.map((sample) => sample.wallMs));
        commands.push({
          args: definition.args,
          behavior,
          exitCode,
          fixtureId: fixture.id,
          gitInvocations: await gitInvocationCount(
            commandCli,
            definition.args,
            definition.cwd,
            tracePath,
            fixture.environment,
            definition.id.startsWith("status-") ? fixture.repositoryPaths : undefined,
            definition.beforeEach,
            definition.afterEach,
          ),
          id: definition.id,
          invocation: definition.invocation,
          networkDependent: definition.networkDependent,
          peakRss: await peakRss(
            commandCli,
            definition.args,
            definition.cwd,
            options.metrics,
            fixture.environment,
            definition.beforeEach,
            definition.afterEach,
          ),
          runtime: definition.runtime ?? cliRuntime(options.source),
          timing: {
            iterations: options.iterations,
            medianMs: durationSummary.medianMs,
            p95Ms: durationSummary.p95Ms,
            samples: samples.toSorted((left, right) => left.wallMs - right.wallMs),
            warmupIterations: options.warmup,
          },
        });
      }
    }

    const unavailablePeakRss = {
      available: false,
      method: options.metrics ? "per-command" : "disabled",
      reason: options.metrics ? "Peak RSS is reported for each command." : "Metrics disabled.",
    };
    const result = {
      artifact: await artifactMetadata(options.source, cli.command),
      commands,
      fixtures: fixtures.map(
        ({
          coordinatedChildWorktreeCount,
          definitionVersion,
          groupCount,
          id,
          repositoryCount,
          worktreeCount,
        }) => ({
          coordinatedChildWorktreeCount,
          definitionVersion,
          groupCount,
          id,
          repositoryCount,
          worktreeCount,
        }),
      ),
      generatedAt: new Date().toISOString(),
      metrics: {
        executableSize: await executableSize(cli, options.metrics),
        peakRss: unavailablePeakRss,
      },
      platform: { arch: arch(), os: platform(), release: release() },
      runtime: {
        build: await buildRuntime(
          options.source,
          cli.command,
          process.env[PROVENANCE_ENVIRONMENT_VARIABLE],
        ),
        runner: nodeRuntime("node-process"),
      },
      schemaVersion: 5,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, serialized, "utf8");
    process.stdout.write(serialized);
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
