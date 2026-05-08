import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const workspaceRoot = dirname(dirname(currentDir));

const windowsExcludedTests = new Set([
  "tests/unit/core/repository.test.ts",
  "tests/unit/hooks.test.ts",
  "tests/integration/create.child-hooks-failure.test.ts",
  "tests/integration/create.child-hooks-parity.test.ts",
  "tests/integration/create.child-hooks-success.test.ts",
  "tests/integration/create.non-bare-parity.test.ts",
  "tests/integration/hooks-integration.test.ts",
  "tests/integration/remove.hooks.test.ts",
  "tests/integration/repository-integration.test.ts",
  "tests/integration/setup.test.ts",
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

  if (process.platform !== "win32") {
    return [...unitTests, ...integrationTests];
  }

  return [...unitTests, ...integrationTests].filter((filePath) => !shouldSkipWindowsTest(filePath));
}

async function main(): Promise<void> {
  const selectedFiles = getHostTestFiles();

  if (selectedFiles.length === 0) {
    throw new Error("No test files matched the current platform.");
  }

  const proc = Bun.spawn(["bun", "test", ...selectedFiles], {
    cwd: workspaceRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  process.exit(await proc.exited);
}

await main();
