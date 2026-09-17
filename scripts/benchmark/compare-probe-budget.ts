import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBenchmarkFixture, type FixtureId } from "./fixtures.ts";
import { readGitInvocationTrace, type GitInvocationMetric } from "./git-trace.ts";
import { invoke } from "./invoke.ts";
import { validateProbeBudget } from "./probe-budget.ts";
import { validateCliStatusOutput } from "./status-behavior.ts";

const BASE_COMMIT = "b648825295a5c342b6920be0585711678377b452";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export const comparisonCases = [
  { fixture: "small", verbose: false },
  { fixture: "small", verbose: true },
  { fixture: "large", verbose: false },
  { fixture: "large", verbose: true },
] as const;

export interface ProbeComparisonCase {
  args?: string[];
  behavior: Record<string, unknown>;
  binary: "base" | "candidate";
  durationMs?: number;
  fixture: "small" | "large";
  metric: GitInvocationMetric;
  nativeOutputSha256: string | null;
  verbose: boolean;
}

export interface ProbeComparisonArtifact {
  adapter: { argv: string[]; sha256: string };
  base: { binarySha256: string; commit: string; [key: string]: unknown };
  candidate: { binarySha256: string; commit: string; [key: string]: unknown };
  cases: ProbeComparisonCase[];
  fixture: { definitionVersion: number; sourceSha256: string; [key: string]: unknown };
  provenance: { sameAdapterProcess: boolean; [key: string]: unknown };
  schemaVersion: number;
  [key: string]: unknown;
}

const fail = (message: string): never => {
  throw new Error(`Probe comparison rejected: ${message}`);
};

function comparableBehavior(behavior: Record<string, unknown>): string {
  const clone = structuredClone(behavior) as {
    freshness?: { mode?: string; remoteRefsRefreshed?: boolean };
    statuses?: Array<Record<string, unknown>>;
  };
  for (const status of clone.statuses ?? []) {
    delete status.baseBranch;
    delete status.defaultBranch;
  }
  return JSON.stringify(clone);
}

export function validateComparisonArtifact(artifact: ProbeComparisonArtifact): void {
  if (artifact.schemaVersion !== 1) fail("unsupported artifact schema");
  if (artifact.fixture.definitionVersion !== 4) fail("fixture definition v4 is required");
  if (!artifact.provenance.sameAdapterProcess)
    fail("base and candidate did not use one adapter process");
  if (artifact.base.commit !== BASE_COMMIT) fail("immutable base commit differs");
  if (artifact.base.binarySha256 === artifact.candidate.binarySha256)
    fail("base and candidate binary identities are equal");
  for (const definition of comparisonCases) {
    const matches = artifact.cases.filter(
      (entry) => entry.fixture === definition.fixture && entry.verbose === definition.verbose,
    );
    const base =
      matches.find((entry) => entry.binary === "base") ??
      fail("comparison matrix is missing base evidence");
    const candidate =
      matches.find((entry) => entry.binary === "candidate") ??
      fail("comparison matrix is missing candidate evidence");
    if (matches.length !== 2) fail("comparison matrix contains duplicate evidence");
    if (base.nativeOutputSha256 !== candidate.nativeOutputSha256)
      fail("native verbose output differs");
    if (comparableBehavior(base.behavior) !== comparableBehavior(candidate.behavior))
      fail("semantic status output differs outside the approved default-resolution correction");
    const mainPath =
      base.metric.repositories?.find((repository) => repository.path.endsWith("/workspace"))
        ?.path ?? fail("main repository attribution is unavailable");
    validateProbeBudget(
      { ...base, behavior: JSON.parse(comparableBehavior(base.behavior)) },
      { ...candidate, behavior: JSON.parse(comparableBehavior(candidate.behavior)) },
      {
        fixture: definition.fixture,
        mainPath,
        verbose: definition.verbose,
      },
    );
  }
}

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function command(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number>((settle, reject) => {
    child.on("error", reject);
    child.on("close", (code) => settle(code ?? 1));
  });
  return {
    exitCode,
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  };
}

