import { afterEach, describe, expect, test } from "vitest";
import { delimiter, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const qualityScript = new URL("../../scripts/quality/changed-files-quality.ts", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("changed-files quality checks", () => {
  test.skipIf(process.platform === "win32")(
    "uses the repository oxlint config for changed TypeScript files",
    () => {
      const repository = mkdtempSync(join(tmpdir(), "arashi-quality-changed-"));
      temporaryDirectories.push(repository);

      writeFileSync(join(repository, ".oxlintrc.json"), "{}\n");
      writeFileSync(join(repository, ".oxfmtrc.json"), "{}\n");
      writeFileSync(join(repository, "sample.ts"), "export const value = 1;\n");

      execFileSync("git", ["init", "--quiet"], { cwd: repository });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repository });
      execFileSync("git", ["add", "."], { cwd: repository });
      execFileSync("git", ["commit", "--quiet", "-m", "test fixture"], { cwd: repository });

      writeFileSync(join(repository, "sample.ts"), "export const value = 2;\n");

      const result = spawnSync(process.execPath, [fileURLToPath(qualityScript)], {
        cwd: repository,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(repositoryRoot, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
        },
      });

      expect(result.stderr).not.toContain("Failed to parse oxlint configuration file");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );
});
