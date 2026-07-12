import { dirname, join, relative } from "path";
import { readFileSync, readdirSync } from "fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const workspaceRoot = dirname(dirname(currentDir));

const windowsExcludedTests = new Set([
  "tests/integration/create.child-hooks-failure.test.ts",
  "tests/integration/create.child-hooks-parity.test.ts",
  "tests/integration/create.child-hooks-success.test.ts",
  "tests/integration/create.non-bare-parity.test.ts",
  "tests/integration/hook-execution.test.ts",
  "tests/integration/hooks-integration.test.ts",
  "tests/integration/remove.hooks.test.ts",
  "tests/integration/repository-management.test.ts",
  "tests/integration/repository-integration.test.ts",
  "tests/integration/setup.test.ts",
  "tests/integration/worktree-path-calculation.test.ts",
]);

const windowsShellExecutionPatterns = [
  /runLifecycleHook/,
  /executeHook/,
  /createRepoSpecificHookInRepo/,
  /createChildHookWorkspace/,
  /#!\/bin\/(?:sh|bash)/,
  /chmod\s*\+x/,
  /\.sh\.example/,
  /ARASHI_SHELL:\s*"bash"/,
  /hasSetupScript\s*:\s*true/,
  /setup\.sh/,
  /setup\.bash/,
  /install\.sh/,
  /bootstrap\.sh/,
];

const windowsSupplementalTests = [
  "tests/integration/config-integration.test.ts",
  "tests/integration/create.bare-config-fallback.test.ts",
  "tests/integration/create.bare-context.setup.test.ts",
  "tests/integration/create.bare-missing-config-error.test.ts",
  "tests/integration/create.bare-rollback-guarantee.test.ts",
  "tests/integration/create.bare-root-success.test.ts",
  "tests/integration/create.defaults.test.ts",
  "tests/integration/create.worktree-location-resolution.test.ts",
  "tests/integration/switch.test.ts",
  "tests/unit/commands/create.bare-context.test.ts",
  "tests/unit/commands/create.defaults.test.ts",
  "tests/unit/core/worktree.test.ts",
  "tests/unit/lib/shell-integration.test.ts",
  "tests/unit/lib/switch-launcher.test.ts",
  "tests/unit/repository-type-detection.test.ts",
  "tests/unit/setup-output.test.ts",
].toSorted((left, right) => left.localeCompare(right));

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function shouldSkipWindowsTest(relativePath: string): boolean {
  if (windowsExcludedTests.has(relativePath)) {
    return true;
  }

  const fileContents = readFileSync(join(workspaceRoot, relativePath), "utf8");
  return windowsShellExecutionPatterns.some((pattern) => pattern.test(fileContents));
}

function collectTestFiles(rootDir: string): string[] {
  const files: string[] = [];
  const pendingDirectories = [rootDir];

  while (pendingDirectories.length > 0) {
    const dirPath = pendingDirectories.pop();
    if (!dirPath) {
      continue;
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        pendingDirectories.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
        continue;
      }

      files.push(normalizeRelativePath(relative(workspaceRoot, fullPath)));
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function getHostTestFiles(): string[] {
  const unitTests = collectTestFiles(join(workspaceRoot, "tests", "unit"));
  const integrationTests = collectTestFiles(join(workspaceRoot, "tests", "integration"));
  const hostTests = [...unitTests, ...integrationTests];

  if (process.platform !== "win32") {
    return hostTests;
  }

  const windowsHostTests = hostTests.filter((filePath) => !shouldSkipWindowsTest(filePath));
  return [...new Set([...windowsHostTests, ...windowsSupplementalTests])].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

async function main(): Promise<void> {
  const selectedFiles = getHostTestFiles();

  if (selectedFiles.length === 0) {
    throw new Error("No test files matched the current platform.");
  }

  const proc = spawn(
    process.execPath,
    [join(workspaceRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...selectedFiles],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => resolve(code ?? 1));
  });
  process.exit(exitCode);
}

await main();
