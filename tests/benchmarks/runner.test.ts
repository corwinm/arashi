import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { waitForProcessClose } from "../../scripts/benchmark/process.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const temporaryPaths: string[] = [];

interface BenchmarkCommandResult {
  behavior: {
    freshness?: { mode: string; remoteRefsRefreshed: boolean };
    nativeStatus?: boolean;
    statuses?: unknown[];
    candidates?: string[];
    branchName?: string;
    operationCount?: number;
    paths?: string[];
    repositories?: string[];
    repositoryPaths?: string[];
    successCount?: number;
    worktrees?: Array<{ branch: string; subRepositories: string[] }>;
  };
  exitCode: number;
  fixtureId: string;
  gitInvocations: {
    available: boolean;
    count?: number;
    method: string;
    repositories?: Array<{ count: number; path: string }>;
    unattributed?: { count: number; reason: string };
  };
  id: string;
  invocation: {
    method: string;
    refresh: string;
    topology: string;
  };
  networkDependent: boolean;
  runtime: RuntimeMetadata;
  timing: {
    medianMs: number;
    p95Ms: number;
    samples: Array<{
      cpu: {
        available: boolean;
        method: string;
        reason?: string;
        systemMs?: number;
        userMs?: number;
      };
      wallMs: number;
    }>;
  };
}

interface RuntimeMetadata {
  method: string;
  name: string;
  version: { available: boolean; reason?: string; value?: string };
}

interface ArtifactMetadata {
  available: boolean;
  filename?: string;
  reason?: string;
  sha256?: string;
  sizeBytes?: number;
}

interface BenchmarkResult {
  artifact: ArtifactMetadata;
  commands: BenchmarkCommandResult[];
  fixtures: {
    coordinatedChildWorktreeCount: number;
    groupCount: number;
    id: string;
    repositoryCount: number;
    worktreeCount: number;
  }[];
  metrics: {
    executableSize: { available: boolean };
    peakRss: { available: boolean };
  };
  platform: { arch: string; os: string };
  runtime: { build: RuntimeMetadata; runner: RuntimeMetadata };
  schemaVersion: number;
}

