import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  benchmarkExecutablePath,
  orchestrateBenchmark,
  type OrchestrationCommand,
} from "../../scripts/benchmark/orchestrate.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true, maxRetries: 3, retryDelay: 10 })),
  );
});

describe("benchmark one-command orchestration", () => {
  test("probes and uses the same Bun, records the built artifact, and forwards runner arguments", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "arashi-orchestrator-test-"));
    temporaryPaths.push(repositoryRoot);
    await mkdir(join(repositoryRoot, "bin"));
    const commands: OrchestrationCommand[] = [];
    let runnerRecord: unknown;
    const executablePath = benchmarkExecutablePath(repositoryRoot, process.platform);
    const runnerPath = join(repositoryRoot, "scripts", "benchmark", "run.ts");

    const exitCode = await orchestrateBenchmark(
      ["--fixture", "small", "--iterations", "1", "--output", "portable.json"],
      {
        bunCommand: "resolved-bun",
        repositoryRoot,
        runCommand: async (command) => {
          commands.push(command);
          if (command.command === "resolved-bun" && command.args[0] === "--version") {
            return { exitCode: 0, stderr: "", stdout: "1.3.14\n" };
          }
          if (command.command === "resolved-bun" && command.args[0] === "build") {
            await writeFile(command.args.at(-1)!, "compiled bytes");
          }
          if (command.args.includes(runnerPath)) {
            runnerRecord = JSON.parse(
              await readFile(command.environment.ARASHI_BENCHMARK_PROVENANCE!, "utf8"),
            );
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(commands.filter(({ command }) => command === "resolved-bun")).toEqual([
      expect.objectContaining({ args: ["--version"], command: "resolved-bun" }),
      expect.objectContaining({
        args: ["build", "src/index.ts", "--compile", "--minify", "--outfile", executablePath],
        command: "resolved-bun",
      }),
    ]);
    expect(commands.at(-1)).toEqual(
      expect.objectContaining({
        args: [
          "--experimental-strip-types",
          join(repositoryRoot, "scripts", "benchmark", "run.ts"),
          "--fixture",
          "small",
          "--iterations",
          "1",
          "--output",
          "portable.json",
        ],
        command: process.execPath,
      }),
    );
    expect(runnerRecord).toEqual({
      artifact: expect.objectContaining({
        filename: basename(executablePath),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sizeBytes: 14,
      }),
      compiler: { name: "bun", version: "1.3.14" },
      schemaVersion: 1,
    });
  });

  test("selects the executable filename Bun produces on each platform", () => {
    expect(benchmarkExecutablePath("portable-root", "win32")).toBe(
      join("portable-root", "bin", "arashi.bin.exe"),
    );
    expect(benchmarkExecutablePath("portable-root", "linux")).toBe(
      join("portable-root", "bin", "arashi.bin"),
    );
  });
});
