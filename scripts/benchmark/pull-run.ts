import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPullBenchmarkFixture } from "./pull-fixture.ts";
import { validatePullOutput } from "./pull-behavior.ts";
import { invoke } from "./invoke.ts";
import { summarizeDurations } from "./statistics.ts";
import { executableNamesForPlatform } from "./platform.ts";
import { nodeRuntime, cliRuntime } from "./runtime.ts";

const root = resolve(import.meta.dirname, "../..");

function options(argv: string[]) {
  const parsed = {
    iterations: 7,
    warmup: 2,
    output: join(root, "benchmark-results", `pull-${platform()}-${arch()}.json`),
    binary: "",
    binarySourceHead: "",
    jobs: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") continue;
    if (
      ![
        "--iterations",
        "--warmup",
        "--output",
        "--binary",
        "--binary-source-head",
        "--jobs",
      ].includes(arg)
    )
      throw new Error(`Unknown pull benchmark option: ${arg}`);
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--binary") parsed.binary = resolve(value);
    else if (arg === "--binary-source-head") {
      if (!/^[a-f0-9]{40}$/.test(value))
        throw new Error("--binary-source-head requires a full Git SHA");
      parsed.binarySourceHead = value;
    } else if (arg === "--output") parsed.output = resolve(value);
    else {
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        ((arg === "--iterations" || arg === "--jobs") && Number(value) === 0)
      )
        throw new Error(
          `${arg} requires ${arg === "--warmup" ? "a nonnegative" : "a positive"} integer`,
        );
      if (arg === "--warmup") parsed.warmup = Number(value);
      else if (arg === "--jobs") parsed.jobs = Number(value);
      else parsed.iterations = Number(value);
    }
  }
  return parsed;
}

export async function runPullBenchmark(argv: string[]) {
  const settings = options(argv);
  const pullArgv =
    settings.jobs === 1 ? ["pull", "--json"] : ["pull", "--json", "--jobs", String(settings.jobs)];
  const executable =
    settings.binary ||
    executableNamesForPlatform(platform())
      .map((name) => join(root, "bin", name))
      .find((candidate) => {
        try {
          return requireStat(candidate);
        } catch {
          return false;
        }
      });
  if (!executable)
    throw new Error("Built executable missing; run pnpm build before pnpm benchmark:pull:run");
  const binary = await readFile(executable);
  const artifact = {
    filename: executable.split(/[\\/]/).at(-1),
    bytes: binary.length,
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
  const fixtures = [];
  try {
    for (const id of ["small", "large"] as const)
      fixtures.push(await createPullBenchmarkFixture(id));
    const cases = [];
    for (const fixture of fixtures) {
      const samples = [];
      for (let index = 0; index < settings.warmup + settings.iterations; index += 1) {
        await fixture.prepare();
        const measured = await invoke(
          { command: executable, args: [] },
          pullArgv,
          fixture.refreshedRoot,
          fixture.environment,
          { measureCpu: true },
        );
        if (measured.exitCode !== 0)
          throw new Error(
            `${fixture.id} pull exited ${measured.exitCode}: ${measured.stderr} ${measured.stdout}`,
          );
        const behavior = validatePullOutput(measured.stdout, fixture.pullPaths);
        await fixture.verifyUpdated();
        if (index >= settings.warmup)
          samples.push({
            wallMs: measured.durationMs,
            cpu: measured.cpu,
            stdout: measured.stdout,
            behavior,
          });
      }
      const summary = summarizeDurations(samples.map(({ wallMs }) => wallMs));
      cases.push({
        id: `pull-${fixture.id}`,
        fixture: {
          id: fixture.id,
          definitionVersion: fixture.definitionVersion,
          pullCaseVersion: 1,
          fingerprint: fixture.fixtureFingerprint,
          repositoryCount: fixture.repositoryCount,
          coordinatedChildWorktreeCount: fixture.coordinatedChildWorktreeCount,
          worktreeCount: fixture.worktreeCount,
          repositoryNames: fixture.pullPaths.map((path) => path.split(/[\\/]/).at(-1)),
          remoteUpdates: fixture.pullPaths.length,
        },
        command: {
          executable: artifact.filename,
          argv: pullArgv,
          cwd: "fixture-workspace-root",
          method: "direct-compiled-binary",
          remote: "local-filesystem",
        },
        timing: {
          warmup: settings.warmup,
          iterations: settings.iterations,
          medianMs: summary.medianMs,
          p95Ms: summary.p95Ms,
        },
        samples: samples.toSorted((a, b) => a.wallMs - b.wallMs),
      });
    }
    const after = createHash("sha256")
      .update(await readFile(executable))
      .digest("hex");
    if (after !== artifact.sha256) throw new Error("Benchmark executable changed during the run");
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      binarySourceHead: settings.binarySourceHead || null,
      harnessHead: (
        await invoke({ command: "git", args: [] }, ["rev-parse", "HEAD"], root)
      ).stdout.trim(),
      artifact,
      runtime: {
        runner: nodeRuntime("node-process"),
        invocation: cliRuntime(false),
        compiler: {
          available: false,
          reason: "Existing built artifact; build command not instrumented by this runner",
        },
      },
      host: { os: platform(), arch: arch(), release: release() },
      cases,
    };
    await mkdir(dirname(settings.output), { recursive: true });
    await writeFile(settings.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  }
}

function requireStat(path: string) {
  return !!statSync(path).isFile();
}
import { statSync } from "node:fs";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runPullBenchmark(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify({ artifact: result.artifact, cases: result.cases.map(({ id, timing, fixture }) => ({ id, timing, fixture })) }, null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