async function runBenchmarkWithEnvironment(environment: NodeJS.ProcessEnv, ...args: string[]) {
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
    {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exitCode = await waitForProcessClose(child);
  let result: BenchmarkResult | null = null;
  try {
    result = JSON.parse(await readFile(outputPath, "utf8")) as BenchmarkResult;
  } catch {}
  return { exitCode, result, stderr, stdout };
}

async function runBenchmark(...args: string[]) {
  return runBenchmarkWithEnvironment({}, ...args);
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
    expect(result.schemaVersion).toBe(5);
    expect(result.artifact).toEqual({
      available: false,
      reason: "Source mode has no Arashi executable artifact.",
    });
    expect(result.runtime.runner).toEqual({
      method: "node-process",
      name: "node",
      version: { available: true, value: process.version },
    });
    expect(result.runtime.build).toEqual({
      method: "not-applicable-source-mode",
      name: "bun",
      version: {
        available: false,
        reason: "Source mode does not build or invoke the Arashi executable.",
      },
    });
    expect(result.platform.os).toBe(process.platform);
    expect(result.platform.arch).toBe(process.arch);
    expect(result.fixtures).toEqual([
      expect.objectContaining({
        id: "small",
        coordinatedChildWorktreeCount: 2,
        groupCount: 2,
        repositoryCount: 2,
        worktreeCount: 2,
      }),
    ]);

    const commands: Record<string, BenchmarkCommandResult> = Object.fromEntries(
      result.commands.map((command) => [command.id, command]),
    );
    expect(commands["status-local"].behavior.freshness).toEqual({
      mode: "local",
      remoteRefsRefreshed: false,
    });
    expect(commands["status-refreshed"].behavior.freshness).toEqual({
      mode: "refreshed",
      remoteRefsRefreshed: true,
    });
    expect(commands["status-local-verbose"].behavior.nativeStatus).toBe(true);
    expect(commands["status-local"].behavior.nativeStatus).toBe(false);
    expect(commands["status-local"].behavior.statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baseBranch: null,
          defaultBranch: expect.objectContaining({
            state: "available",
            compareRef: "refs/remotes/origin/main",
          }),
        }),
      ]),
    );
    expect(Object.keys(commands)).toEqual([
      "version",
      "help",
      "create-coordinated",
      "remove-coordinated",
      "completion-static-query",
      "completion-repository",
      "completion-group",
      "completion-worktree",
      "list-plain",
      "list-enriched-json",
      "status-local",
      "status-local-verbose",
      "status-local-collector",
      "status-refreshed",
      "status-refreshed-verbose",
    ]);
    for (const command of Object.values(commands)) {
      expect(command.fixtureId).toBe("small");
      expect(command.exitCode).toBe(0);
      expect(command.timing.samples).toHaveLength(1);
      expect(command.timing.samples[0]).toEqual({
        cpu: expect.objectContaining({
          available: expect.any(Boolean),
          method: expect.any(String),
        }),
        wallMs: expect.any(Number),
      });
      expect(command.timing.medianMs).toBeGreaterThanOrEqual(0);
      expect(command.timing.p95Ms).toBeGreaterThanOrEqual(0);
      expect(command.gitInvocations).toEqual(
        expect.objectContaining({ available: expect.any(Boolean), method: expect.any(String) }),
      );
    }
    expect(commands["completion-static-query"].behavior.candidates).toContain("status");
    expect(commands["create-coordinated"].behavior).toEqual({
      branchName: "benchmark-create",
      successCount: 2,
    });
    expect(commands["remove-coordinated"].behavior).toEqual({
      branchName: "benchmark-remove",
      operationCount: 4,
      successCount: 4,
    });
    expect(commands["completion-static-query"].gitInvocations.count).toBe(0);
    expect(commands["completion-repository"].behavior.candidates).toContain("repo-01");
    expect(commands["completion-group"].behavior.candidates).toContain("benchmark-core");
    expect(commands["completion-worktree"].behavior.candidates).toContain("fixture-01");
    expect(commands["list-enriched-json"].behavior.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: "fixture-01",
          subRepositories: expect.arrayContaining(["repos/repo-01", "repos/repo-02"]),
        }),
      ]),
    );
    expect(commands["list-plain"].behavior.paths).toHaveLength(2);
    expect(commands["list-plain"].behavior.paths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("workspace"),
        expect.stringContaining("fixture-01"),
      ]),
    );
    expect(commands["list-plain"].gitInvocations.count).toBeGreaterThan(0);
    expect(commands["status-local"].behavior.repositories).toEqual(
      commands["status-refreshed"].behavior.repositories,
    );
    expect(commands["status-local"].behavior.repositoryPaths).toEqual(
      commands["status-local"].behavior.statuses?.map(
        (status) => (status as { path: string }).path,
      ),
    );
    expect(commands["status-local"].invocation).toEqual({
      method: "arashi-cli-status",
      refresh: "explicit-local",
      topology: "tracked-remote",
    });
    expect(commands["status-local"].networkDependent).toBe(false);
    expect(commands["status-local-verbose"].behavior.statuses).toEqual(
      commands["status-local"].behavior.statuses,
    );
    expect(commands["status-local-collector"].behavior).toEqual(commands["status-local"].behavior);
    expect(commands["status-local"].gitInvocations).toMatchObject({ fetchCount: 0 });
    for (const id of [
      "status-local",
      "status-local-verbose",
      "status-local-collector",
      "status-refreshed",
      "status-refreshed-verbose",
    ]) {
      const metric = commands[id].gitInvocations;
      expect(metric.available).toBe(true);
      expect(metric.repositories?.map(({ path }) => path).toSorted()).toEqual(
        commands[id].behavior.repositoryPaths?.toSorted(),
      );
      expect(
        (metric.repositories?.reduce((sum, repository) => sum + repository.count, 0) ?? 0) +
          (metric.unattributed?.count ?? 0),
      ).toBe(metric.count);
    }
    expect(commands["status-refreshed-verbose"].behavior.statuses).toEqual(
      commands["status-refreshed"].behavior.statuses,
    );
    expect(commands["version"].runtime).toEqual({
      method: "node-source",
      name: "node",
      version: { available: true, value: process.version },
    });
    expect(commands["status-refreshed"].invocation).toEqual({
      method: "arashi-cli-status",
      refresh: "default",
      topology: "tracked-remote",
    });
    expect(commands["status-refreshed"].networkDependent).toBe(true);
    expect(result.metrics.peakRss.available).toBe(false);
    expect(result.metrics.executableSize.available).toBe(false);
  }, 120_000);

  test("rejects invalid iteration counts without creating plausible output", async () => {
    const { exitCode, stderr } = await runBenchmark("--iterations", "0");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--iterations must be a positive integer");
  });

  test("materializes coordinated child worktrees and exposes them in the large fixture", async () => {
    const { exitCode, result, stderr } = await runBenchmark("--fixture", "large");

    expect(exitCode, stderr).toBe(0);
    if (!result) throw new Error("Benchmark result was not written.");
    expect(result.fixtures).toEqual([
      expect.objectContaining({
        coordinatedChildWorktreeCount: 40,
        groupCount: 2,
        id: "large",
        repositoryCount: 8,
        worktreeCount: 6,
      }),
    ]);
    const commands = Object.fromEntries(result.commands.map((command) => [command.id, command]));
    expect(commands["completion-repository"].behavior.candidates).toContain("repo-08");
    expect(commands["completion-group"].behavior.candidates).toEqual(
      expect.arrayContaining(["benchmark-core"]),
    );
    expect(commands["completion-worktree"].behavior.candidates).toContain("fixture-05");
    expect(commands["list-plain"].behavior.paths).toHaveLength(6);
    expect(commands["list-enriched-json"].behavior.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch: "fixture-05",
          subRepositories: expect.arrayContaining(["repos/repo-01", "repos/repo-08"]),
        }),
      ]),
    );
  }, 120_000);

  test("resets stateful create and remove cases before every invocation", async () => {
    const { exitCode, result, stderr } = await runBenchmark("--warmup", "1", "--iterations", "2");

    expect(exitCode, stderr).toBe(0);
    if (!result) throw new Error("Benchmark result was not written.");
    for (const id of ["create-coordinated", "remove-coordinated"]) {
      const command = result.commands.find((candidate) => candidate.id === id);
      expect(command?.timing.samples).toHaveLength(2);
      expect(command?.exitCode).toBe(0);
    }
  }, 120_000);
});
