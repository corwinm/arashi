import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const temporaryPaths: string[] = [];

interface BenchmarkCommandResult {
  exitCode: number;
  fixtureId: string;
  gitInvocations: { available: boolean; count?: number; method: string };
  id: string;
  networkDependent: boolean;
  timing: { medianMs: number; p95Ms: number; samplesMs: number[] };
}

interface BenchmarkResult {
  commands: BenchmarkCommandResult[];
  fixtures: { arch?: string; id: string; repositoryCount: number; worktreeCount: number }[];
  metrics: {
    executableSize: { available: boolean };
    peakRss: { available: boolean };
  };
  platform: { arch: string; os: string };
  runtime: { name: string; version: string };
  schemaVersion: number;
}

async function runBenchmark(...args: string[]) {
  const outputDirectory = await mkdtemp(join(tmpdir(), "arashi-benchmark-test-"));
  temporaryPaths.push(outputDirectory);
  const outputPath = join(outputDirectory, "result.json");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/benchmark/run.ts",
      "--fixture",
      "small",
      "--warmup",
      "0",
      "--iterations",
      "1",
      "--no-metrics",
      "--source",
      "--output",
      outputPath,
      ...args,
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  let result: BenchmarkResult | null = null;
  try {
    result = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkResult;
  } catch {}
  return { exitCode, result, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI performance benchmark runner", () => {
  test("exercises the real CLI against a reproducible fixture and emits machine-readable results", async () => {
    const { exitCode, result, stderr, stdout } = await runBenchmark();

    expect(exitCode, stderr).toBe(0);
    expect(result).not.toBeNull();
    if (!result) throw new Error("Benchmark result was not written.");
    expect(JSON.parse(stdout)).toEqual(result);
    expect(result.schemaVersion).toBe(1);
    expect(result.runtime.name).toBe("node");
    expect(result.runtime.version).toMatch(/^v\d+/);
    expect(result.platform.os).toBe(process.platform);
    expect(result.platform.arch).toBe(process.arch);
    expect(result.fixtures).toEqual([
      expect.objectContaining({
        id: "small",
        repositoryCount: 2,
        worktreeCount: 2,
      }),
    ]);

    const commands: Record<string, BenchmarkCommandResult> = Object.fromEntries(
      result.commands.map((command) => [command.id, command]),
    );
    expect(Object.keys(commands)).toEqual([
      "version",
      "help",
      "completion-static",
      "completion-dynamic",
      "list-plain",
      "list-enriched-json",
      "status-local",
      "status-refreshed",
    ]);
    for (const command of Object.values(commands)) {
      expect(command.fixtureId).toBe("small");
      expect(command.exitCode).toBe(0);
      expect(command.timing.samplesMs).toHaveLength(1);
      expect(command.timing.medianMs).toBeGreaterThanOrEqual(0);
      expect(command.timing.p95Ms).toBeGreaterThanOrEqual(0);
      expect(command.gitInvocations).toEqual(
        expect.objectContaining({ available: expect.any(Boolean), method: expect.any(String) }),
      );
    }
    expect(commands["completion-static"].gitInvocations.count).toBe(0);
    expect(commands["list-plain"].gitInvocations.count).toBeGreaterThan(0);
    expect(commands["status-refreshed"].networkDependent).toBe(true);
    expect(result.metrics.peakRss.available).toBe(false);
    expect(result.metrics.executableSize.available).toBe(false);
  }, 120_000);

  test("rejects invalid iteration counts without creating plausible output", async () => {
    const { exitCode, stderr } = await runBenchmark("--iterations", "0");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--iterations must be a positive integer");
  });
});