async function successful(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await command(executable, args, cwd, environment);
  if (result.exitCode !== 0)
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`,
    );
  return result;
}

async function fileHash(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function controlledBuildEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "HOME",
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
  ];
  const environment: NodeJS.ProcessEnv = { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const key of keys) if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
}

async function version(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  return (await successful(executable, args, cwd, environment)).stdout.trim();
}

async function buildCheckout(
  repositoryRoot: string,
  checkout: string,
  commit: string,
  bun: string,
  pnpm: string,
  environment: NodeJS.ProcessEnv,
) {
  await successful(
    "git",
    ["worktree", "add", "--detach", "--force", checkout, commit],
    repositoryRoot,
    environment,
  );
  const installArgs = ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"];
  const install = await successful(pnpm, installArgs, checkout, environment);
  const executable = join(checkout, "bin", platform() === "win32" ? "arashi.exe" : "arashi.bin");
  const buildArgs = ["build", "src/index.ts", "--compile", "--minify", "--outfile", executable];
  const build = await successful(bun, buildArgs, checkout, environment);
  const actualCommit = (
    await successful("git", ["rev-parse", "HEAD"], checkout, environment)
  ).stdout.trim();
  if (actualCommit !== commit)
    throw new Error(`Checkout drifted: expected ${commit}, got ${actualCommit}`);
  return {
    binarySha256: await fileHash(executable),
    build: {
      args: buildArgs,
      command: bun,
      logSha256: sha256(`${build.stdout}\0${build.stderr}`),
    },
    commit: actualCommit,
    executable,
    install: {
      args: installArgs,
      command: pnpm,
      logSha256: sha256(`${install.stdout}\0${install.stderr}`),
    },
    size: (await stat(executable)).size,
  };
}

function nativeOutputHash(stdout: string, verbose: boolean): string | null {
  if (!verbose) return null;
  const parsed = JSON.parse(stdout) as {
    data?: { repositories?: Array<{ fullStatus?: string; path?: string }> };
  };
  const records = (parsed.data?.repositories ?? [])
    .map(({ fullStatus, path }) => ({ fullStatus, path }))
    .toSorted((left, right) => (left.path ?? "").localeCompare(right.path ?? ""));
  return sha256(`${JSON.stringify(records)}\n`);
}

async function measure(
  binary: "base" | "candidate",
  executable: string,
  fixture: Awaited<ReturnType<typeof createBenchmarkFixture>>,
  verbose: boolean,
  tracePath: string,
): Promise<ProbeComparisonCase> {
  await rm(tracePath, { force: true });
  const args = ["status", ...(verbose ? ["--verbose"] : []), "--json"];
  const result = await invoke({ args: [], command: executable }, args, fixture.refreshedRoot, {
    ...fixture.environment,
    GIT_TRACE2_EVENT: tracePath,
  });
  if (result.exitCode !== 0)
    throw new Error(`${binary} ${fixture.id} status failed: ${result.stderr}`);
  const behavior = await validateCliStatusOutput(result.stdout, {
    environment: fixture.environment,
    expectedDefaultResolution: binary === "base" ? "available" : "unresolved",
    expectedRepositoryPaths: fixture.repositoryPaths,
    local: false,
    verbose,
  });
  const metric = await readGitInvocationTrace(tracePath);
  if (!metric.available)
    throw new Error(`${binary} ${fixture.id} Trace2 unavailable: ${metric.reason}`);
  const attributed = (metric.repositories ?? []).reduce((sum, entry) => sum + entry.count, 0);
  if (attributed + (metric.unattributed?.count ?? 0) !== metric.count)
    throw new Error(`${binary} ${fixture.id} Trace2 attribution does not reconcile`);
  const actualPaths = (metric.repositories ?? []).map(({ path }) => path).toSorted();
  if (JSON.stringify(actualPaths) !== JSON.stringify(fixture.repositoryPaths.toSorted()))
    throw new Error(`${binary} ${fixture.id} Trace2 named repository paths differ from fixture`);
  return {
    args,
    behavior,
    binary,
    durationMs: result.durationMs,
    fixture: fixture.id as "small" | "large",
    metric,
    nativeOutputSha256: nativeOutputHash(result.stdout, verbose),
    verbose,
  };
}

async function configureComparisonFixture(
  fixture: Awaited<ReturnType<typeof createBenchmarkFixture>>,
): Promise<void> {
  // The approved baseline fixture has no local symbolic remote HEAD. The
  // regular benchmark fixture creates one for deterministic general-purpose
  // behavior, so remove only that local ref before both immutable binaries run.
  for (const repository of fixture.repositoryPaths) {
    await successful(
      "git",
      ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
      repository,
      fixture.environment,
    );
  }
}

async function fixtureTopology(
  fixture: Awaited<ReturnType<typeof createBenchmarkFixture>>,
  environment: NodeJS.ProcessEnv,
) {
  const repositories = [];
  for (const path of fixture.repositoryPaths) {
    repositories.push({
      branch: (
        await successful("git", ["branch", "--show-current"], path, environment)
      ).stdout.trim(),
      configSha256: sha256(
        (
          await successful(
            "git",
            ["config", "--null", "--list", "--show-origin", "--show-scope"],
            path,
            environment,
          )
        ).stdout,
      ),
      path,
      remotes: (await successful("git", ["remote", "-v"], path, environment)).stdout
        .trim()
        .split("\n")
        .filter(Boolean),
    });
  }
  return {
    coordinatedChildWorktreeCount: fixture.coordinatedChildWorktreeCount,
    groupCount: fixture.groupCount,
    id: fixture.id,
    repositories,
    repositoryCount: fixture.repositoryCount,
    worktreeCount: fixture.worktreeCount,
  };
}

export function parseArguments(argv: string[]) {
  let candidate = "HEAD";
  let output = join(tmpdir(), "arashi-probe-comparison.json");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    if (argv[index] === "--candidate")
      candidate = argv[++index] ?? fail("--candidate needs a value");
    else if (argv[index] === "--output")
      output = resolve(argv[++index] ?? fail("--output needs a value"));
    else fail(`unknown option ${argv[index]}`);
  }
  return { candidate, output };
}

export async function runProbeComparison(argv: string[]): Promise<ProbeComparisonArtifact> {
  const options = parseArguments(argv);
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const environment = controlledBuildEnvironment();
  const candidateCommit = (
    await successful("git", ["rev-parse", options.candidate], repositoryRoot, environment)
  ).stdout.trim();
  const status = await successful(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    repositoryRoot,
    environment,
  );
  if (status.stdout.trim())
    throw new Error("Candidate worktree must be clean before immutable comparison");
  const workspace = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "arashi-probe-comparison-")),
  );
  const baseCheckout = join(workspace, "base");
  const candidateCheckout = join(workspace, "candidate");
  const traces = join(workspace, "traces");
  const bun = process.env.BUN_BINARY ?? "bun";
  const pnpm = process.env.PNPM_BINARY ?? "pnpm";
  const fixtures: Awaited<ReturnType<typeof createBenchmarkFixture>>[] = [];
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(traces));
    const base = await buildCheckout(
      repositoryRoot,
      baseCheckout,
      BASE_COMMIT,
      bun,
      pnpm,
      environment,
    );
    const candidate = await buildCheckout(
      repositoryRoot,
      candidateCheckout,
      candidateCommit,
      bun,
      pnpm,
      environment,
    );
    const cases: ProbeComparisonCase[] = [];
    const topology = [];
    for (const fixtureId of ["small", "large"] as FixtureId[]) {
      const fixture = await createBenchmarkFixture(fixtureId);
      fixtures.push(fixture);
      await configureComparisonFixture(fixture);
      topology.push(await fixtureTopology(fixture, fixture.environment));
      for (const verbose of [false, true]) {
        cases.push(
          await measure(
            "base",
            base.executable,
            fixture,
            verbose,
            join(traces, `${fixtureId}-base-${verbose}.json`),
          ),
        );
        cases.push(
          await measure(
            "candidate",
            candidate.executable,
            fixture,
            verbose,
            join(traces, `${fixtureId}-candidate-${verbose}.json`),
          ),
        );
      }
    }
    const artifact: ProbeComparisonArtifact = {
      adapter: {
        argv: ["status", "[--verbose]", "--json"],
        sha256: await fileHash(import.meta.filename),
      },
      base,
      candidate,
      cases,
      fixture: {
        definitionVersion: 4,
        sourceSha256: await fileHash(join(import.meta.dirname, "fixtures.ts")),
        topology,
      },
      provenance: {
        buildEnvironment: environment,
        buildOptionsEqual:
          base.build.command === candidate.build.command &&
          JSON.stringify(base.build.args.slice(0, -1)) ===
            JSON.stringify(candidate.build.args.slice(0, -1)),
        commandBoundary: "compiled public CLI executable",
        gitTraceRule:
          "Trace2 start events whose sid has no slash; def_repo.worktree canonical attribution; Git descendants excluded",
        host: { arch: arch(), os: platform(), release: release() },
        metricMethod:
          "one Git Trace2 root-session sample per binary/case; named + unattributed = aggregate",
        sameAdapterProcess: true,
        samples: 1,
        toolchain: {
          bun: await version(bun, ["--version"], repositoryRoot, environment),
          git: await version("git", ["--version"], repositoryRoot, environment),
          node: process.version,
          pnpm: await version(pnpm, ["--version"], repositoryRoot, environment),
        },
        warmup: 0,
      },
      schemaVersion: 1,
    };
    validateComparisonArtifact(artifact);
    await writeFile(options.output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    return artifact;
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
    for (const checkout of [baseCheckout, candidateCheckout]) {
      await command(
        "git",
        ["worktree", "remove", "--force", checkout],
        repositoryRoot,
        environment,
      ).catch(() => ({ exitCode: 1, stderr: "", stdout: "" }));
    }
    await rm(workspace, { force: true, recursive: true });
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    await runProbeComparison(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
