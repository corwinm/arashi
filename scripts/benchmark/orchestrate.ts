import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executableNamesForPlatform } from "./platform.ts";
import { waitForProcessClose } from "./process.ts";
import { PROVENANCE_ENVIRONMENT_VARIABLE, writeBuildProvenance } from "./provenance.ts";

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface OrchestrationCommand {
  args: string[];
  command: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

type CommandRunner = (command: OrchestrationCommand) => Promise<CommandResult>;

interface OrchestrationDependencies {
  bunCommand?: string;
  repositoryRoot?: string;
  runCommand?: CommandRunner;
}

function resolveExecutable(name: string, environment: NodeJS.ProcessEnv): string {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const extensions =
    process.platform === "win32" ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      try {
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  throw new Error(`${name} executable was not found on PATH.`);
}

export function benchmarkExecutablePath(
  repositoryRoot: string,
  targetPlatform: NodeJS.Platform,
): string {
  return join(repositoryRoot, "bin", executableNamesForPlatform(targetPlatform)[0]!);
}

async function defaultRunCommand(command: OrchestrationCommand): Promise<CommandResult> {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.environment,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await waitForProcessClose(child);
  return { exitCode, stderr, stdout };
}

function forward(result: CommandResult): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function requireSuccess(label: string, result: CommandResult): void {
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}.`);
}

export async function orchestrateBenchmark(
  argv: string[],
  dependencies: OrchestrationDependencies = {},
): Promise<number> {
  const repositoryRoot = dependencies.repositoryRoot ?? resolve(import.meta.dirname, "../..");
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const environment = { ...process.env };
  const bunCommand = dependencies.bunCommand ?? resolveExecutable("bun", environment);

  const versionProbe = await runCommand({
    args: ["--version"],
    command: bunCommand,
    cwd: repositoryRoot,
    environment,
  });
  requireSuccess("Bun version probe", versionProbe);
  const compilerVersion = versionProbe.stdout.trim();
  if (!compilerVersion) throw new Error("Bun version probe returned no version.");

  const packageManagerCommand = process.env.npm_execpath
    ? {
        args: [process.env.npm_execpath, "run", "completion:check"],
        command: process.execPath,
      }
    : { args: ["run", "completion:check"], command: "pnpm" };
  const completion = await runCommand({
    ...packageManagerCommand,
    cwd: repositoryRoot,
    environment,
  });
  forward(completion);
  requireSuccess("Completion contract check", completion);

  const executablePath = benchmarkExecutablePath(repositoryRoot, process.platform);
  const build = await runCommand({
    args: ["build", "src/index.ts", "--compile", "--minify", "--outfile", executablePath],
    command: bunCommand,
    cwd: repositoryRoot,
    environment,
  });
  forward(build);
  requireSuccess("Bun build", build);

  const provenanceDirectory = await mkdtemp(join(tmpdir(), "arashi-benchmark-provenance-"));
  try {
    const provenancePath = join(provenanceDirectory, "build.json");
    await writeBuildProvenance(provenancePath, executablePath, compilerVersion);
    const runner = await runCommand({
      args: [
        "--experimental-strip-types",
        join(repositoryRoot, "scripts", "benchmark", "run.ts"),
        ...argv,
      ],
      command: process.execPath,
      cwd: repositoryRoot,
      environment: {
        ...environment,
        [PROVENANCE_ENVIRONMENT_VARIABLE]: provenancePath,
      },
    });
    forward(runner);
    return runner.exitCode;
  } finally {
    await rm(provenanceDirectory, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 100,
    });
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    process.exitCode = await orchestrateBenchmark(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
