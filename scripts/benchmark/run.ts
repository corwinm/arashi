import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createBenchmarkFixture, type BenchmarkFixture, type FixtureId } from "./fixtures.ts";
import { readGitInvocationTrace } from "./git-trace.ts";
import { executableNamesForPlatform } from "./platform.ts";
import { waitForProcessClose } from "./process.ts";
import { summarizeDurations } from "./statistics.ts";

interface Options {
  fixtureIds: FixtureId[];
  iterations: number;
  metrics: boolean;
  outputPath: string;
  source: boolean;
  warmup: number;
}

interface Invocation {
  args: string[];
  command: string;
}

interface ProcessResult {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface CommandDefinition {
  args: string[];
  behavior(stdout: string): Record<string, unknown>;
  cli?: Invocation;
  cwd: string;
  id: string;
  invocation: { method: string; refresh: string; topology: string };
  networkDependent: boolean;
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
    fixtureIds: ["small", "larger"],
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
      if (fixture !== "small" && fixture !== "larger") {
        throw new Error("--fixture must be small or larger.");
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

async function invoke(
  cli: Invocation,
  args: string[],
  cwd: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  const start = performance.now();
  const child = spawn(cli.command, [...cli.args, ...args], {
    cwd,
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      ...extraEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await waitForProcessClose(child);
  return { durationMs: performance.now() - start, exitCode, stderr, stdout };
}

async function gitInvocationCount(
  cli: Invocation,
  args: string[],
  cwd: string,
  tracePath: string,
): Promise<{ available: boolean; count?: number; method: string; reason?: string }> {
  await rm(tracePath, { force: true });
  const supportPath = `${tracePath}.support`;
  await rm(supportPath, { force: true });
  const supportProbe = await invoke({ args: [], command: "git" }, ["version"], cwd, {
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
  const result = await invoke(cli, args, cwd, { GIT_TRACE2_EVENT: tracePath });
  if (result.exitCode !== 0) throw new Error(`Trace invocation failed: ${result.stderr}`);

  return readGitInvocationTrace(tracePath);
}

async function peakRss(
  cli: Invocation,
  args: string[],
  cwd: string,
  enabled: boolean,
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
  const result = await invoke(
    { args: [...timeArgs, cli.command, ...cli.args], command: "/usr/bin/time" },
    args,
    cwd,
  );
  if (result.exitCode !== 0) {
    return { available: false, method: "time", reason: `time exited ${result.exitCode}.` };
  }
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

function cliStatusBehavior(stdout: string): Record<string, unknown> {
  const envelope = JSON.parse(stdout) as {
    data?: { repositories?: Array<{ name?: string }> };
  };
  return {
    repositories: (envelope.data?.repositories ?? []).flatMap(({ name }) => (name ? [name] : [])),
  };
}

function localStatusBehavior(stdout: string): Record<string, unknown> {
  const result = JSON.parse(stdout) as { refreshWarnings?: unknown[]; repositories?: string[] };
  if ((result.refreshWarnings ?? []).length > 0) {
    throw new Error("Benchmark-only local status unexpectedly produced refresh warnings.");
  }
  return { repositories: result.repositories ?? [] };
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
    behavior: noBehavior,
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
    args: [fixture.refreshedRoot],
    behavior: localStatusBehavior,
    cli: {
      args: [
        "--experimental-strip-types",
        join(repositoryRoot, "scripts", "benchmark", "status-local.ts"),
      ],
      command: process.execPath,
    },
    cwd: fixture.refreshedRoot,
    id: "status-local",
    invocation: {
      method: "checkAllRepos-without-fetch",
      refresh: "disabled-by-injected-fetch-dependency",
      topology: "tracked-remote",
    },
    networkDependent: false,
  },
  {
    args: ["status", "--json"],
    behavior: cliStatusBehavior,
    cwd: fixture.refreshedRoot,
    id: "status-refreshed",
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
          const warmup = await invoke(commandCli, definition.args, definition.cwd);
          if (warmup.exitCode !== 0) {
            throw new Error(`${definition.id} warm-up failed: ${warmup.stderr}`);
          }
        }
        const samples: number[] = [];
        let exitCode = 0;
        let stdout = "";
        for (let index = 0; index < options.iterations; index += 1) {
          const measured = await invoke(commandCli, definition.args, definition.cwd);
          exitCode = measured.exitCode;
          stdout = measured.stdout;
          if (exitCode !== 0) throw new Error(`${definition.id} failed: ${measured.stderr}`);
          samples.push(measured.durationMs);
        }
        const tracePath = join(
          definition.cwd,
          ".git",
          `arashi-benchmark-trace-${definition.id}.json`,
        );
        commands.push({
          args: definition.args,
          behavior: definition.behavior(stdout),
          exitCode,
          fixtureId: fixture.id,
          gitInvocations: await gitInvocationCount(
            commandCli,
            definition.args,
            definition.cwd,
            tracePath,
          ),
          id: definition.id,
          invocation: definition.invocation,
          networkDependent: definition.networkDependent,
          peakRss: await peakRss(commandCli, definition.args, definition.cwd, options.metrics),
          timing: {
            iterations: options.iterations,
            ...summarizeDurations(samples),
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
      runtime: { name: "node", version: process.version },
      schemaVersion: 1,
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
