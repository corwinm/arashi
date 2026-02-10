import { spawnSync } from "node:child_process";

const CHANGED_FILE_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".cts",
  ".mts",
  ".tsx",
  ".json",
  ".yaml",
  ".yml",
  ".md",
]);

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getChangedFiles(): string[] {
  const trackedResult = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);

  if (trackedResult.status !== 0) {
    throw new Error("Unable to detect changed files from git diff.");
  }

  const untrackedResult = spawnSync("git", ["ls-files", "--others", "--exclude-standard"]);

  if (untrackedResult.status !== 0) {
    throw new Error("Unable to detect untracked files from git ls-files.");
  }

  const trackedFiles = trackedResult.stdout.toString("utf8").split("\n");
  const untrackedFiles = untrackedResult.stdout.toString("utf8").split("\n");

  return [...trackedFiles, ...untrackedFiles]
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => {
      const dotIndex = file.lastIndexOf(".");
      if (dotIndex < 0) {
        return false;
      }

      return CHANGED_FILE_EXTENSIONS.has(file.slice(dotIndex));
    });
}

function splitQualityTargets(files: string[]): {
  lintTargets: string[];
  formatTargets: string[];
} {
  const lintTargets = files.filter((file) => {
    return (
      file.endsWith(".js") ||
      file.endsWith(".cjs") ||
      file.endsWith(".mjs") ||
      file.endsWith(".jsx") ||
      file.endsWith(".ts") ||
      file.endsWith(".cts") ||
      file.endsWith(".mts") ||
      file.endsWith(".tsx")
    );
  });

  const formatTargets = files;

  return { lintTargets, formatTargets };
}

const changedFiles = getChangedFiles();

if (changedFiles.length === 0) {
  console.log("No changed source files detected for quality checks.");
  process.exit(0);
}

const { lintTargets, formatTargets } = splitQualityTargets(changedFiles);

if (lintTargets.length > 0) {
  run("oxlint", ["--config", "oxlint.json", "-D", "no-explicit-any", ...lintTargets]);
} else {
  console.log("No changed JavaScript or TypeScript files detected for linting.");
}

run("oxfmt", ["--config", ".oxfmtrc.json", "--check", ...formatTargets]);
